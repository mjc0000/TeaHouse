/**
 * End-to-end API suite.
 *
 * Boots a fake OpenAI-compatible provider plus the teahouse server on loopback,
 * then drives the real HTTP surface: import -> chat -> preview -> generate.
 * The fake provider streams SSE and reports usage, so the streaming path, the
 * saved transcript and the token calibration are all exercised for real.
 *
 * Run: node scripts/test-api.ts
 */

import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTeahouseServer } from '../src/server.ts';
import { parseCardFile } from '../src/formats/character-card.ts';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = resolve(here, '..', 'corpus');

let checks = 0;
let failures = 0;

function check(ok: boolean, label: string, detail = ''): void {
  checks++;
  if (ok) return;
  failures++;
  console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`);
}

function eq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(a === b, label, `got ${a}, want ${b}`);
}

const json = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible provider
// ---------------------------------------------------------------------------

const REPLY = 'The woods remember you, traveller. Eldoria keeps its own counsel.';
/** The thinking channel a reasoning model streams before any visible text. */
const THINKING = 'Let me recall the district before answering. ZQXTHINKMARKER.';
/** What the fake provider answers when it is asked to summarise. */
const SUMMARY = 'ZQXSUMMARYMARKER: the harbourmaster keeps the ledger, and the tide is turning.';

/** The last request the provider was sent, so the knob under test can be read. */
let lastProviderRequest: Record<string, any> | null = null;
/** The Authorization header of the last request, to prove which key was used. */
let lastProviderAuth = '';
/** Flipped by the memory suite to make the summarising call fail. */
let summaryFails = false;
/** Counts the non-streaming translation calls, so a batch can prove its size. */
let translationCalls = 0;
/** Flipped by the translation suite to make a translation call fail. */
let translationFails = false;
/** What the model-selected retrieval call answers; garbage tests the parser. */
let selectionAnswer = '[1]';
/** How many model-selected retrieval calls the provider saw. */
let selectionCalls = 0;
/** Paths the fake model will ask `read_file` for, one per agent round. */
let agentToolPaths: string[] = [];
/** How many tool-carrying calls the provider saw. */
let agentCalls = 0;
/** Set by the overflow suite: the next streaming call is rejected with this. */
let overflowOnce: string | null = null;
/** Streaming chat calls seen, so a bounded retry can be counted. */
let streamCalls = 0;
/** Flipped by the empty-turn suite: the next streaming call answers with no text. */
let emptyReplyOnce = false;
/** Flipped by the vector suite to pretend the embedding endpoint is missing. */
let failEmbeddings = false;

const EMBED_DIMS = 16;
/** Bag of words, hashed into a fixed width and normalised. Enough to rank. */
function fakeVector(text: string): number[] {
  const vector = new Array(EMBED_DIMS).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let hash = 2166136261;
    for (const char of word) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    vector[hash % EMBED_DIMS] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

const fakeProvider = createServer((request, response) => {
  if (request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'fake-model' }, { id: 'another-model' }] }));
    return;
  }
  // Deterministic embeddings: a bag of words hashed into a fixed width, so texts
  // that share words land close together and the ranking is predictable.
  if (request.url === '/v1/embeddings') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { input?: unknown; model?: string };
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
      if (failEmbeddings) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'no such endpoint' } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          model: payload.model ?? 'fake-embed',
          data: inputs.map((text, index) => ({ index, embedding: fakeVector(String(text ?? '')) })),
        }),
      );
    });
    return;
  }
  // A fixed squeak of audio: the bytes do not matter, only that they arrive
  // with an audio content type when the key is accepted.
  if (request.url === '/v1/audio/speech') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        input?: unknown;
      };
      if (typeof payload.input !== 'string' || payload.input === '') {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'no input' } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      response.end(Buffer.from('ZQXAUDIOBYTES'));
    });
    return;
  }
  if (request.url === '/v1/completions') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        prompt?: string;
        stop?: string[];
      };
        lastProviderRequest = payload as Record<string, any>;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      for (const word of 'COMPLETED plain reply.'.split(' ')) {
        response.write(`data: ${JSON.stringify({ choices: [{ text: `${word} ` }] })}\n\n`);
      }
      response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } })}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
    });
    return;
  }
  if (request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      stream?: boolean;
      messages?: { role: string; content: string }[];
    };
    lastProviderRequest = payload as Record<string, any>;
    lastProviderAuth = String(request.headers.authorization ?? '');
    // The overflow suite rejects the first streaming call, exactly as a real
    // provider does when the prompt does not fit.
    if (payload.stream === true) streamCalls++;
    if (overflowOnce !== null && payload.stream === true) {
      const message = overflowOnce;
      overflowOnce = null;
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }));
      return;
    }
    // A provider that was told to skip thinking stops sending the channel, which
    // is what the real one does (measured against DeepSeek).
    const asked = payload.reasoning_effort === 'none' || (payload as any).thinking?.type === 'disabled';
    const thinking = asked ? '' : THINKING;
    // The summarising call is told what to do by its system message; answering it
    // with the roleplay reply would make the memory suite assert nonsense.
    const summarizing = (payload.messages ?? []).some((message) =>
      String(message.content).includes('Summarize the most important facts'),
    );
    const translating = (payload.messages ?? []).some((message) =>
      String(message.content).includes('Translate the following roleplay chat message'),
    );
    if (translating) translationCalls++;
    if (translating && translationFails) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'the translator is having a bad day' } }));
      return;
    }
    // Model-selected retrieval is its own cheap non-streaming call.
    const selecting = (payload.messages ?? []).some((message) =>
      String(message.content).includes('You choose optional background notes'),
    );
    if (selecting) selectionCalls++;
    // Agent mode: the call carries a `read_file` tool. The fake model asks for
    // the next scripted path, then stops once the script is empty.
    const agenting = Array.isArray((payload as any).tools)
      && (payload as any).tools.some((tool: any) => tool?.function?.name === 'read_file');
    if (agenting) {
      agentCalls++;
      const path = agentToolPaths.shift();
      const message = path
        ? {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: `call_${agentCalls}`,
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path }) },
          }],
        }
        : { role: 'assistant', content: 'READY' };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message, finish_reason: path ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }));
      return;
    }
    if (summarizing && summaryFails) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'the summariser is having a bad day' } }));
      return;
    }
    const answer = summarizing ? SUMMARY : selecting ? selectionAnswer : REPLY;
    if (!payload.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }));
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (emptyReplyOnce) {
      // A reasoning model that spends the whole budget thinking: frames arrive,
      // but no visible text and nothing to save.
      emptyReplyOnce = false;
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'ZQXTHINKMARKER budget eaten' } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 4000, total_tokens: 4100 } })}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }
    for (const word of thinking === '' ? [] : thinking.split(' ')) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: `${word} ` } }] })}\n\n`);
    }
    const words = REPLY.split(' ');
    for (const word of words) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${word} ` } }] })}\n\n`);
    }
    response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
    response.write('data: [DONE]\n\n');
    response.end();
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const fakePort = await new Promise<number>((resolvePromise) => {
  fakeProvider.listen(0, '127.0.0.1', () => {
    const address = fakeProvider.address();
    resolvePromise(typeof address === 'object' && address ? address.port : 0);
  });
});

const dataDir = mkdtempSync(join(tmpdir(), 'teahouse-test-'));
let app = createTeahouseServer({ dataDir, port: 0, host: '127.0.0.1' });
let base = await app.listen();
console.log(`teahouse: ${base}\nfake provider: http://127.0.0.1:${fakePort}\ndata: ${dataDir}`);

const api = async (path: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw text for non-JSON endpoints */
  }
  return { status: response.status, body };
};

try {
  // -------------------------------------------------------------------------
  section('health and config');
  // -------------------------------------------------------------------------

  eq((await api('/api/health')).status, 200, 'health responds');

  const configUpdate = await api('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${fakePort}`,
      apiKey: 'test-key',
      model: 'fake-model',
      maxContext: 4096,
      responseReserve: 256,
      personaName: 'Traveller',
      personaDescription: 'A wandering scholar with a lantern.',
    }),
  });
  eq(configUpdate.status, 200, 'config update accepted');
  eq(configUpdate.body.model, 'fake-model', 'config persisted');
  eq(configUpdate.body.maxContext, 4096, 'context window persisted');

  const readBack = await api('/api/config');
  eq(readBack.body.apiKey, '***', 'api key is masked on read');
  eq(readBack.body.personaName, 'Traveller', 'persona persisted');

  // -------------------------------------------------------------------------
  section('import world and character');
  // -------------------------------------------------------------------------

  const worldBytes = readFileSync(join(corpus, 'owned', 'st-native', 'full-fields.json'));
  const worldImport = await api('/api/worlds/import?name=eldoria', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: worldBytes,
  });
  eq(worldImport.status, 200, 'world import accepted');
  eq(worldImport.body.format, 'st-native', 'world format detected');
  eq(worldImport.body.entries, 4, 'world entry count');

  const bigBytes = readFileSync(join(corpus, 'owned', 'character-book', 'standalone.json'));
  const bigImport = await api('/api/worlds/import?name=eldenring', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bigBytes,
  });
  eq(bigImport.body.format, 'character-book', 'array-form book detected');
  eq(bigImport.body.entries, 2, 'array-form book entry count');

  const worlds = await api('/api/worlds');
  eq(worlds.body.length, 2, 'both worlds listed');

  // Imported bytes must survive a round trip through the API.
  const rawBack = await api('/api/worlds/eldoria/raw');
  check(
    JSON.stringify(rawBack.body) === JSON.stringify(JSON.parse(worldBytes.toString('utf8'))),
    'world raw output round-trips the imported document',
  );

  const cardBytes = readFileSync(join(corpus, 'owned', 'cards', 'osk.png'));
  const cardImport = await api('/api/characters/import?name=seraphina', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: cardBytes,
  });
  eq(cardImport.status, 200, 'character import accepted');
  eq(cardImport.body.name, 'Osk', 'character name parsed from PNG');
  check((cardImport.body.books?.[0]?.entries ?? 0) > 0, 'embedded character book parsed');

  const avatar = await fetch(`${base}/api/characters/seraphina/avatar`);
  const avatarBytes = Buffer.from(await avatar.arrayBuffer());
  eq(avatarBytes.length, cardBytes.length, 'avatar serves the original PNG bytes');
  eq(avatar.headers.get('content-type'), 'image/png', 'avatar content type');

  const cardDetail = await api('/api/characters/seraphina');
  const cardDescription = String(cardDetail.body.fields?.description ?? '');
  check(cardDescription.length > 20, 'card exposes a description', `${cardDescription.length} chars`);
  console.log(`  card: name="${cardDetail.body.name}" description=${cardDescription.length} chars`);

  const stNative = await api('/api/worlds/eldenring/st-native');
  eq(stNative.body.entries && Object.keys(stNative.body.entries).length, 2,
    'array-form book exports as an ST-native object');

  // -------------------------------------------------------------------------
  section('skills');
  // -------------------------------------------------------------------------

  /** A STORE-only zip, so the importer has a real archive to read. */
  function zipStore(entries: { name: string; text: string }[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
      const entryName = Buffer.from(entry.name, 'utf8');
      const data = Buffer.from(entry.text, 'utf8');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 8); // method: STORE
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(entryName.length, 26);
      locals.push(local, entryName, data);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(entryName.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, entryName);
      offset += 30 + entryName.length + data.length;
    }
    const localPart = Buffer.concat(locals);
    const centralPart = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralPart.length, 12);
    eocd.writeUInt32LE(localPart.length, 16);
    return Buffer.concat([localPart, centralPart, eocd]);
  }

  const skillMd = [
    '---',
    'name: yekaterina',
    'description: A haughty 1931 Harbin emigre who talks like a slow waltz.',
    'author: someone',
    'version: 1.2',
    'extra-field: kept',
    '---',
    '',
    '# Yekaterina',
    '',
    'You are Yekaterina. Speak with clipped, unhurried precision.',
  ].join('\n');

  const mdImport = await api('/api/characters/import?name=yekaterina.md', {
    method: 'POST',
    body: Buffer.from(skillMd),
  });
  eq(mdImport.status, 200, 'a SKILL.md imports');
  const mdId = mdImport.body.id as string;
  eq(mdImport.body.name, 'yekaterina', 'the frontmatter name is the card name');
  const mdCard = await api(`/api/characters/${mdId}/export`);
  eq(mdCard.body.data.creator_notes, 'A haughty 1931 Harbin emigre who talks like a slow waltz.',
    'the skill description becomes the card note');
  check(String(mdCard.body.data.description).includes('You are Yekaterina'),
    'the SKILL.md body is the card description');
  eq(mdCard.body.data.creator, 'someone', 'author maps to creator');
  eq(mdCard.body.data.character_version, '1.2', 'version maps to character_version');
  check(existsSync(join(dataDir, 'characters', mdId, 'skill.md')),
    'the original markdown is kept beside the card');

  const zipBytes = zipStore([
    { name: 'yekaterina/SKILL.md', text: skillMd },
    { name: 'yekaterina/references/city.md', text: '# Harbin\n\nHome in 1931.' },
  ]);
  const zipImport = await api('/api/characters/import?name=yekaterina.zip', {
    method: 'POST',
    body: zipBytes,
  });
  eq(zipImport.status, 200, 'a zipped skill imports');
  const zipId = zipImport.body.id as string;
  eq(zipImport.body.books?.[0]?.entries, 1, 'references become an embedded book');
  check(
    readFileSync(join(dataDir, 'characters', zipId, 'card.json'), 'utf8').includes('extra-field'),
    'unknown frontmatter survives in the stored card',
  );
  check(existsSync(join(dataDir, 'characters', zipId, 'skill.zip')),
    'the original zip is kept verbatim');

  const plainImport = await api('/api/characters/import?name=plain.md', {
    method: 'POST',
    body: Buffer.from('# Plain Skill\n\nNo frontmatter here.'),
  });
  eq(plainImport.body.name, 'Plain Skill', 'a heading names a skill without frontmatter');

  const emptyZip = zipStore([{ name: 'notes/readme.txt', text: 'nothing useful' }]);
  eq(
    (await api('/api/characters/import?name=empty.zip', { method: 'POST', body: emptyZip })).status,
    400,
    'a zip with no SKILL.md is refused',
  );
  eq(
    (await api('/api/characters/import?name=empty.md', { method: 'POST', body: Buffer.alloc(0) })).status,
    400,
    'an empty file is refused',
  );
  eq(
    (await api('/api/characters/import?name=photo.jpg', {
      method: 'POST',
      body: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
    })).status,
    400,
    'a binary that is not a card is refused',
  );
  // A skill has no greeting, so the first chat must simply start empty rather
  // than fail on "greeting 0 out of range".
  const skillChat = await api('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId: mdId }),
  });
  eq(skillChat.status, 200, 'a skill card with no greeting still starts a chat');
  const skillTranscript = await api(`/api/chats/${skillChat.body.id}`);
  eq((skillTranscript.body.entries as unknown[]).length, 0, 'and the transcript is empty');
  await api(`/api/chats/${skillChat.body.id}`, { method: 'DELETE' });

  for (const id of [mdId, zipId, plainImport.body.id as string]) {
    await api(`/api/characters/${id}`, { method: 'DELETE' });
  }
  // -------------------------------------------------------------------------
  section('chat lifecycle');
  // -------------------------------------------------------------------------

  const chat = await api('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId: 'seraphina', worldRefs: ['eldoria'], name: 'test chat' }),
  });
  eq(chat.status, 200, 'chat created');
  const chatId = chat.body.id as string;
  check(typeof chatId === 'string' && chatId.length > 0, 'chat has an id');

  const message = await api(`/api/chats/${chatId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'I ask about the Lantern District at dusk.' }),
  });
  eq(message.status, 200, 'user message appended');
  eq(message.body.role, 'user', 'message role');

  // -------------------------------------------------------------------------
  section('prompt preview');
  // -------------------------------------------------------------------------

  const preview = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  eq(preview.status, 200, 'preview responds');
  check(preview.body.messages.length > 0, 'preview produced messages');
  check(preview.body.totalTokens > 0, 'preview counted tokens');
  eq(preview.body.mode, 'estimate', 'mode is estimate without a tokenizer file');

  const worldItem = preview.body.itemization.find((item: any) => item.identifier === 'worldInfoBefore');
  check((worldItem?.worldHits?.length ?? 0) > 0, 'preview reports the world book hit');
  const keys = worldItem?.worldHits?.[0]?.matchedKeys ?? [];
  check(
    keys.includes('lantern district') || keys.includes('district'),
    'preview reports which key matched',
    keys.join('|'),
  );
  console.log(`  preview: ${preview.body.messages.length} messages, ${preview.body.totalTokens} tokens, ` +
    `world hit uid=${worldItem?.worldHits?.[0]?.uid} keys=${keys.join('|')}`);

  const descriptionProbe = cardDescription.slice(0, 40);
  check(
    preview.body.messages.some((m: any) => m.content.includes(descriptionProbe)),
    'card description reached the preview',
    `probe: ${descriptionProbe.slice(0, 40)}`,
  );
  check(
    !JSON.stringify(preview.body.messages).includes('{{user}}'),
    'no unexpanded macros in the preview',
  );

  // Full injection: the embedded book goes in wholesale, and a per-chat pin
  // overrides the configured mode (which stays on keyword here).
  const fullHitsOf = (body: any) =>
    body.itemization
      .flatMap((item: any) => item.worldHits ?? [])
      .filter((hit: any) => hit.source === 'full');
  await api(`/api/chats/${chatId}`, json('PUT', { retrievalMode: 'all' }));
  const fullPreview = await api('/api/prompt/preview', json('POST', { chatId }));
  eq(fullPreview.body.retrievalMode, 'all', 'the per-chat pin is the effective mode');
  // The fixture world book mirrors one live entry of the card's book (and one
  // disabled one): the live duplicate is shadowed, the disabled one is not.
  eq(fullHitsOf(fullPreview.body).length, 1, 'the embedded book is injected wholesale, minus the live duplicate');
  await api('/api/config', json('PUT', { retrieval: { fullForceOnConflict: true } }));
  const forcedPreview = await api('/api/prompt/preview', json('POST', { chatId }));
  eq(fullHitsOf(forcedPreview.body).length, 2, 'the conflict switch restores the shadowed copy');
  await api('/api/config', json('PUT', { retrieval: { fullForceOnConflict: false } }));
  await api(`/api/chats/${chatId}`, json('PUT', { retrievalMode: null }));
  const keywordPreview = await api('/api/prompt/preview', json('POST', { chatId }));
  eq(keywordPreview.body.retrievalMode, 'keyword', 'clearing the pin follows the default again');
  eq(fullHitsOf(keywordPreview.body).length, 0, 'and nothing is force-injected');

  const withPending = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, pendingUserMessage: 'What is the glade?' }),
  });
  check(
    JSON.stringify(withPending.body.messages).includes('What is the glade?'),
    'pending message is included in the preview without being saved',
  );
  const afterPreview = await api(`/api/chats/${chatId}`);
  eq(afterPreview.body.entries.length, 2, 'preview does not persist the pending message (greeting + the one turn)');

  // -------------------------------------------------------------------------
  section('scan debug');
  // -------------------------------------------------------------------------

  const scanDebug = await api('/api/scan/debug', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, message: 'I ask the harbourmaster about the tide.' }),
  });
  eq(scanDebug.status, 200, 'scan debug responds');
  check(scanDebug.body.hits.length > 0, 'scan finds hits for a matching message');
  console.log(`  scan debug hits: ${scanDebug.body.hits.map((hit: any) => `${hit.world}#${hit.uid} "${hit.comment}" via ${hit.activatedBy} keys=${hit.matchedKeys.join('|')}`).join(' ; ') || 'none'}`);
  console.log(`  scan debug skipped: ${(scanDebug.body.skipped ?? []).map((item: any) => `${item.world}#${item.uid}:${item.reason}`).join(' ; ') || 'none'}`);
  const harbourmaster = scanDebug.body.hits.find((hit: any) => hit.comment === 'The Harbourmaster');
  check(harbourmaster !== undefined, 'the harbourmaster entry fired');
  check(scanDebug.body.budget > 0, 'budget reported');
  console.log(`  scan: ${scanDebug.body.hits.length} hits, budget=${scanDebug.body.budget}, ` +
    `tokens=${scanDebug.body.tokensUsed}, loops=${scanDebug.body.loops}`);
  eq(scanDebug.body.worlds.length, 2, 'character book plus selected world are both scanned');

  // -------------------------------------------------------------------------
  section('generation over SSE');
  // -------------------------------------------------------------------------

  const generateResponse = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, message: 'Who guards this place?' }),
  });
  eq(generateResponse.status, 200, 'generate responds');
  eq(generateResponse.headers.get('content-type'), 'text/event-stream; charset=utf-8', 'generate streams SSE');

  const raw = await generateResponse.text();
  const events = raw
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as any);

  const types = events.map((event) => event.type);
  check(types.includes('prompt'), 'a prompt event is sent first');
  check(types.includes('delta'), 'delta events are streamed');
  check(types.includes('usage'), 'provider usage is forwarded');
  check(types.includes('saved'), 'the assistant message is saved');
  check(types.includes('done'), 'a done event closes the stream');
  eq(types[0], 'prompt', 'prompt event comes before any delta');

  const streamed = events.filter((event) => event.type === 'delta').map((event) => event.text).join('');
  check(streamed.includes('Eldoria'), 'streamed text matches the provider reply', streamed.slice(0, 60));
  eq(streamed.trim(), REPLY.trim(), 'the full reply is streamed');

  const calibration = events.find((event) => event.type === 'calibration');
  check(calibration !== undefined, 'calibration runs when usage is reported');
  check(calibration?.divergence > 0, 'divergence is measured');
  console.log(`  calibration: divergence=${calibration?.divergence?.toFixed(3)} ` +
    `overhead=${calibration?.stats?.perMessageOverhead?.toFixed(2)} calibrations=${calibration?.stats?.calibrations}`);

  const afterGenerate = await api(`/api/chats/${chatId}`);
  const entries = afterGenerate.body.entries as any[];
  eq(entries.length, 4, 'transcript holds the greeting, the two user turns and the reply');
  eq(entries[0].role, 'assistant', 'the first entry is the greeting seeded from the card');
  eq(entries[1].role, 'user', 'then the first user turn');
  eq(entries[2].role, 'user', 'then the second user turn');
  eq(entries[3].role, 'assistant', 'and finally the reply');
  eq(entries[3].content.trim(), REPLY.trim(), 'saved reply matches the stream');
  check(entries[3].parentId === entries[2].id, 'reply is linked to the previous entry');

  // -------------------------------------------------------------------------
  section('model-selected entries');
  // -------------------------------------------------------------------------

  // A dedicated chat, so the turns this adds do not move the counts the rest of
  // the suite asserts on.
  const selectChat = (await api('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId: 'seraphina', worldRefs: ['eldoria'], name: 'select chat' }),
  })).body.id as string;

  /** One generate, reduced to the world hits the `prompt` frame reported. */
  async function promptHits(message: string): Promise<any[]> {
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: selectChat, message }),
    });
    const text = await response.text();
    const prompt = text
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)) as any)
      .find((event) => event.type === 'prompt');
    return (prompt?.itemization ?? []).flatMap((item: any) => item.worldHits ?? []);
  }

  // Default mode (keyword): no extra provider call, and nothing is model-picked.
  const selectCallsBefore = selectionCalls;
  const offHits = await promptHits('Tell me about this place.');
  eq(selectionCalls - selectCallsBefore, 0, 'the default mode makes no retrieval call');
  check(!offHits.some((hit) => hit.source === 'model'), 'and no entry is model-picked');

  // `select`: one call, and the picked entry rides the external activation path.
  await api('/api/config', json('PUT', { retrieval: { mode: 'select' } }));
  const onCallsBefore = selectionCalls;
  const onHits = await promptHits('Tell me about this place.');
  eq(selectionCalls - onCallsBefore, 1, 'one retrieval call per turn');
  const picked = onHits.filter((hit) => hit.source === 'model');
  check(picked.length === 1, 'the picked entry is injected once', `${picked.length}`);
  eq(picked[0]?.activatedBy, 'external', 'and rides the external activation path');

  // A reply the parser cannot read costs the channel, never the turn.
  selectionAnswer = 'sorry, I cannot help with that';
  const junkCallsBefore = selectionCalls;
  const junkHits = await promptHits('Tell me about this place.');
  eq(selectionCalls - junkCallsBefore, 1, 'the retrieval call still happens');
  check(!junkHits.some((hit) => hit.source === 'model'), 'but an unreadable answer yields no picks');
  const afterJunk = await api(`/api/chats/${selectChat}`);
  check((afterJunk.body.entries as any[]).length > 0, 'and the turn still saved a reply');

  selectionAnswer = '[1]';
  await api('/api/config', json('PUT', { retrieval: { mode: 'keyword' } }));
  await api(`/api/chats/${selectChat}`, { method: 'DELETE' });

  // -------------------------------------------------------------------------
  section('agent reads files');
  // -------------------------------------------------------------------------

  const agentZip = zipStore([
    {
      name: 'agent-probe/SKILL.md',
      text: '---\nname: agent-probe\ndescription: A skill for the agent read loop.\n---\n\nUse the notes when asked.\n',
    },
    { name: 'agent-probe/references/secret.md', text: '# Secret\n\nZQXAGENTMARKER lives here.\n' },
  ]);
  const agentSkillId = (await api('/api/characters/import?name=agent-probe.zip', {
    method: 'POST',
    body: agentZip,
  })).body.id as string;
  const agentChat = (await api('/api/chats', json('POST', { characterId: agentSkillId }))).body.id as string;

  /** The `prompt` frame of a generate call. */
  async function agentFrame(message: string): Promise<any> {
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: agentChat, message }),
    });
    const text = await response.text();
    return text
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)) as any)
      .find((event) => event.type === 'prompt');
  }
  const agentBlockOf = (frame: any) =>
    (frame?.itemization ?? []).find((item: any) => item.identifier === 'agentSkillFiles');

  await api('/api/config', json('PUT', { retrieval: { mode: 'agent', agentMaxRounds: 4, agentMaxFiles: 4 } }));
  // Two rounds of reads: a file from the skill package, then the same text as an
  // embedded book entry — the two kinds of readable id.
  agentToolPaths = ['agent-probe/references/secret.md', `book/${agentSkillId}:book/0`];
  const agentBefore = agentCalls;
  const agentPrompt = await agentFrame('Tell me about the place.');
  eq(agentPrompt.retrievalMode, 'agent', 'the mode is reported on the prompt frame');
  eq(agentCalls - agentBefore, 3, 'two read rounds plus the closing call');
  eq(agentPrompt.agentReads, ['agent-probe/references/secret.md', `book/${agentSkillId}:book/0`],
    'both reads are reported on the prompt frame');
  check(
    String(agentBlockOf(agentPrompt)?.content ?? '').includes('ZQXAGENTMARKER'),
    'the file the model asked for is injected',
    String(agentBlockOf(agentPrompt)?.content ?? '').slice(0, 80),
  );

  // A path the catalogue never listed cannot be read: no content, nothing injected.
  agentToolPaths = ['../../config.json'];
  const unknownPrompt = await agentFrame('Tell me about the place.');
  eq(String(agentBlockOf(unknownPrompt)?.content ?? ''), '', 'an unlisted path injects nothing');

  // Bare keyword mode spends no extra call at all.
  agentToolPaths = ['agent-probe/references/secret.md'];
  await api('/api/config', json('PUT', { retrieval: { mode: 'keyword' } }));
  const beforeQuiet = agentCalls;
  await agentFrame('Tell me about the place.');
  eq(agentCalls - beforeQuiet, 0, 'another mode makes no agent call');

  await api(`/api/chats/${agentChat}`, { method: 'DELETE' });
  await api(`/api/characters/${agentSkillId}`, { method: 'DELETE' });

  // -------------------------------------------------------------------------
  section('provider presets');
  // -------------------------------------------------------------------------

  const providers = await api('/api/providers');
  eq(providers.status, 200, 'the preset table is served');
  check((providers.body.providers ?? []).length >= 10, 'and lists the common endpoints', `${providers.body.providers?.length}`);
  eq(
    providers.body.active,
    null,
    'the fake endpoint in this suite matches no preset',
  );
  // The query form answers about values the dialog has not saved yet.
  const queried = await api(
    '/api/providers?baseUrl=https%3A%2F%2Fapi.deepseek.com%2Fv1&model=deepseek-flash',
  );
  eq(queried.body.active, 'deepseek', 'a queried base URL still resolves');
  eq(queried.body.current?.contextWindow, 1_048_576, 'with the documented window');
  // The saved config is untouched by that query.
  const afterQuery = await api('/api/providers');
  eq(afterQuery.body.active, null, 'and the query does not change what is saved');
  // Labels are served in the interface language the client asks for.
  const englishProviders = await api('/api/providers?lang=en');
  eq(
    (englishProviders.body.providers as any[]).find((provider) => provider.id === 'zhipu')?.label,
    'Zhipu GLM',
    'the preset table answers in the requested language',
  );
  const unknownLanguage = await api('/api/providers?lang=xx');
  eq(
    (unknownLanguage.body.providers as any[]).find((provider) => provider.id === 'zhipu')?.label,
    '智谱 GLM',
    'an unknown language falls back to the source',
  );
  await api('/api/config', json('PUT', { baseUrl: `http://127.0.0.1:${fakePort}` }));

  // A window we know is adopted automatically while the value is still the
  // shipped default; a number the user typed is left exactly as it is.
  const beforeAdopt = (await api('/api/config')).body as any;
  await api('/api/config', json('PUT', {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    maxContext: 65_536,
  }));
  eq(Number((await api('/api/config')).body.maxContext), 1_048_576, 'a known window replaces the shipped default');
  await api('/api/config', json('PUT', { maxContext: 300_000 }));
  eq(Number((await api('/api/config')).body.maxContext), 300_000, 'but a number the user typed is left alone');
  await api('/api/config', json('PUT', {
    baseUrl: beforeAdopt.baseUrl,
    model: beforeAdopt.model,
    maxContext: beforeAdopt.maxContext,
  }));

  // -------------------------------------------------------------------------
  section('context overflow learns the window');
  // -------------------------------------------------------------------------

  const limitChat = (await api('/api/chats', json('POST', { characterId: 'seraphina' }))).body.id as string;
  const windowBefore = Number((await api('/api/config')).body.maxContext);

  overflowOnce = "This model's maximum context length is 2048 tokens. However, you requested 3850 tokens "
    + '(3820 in the messages, 30 in the completion). Please reduce the length of the messages or completion.';
  const streamCallsBefore = streamCalls;
  const overflowTurn = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: limitChat, message: 'hello there' }),
  });
  const overflowText = await overflowTurn.text();
  check(overflowText.includes('"type":"warning"'), 'an overflow produces a warning frame', overflowText.slice(0, 160));
  check(overflowText.includes('上下文超了'), 'the warning says what was learned', overflowText.slice(0, 300));
  check(
    overflowText.includes('"code":"generate.overflowWindow"'),
    'and carries the code the client translates',
    overflowText.slice(0, 300),
  );
  check(overflowText.includes('2048'), 'and names the window the provider reported');
  check(overflowText.includes('"type":"saved"'), 'and the turn still completes after the retry');
  eq(streamCalls - streamCallsBefore, 2, 'exactly one retry was made');
  const corrected = Number((await api('/api/config')).body.maxContext);
  check(corrected > 0 && corrected < windowBefore, 'the window is corrected downwards', `${corrected} < ${windowBefore}`);
  const learned = await api('/api/providers');
  eq(learned.body.current?.contextWindow, 2048, "the provider's own window is kept as learned");
  eq(learned.body.current?.source, 'learned', 'marked as learned rather than documented');
  check(
    ((await api(`/api/chats/${limitChat}`)).body.entries as any[]).some((entry) => entry.role === 'assistant'),
    'the retried attempt saved a reply',
  );

  // A numberless overflow keeps the warning but must not invent a window.
  await api(`/api/chats/${limitChat}`, { method: 'DELETE' });
  await api('/api/config', json('PUT', { maxContext: windowBefore }));
  const vagueChat = (await api('/api/chats', json('POST', { characterId: 'seraphina' }))).body.id as string;
  overflowOnce = 'Please reduce the length of the messages or completion';
  const vagueTurn = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: vagueChat, message: 'hello there' }),
  });
  const vagueText = await vagueTurn.text();
  check(vagueText.includes('没有可用的数字'), 'a numberless overflow says so instead of guessing', vagueText.slice(0, 300));
  eq(Number((await api('/api/config')).body.maxContext), windowBefore, 'and leaves the window alone');
  await api(`/api/chats/${vagueChat}`, { method: 'DELETE' });

  // A turn with no visible text (a reasoning model eating the budget) must not be
  // silent: nothing is saved, so without a warning the bubble just vanishes.
  const emptyTurnChat = (await api('/api/chats', json('POST', { characterId: 'seraphina' }))).body.id as string;
  const emptyBefore = ((await api(`/api/chats/${emptyTurnChat}`)).body.entries as any[]).length;
  emptyReplyOnce = true;
  const emptyTurn = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: emptyTurnChat, message: 'hello there' }),
  });
  const emptyText = await emptyTurn.text();
  check(emptyText.includes('"type":"warning"'), 'an empty reply produces a warning frame', emptyText.slice(0, 160));
  check(emptyText.includes('没有输出正文'), 'naming the likely cause', emptyText.slice(0, 300));
  check(emptyText.includes('"chars":0'), 'and the turn reports zero characters');
  const emptyEntries = (await api(`/api/chats/${emptyTurnChat}`)).body.entries as any[];
  eq(emptyEntries.length, emptyBefore + 1, 'the user turn is kept and no empty reply is saved');
  eq(emptyEntries[emptyEntries.length - 1]?.role, 'user', 'and the last entry is still the user message');
  await api(`/api/chats/${emptyTurnChat}`, { method: 'DELETE' });

  // -------------------------------------------------------------------------
  section('thinking (reasoning models)');
  // -------------------------------------------------------------------------

  // A reasoning model streams its thinking as its own channel before any text.
  check(types.includes('reasoning'), 'reasoning frames are forwarded to the client');
  const streamedThinking = events
    .filter((event) => event.type === 'reasoning')
    .map((event) => event.text)
    .join('');
  check(
    streamedThinking.includes('ZQXTHINKMARKER'),
    'the thinking is streamed as its own channel',
    streamedThinking.slice(0, 60),
  );
  eq(entries[3].reasonings?.length, 1, 'the thinking is kept on the message');
  check(
    String(entries[3].reasonings?.[0]).includes('ZQXTHINKMARKER'),
    'and it is the thinking that was streamed',
  );

  // It must never travel back to the provider: assembly reads the reply only.
  const previewWithThinking = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  check(
    !JSON.stringify(previewWithThinking.body.messages).includes('ZQXTHINKMARKER'),
    'the thinking is never sent back to the provider',
  );

  // The rest of this section needs turns of its own; it runs in a scratch chat
  // and removes it again, so the transcript-length assertions below are untouched.
  const scratch = await api('/api/chats', json('POST', { characterId: 'seraphina', name: 'thinking probe' }));
  const scratchId = scratch.body.id as string;

  // Off: neither forwarded nor stored.
  await api('/api/config', json('PUT', { showReasoning: false }));
  const quietResponse = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: scratchId, message: 'Say that again.' }),
  });
  const quietEvents = (await quietResponse.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as any);
  check(
    !quietEvents.some((event) => event.type === 'reasoning'),
    'with the setting off, no thinking is forwarded',
  );
  const quietEntries = (await api(`/api/chats/${scratchId}`)).body.entries as any[];
  const quietReply = quietEntries[quietEntries.length - 1];
  eq(quietReply.reasonings, undefined, 'and none is stored');
  check(quietReply.content.trim() === REPLY.trim(), 'the reply itself is still saved');

  // The provider is told to skip thinking, and then sends none of it.
  await api('/api/config', json('PUT', { showReasoning: true, disableThinking: true }));
  const knockedResponse = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: scratchId, message: 'And once more.' }),
  });
  const knockedEvents = (await knockedResponse.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as any);
  eq(lastProviderRequest?.reasoning_effort, 'none', 'the request asks for no reasoning effort');
  eq(lastProviderRequest?.thinking?.type, 'disabled', 'and for thinking to be disabled');
  check(
    !knockedEvents.some((event) => event.type === 'reasoning'),
    'so the provider sends no thinking',
  );
  const knockedEntries = (await api(`/api/chats/${scratchId}`)).body.entries as any[];
  eq(knockedEntries[knockedEntries.length - 1].reasonings, undefined, 'and nothing is stored for it');
  await api('/api/config', json('PUT', { disableThinking: false }));

  // A regenerated reply keeps its thinking aligned with the candidate it belongs
  // to, so swiping shows the thinking that produced the text being shown.
  const regenerateResponse = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: scratchId, regenerate: true }),
  });
  await regenerateResponse.text();
  const variantEntries = (await api(`/api/chats/${scratchId}`)).body.entries as any[];
  const withVariants = variantEntries[variantEntries.length - 1];
  check((withVariants.variants?.length ?? 0) >= 2, 'the regenerate produced a second candidate');
  eq(
    withVariants.reasonings?.length,
    withVariants.variants?.length,
    'thinking stays index-aligned with the candidates',
  );
  await api(`/api/chats/${scratchId}`, { method: 'DELETE' });

  // The provider's real prompt size is persisted as the chat's anchor, and the
  // next preview exposes it so the budget bar stops presenting a pure guess.
  const anchoredPreview = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  eq(anchoredPreview.body.pressureTokens, 100, 'the provider prompt size is anchored to the chat');
  check(typeof anchoredPreview.body.anchorAt === 'string', 'the anchor is timestamped');
  // The projection is exactly the provider figure plus the meter's movement
  // since the anchored request, so it can shrink as well as grow.
  eq(
    anchoredPreview.body.projectedTokens,
    Math.max(0, anchoredPreview.body.pressureTokens + (anchoredPreview.body.totalTokens - anchoredPreview.body.anchorHeuristicTokens)),
    'the projection is the provider anchor plus the heuristic delta',
  );
  check(
    anchoredPreview.body.projectedTokens !== anchoredPreview.body.totalTokens,
    'the displayed figure is anchored, not the raw heuristic total',
    `projected=${anchoredPreview.body.projectedTokens} heuristic=${anchoredPreview.body.totalTokens}`,
  );

  // The default model is global; the topbar switcher only pins one conversation.
  const chatPatch = await api(`/api/chats/${chatId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'another-model' }),
  });
  eq(chatPatch.body.model, 'another-model', 'the chat model override is stored');
  const overridePreview = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  eq(overridePreview.body.model, 'another-model', 'the preview uses the chat override');
  eq((await api('/api/config')).body.model, 'fake-model', 'the global default is untouched by a chat switch');

  await api(`/api/chats/${chatId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: null }),
  });
  const followPreview = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  eq(followPreview.body.model, 'fake-model', 'clearing the override follows the default again');

  // The JSONL store must be one JSON object per line.
  const jsonl = readFileSync(join(dataDir, 'chats', `${chatId}.jsonl`), 'utf8').trim().split('\n');
  eq(jsonl.length, 4, 'one JSONL line per entry');
  check(jsonl.every((line) => typeof JSON.parse(line).role === 'string'), 'every line parses');

  // -------------------------------------------------------------------------
  section('regenerate and variants');
  // -------------------------------------------------------------------------

  const regen = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, regenerate: true }),
  });
  const regenEvents = (await regen.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as any);
  check(regenEvents.some((event) => event.type === 'replaced'), 'regenerate replaces rather than appends');

  const afterRegen = await api(`/api/chats/${chatId}`);
  eq(afterRegen.body.entries.length, 4, 'regenerate does not grow the transcript');
  const last = afterRegen.body.entries[3];
  eq(last.variants.length, 2, 'two variants stored');
  eq(last.activeVariant, 1, 'the new variant is active');

  const switched = await api(`/api/chats/${chatId}/variant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryId: last.id, index: 0 }),
  });
  eq(switched.body.activeVariant, 0, 'variant switching works');

  const previewAfterSwitch = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  const historyItem = previewAfterSwitch.body.itemization.find((item: any) => item.kind === 'history');
  check(
    (historyItem?.messages?.length ?? 0) >= 3,
    'history block reports the transcript',
    String(historyItem?.messages?.length),
  );
  // The card depth prompt is injected into the request.
  check(
    JSON.stringify(previewAfterSwitch.body.messages).includes('Keep the harbour cold'),
    'the card depth prompt is injected into the request',
  );

  // -------------------------------------------------------------------------
  section('context template and regex');
  // -------------------------------------------------------------------------

  // The template is one config string; the preview renders it as a story block.
  const templateText = '{{#if description}}DESC:{{description}}{{/if}}|{{char}}';
  const templatePut = await api('/api/config', json('PUT', { contextTemplate: templateText }));
  eq(templatePut.status, 200, 'the template is stored as config');
  const templatePreview = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  const storyItem = templatePreview.body.itemization.find((item: any) => item.identifier === 'story');
  check(Boolean(storyItem), 'the preview carries a story block');
  check(String(storyItem?.content ?? '').includes('DESC:'), 'rendered, not the raw template');
  check(String(storyItem?.content ?? '').includes('Osk'), '{{char}} expanded to the card name');
  await api('/api/config', json('PUT', { contextTemplate: '' }));
  const storyOffPreview = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  eq(
    storyOffPreview.body.itemization.find((item: any) => item.identifier === 'story')?.skippedReason,
    'disabled',
    'an empty template disables the block',
  );

  // Regex: whole-file save, invalid rejected, prompt side rewrites the request.
  const emptyRegex = await api('/api/regex');
  eq(emptyRegex.status, 200, 'regex list reads');
  eq(Array.isArray(emptyRegex.body.rules), true, 'as a rule list');
  const badRegex = await api('/api/regex', json('PUT', {
    rules: [{ id: 'bad', name: '坏', pattern: '([', flags: '', replacement: '', scope: 'prompt', enabled: true }],
  }));
  eq(badRegex.status, 400, 'an uncompilable rule is refused');
  const regexPut = await api('/api/regex', json('PUT', {
    rules: [{ id: 'r1', name: '称呼', pattern: 'traveller', flags: 'gi', replacement: 'warden', scope: 'prompt', enabled: true }],
  }));
  eq(regexPut.status, 200, 'a valid rule is stored');
  const regexPreview = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  check(
    JSON.stringify(regexPreview.body.messages).toLowerCase().includes('warden'),
    'the prompt-side rewrite reaches the request',
  );
  check(
    (regexPreview.body.warnings ?? []).some(
      (w: any) => w.code === 'regex.rewroteNamed' && String(w.params?.name).includes('称呼'),
    ),
    'and the preview names the rule',
  );
  const tried = await api('/api/regex/test', json('POST', {
    pattern: 'a+', flags: 'g', replacement: 'b', text: 'caaab',
  }));
  eq(tried.body.result, 'cbb', 'trying a rule answers without storing');
  eq(tried.body.count, 1, 'with a count');
  await api('/api/regex', json('PUT', { rules: [] }));

  // -------------------------------------------------------------------------
  section('personas and fonts');
  // -------------------------------------------------------------------------

  const emptyPersonas = await api('/api/personas');
  eq(emptyPersonas.status, 200, 'persona library reads');
  eq(Array.isArray(emptyPersonas.body.items), true, 'as an item list');

  const badPersonas = await api('/api/personas', json('PUT', {
    activeId: 'ghost',
    items: [{ id: 'p1', name: '', description: 'x' }],
  }));
  eq(badPersonas.status, 400, 'a nameless preset and a dangling default are refused');

  const personaPut = await api('/api/personas', json('PUT', {
    activeId: 'p-traveller',
    items: [
      { id: 'p-traveller', name: 'ZQXPERSONA', description: 'A lantern-bearing wanderer.' },
      { id: 'p-other', name: '旁观者', description: 'Just watching.' },
    ],
  }));
  eq(personaPut.status, 200, 'two presets are stored');
  eq(personaPut.body.activeId, 'p-traveller', 'with a default');

  // The default reaches the request without touching the chat.
  const personaPreview = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  check(
    JSON.stringify(personaPreview.body.messages).includes('A lantern-bearing wanderer.'),
    'the active preset reaches the request',
  );

  // Pinning one conversation does not move the others.
  const otherChat = await api('/api/chats', json('POST', { characterId: 'seraphina' }));
  const otherId = otherChat.body.id as string;
  const pinOther = await api(`/api/chats/${otherId}`, json('PUT', { personaId: 'p-other' }));
  eq(pinOther.status, 200, 'pinning accepts an existing preset');
  eq(pinOther.body.personaId, 'p-other', 'and stores the pin');
  const pinnedPreview = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: otherId }),
  });
  check(
    JSON.stringify(pinnedPreview.body.messages).includes('Just watching.'),
    'the pinned chat speaks as its preset',
  );
  check(
    JSON.stringify((await api('/api/prompt/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId }),
    })).body.messages).includes('A lantern-bearing wanderer.'),
    'while the first chat still follows the default',
  );
  eq(
    (await api(`/api/chats/${otherId}`, json('PUT', { personaId: 'nope' }))).status,
    400,
    'pinning a missing preset is refused',
  );
  const unpin = await api(`/api/chats/${otherId}`, json('PUT', { personaId: null }));
  eq(unpin.status, 200, 'clearing follows the default again');
  eq(unpin.body.personaId, undefined, 'and the pin is gone');

  // Fonts: an empty room, an upload, a serving, a traversal refusal, a delete.
  const emptyFonts = await api('/api/fonts');
  eq(emptyFonts.status, 200, 'font list reads');
  eq(Array.isArray(emptyFonts.body.files), true, 'as a file list');
  const fontBytes = Buffer.from('wouter-face-bytes');
  const fontUp = await api('/api/fonts?name=ZQXTest.woff2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: fontBytes,
  });
  eq(fontUp.status, 200, 'a font uploads');
  check(
    (fontUp.body.files ?? []).some((file: any) => file.name === 'ZQXTest.woff2' && file.family === 'ZQXTest'),
    'and is listed with its family',
    JSON.stringify(fontUp.body.files),
  );
  const served = await api('/api/fonts/ZQXTest.woff2/file');
  eq(served.status, 200, 'the file is served back');
  eq(
    (await api('/api/fonts/..%2Fconfig.json/file')).status,
    404,
    'a traversal is not served',
  );
  eq(
    (await api('/api/fonts?name=evil.txt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fontBytes,
    })).status,
    400,
    'a non-font extension is refused',
  );
  const fontDel = await api('/api/fonts/ZQXTest.woff2', { method: 'DELETE' });
  eq(fontDel.status, 200, 'the upload is deleted again');
  eq((fontDel.body.files ?? []).length, 0, 'leaving the room empty');

  // Tidy up: the extra chat and the library would otherwise move every later
  // count and every later persona-dependent assertion.
  await api(`/api/chats/${otherId}`, { method: 'DELETE' });
  await api('/api/personas', json('PUT', { activeId: '', items: [] }));

  // -------------------------------------------------------------------------
  section('translation');
  // -------------------------------------------------------------------------

  await api('/api/config', json('PUT', { outputLanguage: '中文' }));
  // The trailing assistant reply is English (the fake provider's fixed text),
  // so it is exactly what the feature is for.
  const transcript = (await api(`/api/chats/${chatId}`)).body.entries as any[];
  const foreign = transcript.filter((entry: any) => entry.role === 'assistant').at(-1);
  const first = await api(`/api/chats/${chatId}/entries/${foreign.id}/translate`, json('POST', {}));
  eq(first.status, 200, 'a foreign message translates');
  eq(first.body.cached, false, 'the first call spends a model call');
  eq(first.body.entry.translation?.lang, '中文', 'into the reply language');
  check(String(first.body.entry.translation?.text ?? '').length > 0, 'with real text');
  const repeat = await api(`/api/chats/${chatId}/entries/${foreign.id}/translate`, json('POST', {}));
  eq(repeat.body.cached, true, 'the second call reads the cache');
  eq(
    (await api(`/api/chats/${chatId}/entries/nope/translate`, json('POST', {}))).status,
    404,
    'a missing entry is 404',
  );
  const sysEntry = await api(`/api/chats/${chatId}/message`, json('POST', { role: 'system', content: 'note' }));
  eq(
    (await api(`/api/chats/${chatId}/entries/${sysEntry.body.id}/translate`, json('POST', {}))).status,
    400,
    'a system note is refused',
  );

  // The batch endpoint: one request covers many messages, the model calls run
  // a few at a time, and the chat is written once.
  const addAssistant = async (content: string): Promise<string> =>
    (await api(`/api/chats/${chatId}/message`, json('POST', { role: 'assistant', content }))).body.id as string;
  const batchIds = [
    await addAssistant('First foreign line.'),
    await addAssistant('Second foreign line.'),
    await addAssistant('Third foreign line.'),
  ];
  const callsBefore = translationCalls;
  const batch = await api(
    `/api/chats/${chatId}/translate`,
    json('POST', { entryIds: [...batchIds, foreign.id, 'nope', sysEntry.body.id] }),
  );
  eq(batch.status, 200, 'the batch endpoint answers');
  eq(batch.body.translated.length, 3, 'and translates the three new messages');
  check(batch.body.cached.includes(foreign.id), 'an already-translated message is reported as cached');
  eq(batch.body.failed.length, 0, 'nothing failed');
  check(!batch.body.translated.includes('nope'), 'a missing entry is skipped, not failed');
  check(!batch.body.translated.includes(sysEntry.body.id), 'so is a system note');
  check(!batch.body.cached.includes('nope'), 'and a missing entry is not cached either');
  eq(translationCalls - callsBefore, 3, 'exactly one model call per new message');

  const repeatBatch = await api(`/api/chats/${chatId}/translate`, json('POST', { entryIds: batchIds }));
  eq(translationCalls - callsBefore, 3, 'a second batch reads the cache instead of the provider');
  eq(repeatBatch.body.cached.length, 3, 'and reports all three as cached');

  // A provider failure is a per-entry result; the batch as a whole still answers.
  const failId = await addAssistant('A line that cannot be translated.');
  translationFails = true;
  const failing = await api(`/api/chats/${chatId}/translate`, json('POST', { entryIds: [failId] }));
  translationFails = false;
  eq(failing.status, 200, 'a provider failure is a result, not a broken request');
  eq(failing.body.failed.length, 1, 'and is reported per entry');
  eq(failing.body.failed[0].entryId, failId, 'against the entry that failed');
  eq(failing.body.translated.length, 0, 'with nothing written for it');

  // The batch messages were scaffolding; the transcript is restored so later
  // sections see the same counts they did before.
  for (const id of [...batchIds, failId]) {
    await api(`/api/chats/${chatId}/entries/${id}`, { method: 'DELETE' });
  }

  await api('/api/config', json('PUT', { outputLanguage: '' }));
  eq(
    (await api(`/api/chats/${chatId}/entries/${foreign.id}/translate`, json('POST', {}))).status,
    400,
    'without a target language there is nothing to translate into',
  );
  // The system note was only scaffolding for the refusal above.
  await api(`/api/chats/${chatId}/entries/${sysEntry.body.id}`, { method: 'DELETE' });

  // -------------------------------------------------------------------------
  section('images');
  // -------------------------------------------------------------------------

  // A scratch chat, so the extra turns below move no other assertion.
  const imageChat = await api('/api/chats', json('POST', { characterId: 'seraphina', greeting: -1 }));
  const imageChatId = imageChat.body.id as string;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const uploaded = await api('/api/images?name=probe.png', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: png,
  });
  eq(uploaded.status, 200, 'a PNG uploads');
  eq(uploaded.body.mime, 'image/png', 'sniffed from the content');
  const imageId = uploaded.body.id as string;
  eq(
    (await api('/api/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('not an image at all'),
    })).status,
    400,
    'a text file is refused',
  );
  const servedImage = await api(`/api/images/${imageId}`);
  eq(servedImage.status, 200, 'the file is served back');
  eq((await api('/api/images/nope.png')).status, 404, 'a missing file is 404');

  const withImage = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: imageChatId, message: 'What is in this picture?', imageIds: [{ id: imageId, name: 'probe.png' }] }),
  });
  const imageEvents = (await withImage.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as any);
  check(imageEvents.some((event) => event.type === 'saved'), 'the turn with a picture lands');
  const storedTurn = (await api(`/api/chats/${imageChatId}`)).body.entries;
  eq(storedTurn.length, 2, 'one user turn plus the reply');
  eq(storedTurn[0].images?.length, 1, 'the user turn carries the reference');
  eq(storedTurn[0].images[0].name, 'probe.png', 'under its original name');
  const sentBlocks = lastProviderRequest?.messages?.at(-1)?.content;
  check(
    Array.isArray(sentBlocks) && sentBlocks.some((part: any) => part.type === 'image_url' && String(part.image_url?.url ?? '').startsWith('data:image/png;base64,')),
    'the provider got base64-inline blocks',
  );
  const imagePreview = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: imageChatId }),
  });
  eq(imagePreview.body.images?.length, 1, 'the preview names the picture without its bytes');
  eq(imagePreview.body.imageTokens, 1024, 'with the per-image estimate kept apart');
  eq(
    (await api('/api/generate', json('POST', { chatId: imageChatId, message: 'hi', imageIds: ['nope.png'] }))).status,
    400,
    'an unknown image id fails fast',
  );
  await api(`/api/chats/${imageChatId}`, { method: 'DELETE' });

  // -------------------------------------------------------------------------
  section('sprites');
  // -------------------------------------------------------------------------

  // Uploads land under the chat's character and list through the panel endpoint.
  // Seraphina came from a PNG card, so its seeded resting face is already here.
  const spriteChat = await api('/api/chats', json('POST', { characterId: 'seraphina', greeting: -1 }));
  const spriteChatId = spriteChat.body.id as string;
  const spritePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const spriteUpload = (emotion: string, body: Buffer) => api(
    `/api/chats/${spriteChatId}/sprite-files?emotion=${encodeURIComponent(emotion)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body },
  );
  const spriteUp = await spriteUpload('开心', spritePng);
  eq(spriteUp.status, 200, 'an expression image uploads');
  eq(spriteUp.body.emotion, '开心', 'under its keyword');
  const spriteState = () => api(`/api/chats/${spriteChatId}/sprite`).then((response) => response.body);
  const spriteEmotions = async () => ((await spriteState()).files as Array<{ emotion: string }>).map((file) => file.emotion);
  check((await spriteEmotions()).includes('开心'), 'and lists through the panel endpoint');
  check((await spriteEmotions()).includes('默认'), 'alongside the seeded resting face');
  eq((await api('/api/sprites/seraphina/%E5%BC%80%E5%BF%83.png')).status, 200, 'the file is served back');
  eq((await spriteUpload('开心', spritePng)).status, 200, 're-uploading the keyword replaces');
  eq((await spriteEmotions()).length, 2, 'still two files, not three');
  eq((await spriteUpload('nope', Buffer.from('not an image at all'))).status, 400, 'a text file is refused');
  eq((await spriteUpload('', spritePng)).status, 400, 'an empty keyword is refused');
  eq((await spriteUpload('../x', spritePng)).status, 400, 'a keyword that climbs out is refused');
  eq((await spriteUpload('a/b', spritePng)).status, 400, 'so is one with a separator');
  eq(
    (await api(`/api/chats/${spriteChatId}/sprite-files?file=${encodeURIComponent('开心.png')}`, { method: 'DELETE' })).status,
    200,
    'the file deletes',
  );
  eq(((await spriteState()).files as unknown[]).length, 1, 'and leaves only the resting face');
  eq((await api('/api/sprites/seraphina/%E5%BC%80%E5%BF%83.png')).status, 404, 'and the bytes are gone');
  eq(
    (await api(`/api/chats/${spriteChatId}/sprite-files?file=${encodeURIComponent('开心.png')}`, { method: 'DELETE' })).status,
    404,
    'deleting it twice is 404',
  );
  eq(
    (await api(`/api/chats/${spriteChatId}/sprite-files?file=${encodeURIComponent('../db.json')}`, { method: 'DELETE' })).status,
    404,
    'and only a listed file can go',
  );
  await api(`/api/chats/${spriteChatId}`, { method: 'DELETE' });

  // -------------------------------------------------------------------------
  section('text completion');
  // -------------------------------------------------------------------------

  // A scratch chat, so the extra turn moves no other assertion.
  const completionChat = await api('/api/chats', json('POST', { characterId: 'seraphina', greeting: -1 }));
  const completionChatId = completionChat.body.id as string;
  await api('/api/config', json('PUT', { textCompletion: true }));
  const completed = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: completionChatId, message: 'Hello there.' }),
  });
  const completedEvents = (await completed.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as any);
  check(completedEvents.some((event) => event.type === 'saved'), 'the completion turn lands');
  check(
    !completedEvents.some((event) => event.type === 'error'),
    'with no error event along the way (usage-only frames carry no choices)',
    completedEvents.filter((event) => event.type === 'error').map((event) => event.message).join(';'),
  );
  check(
    (completedEvents.filter((event) => event.type === 'delta').map((event) => event.text).join('')).includes('COMPLETED'),
    'streamed from the completions endpoint',
  );
  check(
    String(lastProviderRequest?.prompt ?? '').endsWith('Osk:\n'),
    'the flat prompt ends on the open reply line',
    String(lastProviderRequest?.prompt ?? '').slice(-40),
  );
  check(
    Array.isArray(lastProviderRequest?.stop) && (lastProviderRequest.stop as string[]).includes('\nOsk:'),
    'with the speaker stops attached',
    JSON.stringify((lastProviderRequest?.stop ?? [])),
  );
  const completionPreview = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: completionChatId }),
  });
  check(
    String(completionPreview.body.completion?.prompt ?? '').endsWith('Osk:\n'),
    'the preview shows the flat prompt that is actually sent',
  );
  await api('/api/config', json('PUT', { textCompletion: false }));
  await api(`/api/chats/${completionChatId}`, { method: 'DELETE' });

  // -------------------------------------------------------------------------
  section('speech');
  // -------------------------------------------------------------------------

  // The speech key is masked on read, like the chat key.
  await api('/api/config', json('PUT', { tts: { apiKey: 'sk-speech' } }));
  eq((await api('/api/config')).body.tts.apiKey, '***', 'the speech key is masked on read');
  // Pointed at the fake provider, which answers /audio/speech with bytes.
  await api('/api/config', json('PUT', { tts: { baseUrl: `http://127.0.0.1:${fakePort}/v1`, mode: 'online' } }));
  const spoken = await api('/api/tts/speak', json('POST', { text: '你好。' }));
  eq(spoken.status, 200, 'the proxy returns audio');
  eq(
    (await api('/api/tts/speak', json('POST', { text: '' }))).status,
    400,
    'an empty text is refused before any provider call',
  );
  eq(
    (await api('/api/tts/speak', json('POST', { text: 'x'.repeat(4001) }))).status,
    400,
    'so is a text longer than the cap',
  );
  await api('/api/config', json('PUT', { tts: { apiKey: '' } }));
  eq(
    (await api('/api/tts/speak', json('POST', { text: '你好。' }))).status,
    400,
    'without a key there is nothing to speak with',
  );
  await api('/api/config', json('PUT', { tts: { mode: 'local' } }));

  // -------------------------------------------------------------------------
  section('group chat');
  // -------------------------------------------------------------------------

  const allyImport = await api('/api/characters/import?name=ally', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spec: 'chara_card_v2',
      data: {
        name: 'Ally',
        description: 'A backup friend.',
        personality: 'Cheerful.',
        scenario: '',
        first_mes: 'Ally here.',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
      },
    }),
  });
  eq(allyImport.status, 200, 'a second character imports');

  const groupChat = await api('/api/chats', json('POST', {
    characterId: 'seraphina',
    name: 'group probe',
    greeting: -1,
    members: ['seraphina', 'ally'],
  }));
  const groupChatId = groupChat.body.id as string;
  eq(groupChat.body.members, ['seraphina', 'ally'], 'the lineup is stored in order');
  check(
    ((await api('/api/chats')).body as any[]).some(
      (chat: any) => chat.id === groupChatId && Array.isArray(chat.members) && chat.members.length === 2,
    ),
    'the chat list carries the lineup, so the client can mark a group',
  );

  eq(
    (await api(`/api/chats/${groupChatId}/members`, json('POST', { members: ['nope'] }))).status,
    404,
    'an unknown member is refused',
  );
  eq(
    (await api(`/api/chats/${groupChatId}/members`, json('POST', { members: 'seraphina' }))).status,
    400,
    'a non-array lineup is refused',
  );

  // The fake director answers with prose, never a name, so speaking falls back
  // to round-robin: the first turn goes to the first member.
  const groupTurn = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: groupChatId, message: 'Hello, everyone.' }),
  });
  await groupTurn.text();
  const groupEntries = (await api(`/api/chats/${groupChatId}`)).body.entries as any[];
  eq(groupEntries.length, 2, 'one user turn plus the reply');
  eq(groupEntries[1].speaker, 'seraphina', 'round-robin starts at the first member');
  check(
    (lastProviderRequest?.messages ?? []).every((message: any) => typeof message.content === 'string'),
    'history still travels as plain strings',
  );
  check(
    (lastProviderRequest?.messages ?? []).some((message: any) => message.role === 'user' && message.name === 'Traveller'),
    'with the speaker name attached',
    JSON.stringify((lastProviderRequest?.messages ?? []).map((message: any) => `${message.role}:${message.name ?? ''}`)),
  );

  // `@Ally` pins the turn; regenerating keeps the pin instead of re-picking.
  const forced = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: groupChatId, message: 'Your turn, Ally.', speaker: 'ally' }),
  });
  await forced.text();
  const forcedEntries = (await api(`/api/chats/${groupChatId}`)).body.entries as any[];
  eq(forcedEntries.at(-1).speaker, 'ally', 'a pinned speaker answers');
  const reRolled = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: groupChatId, regenerate: true }),
  });
  await reRolled.text();
  const reRolledEntries = (await api(`/api/chats/${groupChatId}`)).body.entries as any[];
  eq(reRolledEntries.at(-1).speaker, 'ally', 'regenerating keeps the speaker');
  check(
    (lastProviderRequest?.messages ?? []).some((message: any) => message.role === 'assistant' && typeof message.name === 'string' && message.name !== ''),
    'and the next request names the assistant turns',
  );
  const groupTrace = await api(`/api/chats/${groupChatId}/trace`);
  check(
    groupTrace.body.events.some((event: any) => event.type === 'turn' && event.speaker === 'ally'),
    'the trajectory names who answered',
  );

  // --- per-member connections -----------------------------------------------
  // A group member may answer through its own endpoint: different provider,
  // different model, different key. Everyone else follows the chat.
  const savedConnections = await api('/api/connections', json('PUT', {
    version: 1,
    items: [
      { id: 'ally-conn', label: 'Ally line', baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: 'member-key', model: 'ally-model' },
    ],
  }));
  eq(savedConnections.status, 200, 'extra connections save');
  eq(savedConnections.body.items[0].apiKey, '***', 'the key comes back masked');
  eq((await api('/api/connections')).body.items.length, 1, 'and they read back');
  eq(
    (await api('/api/connections', json('PUT', { version: 1, items: [{ id: 'bad', label: 'Bad', baseUrl: 'https://x.invalid/v1', model: '' }] }))).status,
    400,
    'a connection without a model is refused',
  );

  await api(`/api/chats/${groupChatId}/members`, json('POST', {
    members: ['seraphina', 'ally'],
    memberConnections: { ally: 'ally-conn' },
  }));
  eq(
    ((await api(`/api/chats/${groupChatId}`)).body.meta.memberConnections as any).ally,
    'ally-conn',
    'a member keeps its own connection',
  );
  eq(
    (await api(`/api/chats/${groupChatId}/members`, json('POST', {
      members: ['seraphina', 'ally'],
      memberConnections: { ally: 'nope' },
    }))).status,
    400,
    'a connection that does not exist is refused',
  );

  // A turn pinned to Ally goes out on Ally's endpoint, model and key...
  const memberTurn = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: groupChatId, message: 'Ally, your line.', speaker: 'ally' }),
  });
  await memberTurn.text();
  eq(lastProviderRequest?.model, 'ally-model', "the member's model reaches the provider");
  check(lastProviderAuth.includes('member-key'), "and so does the member's key", lastProviderAuth);
  // ...while the host still speaks through the chat's own endpoint.
  const hostTurn = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: groupChatId, message: 'Host, your line.', speaker: 'seraphina' }),
  });
  await hostTurn.text();
  check(lastProviderRequest?.model !== 'ally-model', 'the host is not routed through it', String(lastProviderRequest?.model));
  check(!lastProviderAuth.includes('member-key'), 'nor with the member key', lastProviderAuth);

  // A masked key on save keeps the stored one rather than writing the mask.
  await api('/api/connections', json('PUT', {
    version: 1,
    items: [{ id: 'ally-conn', label: 'Ally line', baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: '***', model: 'ally-model' }],
  }));
  const maskedTurn = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: groupChatId, message: 'Ally again.', speaker: 'ally' }),
  });
  await maskedTurn.text();
  eq(lastProviderRequest?.model, 'ally-model', 'the connection still routes after a masked save');
  check(lastProviderAuth.includes('member-key'), 'and still holds the original key', lastProviderAuth);

  await api('/api/connections', json('PUT', { version: 1, items: [] }));
  eq((await api('/api/connections')).body.items.length, 0, 'connections clear again');

  // How many members answer one message: 1 is the default, 0 means everyone.
  await api(`/api/chats/${groupChatId}/members`, json('POST', {
    members: ['seraphina', 'ally'],
    groupReplyLimit: 0,
  }));
  eq(
    ((await api(`/api/chats/${groupChatId}`)).body.meta as any).groupReplyLimit,
    0,
    'a group may answer with everyone in turn',
  );
  await api(`/api/chats/${groupChatId}/members`, json('POST', {
    members: ['seraphina', 'ally'],
    groupReplyLimit: 1,
  }));
  eq(
    ((await api(`/api/chats/${groupChatId}`)).body.meta as any).groupReplyLimit,
    undefined,
    'and going back to one stores nothing',
  );
  eq(
    (await api(`/api/chats/${groupChatId}/members`, json('POST', {
      members: ['seraphina', 'ally'],
      groupReplyLimit: -1,
    }))).status,
    400,
    'a negative reply count is refused',
  );

  // --- group speaker modes --------------------------------------------------
  // How a group picks who answers. `round` is what every group did before the
  // mode existed; the rest are SillyTavern's reply strategies.

  /** Every frame of one generate call on the group chat. */
  async function groupFrames(message: string): Promise<any[]> {
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: groupChatId, message }),
    });
    const text = await response.text();
    return text
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)) as any);
  }
  const frameOf = (frames: any[], type: string) => frames.find((event) => event.type === type);
  const speakersIn = async (): Promise<string[]> =>
    ((await api(`/api/chats/${groupChatId}`)).body.entries as any[])
      .map((entry) => entry.speaker)
      .filter((speaker) => typeof speaker === 'string' && speaker !== '');

  eq(
    ((await api(`/api/chats/${groupChatId}/members`, json('POST', {
      members: ['seraphina', 'ally'],
      groupMode: 'natural',
    }))).body as any).groupMode,
    'natural',
    'a group may pick its speakers by talkativeness',
  );
  eq(
    ((await api(`/api/chats/${groupChatId}/members`, json('POST', {
      members: ['seraphina', 'ally'],
      groupMode: 'round',
    }))).body as any).groupMode,
    undefined,
    'and going back to round stores nothing',
  );
  eq(
    (await api(`/api/chats/${groupChatId}/members`, json('POST', {
      members: ['seraphina', 'ally'],
      groupMode: 'telepathy',
    }))).status,
    400,
    'an unknown group mode is refused',
  );
  eq(
    ((await api(`/api/chats/${groupChatId}`, json('PUT', { groupMode: 'pooled' }))).body as any).groupMode,
    'pooled',
    'the mode can also be pinned on the chat',
  );
  eq(
    ((await api(`/api/chats/${groupChatId}`, json('PUT', { groupMode: null }))).body as any).groupMode,
    undefined,
    'and cleared again',
  );

  // Talkativeness is a preference about the character, not card data: it lives
  // in the character's sidecar and defaults to an even 50.
  eq(
    ((await api('/api/characters/seraphina')).body as any).talkativeness,
    50,
    'a card that never mentions talkativeness reads as the even default',
  );
  eq((await api('/api/characters/seraphina', json('PATCH', { talkativeness: 150 }))).status, 400, 'out-of-range talkativeness is refused');
  eq((await api('/api/characters/seraphina', json('PATCH', { talkativeness: 'chatty' }))).status, 400, 'and so is a non-number');
  eq(
    ((await api('/api/characters/seraphina', json('PATCH', { talkativeness: 100 }))).body as any).talkativeness,
    100,
    'a chatty character saves',
  );
  eq(
    ((await api('/api/characters/seraphina', json('PATCH', { talkativeness: null }))).body as any).talkativeness,
    50,
    'and clearing it follows the card again',
  );
  check(
    ((await api('/api/characters')).body as any[]).some((card: any) => card.id === 'ally' && typeof card.talkativeness === 'number'),
    'the character list carries talkativeness, so the group picker can show it',
  );

  // `list`: everyone, in lineup order. The plan rides the prompt frame so the
  // client knows whom to chain; the first name is the one answering now.
  await api(`/api/chats/${groupChatId}/members`, json('POST', {
    members: ['seraphina', 'ally'],
    groupMode: 'list',
    groupReplyLimit: 0,
  }));
  const listFrames = await groupFrames('Everyone, say hello.');
  eq(frameOf(listFrames, 'prompt').groupPlan, ['seraphina', 'ally'], 'list mode plans the whole lineup, in order');
  eq((await speakersIn()).at(-1), 'seraphina', 'and the first name on the plan answers now');

  // `natural`: a 100 talks over a 0, whatever the roll order is.
  await api(`/api/chats/${groupChatId}/members`, json('POST', {
    members: ['seraphina', 'ally'],
    groupMode: 'natural',
    groupReplyLimit: 1,
  }));
  await api('/api/characters/seraphina', json('PATCH', { talkativeness: 100 }));
  await api('/api/characters/ally', json('PATCH', { talkativeness: 0 }));
  const naturalFrames = await groupFrames('Who is around?');
  eq(frameOf(naturalFrames, 'prompt').groupPlan, ['seraphina'], 'a chatty member is the one who speaks up');
  eq((await speakersIn()).at(-1), 'seraphina', 'and answers the turn');

  // `manual`: only a name brings an answer; a message that names nobody is the
  // user's alone.
  await api(`/api/chats/${groupChatId}/members`, json('POST', {
    members: ['seraphina', 'ally'],
    groupMode: 'manual',
  }));
  const beforeManual = ((await api(`/api/chats/${groupChatId}`)).body.entries as any[]).length;
  const silentFrames = await groupFrames('Nobody is called on here.');
  eq(frameOf(silentFrames, 'warning')?.code, 'generate.noGroupSpeaker', 'manual mode without a name answers nobody');
  eq(frameOf(silentFrames, 'prompt'), undefined, 'and never reaches the model');
  eq(
    ((await api(`/api/chats/${groupChatId}`)).body.entries as any[]).length,
    beforeManual + 1,
    'only the user turn lands',
  );
  const calledFrames = await groupFrames('Ally, your line now.');
  eq(frameOf(calledFrames, 'prompt').groupPlan, ['ally'], 'a named member is the whole plan in manual mode');
  eq((await speakersIn()).at(-1), 'ally', 'and answers');

  // Back to the defaults these chats had before modes existed: round, one
  // reply, and no talkativeness of our own.
  await api(`/api/chats/${groupChatId}/members`, json('POST', { members: ['seraphina', 'ally'], groupMode: 'round' }));
  await api('/api/characters/seraphina', json('PATCH', { talkativeness: null }));
  await api('/api/characters/ally', json('PATCH', { talkativeness: null }));

  // Clearing the lineup returns the chat to solo without touching the transcript.
  const entriesBeforeUngroup = ((await api(`/api/chats/${groupChatId}`)).body.entries as any[]).length;
  const ungrouped = await api(`/api/chats/${groupChatId}/members`, json('POST', { members: [] }));
  eq(ungrouped.status, 200, 'the lineup clears');
  eq(
    ((await api(`/api/chats/${groupChatId}`)).body.entries as any[]).length,
    entriesBeforeUngroup,
    'nothing was deleted',
  );
  await api(`/api/chats/${groupChatId}`, { method: 'DELETE' });
  eq((await api('/api/characters/ally', { method: 'DELETE' })).status, 200, 'the spare character goes too');

  // -------------------------------------------------------------------------
  section('chat sampler');
  // -------------------------------------------------------------------------

  // New chats snapshot the sampler defaults; the snapshot rides every turn.
  await api('/api/config', json('PUT', { temperature: 0.7, frequencyPenalty: 0.3, presencePenalty: -0.2 }));
  const samplerChat = await api('/api/chats', json('POST', { characterId: 'seraphina', greeting: -1 }));
  const samplerChatId = samplerChat.body.id as string;
  const snapshot = (await api(`/api/chats/${samplerChatId}`)).body.meta.params;
  eq(snapshot.temperature, 0.7, 'a new chat snapshots the temperature default');
  eq(snapshot.frequencyPenalty, 0.3, 'and the frequency penalty');
  eq(snapshot.presencePenalty, -0.2, 'and the presence penalty');
  const samplerTurn = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: samplerChatId, message: 'Surprise me.' }),
  });
  await samplerTurn.text();
  eq(lastProviderRequest?.temperature, 0.7, 'the snapshot reaches the provider');
  eq(lastProviderRequest?.frequency_penalty, 0.3, 'as does the frequency penalty');
  eq(lastProviderRequest?.presence_penalty, -0.2, 'and the presence penalty');
  // A later default change does not move a snapshotted chat.
  await api('/api/config', json('PUT', { temperature: 1.4 }));
  eq(
    ((await api(`/api/chats/${samplerChatId}`)).body.meta.params as Record<string, number>).temperature,
    0.7,
    'later default changes do not move a snapshot',
  );
  // The panel writes per-key overrides; the merge keeps the other keys.
  const pinned = await api(`/api/chats/${samplerChatId}`, json('PUT', { params: { temperature: 1.5 } }));
  eq(pinned.status, 200, 'one knob overrides');
  eq(pinned.body.params.temperature, 1.5, 'with the new value');
  eq(pinned.body.params.frequencyPenalty, 0.3, 'and the other keys kept');
  const pinnedTurn = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: samplerChatId, message: 'Again.' }),
  });
  await pinnedTurn.text();
  eq(lastProviderRequest?.temperature, 1.5, 'the override reaches the provider');
  // `null` drops the snapshot: the chat follows the live defaults again.
  const followed = await api(`/api/chats/${samplerChatId}`, json('PUT', { params: null }));
  eq(followed.status, 200, 'resetting follows the defaults');
  eq(followed.body.params, undefined, 'with the snapshot gone');
  const followedTurn = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: samplerChatId, message: 'Once more.' }),
  });
  await followedTurn.text();
  eq(lastProviderRequest?.temperature, 1.4, 'a following chat tracks the live default');
  // Refusals name the knob.
  for (const [params, label] of [
    [{ temperature: 5 }, '温度'],
    [{ topP: 0 }, 'Top P'],
    [{ frequencyPenalty: 3 }, '频率惩罚'],
    [{ presencePenalty: -3 }, '存在惩罚'],
    [{ temperature: 'hot' }, '温度'],
    [{ nope: 1 }, 'unknown sampler knob'],
    ['warm', 'params must be an object'],
  ] as Array<[unknown, string]>) {
    const refused = await api(`/api/chats/${samplerChatId}`, json('PUT', { params }));
    eq(refused.status, 400, `out-of-range params are refused (${label})`);
    check(String((refused.body as any)?.error ?? '').includes(label), 'naming the knob', String((refused.body as any)?.error));
  }
  // A user-facing rejection also carries the code the client translates.
  const outOfRange = await api(`/api/chats/${samplerChatId}`, json('PUT', { params: { temperature: 5 } }));
  eq((outOfRange.body as any)?.code, 'chats.param.temperature.range', 'an out-of-range param carries a translation code');
  eq((outOfRange.body as any)?.params?.max, 2, 'with the values the sentence needs');
  const notNumber = await api(`/api/chats/${samplerChatId}`, json('PUT', { params: { topP: 'hot' } }));
  eq((notNumber.body as any)?.code, 'chats.param.topP.notNumber', 'and a bad type does too');
  await api('/api/config', json('PUT', { temperature: 1, frequencyPenalty: 0, presencePenalty: 0 }));
  await api(`/api/chats/${samplerChatId}`, { method: 'DELETE' });

  // -------------------------------------------------------------------------
  section('sprite seeding');
  // -------------------------------------------------------------------------

  // A PNG card plants its own artwork as the resting face on import.
  const seedCard = await api('/api/characters/import?name=seed-probe', {
    method: 'POST',
    body: readFileSync(join(corpus, 'owned', 'cards', 'osk.png')),
  });
  eq(seedCard.status, 200, 'a PNG card imports');
  const seedChat = await api('/api/chats', json('POST', { characterId: 'seed-probe', greeting: -1 }));
  const seedChatId = seedChat.body.id as string;
  const seeded = (await api(`/api/chats/${seedChatId}/sprite`)).body;
  check(
    (seeded.files as Array<{ emotion: string }>).some((file) => file.emotion === '默认'),
    'the carrier art lists as the resting face',
    JSON.stringify((seeded.files as Array<{ emotion: string }>).map((file) => file.emotion)),
  );
  const seededBytes = Buffer.from(await (await fetch(`${base}/api/sprites/seed-probe/%E9%BB%98%E8%AE%A4.png`)).arrayBuffer());
  check(
    seededBytes.equals(readFileSync(join(corpus, 'owned', 'cards', 'osk.png'))),
    'with the carrier bytes behind it',
    `${seededBytes.length} bytes`,
  );
  // A resting face that is already there is never overwritten, not even by a
  // re-import: replace it, import again, and the replacement stands.
  const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  eq(
    (await api(`/api/chats/${seedChatId}/sprite-files?emotion=${encodeURIComponent('默认')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: tinyPng,
    })).status,
    200,
    'the resting face is replaceable through the panel',
  );
  eq(
    (await api('/api/characters/import?name=seed-probe', {
      method: 'POST',
      body: readFileSync(join(corpus, 'owned', 'cards', 'osk.png')),
    })).status,
    200,
    're-importing works',
  );
  const keptBytes = Buffer.from(await (await fetch(`${base}/api/sprites/seed-probe/%E9%BB%98%E8%AE%A4.png`)).arrayBuffer());
  check(keptBytes.equals(tinyPng), 'and keeps the replacement, not the carrier');
  // A JSON card has no artwork to plant.
  eq(
    (await api('/api/characters/import?name=seed-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: readFileSync(join(corpus, 'owned', 'edge', 'flat-card.json')),
    })).status,
    200,
    'a JSON card imports',
  );
  const seedJsonChat = await api('/api/chats', json('POST', { characterId: 'seed-json', greeting: -1 }));
  eq(
    ((await api(`/api/chats/${seedJsonChat.body.id as string}/sprite`)).body.files as unknown[]).length,
    0,
    'with nothing seeded',
  );
  await api(`/api/chats/${seedChatId}`, { method: 'DELETE' });
  await api(`/api/chats/${seedJsonChat.body.id as string}`, { method: 'DELETE' });
  await api('/api/characters/seed-probe?cascade=true', { method: 'DELETE' });
  await api('/api/characters/seed-json?cascade=true', { method: 'DELETE' });

  section('continue and impersonate');
  // -------------------------------------------------------------------------

  const continued = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, mode: 'continue' }),
  });
  const continuedEvents = (await continued.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as any);
  check(continuedEvents.some((event) => event.type === 'continued'), 'continue grows the same reply');
  const afterContinue = await api(`/api/chats/${chatId}`);
  eq(afterContinue.body.entries.length, 4, 'continue does not grow the transcript');
  const continuedLast = afterContinue.body.entries[3];
  eq(continuedLast.variants.length, 2, 'continue does not add a variant either');
  eq(continuedLast.activeVariant, 0, 'the active candidate stays put');
  check(
    (String(continuedLast.variants[0]).match(/counsel\./g) ?? []).length >= 2,
    'the continuation was appended to the active candidate',
  );

  const impersonated = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, mode: 'impersonate' }),
  });
  const impersonatedEvents = (await impersonated.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as any);
  check(impersonatedEvents.some((event) => event.type === 'impersonated'), 'impersonate saves its own event');
  const afterImpersonation = await api(`/api/chats/${chatId}`);
  eq(afterImpersonation.body.entries.length, 5, 'impersonate appends one message');
  const impersonatedLast = afterImpersonation.body.entries[4];
  eq(impersonatedLast.role, 'user', 'spoken as the user, not as a reply');
  check(
    String(impersonatedLast.content).includes(REPLY.slice(0, 20)),
    'carrying what the model wrote',
  );
  check(
    JSON.stringify(lastProviderRequest?.messages ?? []).includes('the player'),
    'the impersonation instruction reached the provider',
  );
  // It has to be the *last* message, and a *user* one: before the history the
  // model just continues the character's narration, and a trailing *system*
  // note is read as background so it keeps answering as the character too.
  const sentMessages = (lastProviderRequest?.messages ?? []) as { role: string; content: string }[];
  check(
    sentMessages.length > 0
      && sentMessages[sentMessages.length - 1]!.role === 'user'
      && String(sentMessages[sentMessages.length - 1]!.content).includes('the player'),
    'and it is the trailing user message, not one buried in the system prompt',
    JSON.stringify(sentMessages.slice(-3).map((message) => [message.role, String(message.content).slice(0, 24)])),
  );

  // A mode is its own path, not a modifier on a send.
  eq(
    (await api('/api/generate', json('POST', { chatId, mode: 'continue', message: 'hi' }))).status,
    400,
    'a mode cannot be combined with a message',
  );
  // The impersonation above left a user turn trailing, so there is nothing to continue.
  eq(
    (await api('/api/generate', json('POST', { chatId, mode: 'continue' }))).status,
    400,
    'continuing a user turn is refused',
  );

  // -------------------------------------------------------------------------
  section('multi-turn conversation');
  // -------------------------------------------------------------------------

  // Ten more turns: proves the transcript keeps growing, the scan keeps running
  // on the accumulated history, and nothing degrades over repeated generations.
  // The first turn mentions the harbourmaster; the last mentions the district, so
  // the same run also shows the scan window moving.
  const turns = [
    'I ask the harbourmaster about the tide.',
    'Do the wardens patrol at night?',
    'I wait by the sea wall.',
    'What does the tide bell mean?',
    'I rest for a while.',
    'Is the harbour still safe?',
    'I draw my lantern closer.',
    'I ask about the Lantern District by the river.',
  ];

  for (const turn of turns) {
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, message: turn }),
    });
    const frames = (await response.text())
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)) as any);
    const saved = frames.find((event) => event.type === 'saved');
    if (!saved) {
      check(false, `turn "${turn}" produced a reply`, JSON.stringify(frames.map((f) => f.type)));
      break;
    }
  }

  const longChat = await api(`/api/chats/${chatId}`);
  eq(longChat.body.entries.length, 5 + turns.length * 2, 'transcript grew by two entries per turn');
  check(
    longChat.body.entries.every((entry: any) => entry.content.trim().length > 0),
    'no empty entries in the transcript',
  );

  const longPreview = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  const longHits = longPreview.body.itemization
    .flatMap((item: any) => item.worldHits ?? []);
  console.log(`  after ${turns.length + 2} turns: ${longChat.body.entries.length} entries, ` +
    `${longPreview.body.totalTokens} tokens, ${longHits.length} world hit(s), depth=${longPreview.body.budget}`);
  check(longHits.length > 0, 'the world book still fires after many turns');
  check(longPreview.body.totalTokens > 0, 'token accounting still works after many turns');
  check(longPreview.body.trimmed >= 0, 'trimming is reported after many turns');

  // Depth-limited scanning: a key from the first turn must fall out of the window
  // while the newest turn still fires.
  const historyOnly = turns.join(' ');
  check(historyOnly.includes('harbourmaster'), 'test fixture sanity');
  const deepPreview = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, pendingUserMessage: 'And now something unrelated.' }),
  });
  const deepHits = deepPreview.body.itemization.flatMap((item: any) => item.worldHits ?? []);
  const hitSummary = deepHits.map((hit: any) => `${hit.comment}/${hit.activatedBy}`).join(', ') || 'none';
  console.log(`  after ${turns.length} turns: ${deepHits.length} hit(s): ${hitSummary}`);
  // Certain: the district key is two messages back, so it is out of the window.
  check(
    !deepHits.some((hit: any) => hit.comment === 'Lantern District'),
    'a key from earlier has left the scan window',
    hitSummary,
  );
  // Uncertain, so reported rather than asserted: the fixture's harbourmaster has
  // `sticky: 3`, and ST only arms a timed effect that is not already present, so
  // it must have expired and gone quiet by now.
  check(
    !deepHits.some((hit: any) => hit.comment === 'The Harbourmaster'),
    'an expired sticky entry stops firing',
    hitSummary,
  );

  // And the cooldown that follows a sticky window must not keep it suppressed
  // forever either: mentioning the harbourmaster again brings it back.
  const revived = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, pendingUserMessage: 'I ask the harbourmaster about the tide.' }),
  });
  const revivedHits = revived.body.itemization.flatMap((item: any) => item.worldHits ?? []);
  console.log(`  after mentioning the harbourmaster again: ${revivedHits.map((hit: any) => `${hit.comment}/${hit.activatedBy}`).join(', ') || 'none'}`);
  check(
    revivedHits.some((hit: any) => hit.comment === 'The Harbourmaster'),
    'the entry can fire again once its cooldown has passed',
  );

  // -------------------------------------------------------------------------
  section('message-level operations');
  // -------------------------------------------------------------------------

  // The transcript holds an assistant turn with two swipe variants (created by
  // the regenerate section). Find it explicitly: many turns were added since.
  const beforeOps = (await api(`/api/chats/${chatId}`)).body.entries as any[];
  const multiVariant = beforeOps.find(
    (entry) => entry.role === 'assistant' && Array.isArray(entry.variants) && entry.variants.length === 2,
  );
  check(multiVariant !== undefined, 'the transcript still holds a reply with two variants');
  if (!multiVariant) throw new Error('fixture drift: no two-variant reply to test with');

  // Editing a reply must touch only the active variant.
  await api(`/api/chats/${chatId}/variant`, json('POST', { entryId: multiVariant.id, index: 1 }));
  const editedVariant = await api(
    `/api/chats/${chatId}/entries/${multiVariant.id}`,
    json('PATCH', { content: 'edited the active variant' }),
  );
  eq(editedVariant.status, 200, 'a reply can be edited');
  const afterVariantEdit = (await api(`/api/chats/${chatId}`)).body.entries as any[];
  const editedEntry = afterVariantEdit.find((entry) => entry.id === multiVariant.id);
  eq(editedEntry.variants[editedEntry.activeVariant], 'edited the active variant', 'the active variant changed');
  eq(editedEntry.variants[0], multiVariant.variants[0], 'the other variant is untouched');
  eq(editedEntry.content, multiVariant.content, 'content is untouched when variant 0 is not active');

  // Switching to variant 0 and editing it must keep content in sync, because
  // that is what `regenerate` treats as the original.
  await api(`/api/chats/${chatId}/variant`, json('POST', { entryId: multiVariant.id, index: 0 }));
  await api(`/api/chats/${chatId}/entries/${multiVariant.id}`, json('PATCH', { content: 'edited variant zero' }));
  const afterZero = (await api(`/api/chats/${chatId}`)).body.entries as any[];
  const zeroEntry = afterZero.find((entry) => entry.id === multiVariant.id);
  eq(zeroEntry.variants[0], 'edited variant zero', 'variant 0 was updated');
  eq(zeroEntry.content, 'edited variant zero', 'content follows variant 0');

  // A plain user message edits by simply replacing its content.
  const firstUser = afterZero.find((entry) => entry.role === 'user');
  eq((await api(`/api/chats/${chatId}/entries/${firstUser.id}`, json('PATCH', { content: '   ' }))).status, 400,
    'an empty edit is rejected');
  eq((await api(`/api/chats/${chatId}/entries/${firstUser.id}`, json('PATCH', { content: 'rewritten user turn' }))).status, 200,
    'a user turn can be edited');
  eq(
    (await api(`/api/chats/${chatId}`)).body.entries.find((entry: any) => entry.id === firstUser.id).content,
    'rewritten user turn',
    'the user turn edit persisted',
  );
  eq((await api(`/api/chats/${chatId}/entries/nope`, json('PATCH', { content: 'x' }))).status, 404,
    'editing a missing message is a 404');

  const previewAfterEdit = await api('/api/prompt/preview', json('POST', { chatId }));
  check(
    JSON.stringify(previewAfterEdit.body.messages).includes('rewritten user turn'),
    'the edit reaches the assembled request',
  );

  // Deleting one message must keep the rest and re-parent its child.
  const beforeDelete = (await api(`/api/chats/${chatId}`)).body.entries as any[];
  const victimIndex = beforeDelete.findIndex((entry) => entry.role === 'assistant');
  const victim = beforeDelete[victimIndex];
  const child = beforeDelete[victimIndex + 1];
  const deleted = await api(`/api/chats/${chatId}/entries/${victim.id}`, { method: 'DELETE' });
  eq(deleted.status, 200, 'a single message can be deleted');
  eq(deleted.body.reparented, 1, 'its child was re-parented');
  const afterDelete = (await api(`/api/chats/${chatId}`)).body.entries as any[];
  eq(afterDelete.length, beforeDelete.length - 1, 'exactly one entry went away');
  check(!afterDelete.some((entry) => entry.id === victim.id), 'the deleted entry is gone');
  eq(
    afterDelete.find((entry) => entry.id === child.id)?.parentId,
    victim.parentId,
    'the child now points at the deleted entry\u2019s parent',
  );
  eq((await api(`/api/chats/${chatId}/entries/${victim.id}`, { method: 'DELETE' })).status, 404,
    'deleting a missing message is a 404');
  eq((await api('/api/prompt/preview', json('POST', { chatId }))).status, 200, 'the chat still assembles after a delete');

  // Retry from a message: the reply is dropped with everything after it, and a
  // fresh answer is generated.
  const beforeRetry = (await api(`/api/chats/${chatId}`)).body.entries as any[];
  const retryTarget = [...beforeRetry].reverse().find((entry) => entry.role === 'assistant');
  const retryResponse = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, retryEntryId: retryTarget.id }),
  });
  const retryEvents = (await retryResponse.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as any);
  check(retryEvents.some((event) => event.type === 'truncated'), 'a retry reports that it rewound the chat');
  const retried = retryEvents.find((event) => event.type === 'saved');
  check(retried !== undefined, 'the retry produced a saved reply');
  const afterRetry = (await api(`/api/chats/${chatId}`)).body.entries as any[];
  check(!afterRetry.some((entry) => entry.id === retryTarget.id), 'the retried reply was replaced');
  check(afterRetry.length > 0, 'the transcript survived the retry');
  eq(
    (await api('/api/generate', json('POST', { chatId, retryEntryId: 'nope' }))).status,
    400,
    'retrying from a missing message is rejected',
  );

  // -------------------------------------------------------------------------
  section('connection test');
  // -------------------------------------------------------------------------

  const connection = await api('/api/config/test', { method: 'POST' });
  eq(connection.status, 200, 'the connection test answers 200 even when it fails');
  eq(connection.body.ok, true, 'the test reaches the configured provider');
  eq(connection.body.modelCount, 2, 'it reports how many models the provider offers');
  eq(connection.body.modelKnown, true, 'it says whether the configured model is among them');
  check(typeof connection.body.elapsedMs === 'number', 'it reports how long it took');

  await api('/api/config', json('PUT', { baseUrl: 'http://127.0.0.1:1/v1' }));
  const failedConnection = await api('/api/config/test', { method: 'POST' });
  eq(failedConnection.status, 200, 'a failed connection is still a 200');
  eq(failedConnection.body.ok, false, 'the failure is reported as ok:false');
  check(String(failedConnection.body.error).length > 0, 'the provider error is passed through');
  await api('/api/config', json('PUT', { baseUrl: `http://127.0.0.1:${fakePort}` }));
  eq((await api('/api/config/test', { method: 'POST' })).body.ok, true, 'the connection recovers');

  // -------------------------------------------------------------------------
  section('restart durability');
  // -------------------------------------------------------------------------

  const entriesBefore = (await api(`/api/chats/${chatId}`)).body.entries.length;
  await app.close();
  app = createTeahouseServer({ dataDir, port: 0, host: '127.0.0.1' });
  base = await app.listen();
  console.log(`  restarted on ${base}`);

  const chatsAfter = await api('/api/chats');
  eq(chatsAfter.body.length, 1, 'chat survived the restart');
  const chatAfter = await api(`/api/chats/${chatId}`);
  eq(chatAfter.body.entries.length, entriesBefore, 'transcript survived the restart');
  eq(chatAfter.body.meta.worldRefs, ['eldoria'], 'world attachment survived the restart');
  eq((await api('/api/worlds')).body.length, 2, 'worlds survived the restart');
  eq((await api('/api/characters')).body.length, 1, 'characters survived the restart');
  eq((await api('/api/config')).body.model, 'fake-model', 'config survived the restart');

  const afterRestartPreview = await api('/api/prompt/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  });
  eq(afterRestartPreview.status, 200, 'generation path still works after a restart');

  // -------------------------------------------------------------------------
  section('wrong-document rejection');
  // -------------------------------------------------------------------------

  // A character card is not a world book. It used to be accepted, saved, and
  // attached while yielding zero entries: an empty book that never fires and
  // silently displaced the books the chat already had.
  const cardJson = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    name: 'Not A World',
    first_mes: 'hello',
    data: {
      name: 'Not A World',
      first_mes: 'hello',
      character_book: { entries: [{ keys: ['x'], content: 'y' }], extensions: {} },
    },
  };
  const cardAsWorld = await api('/api/worlds/import?name=card-as-world', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(cardJson)),
  });
  eq(cardAsWorld.status, 400, 'a character card is rejected by the world importer');
  check(
    String(cardAsWorld.body.error).includes('character card'),
    'the rejection says it is a character card',
    String(cardAsWorld.body.error),
  );

  const emptyWorld = await api('/api/worlds/import?name=empty-world', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify({ entries: {} })),
  });
  eq(emptyWorld.status, 400, 'a world with zero entries is rejected');
  check(
    String(emptyWorld.body.error).includes('no entries'),
    'the rejection explains that no entries were found',
    String(emptyWorld.body.error),
  );

  const cardsArray = await api('/api/worlds/import?name=cards-array', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify([{ spec: 'chara_card_v2', name: 'A', first_mes: 'hi' }])),
  });
  eq(cardsArray.status, 400, 'an array of cards is rejected by the world importer');
  eq((await api('/api/worlds')).body.filter((entry: any) => !entry.error).length, 2,
    'none of the rejected documents created a world');

  // The same card must still import fine as a character, book and all.
  const cardAsCharacter = await api('/api/characters/import?name=not-a-world', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(cardJson)),
  });
  eq(cardAsCharacter.status, 200, 'the same document imports as a character');
  eq(cardAsCharacter.body.books?.[0]?.entries, 1, 'its embedded book comes along');

  // A file placed on disk by hand that cannot be parsed must be reported, not
  // silently listed as an empty book.
  writeFileSync(join(dataDir, 'worlds', 'hand-made-broken.json'), '{"hello":"world"}');
  const withBroken = await api('/api/worlds');
  const brokenEntry = withBroken.body.find((entry: any) => entry.id === 'hand-made-broken');
  check(brokenEntry !== undefined, 'an unparseable file on disk is still listed');
  check(
    typeof brokenEntry?.error === 'string' && brokenEntry.error !== '',
    'the unparseable file reports an error',
    String(brokenEntry?.error),
  );
  eq((await api('/api/worlds/hand-made-broken')).status, 500, 'loading the unparseable file fails loudly');

  // -------------------------------------------------------------------------
  section('world attachment is server-side');
  // -------------------------------------------------------------------------

  // Attaching B while A is attached must keep A, even if the client's view is stale.
  await api(`/api/chats/${chatId}/worlds`, json('POST', { worldId: 'eldenring', attached: true }));
  const afterFirstAttach = await api(`/api/chats/${chatId}`);
  check(afterFirstAttach.body.meta.worldRefs.includes('eldenring'), 'first world attached');

  await api(`/api/chats/${chatId}/worlds`, json('POST', { worldId: 'eldoria', attached: true }));
  const afterSecondAttach = await api(`/api/chats/${chatId}`);
  // Sorted: "eldenring" precedes "eldoria" ("e" < "o" at the fourth character).
  eq([...afterSecondAttach.body.meta.worldRefs].sort(), ['eldenring', 'eldoria'],
    'attaching a second world keeps the first');

  await api(`/api/chats/${chatId}/worlds`, json('POST', { worldId: 'eldoria', attached: false }));
  const afterDetach = await api(`/api/chats/${chatId}`);
  eq(afterDetach.body.meta.worldRefs, ['eldenring'], 'detaching removes only that world');

  const missingWorld = await api(`/api/chats/${chatId}/worlds`, json('POST', {
    worldId: 'does-not-exist',
    attached: true,
  }));
  eq(missingWorld.status, 404, 'attaching a missing world is refused');

  // -------------------------------------------------------------------------
  section('encoded ids and deletion');
  // -------------------------------------------------------------------------

  // Ids with spaces or non-ASCII must survive the URL round trip. Path segments
  // are percent-encoded by the client and `URL.pathname` keeps that encoding, so
  // the server has to decode; without it, DELETE answered 200 and removed nothing.
  const trickyName = '测试 世界 book';
  const trickyImport = await api(`/api/worlds/import?name=${encodeURIComponent(trickyName)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: readFileSync(join(corpus, 'owned', 'agnai', 'memory.json')),
  });
  eq(trickyImport.status, 200, 'a world with spaces and non-ASCII imports');

  const encoded = encodeURIComponent(trickyName);
  const trickyGet = await api(`/api/worlds/${encoded}`);
  eq(trickyGet.status, 200, 'the encoded id resolves on read');
  eq(trickyGet.body.entries.length, 3, 'the encoded id returns the right entries');

  const trickyRaw = await api(`/api/worlds/${encoded}/raw`);
  eq(trickyRaw.status, 200, 'the encoded id resolves on the raw endpoint');

  const trickyDelete = await api(`/api/worlds/${encoded}`, { method: 'DELETE' });
  eq(trickyDelete.status, 200, 'the encoded id deletes');
  eq((await api(`/api/worlds/${encoded}`)).status, 500, 'the deleted world is really gone');
  check(
    !(await api('/api/worlds')).body.some((entry: any) => entry.id === trickyName),
    'the deleted world is absent from the listing',
  );

  eq((await api('/api/worlds/never-existed', { method: 'DELETE' })).status, 404,
    'deleting a missing world reports 404 instead of pretending success');

  const malformed = await fetch(`${base}/api/worlds/%E0%A4%A`);
  eq(malformed.status, 400, 'malformed percent-encoding is rejected');

  // -------------------------------------------------------------------------
  section('reply language');
  // -------------------------------------------------------------------------

  const freshStack = await api('/api/prompt/stack');
  check(freshStack.body.defaultLanguageInstruction.includes('{{language}}'), 'the stack endpoint publishes the default wording');
  eq(
    freshStack.body.blocks.find((block: any) => block.identifier === 'language')?.enabled,
    false,
    'the language block starts disabled',
  );

  await api('/api/config', json('PUT', { outputLanguage: '中文' }));
  const zhStack = await api('/api/prompt/stack');
  const zhBlock = zhStack.body.blocks.find((block: any) => block.identifier === 'language');
  eq(zhBlock.enabled, true, 'setting a language enables the block');
  check(String(zhBlock.content).includes('中文'), 'the stack endpoint renders the instruction');
  check(
    zhStack.body.blocks.findIndex((block: any) => block.identifier === 'language') ===
      zhStack.body.blocks.findIndex((block: any) => block.identifier === 'main') + 1,
    'the block is published right after the main prompt',
  );

  const zhPreview = await api('/api/prompt/preview', json('POST', { chatId }));
  check(JSON.stringify(zhPreview.body.messages).includes('中文'), 'the instruction reaches the assembled request');
  check(
    zhPreview.body.itemization.some((item: any) => item.identifier === 'language' && item.tokens > 0),
    'the block is itemised with its own token cost',
  );

  await api('/api/config', json('PUT', { languageInstruction: 'Reply only in {{language}}.' }));
  const custom = await api('/api/prompt/preview', json('POST', { chatId }));
  check(JSON.stringify(custom.body.messages).includes('Reply only in 中文.'), 'a custom template is honoured');

  await api('/api/config', json('PUT', { outputLanguage: '火星文' }));
  const fun = await api('/api/prompt/preview', json('POST', { chatId }));
  check(JSON.stringify(fun.body.messages).includes('火星文'), 'an arbitrary language string is injected verbatim');

  await api('/api/config', json('PUT', { outputLanguage: '', languageInstruction: '' }));
  const cleared = await api('/api/prompt/preview', json('POST', { chatId }));
  check(
    !JSON.stringify(cleared.body.messages).includes('Reply only in'),
    'clearing the language removes the instruction',
  );
  eq(
    cleared.body.itemization.find((item: any) => item.identifier === 'language')?.skippedReason,
    'disabled',
    'the cleared block reports itself as disabled',
  );

  // -------------------------------------------------------------------------
  section('error handling');
  // -------------------------------------------------------------------------

  eq((await api('/api/chats/does-not-exist')).status, 500, 'missing chat reports an error');
  eq((await api('/api/characters/does-not-exist')).status, 404, 'missing character is a 404');
  eq((await api('/api/nope')).status, 404, 'unknown route is 404');

  const badWorld = await api('/api/worlds/import?name=broken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from('{"not":"a world"}'),
  });
  eq(badWorld.status, 400, 'a non-world document is rejected');
  eq((await api('/api/worlds')).body.filter((entry: any) => !entry.error).length, 2,
    'the rejected import did not create a world');

  // A bad document must not overwrite a good one. It is a client error (400),
  // not a server fault: the document was understood well enough to reject.
  const badPut = await api('/api/worlds/eldoria/raw', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nope: true }),
  });
  eq(badPut.status, 400, 'invalid raw update is rejected');
  const stillGood = await api('/api/worlds/eldoria');
  eq(stillGood.body.entries.length, 4, 'the existing world survived the bad write');

  // -------------------------------------------------------------------------
  section('world entry CRUD');
  // -------------------------------------------------------------------------

  const fieldMeta = await api('/api/worlds/fields');
  check((fieldMeta.body.fields?.length ?? 0) > 30, 'field metadata is published', String(fieldMeta.body.fields?.length));
  check((fieldMeta.body.groups?.length ?? 0) >= 5, 'field metadata carries groups');
  const positionSpec = fieldMeta.body.fields.find((field: any) => field.field === 'position');
  eq(positionSpec?.type, 'enum', 'position is exposed as an enum');
  eq(positionSpec?.options?.length, 8, 'position offers all eight insertion slots');
  check(
    fieldMeta.body.fields.some((field: any) => field.field === 'vectorized' && field.readOnly !== true),
    'a field vector storage needs is editable',
  );
  check(
    fieldMeta.body.fields.some((field: any) => field.field === 'displayIndex' && field.readOnly === true),
    'the metadata still marks the fields that are not',
  );
  // Field metadata is served in the interface language the editor asks for.
  const englishFields = await api('/api/worlds/fields?lang=en');
  const englishPosition = (englishFields.body.fields as any[]).find((field) => field.field === 'position');
  eq(englishPosition?.label, 'Injection position', 'field labels follow the requested language');
  eq(englishPosition?.options?.[0]?.label, 'Before character ↑Char', 'and so do option labels');

  const worldBefore = await api('/api/worlds/eldoria');
  const baseCount = worldBefore.body.entries.length as number;

  const added = await api('/api/worlds/eldoria/entries', json('POST', {
    comment: 'API created',
    content: 'created through the API',
    key: ['api-created'],
    order: 42,
  }));
  eq(added.status, 200, 'entry created');
  const uid = added.body.entry.uid as number;
  eq(added.body.entries, baseCount + 1, 'entry count grew');

  const afterAdd = await api('/api/worlds/eldoria');
  check(afterAdd.body.entries.some((entry: any) => entry.uid === uid), 'created entry is persisted');

  const rawAfterAdd = await api('/api/worlds/eldoria/raw');
  eq(Object.keys(rawAfterAdd.body.entries).length, baseCount + 1, 'the source document grew too');
  check(
    rawAfterAdd.body.entries['0']?.myCustomField?.flag === true,
    'creating an entry left the existing unknown fields alone',
  );

  const patched = await api(`/api/worlds/eldoria/entries/${uid}`, json('PATCH', {
    comment: 'renamed through the API',
    probability: 42,
    position: 3,
    constant: true,
  }));
  eq(patched.status, 200, 'entry patched');

  const afterPatch = await api('/api/worlds/eldoria');
  const patchedEntry = afterPatch.body.entries.find((entry: any) => entry.uid === uid);
  eq(patchedEntry.comment, 'renamed through the API', 'comment persisted');
  eq(patchedEntry.probability, 42, 'probability persisted');
  eq(patchedEntry.position, 3, 'position persisted');
  eq(patchedEntry.constant, true, 'constant persisted');

  const rawAfterPatch = await api('/api/worlds/eldoria/raw');
  eq(rawAfterPatch.body.entries[String(uid)].comment, 'renamed through the API', 'the raw document reflects the patch');
  check(
    rawAfterPatch.body.entries['1']?.anotherCustom === 'kept verbatim',
    'patching one entry did not disturb another entry\u2019s unknown fields',
  );

  // A comma inside a regex key must not split it.
  const regexKey = await api(`/api/worlds/eldoria/entries/${uid}`, json('PATCH', {
    key: ['/a{1,2}/', 'plain'],
  }));
  eq(regexKey.status, 200, 'a regex key is accepted');
  eq(regexKey.body.entry.key, ['/a{1,2}/', 'plain'], 'a comma inside a regex key does not split it');

  const unknownField = await api(`/api/worlds/eldoria/entries/${uid}`, json('PATCH', { nope: 1 }));
  eq(unknownField.status, 400, 'an unknown field is rejected');
  check(Array.isArray(unknownField.body.problems), 'the rejection lists the problems');
  check(String(unknownField.body.error).includes('nope'), 'the rejection names the field');

  eq((await api(`/api/worlds/eldoria/entries/${uid}`, json('PATCH', { displayIndex: 7 }))).status, 400,
    'a read-only field is rejected');
  eq((await api(`/api/worlds/eldoria/entries/${uid}`, json('PATCH', { position: 99 }))).status, 400,
    'an out-of-range enum is rejected');
  eq((await api(`/api/worlds/eldoria/entries/${uid}`, json('PATCH', { probability: 500 }))).status, 400,
    'an out-of-range number is rejected');
  eq((await api(`/api/worlds/eldoria/entries/${uid}`, json('PATCH', { triggers: ['nope'] }))).status, 400,
    'an unknown trigger is rejected');

  const duplicated = await api(`/api/worlds/eldoria/entries/${uid}/duplicate`, json('POST', {}));
  eq(duplicated.status, 200, 'entry duplicated');
  check(duplicated.body.entry.uid !== uid, 'the copy has its own uid');
  eq(duplicated.body.entry.content, patchedEntry.content, 'the copy keeps the content');
  check(
    String(duplicated.body.entry.comment).includes('copy'),
    'the copy is labelled',
    String(duplicated.body.entry.comment),
  );

  eq((await api(`/api/worlds/eldoria/entries/${duplicated.body.entry.uid}`, { method: 'DELETE' })).status, 200,
    'the duplicate is deleted');
  eq((await api(`/api/worlds/eldoria/entries/${uid}`, { method: 'DELETE' })).status, 200,
    'the created entry is deleted');
  eq((await api('/api/worlds/eldoria')).body.entries.length, baseCount, 'the world is back to its original size');
  eq((await api('/api/worlds/eldoria/entries/999999', { method: 'DELETE' })).status, 404,
    'deleting a missing entry is a 404');
  eq((await api('/api/worlds/eldoria/entries/999999', json('PATCH', { comment: 'x' }))).status, 404,
    'patching a missing entry is a 404');

  const bookPatch = await api('/api/worlds/eldoria', json('PATCH', {
    scanDepth: 7,
    tokenBudget: 300,
    recursiveScanning: true,
  }));
  eq(bookPatch.status, 200, 'book-level settings patched');
  const afterBook = await api('/api/worlds/eldoria');
  eq(afterBook.body.scanDepth, 7, 'scanDepth persisted');
  eq(afterBook.body.tokenBudget, 300, 'tokenBudget persisted');
  eq(afterBook.body.recursiveScanning, true, 'recursiveScanning persisted');
  eq((await api('/api/worlds/eldoria', json('PATCH', { nope: 1 }))).status, 400,
    'an unknown book field is rejected');

  // -------------------------------------------------------------------------
  section('edits are written back in the source format');
  // -------------------------------------------------------------------------

  // eldenring was imported from an array-form CharacterBook.
  const cbAdded = await api('/api/worlds/eldenring/entries', json('POST', {
    comment: 'array-format entry',
    content: 'written back as a CharacterBook',
    key: ['cb-key'],
    order: 55,
    position: 1,
    probability: 30,
  }));
  eq(cbAdded.status, 200, 'an entry can be added to an array-format book');

  const cbRaw = await api('/api/worlds/eldenring/raw');
  check(Array.isArray(cbRaw.body.entries), 'character-book keeps entries as an array');
  const cbEntry = cbRaw.body.entries.find((entry: any) => entry.id === cbAdded.body.entry.uid);
  check(cbEntry !== undefined, 'the new entry is in that array');
  eq(cbEntry?.keys, ['cb-key'], 'the key was written as `keys`, not `key`');
  eq(cbEntry?.insertion_order, 55, 'the order was written as `insertion_order`');
  eq(cbEntry?.enabled, true, 'disable was written as the inverted `enabled`');
  eq(typeof cbEntry?.position, 'string', 'position was written as a before_char/after_char string');
  eq(cbEntry?.extensions?.probability, 30, 'probability landed in extensions.probability');
  check(
    cbRaw.body.entries[0]?.custom_note !== undefined,
    'the original unknown field is still in the array-format document',
  );

  eq((await api(`/api/worlds/eldenring/entries/${cbAdded.body.entry.uid}`, { method: 'DELETE' })).status, 200,
    'the array-format entry is deleted');
  eq((await api('/api/worlds/eldenring/raw')).body.entries.length, 2, 'the array-format book is back to two entries');

  // A Risu book keeps its own shape: data[] with comma-joined keys.
  const risuImport = await api('/api/worlds/import?name=risu-book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: readFileSync(join(corpus, 'owned', 'risu', 'lorebook.json')),
  });
  eq(risuImport.body.format, 'risu', 'the risu book imported');

  const risuAdded = await api('/api/worlds/risu-book/entries', json('POST', {
    comment: 'risu entry',
    content: 'written back as a Risu lorebook',
    key: ['one', 'two'],
    order: 77,
  }));
  eq(risuAdded.status, 200, 'an entry can be added to a risu book');
  const risuRaw = await api('/api/worlds/risu-book/raw');
  check(Array.isArray(risuRaw.body.data), 'risu keeps its entries under data[]');
  const risuEntry = risuRaw.body.data.find((entry: any) => entry.content === 'written back as a Risu lorebook');
  eq(risuEntry?.key, 'one,two', 'risu keys are written back as a comma-joined string');
  eq(risuEntry?.insertorder, 77, 'the order was written as `insertorder`');

  // Editing a pregiven risu entry must not rearrange its keys either.
  const risuFirst = risuRaw.body.data[0];
  const risuPatched = await api(`/api/worlds/risu-book/entries/0`, json('PATCH', { comment: 'risu renamed' }));
  eq(risuPatched.status, 200, 'a pregiven risu entry can be patched');
  const risuAfter = await api('/api/worlds/risu-book/raw');
  eq(risuAfter.body.data[0].comment, 'risu renamed', 'the risu patch landed on the right source field');
  eq(risuAfter.body.data[0].key, risuFirst.key, 'patching did not disturb the comma-joined keys');

  // -------------------------------------------------------------------------
  section('character management');
  // -------------------------------------------------------------------------

  const renamed = await api('/api/characters/seraphina', json('PATCH', { name: 'Osk the Harbourmaster' }));
  eq(renamed.status, 200, 'character renamed');
  eq(renamed.body.idChanged, false, 'renaming does not change the id');
  eq((await api('/api/characters/seraphina')).body.name, 'Osk the Harbourmaster', 'the new name is persisted');
  const detail = await api('/api/characters/seraphina');
  check(Array.isArray(detail.body.chats), 'character detail lists its chats');
  eq(detail.body.chats.length, 1, 'the open chat is listed');
  check(
    (await api('/api/characters')).body.some((entry: any) => entry.id === 'seraphina' && entry.name === 'Osk the Harbourmaster'),
    'the list reflects the rename',
  );

  // Re-keying must carry the chats along.
  eq((await api(`/api/chats/${chatId}`)).body.meta.characterId, 'seraphina', 'the chat starts on the old id');
  const rekeyed = await api('/api/characters/seraphina', json('PATCH', { id: 'osk' }));
  eq(rekeyed.status, 200, 'character re-keyed');
  eq(rekeyed.body.id, 'osk', 'the new id is returned');
  eq(rekeyed.body.chatsUpdated, 1, 'the chat was migrated');
  eq((await api(`/api/chats/${chatId}`)).body.meta.characterId, 'osk', 'the chat points at the new id');
  eq((await api('/api/characters/seraphina')).status, 404, 'the old id is gone');
  eq((await api('/api/prompt/preview', json('POST', { chatId }))).status, 200,
    'the chat still assembles after a re-key');

  const second = await api('/api/characters/import?name=second', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: readFileSync(join(corpus, 'owned', 'edge', 'flat-card.json')),
  });
  eq(second.status, 200, 'a second character is imported');
  eq((await api('/api/characters/osk', json('PATCH', { id: 'second' }))).status, 409,
    're-keying onto an existing id is refused');
  eq((await api('/api/characters/missing-one', json('PATCH', { name: 'x' }))).status, 404,
    'patching a missing character is a 404');

  const blocked = await api('/api/characters/osk', { method: 'DELETE' });
  eq(blocked.status, 409, 'deleting a character that still has chats is refused');
  check(String(blocked.body.error).includes('cascade'), 'the refusal explains the cascade flag');

  const cascaded = await api('/api/characters/osk?cascade=true', { method: 'DELETE' });
  eq(cascaded.status, 200, 'the cascade delete is accepted');
  eq(cascaded.body.chatsDeleted, 1, 'its chat went with it');
  eq((await api(`/api/chats/${chatId}`)).status, 500, 'the chat is gone');
  eq((await api('/api/characters/osk', { method: 'DELETE' })).status, 404, 'deleting a missing character is a 404');
  eq((await api('/api/characters/second', { method: 'DELETE' })).status, 200,
    'a character without chats deletes without a cascade flag');
  // The card imported by the wrong-document section is still here; that is the
  // point of this assertion, so the cleanup path is visible.
  eq(
    (await api('/api/characters')).body.map((entry: any) => entry.id),
    ['not-a-world'],
    'only the card imported by another section remains',
  );

  // -------------------------------------------------------------------------
  section('card editing and greetings');
  // -------------------------------------------------------------------------

  const probe = await api('/api/characters/import?name=probe', {
    method: 'POST',
    body: readFileSync(join(corpus, 'owned', 'cards', 'osk.png')),
  });
  eq(probe.status, 200, 'a card is imported for the editing checks');

  const beforeEdit = (await api('/api/characters/probe')).body;
  check(String(beforeEdit.fields.first_mes).trim() !== '', 'the card carries a first message');
  eq(beforeEdit.fields.alternate_greetings.length, 1, 'and one alternate greeting');

  // A new chat starts from the card's first message. Every chat used to be
  // created empty, so the character never got to speak first.
  const greeted = await api('/api/chats', json('POST', { characterId: 'probe' }));
  const greetedEntries = (await api(`/api/chats/${greeted.body.id}`)).body.entries as any[];
  eq(greetedEntries.length, 1, 'a new chat is seeded with one entry');
  eq(greetedEntries[0].role, 'assistant', 'which is the greeting, said by the character');
  eq(
    greetedEntries[0].content,
    String(beforeEdit.fields.first_mes).trim(),
    'and it is the card first message',
  );
  eq(greetedEntries[0].parentId, null, 'the greeting is the root of the transcript');

  // Any of the card's greetings can start one instead.
  const offers = [String(beforeEdit.fields.first_mes).trim(), ...beforeEdit.fields.alternate_greetings];
  const alternateChat = await api('/api/chats', json('POST', { characterId: 'probe', greeting: 1 }));
  const alternateEntries = (await api(`/api/chats/${alternateChat.body.id}`)).body.entries as any[];
  eq(alternateEntries[0].content, offers[1], 'a chosen alternate greeting starts the chat');

  // `-1` still asks for an empty chat; anything else out of range is refused.
  const emptyChat = await api('/api/chats', json('POST', { characterId: 'probe', greeting: -1 }));
  eq((await api(`/api/chats/${emptyChat.body.id}`)).body.entries.length, 0, 'greeting -1 leaves the chat empty');
  eq((await api('/api/chats', json('POST', { characterId: 'probe', greeting: 9 }))).status, 400,
    'an index past the last greeting is refused');
  eq((await api('/api/chats', json('POST', { characterId: 'probe', greeting: 'first' }))).status, 400,
    'a non-numeric greeting is refused');
  eq((await api('/api/chats', json('POST', { characterId: 'nobody' }))).status, 404,
    'seeding from a missing card is a 404');

  // The card's content is editable, through the same lossless write-back the
  // importer uses — a PNG card must stay a PNG card.
  eq(
    (await api('/api/characters/probe', json('PATCH', {
      description: 'A rewritten description.',
      first_mes: 'A new opening line.',
      alternate_greetings: ['Second opening.', '   '],
      tags: ['edited', ' '],
      creator_notes: 'a note',
    }))).status,
    200,
    'content fields are accepted',
  );
  const afterEdit = (await api('/api/characters/probe')).body;
  eq(afterEdit.fields.description, 'A rewritten description.', 'the description is written back');
  eq(afterEdit.fields.first_mes, 'A new opening line.', 'and so is the first message');
  eq(afterEdit.fields.alternate_greetings, ['Second opening.'], 'blank list entries are dropped');
  eq(afterEdit.fields.tags, ['edited'], 'the same for tags');
  eq(afterEdit.name, beforeEdit.name, 'editing content leaves the name alone');
  eq(afterEdit.spec, beforeEdit.spec, 'and the card keeps its spec');
  eq((await api('/api/characters/probe/export')).status, 200, 'the edited card still exports');

  const editedPreview = await api('/api/prompt/preview', json('POST', { chatId: greeted.body.id }));
  check(
    JSON.stringify(editedPreview.body.messages).includes('A rewritten description.'),
    'the edited description reaches the prompt',
  );
  const afterEditChat = await api('/api/chats', json('POST', { characterId: 'probe' }));
  eq(
    (await api(`/api/chats/${afterEditChat.body.id}`)).body.entries[0].content,
    'A new opening line.',
    'and new chats start from the edited greeting',
  );

  // A patch has to fail loudly, naming the field, rather than half-apply.
  const rejectedField = await api('/api/characters/probe', json('PATCH', { nope: 'x' }));
  eq(rejectedField.status, 400, 'an unknown field is refused');
  eq(rejectedField.body.problems[0].field, 'nope', 'and named in the problems list');
  eq((await api('/api/characters/probe', json('PATCH', { description: 42 }))).status, 400,
    'a string field rejects a number');
  eq((await api('/api/characters/probe', json('PATCH', { tags: 'not-a-list' }))).status, 400,
    'a list field rejects a string');
  eq((await api('/api/characters/probe', json('PATCH', { tags: ['ok', 3] }))).status, 400,
    'a list of non-strings is refused');
  eq((await api('/api/characters/probe', json('PATCH', { name: '   ' }))).status, 400,
    'a blank name is still refused');
  eq(
    (await api('/api/characters/probe')).body.fields.description,
    'A rewritten description.',
    'a refused patch changes nothing',
  );

  // Content and a rename in one patch: both must survive.
  await api('/api/characters/probe', json('PATCH', { name: 'Probe Renamed', scenario: 'A new scenario.' }));
  const renamedProbe = (await api('/api/characters/probe')).body;
  eq(renamedProbe.name, 'Probe Renamed', 'content and a rename can be patched together');
  eq(renamedProbe.fields.scenario, 'A new scenario.', 'and both stick');

  for (const id of [greeted.body.id, alternateChat.body.id, emptyChat.body.id, afterEditChat.body.id]) {
    await api(`/api/chats/${id}`, { method: 'DELETE' });
  }
  await api('/api/characters/probe?cascade=true', { method: 'DELETE' });
  check(
    !(await api('/api/characters')).body.some((entry: any) => entry.id === 'probe'),
    'the probe card is cleaned up',
  );

  // -------------------------------------------------------------------------
  section('chat log interchange');
  // -------------------------------------------------------------------------

  // A scratch card and transcript of its own: the sections above delete theirs.
  const logProbe = await api('/api/characters/import?name=log-probe', {
    method: 'POST',
    body: readFileSync(join(corpus, 'owned', 'cards', 'osk.png')),
  });
  eq(logProbe.status, 200, 'a card is imported for the log checks');
  const logChat = await api('/api/chats', json('POST', { characterId: 'log-probe', greeting: -1 }));
  const logChatId = logChat.body.id as string;
  for (const [role, content] of [
    ['user', 'who keeps the harbour?'],
    ['assistant', 'The harbourmaster does, and he counts every lantern.'],
  ] as const) {
    await api(`/api/chats/${logChatId}/message`, json('POST', { role, content }));
  }
  // One reply with two candidates, so the swipe mapping is exercised too.
  await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: logChatId, regenerate: true }),
  }).then((response) => response.text());
  const logEntries = (await api(`/api/chats/${logChatId}`)).body.entries as any[];
  check(
    logEntries.some((entry) => (entry.variants?.length ?? 0) >= 2),
    'the scratch transcript has a reply with candidates',
  );

  // Export it as SillyTavern JSONL and read it back.
  const exported = await fetch(`${base}/api/chats/${logChatId}/export`);
  eq(exported.status, 200, 'a transcript exports');
  const logText = await exported.text();
  const logLines = logText.trim().split('\n').map((line) => JSON.parse(line) as any);
  const header = logLines[0];
  const messageLines = logLines.slice(1);
  const logCard = (await api('/api/characters/log-probe')).body;

  check(typeof header.chat_metadata === 'object', 'the export starts with an ST-style header');
  eq(header.chat_metadata.tavern.chatId, logChatId, 'the header records which chat it came from');
  eq(header.character_name, logCard.name, 'and names the character the ST way');
  eq(header.user_name, 'Traveller', 'and the persona');
  eq(messageLines.length, logEntries.length, 'every entry became a line');
  eq(messageLines[0].is_user, true, 'the first turn is a user message');
  check(typeof messageLines[0].mes === 'string', 'the text is in `mes`');
  check(typeof messageLines[0].send_date === 'string', 'and carries a send date');
  eq(messageLines[1].is_user, false, 'the reply is not');
  check(
    /^[A-Z][a-z]+ \d+, \d{4} \d+:\d{2}(am|pm)$/.test(messageLines[1].send_date),
    'the date looks like ST writes it',
    messageLines[1].send_date,
  );

  // Swipes travel as ST's `swipes` / `swipe_id`.
  const swipeLine = messageLines.find((line) => Array.isArray(line.swipes));
  check(swipeLine !== undefined, 'a reply with candidates exports them as swipes');
  if (swipeLine) {
    check(swipeLine.swipes.length >= 2, 'the candidates are all there');
    eq(swipeLine.mes, swipeLine.swipes[swipeLine.swipe_id], 'and mes is the active candidate');
  }

  // Importing that file creates an equivalent transcript.
  const roundTrip = await api(`/api/chats/import?characterId=log-probe&name=imported-log`, {
    method: 'POST',
    body: logText,
  });
  eq(roundTrip.status, 200, 'the exported log imports back');
  eq(roundTrip.body.format, 'sillytavern', 'and is recognised as an ST log');
  eq(roundTrip.body.entries, logEntries.length, 'with every message');
  const imported = await api(`/api/chats/${roundTrip.body.id}`);
  const importedEntries = imported.body.entries as any[];
  eq(
    importedEntries.map((entry) => entry.role),
    logEntries.map((entry: any) => entry.role),
    'the roles survive the round trip',
  );
  // The export writes the *visible* candidate, which is the active variant when
  // a reply has several.
  const visible = (entry: any) =>
    entry.variants?.length > 0 ? entry.variants[entry.activeVariant ?? 0] : entry.content;
  eq(
    importedEntries.map(visible),
    logEntries.map(visible),
    'and so does the text',
  );
  check(
    importedEntries.every((entry, index) => entry.parentId === (index === 0 ? null : importedEntries[index - 1].id)),
    'the imported transcript is linked end to end',
  );
  if (swipeLine) {
    const importedVariants = importedEntries.find((entry) => Array.isArray(entry.variants));
    check(importedVariants !== undefined, 'candidates survive the round trip');
    eq(importedVariants?.activeVariant, swipeLine.swipe_id, 'and so does which one was active');
  }

  // Our own JSONL is accepted too, so a transcript can be re-imported as-is.
  const ownLog = [
    JSON.stringify({ id: 'm0', parentId: null, role: 'user', content: 'our own line', createdAt: new Date().toISOString() }),
    JSON.stringify({ id: 'm1', parentId: 'm0', role: 'assistant', content: 'our own reply', variants: ['our own reply', 'another'], activeVariant: 1, createdAt: new Date().toISOString() }),
  ].join('\n') + '\n';
  const ownImport = await api('/api/chats/import?characterId=log-probe&name=own-log', { method: 'POST', body: ownLog });
  eq(ownImport.status, 200, 'our own jsonl imports');
  eq(ownImport.body.format, 'tavern', 'and is reported as our format');
  const ownEntries = (await api(`/api/chats/${ownImport.body.id}`)).body.entries as any[];
  eq(ownEntries.length, 2, 'both lines landed');
  eq(ownEntries[1].content, 'another', 'with the active candidate as the visible text');
  eq(ownEntries[1].variants.length, 2, 'and the candidates kept');

  // A log with an unreadable line is still worth importing; the rest arrives.
  const partlyBroken = ['{"mes":"good line","is_user":true}', 'not json at all', '{"mes":"another","is_user":false}'].join('\n');
  const partial = await api('/api/chats/import?characterId=log-probe&name=partial-log', { method: 'POST', body: partlyBroken });
  eq(partial.status, 200, 'an import with one broken line still succeeds');
  eq(partial.body.entries, 2, 'the readable messages are imported');
  eq(partial.body.warnings.length, 1, 'and the broken line is reported');

  // Refusals: nothing to import, or nowhere to put it.
  eq((await api('/api/chats/import?characterId=log-probe', { method: 'POST', body: 'not json' })).status, 400,
    'a file with no messages is refused');
  eq((await api('/api/chats/import?characterId=nobody', { method: 'POST', body: ownLog })).status, 404,
    'importing onto a missing character is a 404');
  eq((await api('/api/chats/import', { method: 'POST', body: ownLog })).status, 400,
    'importing without a character is refused');
  eq((await api('/api/chats/does-not-exist/export')).status, 500, 'exporting a missing chat reports an error');

  for (const id of [logChatId, roundTrip.body.id, ownImport.body.id, partial.body.id]) {
    await api(`/api/chats/${id}`, { method: 'DELETE' });
  }
  await api('/api/characters/log-probe?cascade=true', { method: 'DELETE' });

  // -------------------------------------------------------------------------
  section('branching a transcript');
  // -------------------------------------------------------------------------

  const branchCard = await api('/api/characters/import?name=branch-probe', {
    method: 'POST',
    body: readFileSync(join(corpus, 'owned', 'cards', 'osk.png')),
  });
  eq(branchCard.status, 200, 'a card is imported for the branching checks');
  const origin = await api('/api/chats', json('POST', { characterId: 'branch-probe', greeting: -1 }));
  const originId = origin.body.id as string;
  for (const [role, content] of [
    ['user', 'first'],
    ['assistant', 'first reply'],
    ['user', 'second'],
    ['assistant', 'second reply'],
  ] as const) {
    await api(`/api/chats/${originId}/message`, json('POST', { role, content }));
  }
  const originEntries = (await api(`/api/chats/${originId}`)).body.entries as any[];
  eq(originEntries.length, 4, 'the origin has four turns');

  // Fork at the second turn: the branch keeps that far, the origin keeps everything.
  const forked = await api(`/api/chats/${originId}/fork`, json('POST', { entryId: originEntries[1].id }));
  eq(forked.status, 200, 'a transcript can be forked at a message');
  eq(forked.body.entries, 2, 'the branch keeps the messages up to that one');
  eq(forked.body.name, 'branch-probe chat · 分支', 'and is named after its origin');
  const branchEntries = (await api(`/api/chats/${forked.body.id}`)).body.entries as any[];
  eq(
    branchEntries.map((entry) => entry.content),
    ['first', 'first reply'],
    'the branch holds exactly that prefix',
  );
  check(
    branchEntries.every((entry, index) => entry.parentId === (index === 0 ? null : branchEntries[index - 1].id)),
    'and the prefix is linked end to end',
  );
  const originMeta = (await api(`/api/chats/${originId}`)).body.meta;
  const branchMeta = (await api(`/api/chats/${forked.body.id}`)).body.meta;
  eq(branchMeta.characterId, 'branch-probe', 'the branch belongs to the same character');
  eq(branchMeta.worldRefs, originMeta.worldRefs, 'and keeps its world books');
  eq(branchMeta.model, originMeta.model, 'and its model');
  eq(branchMeta.params, originMeta.params, 'and its sampler snapshot');

  // The origin is untouched — that is the whole point of branching by copy.
  const originAfter = (await api(`/api/chats/${originId}`)).body.entries as any[];
  eq(originAfter.length, 4, 'the origin still has all four turns');
  eq(originAfter[3].content, 'second reply', 'including the reply the branch cut off');

  // Appending to the branch must not touch the origin.
  await api(`/api/chats/${forked.body.id}/message`, json('POST', { role: 'user', content: 'branch only' }));
  eq((await api(`/api/chats/${originId}`)).body.entries.length, 4, 'writing to the branch leaves the origin alone');
  eq((await api(`/api/chats/${forked.body.id}`)).body.entries.length, 3, 'and lands in the branch');

  // Forking the whole thing is a copy; a bogus anchor and a missing chat are refused.
  const copy = await api(`/api/chats/${originId}/fork`, json('POST', { name: 'a full copy' }));
  eq(copy.body.entries, 4, 'forking without an anchor copies everything');
  eq(copy.body.name, 'a full copy', 'and takes the requested name');
  eq((await api(`/api/chats/${originId}/fork`, json('POST', { entryId: 'nope' }))).status, 404,
    'forking at a missing message is a 404');
  eq((await api('/api/chats/does-not-exist/fork', json('POST', {}))).status, 500,
    'forking a missing chat reports an error');

  for (const id of [originId, forked.body.id, copy.body.id]) {
    await api(`/api/chats/${id}`, { method: 'DELETE' });
  }
  await api('/api/characters/branch-probe?cascade=true', { method: 'DELETE' });

  // -------------------------------------------------------------------------
  section('request parameters and PNG export');
  // -------------------------------------------------------------------------

  // A scratch card and chat: the sections above deleted theirs.
  const knobCard = await api('/api/characters/import?name=knobs-probe', {
    method: 'POST',
    body: readFileSync(join(corpus, 'owned', 'cards', 'osk.png')),
  });
  eq(knobCard.status, 200, 'a PNG card is imported for the parameter checks');

  // The four request-level knobs the settings dialog now exposes. The chat is
  // created after the config change, so its snapshot carries the tuned values.
  eq(
    (await api('/api/config', json('PUT', {
      topP: 0.9,
      maxTokens: 512,
      stop: ['\nUser:', '###'],
      requestUsage: true,
    }))).status,
    200,
    'the request parameters are accepted',
  );
  const knobChat = await api('/api/chats', json('POST', { characterId: 'knobs-probe', greeting: -1 }));
  const knobChatId = knobChat.body.id as string;
  const tuned = (await api('/api/config')).body;
  eq(tuned.topP, 0.9, 'top_p is stored');
  eq(tuned.maxTokens, 512, 'the reply cap is stored');
  eq(tuned.stop, ['\nUser:', '###'], 'the stop strings are stored as a list, not a joined string');

  const tunedResponse = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: knobChatId, message: 'do the knobs reach the provider?' }),
  });
  await tunedResponse.text();
  eq(lastProviderRequest?.top_p, 0.9, 'top_p reaches the provider');
  eq(lastProviderRequest?.max_tokens, 512, 'so does the reply cap');
  eq(lastProviderRequest?.stop, ['\nUser:', '###'], 'and so do the stop strings');
  eq(lastProviderRequest?.stream_options?.include_usage, true, 'usage is still requested');

  // Turning usage off removes the parameter rather than sending false.
  await api('/api/config', json('PUT', { requestUsage: false }));
  const quietUsage = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: knobChatId, message: 'and now?' }),
  });
  await quietUsage.text();
  eq(lastProviderRequest?.stream_options, undefined, 'with usage off the parameter is not sent');
  await api('/api/config', json('PUT', {
    topP: 1,
    maxTokens: 0,
    stop: [],
    requestUsage: true,
  }));

  // Exporting a card as PNG hands back the carrier, with the current card inside.
  const pngExport = await fetch(`${base}/api/characters/knobs-probe/export?format=png`);
  eq(pngExport.status, 200, 'a PNG card exports as PNG');
  eq(pngExport.headers.get('content-type'), 'image/png', 'with the image content type');
  const pngBytes = Buffer.from(await pngExport.arrayBuffer());
  eq(pngBytes.subarray(0, 8).toString('latin1'), '\x89PNG\r\n\x1a\n', 'and the bytes really are a PNG');
  const knobDetail = (await api('/api/characters/knobs-probe')).body;
  const reread = parseCardFile(pngBytes, 'exported');
  eq(reread.card.first_mes, knobDetail.fields.first_mes, 'the exported PNG carries the current card data');
  eq(reread.card.name, knobDetail.name, 'including the name');
  eq(reread.card.alternate_greetings, knobDetail.fields.alternate_greetings, 'and the greetings');

  // A JSON-only card has no image to write into, and says so.
  const jsonOnly = await api('/api/characters/import?name=json-only', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: readFileSync(join(corpus, 'owned', 'edge', 'flat-card.json')),
  });
  eq(jsonOnly.status, 200, 'a JSON card is imported');
  const jsonPng = await api('/api/characters/json-only/export?format=png');
  eq(jsonPng.status, 404, 'exporting a JSON card as PNG is refused');
  check(String(jsonPng.body.error).includes('JSON'), 'and the refusal points at JSON', jsonPng.body.error);
  eq((await api('/api/characters/json-only/export')).status, 200, 'while its JSON export works');
  await api('/api/characters/json-only?cascade=true', { method: 'DELETE' });

  for (const id of [knobChatId]) await api(`/api/chats/${id}`, { method: 'DELETE' });
  await api('/api/characters/knobs-probe?cascade=true', { method: 'DELETE' });

  // -------------------------------------------------------------------------
  section('quick replies');
  // -------------------------------------------------------------------------

  // A missing file reads as "none yet", not as an error.
  const emptyReplies = await api('/api/quick-replies');
  eq(emptyReplies.status, 200, 'quick replies load without a file');
  eq(emptyReplies.body.items, [], 'starting empty');
  eq(emptyReplies.body.enabled, true, 'and shown by default');

  // Saving normalises: blank entries are dropped and ids are assigned.
  const savedReplies = await api('/api/quick-replies', json('PUT', {
    enabled: true,
    items: [
      { label: '打招呼', mes: '你好呀' },
      { label: '   ', mes: '  ' },
      { label: '', mes: '*环顾四周*\n第二行' },
      { label: '关掉的', mes: '别显示我', enabled: false },
    ],
  }));
  eq(savedReplies.status, 200, 'a quick reply list saves');
  eq(savedReplies.body.items.length, 3, 'a blank entry is dropped');
  check(
    savedReplies.body.items.every((item: any) => typeof item.id === 'string' && item.id !== ''),
    'every entry gets an id',
  );
  eq(new Set(savedReplies.body.items.map((item: any) => item.id)).size, 3, 'and the ids are unique');
  eq(savedReplies.body.items[1].mes, '*环顾四周*\n第二行', 'multi-line text is kept as-is');
  eq(savedReplies.body.items[2].enabled, false, 'a disabled entry stays disabled');
  eq((await api('/api/quick-replies')).body.items.length, 3, 'and the list is persisted');

  // SillyTavern's extension shape imports: slots append, empty slots are counted.
  const importedReplies = await api('/api/quick-replies/import', json('POST', {
    quickReplyEnabled: true,
    numberOfSlots: 3,
    quickReplySlots: [
      { mes: 'from ST', label: 'ST 槽位', enabled: true },
      { mes: '', label: '' },
      { mes: '第二个', label: '' },
    ],
  }));
  eq(importedReplies.status, 200, 'an ST quick reply export imports');
  eq(importedReplies.body.imported, 2, 'the two real slots arrive');
  eq(importedReplies.body.dropped, 1, 'and the empty one is reported');
  eq(importedReplies.body.total, 5, 'appended to what was there');
  const afterImport = (await api('/api/quick-replies')).body.items as any[];
  eq(afterImport[3].mes, 'from ST', 'in order');
  eq(afterImport[4].label, '', 'a slot without a label keeps an empty one');

  // A bare array is accepted too, and the export goes back to ST's shape.
  eq((await api('/api/quick-replies/import', json('POST', [{ label: 'bare', mes: 'array shape' }]))).status, 200,
    'a bare array imports');
  const stExport = (await api('/api/quick-replies/export')).body;
  check(Array.isArray(stExport.quickReplySlots), 'the export uses ST slot names');
  eq(stExport.numberOfSlots, 6, 'with the current count');
  eq(stExport.quickReplySlots[3].label, 'ST 槽位', 'and the imported entry is in it');
  check(!('id' in stExport.quickReplySlots[0]), 'our ids stay out of the ST shape');

  // Refusals: nothing to import, or a payload that is not a file at all.
  eq((await api('/api/quick-replies/import', json('POST', { nope: 1 }))).status, 400,
    'an unrecognised shape is refused');
  eq((await api('/api/quick-replies', json('PUT', 'nope'))).status, 400, 'a non-object file is refused');

  // -------------------------------------------------------------------------
  section('long-term memory');
  // -------------------------------------------------------------------------

  // Its own chat, so nothing another section deleted or rewrote is in the way.
  const memoryCard = await api('/api/characters/import?name=memory-probe', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: readFileSync(join(corpus, 'owned', 'cards', 'osk.png')),
  });
  eq(memoryCard.status, 200, 'a card for the memory suite imports');
  const memoryChat = await api('/api/chats', json('POST', { characterId: 'memory-probe' }));
  const memoryChatId = memoryChat.body.id as string;

  const memory = () => api(`/api/chats/${memoryChatId}/memory`);
  const empty = await memory();
  eq(empty.status, 200, 'the memory endpoint answers');
  eq(empty.body.record, null, 'a new chat remembers nothing');
  eq(empty.body.settings.enabled, false, 'long-term memory starts switched off');
  eq(empty.body.progress.due, false, 'and is never due while it is off');
  eq(empty.body.progress.since, 1, 'the greeting alone is one message it has not covered');
  eq(
    (await api(`/api/chats/${memoryChatId}/memory/summarize`, json('POST', {}))).status,
    400,
    'summarising while it is off is refused',
  );

  // The switch itself is an ordinary config field, so it saves the way the
  // settings dialog saves.
  const beforeSwitch = await api('/api/prompt/preview', json('POST', { chatId: memoryChatId }));
  const memoryConfig = await api('/api/config', json('PUT', { memory: { enabled: true, interval: 2 } }));
  eq(memoryConfig.body.memory.enabled, true, 'the feature can be switched on');
  eq(memoryConfig.body.scan !== undefined, true, 'without disturbing the scan section');
  eq((await api('/api/config')).body.maxContext, memoryConfig.body.maxContext, 'or anything else in the config');
  // Switching it on with nothing remembered must not change the request: the
  // block is there, empty and switched off, and contributes nothing.
  const afterSwitch = await api('/api/prompt/preview', json('POST', { chatId: memoryChatId }));
  eq(
    JSON.stringify(afterSwitch.body.messages),
    JSON.stringify(beforeSwitch.body.messages),
    'with nothing remembered yet the request is unchanged',
  );
  eq(afterSwitch.body.totalTokens, beforeSwitch.body.totalTokens, 'token for token');

  // A turn that makes the memory due says so in the `done` frame, and only then.
  const memoryTurn = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: memoryChatId, message: 'Where is the ledger?' }),
  });
  const memoryEvents = (await memoryTurn.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as any);
  const doneFrame = memoryEvents.find((event) => event.type === 'done');
  check(doneFrame !== undefined, 'the turn finishes with a done frame');
  eq(doneFrame.memory.due, true, 'the greeting plus a turn reaches an interval of two');
  const anchorBefore = (await api(`/api/chats/${memoryChatId}`)).body.meta.usageAnchor;
  check(anchorBefore !== undefined, 'the turn anchored the provider usage');
  const entriesBeforeSummary = (await api(`/api/chats/${memoryChatId}`)).body.entries.length;

  const tooEarly = await api(`/api/chats/${memoryChatId}/memory/summarize`, json('POST', {}));
  eq(tooEarly.status, 200, 'a manual summary is always allowed');
  eq(tooEarly.body.summarized, 3, 'and covers everything so far');
  check(
    String(tooEarly.body.record.text).includes('ZQXSUMMARYMARKER'),
    'the summary is what the model wrote',
    String(tooEarly.body.record.text),
  );
  const coveredIds = (await api(`/api/chats/${memoryChatId}`)).body.entries.map((entry: any) => entry.id);
  eq(
    tooEarly.body.record.upToEntryId,
    coveredIds[coveredIds.length - 1],
    'and anchors on the last message it covered',
  );
  check(tooEarly.body.record.tokens > 0, 'the summary carries its token count', `${tooEarly.body.record.tokens}`);
  eq(tooEarly.body.record.model, memoryConfig.body.model, 'and remembers which model wrote it');
  eq(tooEarly.body.usage.completionTokens, 20, 'the call reports what it cost');
  check(typeof tooEarly.body.elapsedMs === 'number', 'and how long it took');

  // Summarising must not touch the chat's token anchor: that anchor describes the
  // conversation's own prompt, which the summariser never sends.
  const anchorAfter = (await api(`/api/chats/${memoryChatId}`)).body.meta.usageAnchor;
  eq(anchorAfter.promptTokens, anchorBefore.promptTokens, 'the summary does not move the usage anchor');
  eq(
    (await api(`/api/chats/${memoryChatId}`)).body.entries.length,
    entriesBeforeSummary,
    'and writes nothing into the transcript',
  );

  // Now it is injected, at a depth, as its own itemized block.
  const memoryPreview = await api('/api/prompt/preview', json('POST', { chatId: memoryChatId }));
  const memoryItem = (memoryPreview.body.itemization as any[]).find((item) => item.identifier === 'memory');
  check(memoryItem !== undefined, 'the memory block is itemized');
  eq(memoryItem.kind, 'injection', 'as an injection');
  eq(memoryItem.injectionDepth, 2, 'two messages from the end');
  check(memoryItem.tokens > 0, 'with its own token cost');
  check(
    JSON.stringify(memoryPreview.body.messages).includes('ZQXSUMMARYMARKER'),
    'and the summary reaches the request',
  );
  eq(memoryPreview.body.memoryState.since, 0, 'nothing is pending right after a summary');

  // Editing by hand replaces the text and recounts it.
  const edited = await api(`/api/chats/${memoryChatId}/memory`, json('PUT', { text: '手写的记忆。' }));
  eq(edited.body.record.text, '手写的记忆。', 'a hand edit replaces the summary');
  check(edited.body.record.tokens > 0, 'and is counted', `${edited.body.record.tokens}`);
  eq(edited.body.progress.since, 0, 'while leaving what it covers alone');

  // Freezing stops the automatic path without stopping the editor.
  const frozen = await api(`/api/chats/${memoryChatId}/memory`, json('PUT', { frozen: true }));
  eq(frozen.body.record.frozen, true, 'the summary can be frozen');
  eq(frozen.body.progress.due, false, 'which keeps it out of the automatic path');
  await api('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: memoryChatId, message: 'And the tide?' }),
  });
  const frozenTurn = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: memoryChatId, message: 'Still the tide?' }),
  });
  const frozenDone = (await frozenTurn.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as any)
    .find((event) => event.type === 'done');
  eq(frozenDone.memory.due, false, 'a frozen summary is never reported as due');
  eq(
    (await api(`/api/chats/${memoryChatId}/memory/summarize`, json('POST', {}))).status,
    400,
    'and the automatic call is refused while frozen',
  );
  eq(
    (await api(`/api/chats/${memoryChatId}/memory/summarize`, json('POST', { force: true }))).status,
    200,
    'while the explicit button still works',
  );
  await api(`/api/chats/${memoryChatId}/memory`, json('PUT', { frozen: false }));

  // The provider failing is the user's problem to see, not a broken transcript.
  // A fresh turn first: the tests above summarised everything there was.
  await api('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: memoryChatId, message: 'One more thing.' }),
  });
  summaryFails = true;
  const beforeFailure = (await api(`/api/chats/${memoryChatId}/memory`)).body.record.text;
  const failed = await api(`/api/chats/${memoryChatId}/memory/summarize`, json('POST', { force: true }));
  eq(failed.status, 500, 'a failing summariser reports an error');
  check(
    String(failed.body.error).includes('bad day'),
    'with the provider message passed through',
    String(failed.body.error),
  );
  eq(
    (await api(`/api/chats/${memoryChatId}/memory`)).body.record.text,
    beforeFailure,
    'and the previous summary is kept',
  );
  summaryFails = false;

  // A summary of nothing is refused, and forgetting never deletes messages.
  eq(
    (await api(`/api/chats/${memoryChatId}/memory/summarize`, json('POST', {}))).status,
    200,
    'the turn the failure left behind summarises on the next try',
  );
  const noPending = await api(`/api/chats/${memoryChatId}/memory/summarize`, json('POST', {}));
  eq(noPending.status, 400, 'summarising with nothing new is refused');
  const memoryCleared = await api(`/api/chats/${memoryChatId}/memory`, { method: 'DELETE' });
  eq(memoryCleared.body.record, null, 'forgetting clears the record');
  check(
    (await api(`/api/chats/${memoryChatId}`)).body.entries.length > 2,
    'while the transcript keeps every message',
  );
  eq(
    (await api('/api/prompt/preview', json('POST', { chatId: memoryChatId }))).body.memory,
    null,
    'and the block stops being injected',
  );

  // SillyTavern keeps its summary in `extra.memory` on a message, so a log must
  // carry ours that way and take it back on import.
  await api(`/api/chats/${memoryChatId}/memory`, json('PUT', { text: 'ST 那边的记忆。' }));
  const memoryExport = await (await fetch(`${base}/api/chats/${memoryChatId}/export`)).text();
  const exportedLines = memoryExport.trim().split('\n').map((line) => JSON.parse(line));
  const carrier = exportedLines.filter((line) => line.extra && line.extra.memory);
  eq(carrier.length, 1, 'exactly one exported line carries extra.memory');
  eq(carrier[0].extra.memory, 'ST 那边的记忆。', 'with the summary in it');
  const reimported = await api('/api/chats/import?characterId=memory-probe&name=memory-reimport', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: memoryExport,
  });
  eq(reimported.status, 200, 'the exported log imports again');
  eq(reimported.body.memory, 'ST 那边的记忆。', 'and the summary comes back with it');
  const reimportedView = (await api(`/api/chats/${reimported.body.id}/memory`)).body;
  eq(reimportedView.progress.covered > 0, true, 'anchored to the message it covered');
  eq(
    (await api(`/api/chats/${memoryChatId}/memory`, json('PUT', { nope: 1 }))).status,
    400,
    'an empty memory patch is refused',
  );

  // -------------------------------------------------------------------------
  section('trajectory');
  // -------------------------------------------------------------------------

  const traceCard = await api('/api/characters/import?name=trace-probe', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: readFileSync(join(corpus, 'owned', 'cards', 'osk.png')),
  });
  eq(traceCard.status, 200, 'a card for the trajectory suite imports');
  const traceChat = await api('/api/chats', json('POST', { characterId: 'trace-probe' }));
  const traceChatId = traceChat.body.id as string;
  const trace = () => api(`/api/chats/${traceChatId}/trace`);

  eq((await trace()).body.events.length, 0, 'a new chat has an empty trajectory');
  eq((await trace()).body.stats.turns, 0, 'and no turns counted');

  const traceTurn = (message: string) =>
    fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: traceChatId, message }),
    }).then((response) => response.text());

  await traceTurn('第一句');
  const firstTrace = (await trace()).body;
  eq(firstTrace.events.length, 1, 'one request leaves one row');
  const firstTurn = firstTrace.events[0];
  eq(firstTurn.type, 'turn', 'of the turn kind');
  eq(firstTurn.model, memoryConfig.body.model, 'recording which model answered');
  eq(firstTurn.trigger, 'normal', 'and how it was triggered');
  check(firstTurn.durationMs >= 0, 'with a measured duration', `${firstTurn.durationMs}`);
  check(firstTurn.firstTokenMs !== null, 'and the wait for the first token', `${firstTurn.firstTokenMs}`);
  eq(firstTurn.promptTokens, 100, 'the provider usage is recorded');
  eq(firstTurn.completionTokens, 20, 'on both sides');
  check(String(firstTurn.entryId).startsWith('m'), 'attached to the message it produced', `${firstTurn.entryId}`);
  check(Array.isArray(firstTurn.messages) && firstTurn.messages.length > 0, 'with the messages that were sent');
  eq(firstTurn.failed, null, 'and no failure');
  eq(firstTrace.stats.turns, 1, 'the stats count it');
  eq(firstTrace.stats.promptTokens, 100, 'and add up the prompt tokens');
  eq(firstTrace.bodyTurns, 1, 'the body is still retained');

  // A regeneration is a different trigger, and it produces a variant rather than
  // a new message — the trace says so instead of looking like an ordinary turn.
  const reRoll = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: traceChatId, regenerate: true }),
  });
  await reRoll.text();
  const afterReRoll = (await trace()).body;
  eq(afterReRoll.stats.turns, 2, 'a regeneration is another request');
  eq(afterReRoll.events[1].trigger, 'regenerate', 'recorded as such');

  // Continue and impersonate are their own triggers too.
  const traceContinue = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: traceChatId, mode: 'continue' }),
  });
  await traceContinue.text();
  const traceImpersonate = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: traceChatId, mode: 'impersonate' }),
  });
  await traceImpersonate.text();
  const afterModes = (await trace()).body;
  const triggers = afterModes.events.filter((event: any) => event.type === 'turn').map((event: any) => event.trigger);
  check(triggers.includes('continue'), 'a continuation is recorded as such', triggers.join(','));
  check(triggers.includes('impersonate'), 'so is an impersonation', triggers.join(','));

  // A failure has no message to attach itself to, which is exactly why it needs a
  // row of its own.
  await api('/api/config', json('PUT', { baseUrl: 'http://127.0.0.1:1/v1' }));
  await traceTurn('这一句会失败');
  const afterFail = (await trace()).body;
  const failRow = afterFail.events.filter((event: any) => event.type === 'turn').pop();
  eq(failRow.entryId, null, 'a failed request produced no message');
  check(String(failRow.failed).length > 0, 'and says why', String(failRow.failed));
  eq(failRow.chars, 0, 'with nothing generated');
  eq(afterFail.stats.failures, 1, 'the stats count the failure');
  await api('/api/config', json('PUT', { baseUrl: `http://127.0.0.1:${fakePort}/v1` }));

  // The other things worth a row: memory, edits, deletions, forks.
  await api('/api/config', json('PUT', { memory: { enabled: true, interval: 1 } }));
  await api(`/api/chats/${traceChatId}/memory/summarize`, json('POST', {}));
  const afterMemory = (await trace()).body;
  const memoryRow = afterMemory.events.find((event: any) => event.type === 'memory');
  check(Boolean(memoryRow), 'a memory update is on the timeline');
  check(String(memoryRow.detail).includes('ZQXSUMMARYMARKER'), 'with what it wrote', String(memoryRow.detail));

  const entryToEdit = (await api(`/api/chats/${traceChatId}`)).body.entries[1];
  await api(`/api/chats/${traceChatId}/entries/${entryToEdit.id}`, json('PATCH', { content: '改过的内容' }));
  await api(`/api/chats/${traceChatId}/entries/${entryToEdit.id}`, { method: 'DELETE' });
  const afterEdits = (await trace()).body;
  const kinds = afterEdits.events.map((event: any) => event.type);
  check(kinds.includes('edit'), 'an edit is on the timeline', kinds.join(','));
  check(kinds.includes('delete'), 'so is a deletion', kinds.join(','));
  eq(
    afterEdits.events.find((event: any) => event.type === 'delete').detail,
    '改过的内容',
    'and the deletion remembers what was lost',
  );
  const fork = await api(`/api/chats/${traceChatId}/fork`, json('POST', {}));
  check(
    (await api(`/api/chats/${fork.body.id}/trace`)).body.events.some((event: any) => event.type === 'fork'),
    'a fork starts its own trajectory saying where it came from',
  );

  // Only the newest turns keep their request body; older turns keep their numbers.
  for (let index = 0; index < 22; index++) await traceTurn(`填充 ${index}`);
  const pruned = (await trace()).body;
  const traceTurns = pruned.events.filter((event: any) => event.type === 'turn');
  check(traceTurns.length > 20, 'the numbers of every turn are kept', `${traceTurns.length}`);
  eq(traceTurns[traceTurns.length - 1].messages !== undefined, true, 'the newest turn still carries its body');
  eq(traceTurns[0].messages, undefined, 'an old turn no longer carries its body');
  eq(pruned.bodyTurns, 20, 'and exactly the retention window is kept', `${pruned.bodyTurns}`);
  check(pruned.stats.turns === traceTurns.length, 'the stats still count every turn');

  // A hand-edited file costs its own line, not the file.
  const traceFile = join(dataDir, 'chats', `${traceChatId}.trace.jsonl`);
  writeFileSync(traceFile, `${readFileSync(traceFile, 'utf8')}{"nonsense":true}\n`);
  eq((await trace()).status, 200, 'a broken line does not break the trajectory');
  check((await trace()).body.events.length > 0, 'and the rest of the file still loads');

  eq(
    (await api(`/api/chats/${traceChatId}/trace`, { method: 'DELETE' })).body.events.length,
    0,
    'the trajectory can be forgotten',
  );
  check(
    (await api(`/api/chats/${traceChatId}`)).body.entries.length > 0,
    'without touching the conversation',
  );

  // -------------------------------------------------------------------------
  section('vector storage');
  // -------------------------------------------------------------------------

  const vectorCard = await api('/api/characters/import?name=vector-probe', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: readFileSync(join(corpus, 'owned', 'cards', 'osk.png')),
  });
  eq(vectorCard.status, 200, 'a card for the vector suite imports');
  const vectorWorld = await api('/api/worlds/import?name=vector-book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: readFileSync(join(corpus, 'owned', 'st-native', 'full-fields.json')),
  });
  eq(vectorWorld.status, 200, 'a world book for the vector suite imports');
  const vectorChat = await api('/api/chats', json('POST', { characterId: 'vector-probe' }));
  const vectorChatId = vectorChat.body.id as string;
  await api(`/api/chats/${vectorChatId}/worlds`, json('POST', { worldId: 'vector-book', attached: true }));

  const vectors = () => api('/api/vectors');
  const vectorBook = () => vectors().then((result) => result.body.books.find((book: any) => book.id === 'vector-book'));

  // Off by default: nothing is searched, and the prompt is what it always was.
  const offPreview = await api('/api/prompt/preview', json('POST', { chatId: vectorChatId, pendingUserMessage: 'lantern' }));
  eq(offPreview.body.vectors.enabled, false, 'vector storage starts switched off');
  eq(
    (offPreview.body.itemization ?? []).flatMap((block: any) => block.worldHits ?? []).filter((hit: any) => hit.activatedBy === 'external').length,
    0,
    'so nothing is activated by meaning',
  );

  // Two endpoints, one of which is in use. The switch is what picks it.
  const remote = await api('/api/config', json('PUT', {
    retrieval: { mode: 'vector' },
    vector: {
      enabled: true,
      mode: 'remote',
      remote: { baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: 'k', model: 'fake-embed' },
    },
  }));
  eq(remote.body.vector.mode, 'remote', 'the endpoint in use can be switched');
  eq(
    remote.body.vector.local.baseUrl.includes('11434'),
    true,
    'and the other endpoint is kept, not wiped',
    remote.body.vector.local.baseUrl,
  );
  const tested = await api('/api/vectors/test', json('POST', {}));
  eq(tested.body.ok, true, 'the embedding endpoint answers the connection test');
  eq(tested.body.dims, EMBED_DIMS, 'and reports its width', `${tested.body.dims}`);

  // Nothing is marked yet: the book has entries, none of them vectorized.
  const beforeMarking = await vectorBook();
  eq(beforeMarking.marked, 0, 'an unmarked book has nothing to index');
  const bookDetail = await api('/api/worlds/vector-book');
  // Pick entries that can actually be embedded: content, and not disabled. An
  // empty or disabled entry has nothing to say, marked or not.
  const embeddable = bookDetail.body.entries.filter(
    (entry: any) => String(entry.content ?? '').trim() !== '' && entry.disable !== true,
  );
  const entriesOfBook = embeddable.slice(0, 3);
  eq(entriesOfBook.length, 3, 'the fixture book has three embeddable entries');
  const disabledEntry = bookDetail.body.entries.find((entry: any) => entry.disable === true);
  if (disabledEntry) {
    await api(`/api/worlds/vector-book/entries/${disabledEntry.uid}`, json('PATCH', { vectorized: true }));
    eq(
      (await vectorBook()).marked,
      0,
      'an entry that is marked but disabled is still not a candidate',
    );
  }
  for (const entry of entriesOfBook) {
    eq(
      (await api(`/api/worlds/vector-book/entries/${entry.uid}`, json('PATCH', { vectorized: true }))).status,
      200,
      `entry ${entry.uid} can be marked for vector storage`,
    );
  }
  const afterMarking = await vectorBook();
  eq(afterMarking.marked, 3, 'marking three entries marks three');
  eq(afterMarking.stale, 3, 'and all three need a vector');

  const indexed = await api('/api/worlds/vector-book/vectorize', json('POST', {}));
  eq(indexed.body.embedded, 3, 'indexing embeds what is missing');
  eq(indexed.body.dims, EMBED_DIMS, 'at the endpoint’s width');
  eq(indexed.body.requests, 1, 'in a single batched request');
  eq(indexed.body.status.stale, 0, 'leaving nothing behind');
  eq(indexed.body.status.indexed, 3, 'and three ready entries');

  // A query is ranked by meaning, and the preview says which entries it brought.
  const vectorProbe = await api('/api/vectors/query', json('POST', { text: 'lantern district harbourmaster ledger' }));
  eq(vectorProbe.body.ok, true, 'a query runs');
  check(vectorProbe.body.hits.length > 0, 'and finds something', JSON.stringify(vectorProbe.body.hits.slice(0, 2)));
  check(
    vectorProbe.body.hits[0].score > vectorProbe.body.hits[vectorProbe.body.hits.length - 1].score,
    'best first',
    JSON.stringify(vectorProbe.body.hits.map((hit: any) => Number(hit.score.toFixed(3)))),
  );
  check(vectorProbe.body.hits[0].comment !== '', 'with the entry comment from the book, not the index');

  const hitPreview = await api('/api/prompt/preview', json('POST', { chatId: vectorChatId, pendingUserMessage: 'lantern district harbourmaster ledger' }));
  const externalHits = (hitPreview.body.itemization ?? [])
    .flatMap((block: any) => block.worldHits ?? [])
    .filter((hit: any) => hit.activatedBy === 'external');
  check(externalHits.length > 0, 'the preview activates entries by meaning', JSON.stringify(hitPreview.body.vectors));
  check(
    externalHits.every((hit: any) => typeof hit.score === 'number'),
    'with the similarity carried into the itemization',
  );
  check(hitPreview.body.vectors.ms >= 0, 'and the time the search took', `${hitPreview.body.vectors.ms}`);
  check(
    externalHits.every((hit: any) => hit.matchedKeys.length === 0),
    'without claiming any keyword matched',
  );

  // Editing one entry makes exactly that one stale.
  await api(`/api/worlds/vector-book/entries/${entriesOfBook[0].uid}`, json('PATCH', { content: '完全换掉的内容。' }));
  const afterEntryEdit = await vectorBook();
  eq(afterEntryEdit.stale, 1, 'editing an entry makes exactly one entry stale');
  eq(afterEntryEdit.indexed, 2, 'the other two stay usable');
  const reindexed = await api('/api/worlds/vector-book/vectorize', json('POST', {}));
  eq(reindexed.body.embedded, 1, 're-indexing embeds only the changed entry');

  // Changing the model invalidates the whole index rather than comparing vectors
  // from two different spaces.
  await api('/api/config', json('PUT', { vector: { remote: { model: 'other-embed' } } }));
  const outdated = await vectorBook();
  eq(outdated.outdated, true, 'another model makes the index outdated');
  eq(outdated.indexed, 0, 'so nothing counts as usable');
  await api('/api/config', json('PUT', { vector: { remote: { model: 'fake-embed' } } }));

  // The endpoint being down costs the semantic search, not the turn.
  failEmbeddings = true;
  const deadPreview = await api('/api/prompt/preview', json('POST', { chatId: vectorChatId, pendingUserMessage: 'lantern' }));
  check(
    (deadPreview.body.warnings ?? []).some((warning: any) => warning.code === 'vector.failed'),
    'a dead embedding endpoint is reported as a warning',
    JSON.stringify(deadPreview.body.warnings),
  );
  check((deadPreview.body.messages ?? []).length > 0, 'while the request is still assembled');
  const deadTurn = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: vectorChatId, message: '端点挂了也要能回答' }),
  });
  check((await deadTurn.text()).includes('"type":"saved"'), 'and the turn still completes');
  failEmbeddings = false;

  // Switching back to a local, unreachable endpoint gives the diagnostic that
  // matters: the chat provider is not an embedding provider.
  const localTest = await api('/api/vectors/test', json('POST', { mode: 'local' }));
  eq(localTest.body.ok, false, 'a local service that is not running fails the test');
  check(
    String(localTest.body.error).length > 0,
    'with a reason a user can act on',
    String(localTest.body.error),
  );

  eq(
    (await api('/api/worlds/vector-book/vectors', { method: 'DELETE' })).status,
    200,
    'an index can be forgotten',
  );
  eq((await vectorBook()).indexed, 0, 'leaving the book unindexed');
  eq(
    (await api('/api/worlds/vector-book')).body.entries.length,
    bookDetail.body.entries.length,
    'and the book itself untouched',
  );

  console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILURES'}  checks=${checks} failed=${failures}`);
} finally {
  await app.close().catch(() => {});
  fakeProvider.close();
  rmSync(dataDir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
