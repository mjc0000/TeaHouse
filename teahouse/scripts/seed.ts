/**
 * Seeds a running teahouse with the corpus samples, so the UI has something real
 * to look at without importing by hand.
 *
 *   npm run seed                      # against http://127.0.0.1:8787
 *   TEAHOUSE_URL=http://127.0.0.1:9000 npm run seed
 *
 * Idempotent: importing the same name twice just overwrites it, and it reuses
 * an existing chat for the character instead of piling up new ones.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = resolve(here, '..', 'corpus');
const base = (process.env.TEAHOUSE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');

async function call(path, init) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  return body;
}

const upload = (path, file, type) =>
  call(path, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body: readFileSync(file),
  });

const json = (method, payload) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

console.log(`seeding ${base}`);

const health = await call('/api/health');
if (!health.ok) throw new Error('server is not healthy');

// --- characters -------------------------------------------------------------

const card = await upload(
  '/api/characters/import?name=Osk',
  join(corpus, 'owned', 'cards', 'osk.png'),
  'image/png',
);
console.log(`character: ${card.name} (spec ${card.spec}, ${card.books?.[0]?.entries ?? 0} embedded book entries)`);

// --- worlds -----------------------------------------------------------------

const worldFiles = [
  ['Lantern', 'owned/st-native/full-fields.json'],
  ['LanternBook', 'owned/character-book/standalone.json'],
  ['Harbour', 'owned/agnai/memory.json'],
];

for (const [name, relative] of worldFiles) {
  const result = await upload(
    `/api/worlds/import?name=${encodeURIComponent(name)}`,
    join(corpus, relative),
    'application/json',
  );
  console.log(`world: ${name.padEnd(10)} ${String(result.entries).padStart(5)} entries  format=${result.format}`);
}

// --- chat -------------------------------------------------------------------

const chats = await call('/api/chats');
let chat = chats.find((item) => item.characterId === 'Osk');
// The Osk card embeds a small book of its own, so attach the two books it does
// not carry: that way every hit in the UI has an unambiguous source.
if (!chat) {
  chat = await call('/api/chats', json('POST', {
    characterId: 'Osk',
    name: 'Lantern District check',
    worldRefs: ['LanternBook', 'Harbour'],
  }));
  console.log(`chat: created ${chat.id}`);
} else {
  console.log(`chat: reusing ${chat.id}`);
}
chat = await call(`/api/chats/${chat.id}`, json('PUT', { worldRefs: ['LanternBook', 'Harbour'] }));

const existing = await call(`/api/chats/${chat.id}`);
if (existing.entries.length === 0) {
  await call(`/api/chats/${chat.id}/message`, json('POST', {
    content: 'I ask about the Lantern District at dusk.',
  }));
  console.log('chat: added an opening message that should trigger the Lantern District entry');
}

// --- proof: what the scan and the assembled request look like ---------------

const preview = await call('/api/prompt/preview', json('POST', { chatId: chat.id }));
const hits = preview.itemization.flatMap((item) =>
  (item.worldHits ?? []).map((hit) => ({ ...hit, slot: item.identifier })),
);

console.log('');
console.log(`prompt: ${preview.messages.length} messages, ${preview.totalTokens} tokens, ` +
  `world book ${preview.worldTokens}/${preview.budget} tokens, mode=${preview.mode}`);
console.log(`world book hits this turn: ${hits.length}`);
for (const hit of hits) {
  console.log(`  - [${hit.slot}] ${hit.world}#${hit.uid} "${hit.comment}" via ${hit.activatedBy}` +
    `${hit.matchedKeys.length ? ` keys=${hit.matchedKeys.join('|')}` : ''}`);
}
for (const warning of preview.warnings ?? []) console.log(`  ! ${warning}`);

const scan = await call('/api/scan/debug', json('POST', {
  chatId: chat.id,
  message: 'I ask the harbourmaster about the tide bell.',
}));
console.log(`scan debug: ${scan.entries} entries scanned from ${scan.worlds.length} books, ` +
  `${scan.hits.length} hit(s) for a harbourmaster question`);

console.log('');
console.log(`open ${base} and pick the chat "${chat.name}"`);
