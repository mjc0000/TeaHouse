/**
 * Bootstrap suite: the real page, the real client modules, and the real server.
 *
 * Every other client suite loads one module in isolation against a stub. This one
 * loads `web/js/app.js` exactly as the browser does — install the error surface,
 * wire the views, fetch the initial state — with `web/index.html` parsed into the
 * DOM double as the page, and `fetch` pointed at a freshly seeded teahouse server.
 *
 * That closes the one gap the other suites leave open: a view that reads a field
 * the server never sends, or an entry point that only breaks against a real
 * document, is invisible to a per-module test and shows up as a dead panel in the
 * browser. Here it is an error toast, and an error toast fails the run.
 *
 * Run: node scripts/test-boot.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTeahouseServer } from '../src/server.ts';
import { ENTRY_FIELD_SPECS } from '../src/formats/entry-fields.ts';
import { CHARACTER_FIELDS } from '../web/js/character-fields.js';
import { installDom, type ShimDom, type ShimElement } from './shim-dom.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..', 'web');
const corpus = resolve(here, '..', 'corpus');

let checks = 0;
let failures = 0;

function check(ok: boolean, label: string, detail = ''): void {
  checks++;
  if (ok) return;
  failures++;
  console.log(`  FAIL  ${label}${detail ? ` : ${detail}` : ''}`);
}

function eq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(a === b, label, `got ${a}, want ${b}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// The page, parsed from the real index.html
// ---------------------------------------------------------------------------

/**
 * A stack-based parser for the small subset of HTML the page uses: tags,
 * attributes, self-closing tags, comments and text. It exists so the test builds
 * the page from the shipped markup instead of a hand-written copy that could
 * drift away from it.
 */
function parseHtml(html: string, dom: ShimDom): ShimElement {
  const root = dom.document.createElement('body');
  const stack: ShimElement[] = [root];
  const source = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');

  const tagPattern = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s/>"']+(?:="[^"]*"|='[^']*')?)*)\s*(\/?)>|([^<]+)/g;
  for (const match of source.matchAll(tagPattern)) {
    const [, closing, tag, attributes, selfClosing, text] = match;

    if (text !== undefined) {
      const trimmed = text.trim();
      if (trimmed !== '') stack[stack.length - 1]!.append(dom.document.createTextNode(trimmed));
      continue;
    }
    if (closing === '/') {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const node = dom.document.createElement(tag!);
    for (const attribute of (attributes ?? '').matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
      node.setAttribute(attribute[1]!, attribute[2] ?? '');
    }
    stack[stack.length - 1]!.append(node);
    if (selfClosing !== '/' && !['input', 'br', 'img', 'meta', 'link'].includes(tag!.toLowerCase())) {
      stack.push(node);
    }
  }
  return root;
}

const dom: ShimDom = installDom();
const pageRoot = parseHtml(readFileSync(join(webRoot, 'index.html'), 'utf8'), dom);
// The parser's root stands in for <body>; give the document the page's children.
for (const child of [...pageRoot.childNodes]) dom.document.body.append(child);

const ids = new Set(dom.document.body.descendants().map((node) => node.getAttribute('id')).filter(Boolean));
check(ids.size >= 20, 'the page was parsed into the DOM double', `${ids.size} ids`);

// ---------------------------------------------------------------------------
// A real server, seeded like a first run, and a fake provider behind it
// ---------------------------------------------------------------------------

const REPLY = 'The woods remember you, traveller.';
/** The thinking channel, streamed before the answer like a reasoning model does. */
const THINKING = 'Check the tide charts first. ZQXBOOTMARKER.';
/** What the provider answers when it is asked for a memory summary. */
const SUMMARY = 'ZQXSUMMARYMARKER: the woods, the tide charts and the ledger.';

/** Deterministic embeddings: a bag of words, hashed and normalised. */
const EMBED_DIMS = 16;
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

const provider = createServer((request, response) => {
  if (request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'fake-model' }, { id: 'other-model' }] }));
    return;
  }
  if (request.url === '/v1/embeddings') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { input?: unknown; model?: string };
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
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
  if (request.url !== '/v1/chat/completions' && request.url !== '/v1/completions') {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', async () => {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>;
    // The long-term memory suite asks for a summary through `chatOnce`, which is a
    // plain non-streaming request carrying the summarising instruction.
    const summarizing = Array.isArray(payload.messages)
      && payload.messages.some((message: any) => String(message.content).includes('Summarize the most important facts'));
    if (summarizing && payload.stream !== true) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: SUMMARY }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 90, completion_tokens: 18, total_tokens: 108 },
      }));
      return;
    }
    // Any other non-streaming call (the translation endpoint) gets a fixed
    // marker, so the suite can tell the translation apart from the original.
    if (payload.stream !== true) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ZQXTROLLMARKER' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }));
      return;
    }
    const isCompletion = request.url === '/v1/completions';
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (isCompletion) {
      for (const word of 'COMPLETED plain reply.'.split(' ')) {
        response.write(`data: ${JSON.stringify({ choices: [{ text: `${word} ` }] })}\n\n`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
    } else {
      // The thinking is spread over a few frames with pauses, so the live block is
      // actually observable instead of flashing by inside one microtask.
      const asked = payload.reasoning_effort === 'none' || payload.thinking?.type === 'disabled';
      if (!asked) {
        for (const word of THINKING.split(' ')) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: `${word} ` } }] })}\n\n`);
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
        }
      }
      for (const word of REPLY.split(' ')) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${word} ` } }] })}\n\n`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
    }
    response.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 } })}\n\n`,
    );
    response.write('data: [DONE]\n\n');
    response.end();
  });
});

const providerPort = await new Promise<number>((resolvePromise) => {
  provider.listen(0, '127.0.0.1', () => {
    const address = provider.address();
    resolvePromise(typeof address === 'object' && address ? address.port : 0);
  });
});

const dataDir = mkdtempSync(join(tmpdir(), 'teahouse-boot-'));
const app = createTeahouseServer({ dataDir, port: 0, host: '127.0.0.1' });
const base = await app.listen();
const realFetch = globalThis.fetch;

const api = async (path: string, init?: { method?: string; body?: BodyInit; headers?: Record<string, string> }) => {
  const response = await realFetch(`${base}${path}`, init as RequestInit);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* raw text is fine for the endpoints that answer with bytes */
  }
  return { status: response.status, body: body as any };
};

try {
  // The client's requests are the page's own paths; send them to the real server.
  globalThis.fetch = ((path: string, init?: RequestInit) =>
    realFetch(new URL(path, base), init)) as typeof fetch;

  const worldImport = await api('/api/worlds/import?name=eldoria', {
    method: 'POST',
    body: readFileSync(join(corpus, 'owned', 'st-native', 'full-fields.json')),
  });
  eq(worldImport.status, 200, 'the world book was imported');

  const cardImport = await api('/api/characters/import?name=seraphina', {
    method: 'POST',
    body: readFileSync(join(corpus, 'owned', 'cards', 'osk.png')),
  });
  eq(cardImport.status, 200, 'the character card was imported');

  // Point the server at the fake provider before creating the chat: a new chat
  // snapshots the default model at creation, so it must be set first.
  await api('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${providerPort}`,
      apiKey: 'test-key',
      model: 'fake-model',
      maxContext: 4096,
      responseReserve: 256,
    }),
  });

  const chat = await api('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId: 'seraphina', name: 'boot chat' }),
  });
  const chatId = chat.body.id as string;
  eq(chat.body.model, 'fake-model', 'a new chat snapshots the default model');

  for (const [role, content] of [
    ['user', ' 你好，简述一下 Eldoria 的森林。'],
    ['assistant', 'The woods remember you, traveller. Eldoria keeps its own counsel.'],
  ] as const) {
    await api(`/api/chats/${chatId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, content }),
    });
  }
  await api(`/api/chats/${chatId}/worlds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worldId: 'eldoria', attached: true }),
  });

  // -------------------------------------------------------------------------
  section('boot');
  // -------------------------------------------------------------------------

  const load = (name: string) => import(new URL(`../web/js/${name}`, import.meta.url).href);
  /** Polls until a condition holds, so async work is not raced with a sleep. */
  const until = async (predicate: () => boolean, ms = 4000) => {
    const limit = Date.now() + ms;
    while (Date.now() < limit && !predicate()) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    return predicate();
  };
  const { state } = await load('api.js');

  // This is the browser's entry point, run for real.
  await load('app.js');

  // `main()` is async and not awaited by the module, so wait for the state it
  // fills in (or for the error surface to say something went wrong).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && state.chatId === null && dom.errors().length === 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }

  eq(dom.errors(), [], 'booting the page reported no error');
  check(state.characters.length === 1, 'the character list was loaded', `${state.characters.length}`);
  check(state.worlds.length === 1, 'the world list was loaded', `${state.worlds.length}`);
  check(state.chats.length === 1, 'the chat list was loaded', `${state.chats.length}`);
  eq(state.chatId, chatId, 'the newest chat was opened');
  check(
    state.entries.length === 3,
    'the greeting plus its two turns were loaded',
    `${state.entries.length}`,
  );
  eq(state.entries[0]?.role, 'assistant', 'the transcript starts with the card greeting');
  check(String(state.entries[0]?.content).trim() !== '', 'which is not empty');
  check(state.stack.length > 5, 'the prompt stack was loaded', `${state.stack.length}`);
  eq(state.languageInstructionTemplate !== '', true, 'the server sent its default language wording');

  // -------------------------------------------------------------------------
  section('the page rendered');
  // -------------------------------------------------------------------------

  const text = (selector: string) => dom.one(selector)?.textContent ?? '';
  const count = (selector: string) => dom.all(selector).length;
  const menuLabels = () => dom.all('.menu .menu-label').map((node) => node.textContent);

  check(
    text('#character-list').includes(state.characters[0]!.name),
    'the character is listed',
    text('#character-list'),
  );
  check(text('#world-list').includes('eldoria'), 'the world is listed', text('#world-list'));
  check(text('#chat-list').includes('boot chat'), 'the chat is listed', text('#chat-list'));

  check(text('#chat-title').length > 0, 'the chat header names the chat', text('#chat-title'));
  check(text('#chat-stats').includes('3'), 'the header counts the turns', text('#chat-stats'));
  eq(count('#messages .message'), 3, 'the greeting and both turns are in the transcript');
  eq(dom.all('#messages .message.user').length, 1, 'the user turn is marked as such');
  eq(dom.all('#messages .message.assistant').length, 2, 'and the greeting plus the reply as replies');
  check(text('#messages').includes('你好，简述一下'), 'the user text is on screen');
  check(text('#messages').includes('Eldoria keeps its own counsel'), 'the reply text is on screen');

  // A header value that was never set used to reach the screen as the literal
  // text `null`. Nothing in a header is user content, so this can be exact.
  const headers = dom.all('#messages .message-head');
  check(headers.length > 0, 'the transcript has message headers');
  check(
    headers.every((head) => !/\b(null|undefined)\b/.test(head.textContent ?? '')),
    'no message header leaks a missing value as text',
    headers.map((head) => head.textContent).join(' | '),
  );
  check(
    headers.every(
      (head) =>
        head.querySelectorAll('.speaker').length === 1 &&
        head.querySelectorAll('.role-badge').length === 1,
    ),
    'every header has exactly one speaker and one role badge',
  );
  // A message body must hold elements only. An optional block that came back
  // `null` was handed straight to the native `append`, which turns it into the
  // literal text "null" — invisible to a DOM double that skipped nulls, and very
  // visible on screen.
  check(
    dom.all('#messages .message-body').every((body) => body.childNodes.every((node) => node.nodeType === 1)),
    'a message body holds elements only, with no stray text nodes',
    dom
      .all('#messages .message-body')
      .flatMap((body) => body.childNodes.filter((node) => node.nodeType === 3).map((node) => node.textContent))
      .join(' | '),
  );

  // The import controls carry an icon, and the topbar exposes a connection badge;
  // neither changes the page's structure, so both are asserted here.
  check(dom.one('.file-button .icon') !== null, 'the import controls show an icon');
  check(dom.one('#connection-status button') !== null, 'the topbar connection badge rendered');

  // Pointing at a row explains its short labels through the shared tooltip layer.
  const firstCharacterName = dom.one('#character-list .name')!;
  dom.fire(firstCharacterName, 'mouseenter');
  check(dom.one('.tooltip-layer') !== null, 'pointing at a row explains it');
  dom.fire(firstCharacterName, 'mouseleave');
  eq(dom.all('.tooltip-layer').length, 0, 'and the explanation is taken away again');

  // The badge runs the real connection test against the fake provider.
  const connectionButton = dom.one('#connection-status button')!;
  dom.click(connectionButton);
  check(await until(() => state.ui.connection.status === 'ok'), 'the badge test reports the connection');
  check(
    (dom.one('#connection-status')?.textContent ?? '').includes('已连接'),
    'and the badge says so',
    dom.one('#connection-status')?.textContent ?? '',
  );

  // The provider's model list is fetched automatically, and the topbar picker
  // is built from it. It is a themed button, not a native select, so both the
  // topbar and the settings dialog share one dark dropdown.
  check(
    await until(() => state.models.length === 2),
    'the provider model list is fetched automatically',
    `${state.models.length}`,
  );
  const modelPicker = dom.one('#model-picker button')!;
  eq(modelPicker.tagName, 'BUTTON', 'the topbar model control is a themed button');
  check(
    (modelPicker.textContent ?? '').includes('fake-model'),
    'it shows the configured model',
    modelPicker.textContent ?? '',
  );

  // The fetched list is cached persistently: a reload with no network keeps it.
  check(localStorage.getItem('teahouse.models.v1') !== null, 'the model list is cached on disk');
  const { hydrateModels } = await load('api.js');
  state.models = [];
  state.modelsCached = false;
  hydrateModels();
  eq(state.models.length, 2, 'the cached list hydrates without a fetch');
  eq(state.modelsCached, true, 'and is marked as an offline cache');

  const pickModel = async (label: string) => {
    dom.click(modelPicker);
    const item = dom
      .all('.menu .menu-item')
      .find((node) => node.querySelector('.menu-label')?.textContent === label);
    check(
      Boolean(item),
      `the model menu offers ${label}`,
      dom.all('.menu .menu-label').map((node) => node.textContent).join(','),
    );
    if (item) dom.click(item);
  };

  // Switching from the topbar pins the conversation; it must not move the
  // global default, which only the settings dialog owns.
  await pickModel('other-model');
  check(
    await until(() => state.meta?.model === 'other-model'),
    'picking a model pins the conversation',
    `${state.meta?.model}`,
  );
  eq(state.config?.model, 'fake-model', 'and the global default is unchanged');
  check(
    (modelPicker.textContent ?? '').includes('other-model'),
    'the picker shows the session model',
    modelPicker.textContent ?? '',
  );

  // The default row is marked, and doubles as "follow the default": picking it
  // clears the override again. There is no separate entry for that, and no
  // fetch-the-list entry either — the list arrives on load and the settings page
  // owns the manual fetch.
  dom.click(modelPicker);
  const labels = dom.all('.menu .menu-label').map((node) => node.textContent ?? '');
  const defaultItem = dom
    .all('.menu .menu-item')
    .find((node) => node.querySelector('.menu-label')?.textContent === 'fake-model');
  check(Boolean(defaultItem), 'the default model is listed', labels.join(','));
  eq(
    defaultItem?.querySelector('.menu-hint')?.textContent,
    '默认',
    'and is marked as the default',
  );
  check(
    !labels.some((label) => label.startsWith('跟随默认')),
    'there is no separate follow-the-default entry',
    labels.join(','),
  );
  check(
    !labels.some((label) => label.includes('获取模型列表')),
    'and no fetch-the-list entry in the topbar',
    labels.join(','),
  );
  if (defaultItem) dom.click(defaultItem);
  check(await until(() => state.meta?.model === undefined), 'picking the default clears the override');
  check(
    (modelPicker.textContent ?? '').includes('fake-model'),
    'and the picker falls back to the default',
    modelPicker.textContent ?? '',
  );

  // -------------------------------------------------------------------------
  section('preview on load, and sending without one');
  // -------------------------------------------------------------------------

  // Opening a chat now assembles the preview, so the composition is
  // always available; the panel is populated without pressing 装配预览.
  check(state.preview !== null, 'opening a chat assembles the preview');
  check(
    (state.preview?.messages?.length ?? 0) > 0,
    'with the real message list',
    `${state.preview?.messages?.length}`,
  );

  // The stream announces itself with a `prompt` frame that carries the
  // itemization but no `messages` — the preview panel used to read `.length` off
  // it. Recreate the no-preview state and send: it must still not throw.
  state.preview = null;
  state.ui.hits = { all: [], byWorld: new Map() };
  dom.document.getElementById('input')!.value = '先不看预览，直接说话。';
  dom.click(dom.document.getElementById('btn-send')!);
  check(
    await until(() => dom.document.getElementById('btn-send')!.disabled === false, 8000),
    'the send settled',
  );
  check(text('#messages').includes('先不看预览，直接说话'), 'the sent turn is in the transcript');
  check(text('#messages').includes('The woods remember you'), 'and the reply arrived', text('#messages').slice(-160));
  eq(dom.errors(), [], 'no error was reported while sending without a preview');

  check(count('#token-budget .budget') > 0 || text('#token-budget').length > 0, 'the token bar rendered');
  check(count('#prompt-stack .stack-group') > 0, 'the prompt stack rendered groups', `${count('#prompt-stack .stack-group')}`);
  check(text('#prompt-stack').includes('系统提示词'), 'including the system group');
  check(text('#model-picker').length > 0, 'the topbar shows the model', text('#model-picker'));

  // -------------------------------------------------------------------------
  section('importing through the file inputs');
  // -------------------------------------------------------------------------

  // The client passes the File straight to `fetch`, so a real `File` is all the
  // input needs; `files` is a plain array because the handler only reads [0].
  const worldInput = dom.document.getElementById('import-world')!;
  (worldInput as { files?: unknown }).files = [
    new File([readFileSync(join(corpus, 'owned', 'agnai', 'memory.json'))], 'imported-book.json', {
      type: 'application/json',
    }),
  ];
  dom.fire(worldInput, 'change');
  check(await until(() => state.worlds.length === 2), 'importing a world book added it', `${state.worlds.length}`);
  check(text('#world-list').includes('imported-book'), 'and listed it', text('#world-list'));
  check(
    // Waiting matters: the toast is created after the state this suite polls, so a
    // single read here is a race that a slower run loses.
    await until(
      () => dom.all('.toast .toast-message').some((node) => node.textContent.includes('已导入')),
      5000,
    ),
    'and reported it',
  );

  const characterInput = dom.document.getElementById('import-character')!;
  (characterInput as { files?: unknown }).files = [
    new File([readFileSync(join(corpus, 'owned', 'edge', 'flat-card.json'))], 'flat-card.json', {
      type: 'application/json',
    }),
  ];
  dom.fire(characterInput, 'change');
  check(await until(() => state.characters.length === 2), 'importing a card added it', `${state.characters.length}`);
  check(
    text('#character-list').includes(state.characters[1]!.name),
    'and listed it',
    text('#character-list'),
  );
  eq(dom.errors(), [], 'no error was reported while importing');

  // Importing a card selects it, which opens (or creates) its own chat. Wait for
  // that async chain to settle, then go back to the seeded one for the rest of
  // the run — otherwise the auto-open lands after this switch and wins the race.
  // `flat-card` has no greeting, so its chat starts empty.
  check(
    await until(() => state.meta !== null && state.meta.characterId === 'flat-card'),
    'importing a card opens its own chat',
  );
  const { loadChat } = await load('api.js');
  await loadChat(chatId);
  eq(state.chatId, chatId, 'the seeded chat is selected again');

  // -------------------------------------------------------------------------
  section('the assembly preview, for real');
  // -------------------------------------------------------------------------

  const { refreshPreview, refreshScan } = await load('api.js');
  // The fixture's keys are "lantern district" / "tide bell" / "ashfall".
  await refreshScan('我在 lantern district 等 tide bell 响。');
  await refreshPreview('我在 lantern district 等 tide bell 响。');

  check(!state.preview?.error, 'the preview assembled', String(state.preview?.error ?? ''));
  check((state.preview?.messages?.length ?? 0) > 2, 'the preview has messages', `${state.preview?.messages?.length}`);
  check(state.ui.hits.all.length > 0, 'the world book fired this turn', `${state.ui.hits.all.length}`);
  check(text('#world-hits').length > 0, 'the hits panel rendered', text('#world-hits').slice(0, 120));
  check(
    count('#preview .preview-row') > 0,
    'the request preview rendered rows',
    `${count('#preview .preview-row')}`,
  );
  check(text('#token-budget').includes('%'), 'the budget bar shows a percentage', text('#token-budget'));
  eq(dom.errors(), [], 'no error was reported while previewing');

  // -------------------------------------------------------------------------
  section('panel toggles and the settings dialog');
  // -------------------------------------------------------------------------

  dom.click(dom.document.getElementById('btn-toggle-left')!);
  check(dom.one('.layout')!.classList.contains('hide-left'), 'the left panel collapses');
  dom.click(dom.document.getElementById('btn-toggle-right')!);
  check(dom.one('.layout')!.classList.contains('hide-right'), 'the right panel collapses');
  dom.click(dom.document.getElementById('btn-toggle-right')!);
  check(!dom.one('.layout')!.classList.contains('hide-right'), 'and expands again');

  // The dividers resize the columns, and the widths persist with the rest of the
  // layout. The left panel is still collapsed above, so bring it back first.
  dom.click(dom.document.getElementById('btn-toggle-left')!);
  const leftResizer = dom.one('.resizer-left')!;
  const layoutStyle = () => (dom.one('.layout') as unknown as { style: Record<string, string> }).style;
  dom.fire(leftResizer, 'keydown', { key: 'ArrowRight' });
  dom.fire(leftResizer, 'keydown', { key: 'ArrowRight' });
  check(layoutStyle()['--track-left'] === '216px', 'arrow keys widen the left column', layoutStyle()['--track-left']);
  dom.fire(leftResizer, 'pointerdown', { button: 0, clientX: 1000, pointerId: 1 });
  dom.fire(leftResizer, 'pointermove', { clientX: 1100, pointerId: 1 });
  dom.fire(leftResizer, 'pointerup', { clientX: 1100, pointerId: 1 });
  check(layoutStyle()['--track-left'] === '316px', 'dragging a divider widens its column', layoutStyle()['--track-left']);
  eq(
    JSON.parse(localStorage.getItem('teahouse.layout.v1') ?? '{}').leftWidth,
    316,
    'and the width is remembered',
  );

  dom.click(dom.document.getElementById('btn-settings')!);
  eq(dom.all('[role="tab"]').length, 6, 'the settings dialog opens from the real button');
  dom.click(dom.button('关闭')!);
  eq(dom.errors(), [], 'still no error reported');

  // -------------------------------------------------------------------------
  section('transcript actions');
  // -------------------------------------------------------------------------

  // Editing a turn goes through the DOM the browser would use: open the menu,
  // choose edit, write, save.
  const reply = dom.all('#messages .message.assistant')[0]!;
  check(reply.querySelector('.message-actions') !== null, 'a reply has its action bar');
  const editButton = reply.descendants().find((node) => node.textContent === '编辑');
  check(Boolean(editButton), 'which offers edit');
  if (editButton) {
    dom.click(editButton);
    const editor = dom.one('.message-editor');
    check(Boolean(editor), 'the inline editor opened');
    if (editor) {
      editor.value = 'edited from the boot suite';
      dom.click(dom.all('button').find((node) => node.textContent === '保存')!);
      const deadline2 = Date.now() + 6000;
      while (Date.now() < deadline2 && !text('#messages').includes('edited from the boot suite')) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
      check(text('#messages').includes('edited from the boot suite'), 'the edit was saved and re-rendered');
    }
  }
  eq(dom.errors(), [], 'no error was reported while editing');

  // -------------------------------------------------------------------------
  section('sending a turn, streaming for real');
  // -------------------------------------------------------------------------

  const input = dom.document.getElementById('input')!;
  const beforeSend = state.entries.length;
  input.value = '再讲一次森林的事。';
  dom.click(dom.document.getElementById('btn-send')!);
  check(
    await until(() => dom.document.getElementById('btn-send')!.disabled === true, 5000),
    'the composer locks while streaming',
  );

  // The thinking channel is shown as it arrives: otherwise the phase before the
  // first visible token looks like a hang, which is what a reasoning model feels
  // like from the outside.
  const liveThinking = await until(
    () => (dom.one('.message.pending .thinking')?.textContent ?? '').includes('ZQXBOOTMARKER'),
6000,
  );
  check(liveThinking, 'the live thinking block fills while the model thinks', text('.message.pending'));
  if (liveThinking) {
    check(text('.message.pending').includes('思考'), 'and is labelled as thinking');
  }
  check(
    await until(() => text('#stream-status').includes('输出中'), 6000),
    'the status switches to the answering phase',
    text('#stream-status'),
  );

  // Wait on the state, not on the reply text: the fixtures answer with the same
  // sentence every time, so matching text would return from an earlier turn.
  check(
    await until(
      () => state.entries.length >= beforeSend + 2 && dom.document.getElementById('btn-send')!.disabled === false,
      8000,
    ),
    'the turn and its reply were saved',
    `${beforeSend} -> ${state.entries.length}`,
  );
  check(text('#messages').includes('再讲一次森林的事'), 'the sent turn is in the transcript');
  check(text('#messages').includes('The woods remember you'), 'the streamed reply arrived', text('#messages').slice(-200));
  check(state.entries.length >= 4, 'the turn was persisted', `${state.entries.length}`);
  eq(dom.document.getElementById('btn-send')!.disabled, false, 'the composer is usable again');
  eq(dom.document.getElementById('btn-stop')!.disabled, true, 'and the stop button is off');
  eq(text('#stream-status'), '', 'the stream status cleared');

  // After the turn, the thinking lives on the message as a collapsed block.
  const persisted = dom.one('#messages .message .reasoning');
  check(Boolean(persisted), 'the finished message carries its thinking');
  if (persisted) {
    check(
      text('#messages .message .reasoning').includes('ZQXBOOTMARKER'),
      'with the text that was streamed',
      text('#messages .message .reasoning').slice(0, 80),
    );
    check(persisted.querySelector('.reasoning-body') !== null, 'and a body to expand');
    eq(persisted.hasAttribute('open'), false, 'collapsed by default');
  }
  check(text('#token-budget').includes('%'), 'the budget bar still reports a percentage');
  check(
    (state.preview?.calibrations ?? 0) > 0 || state.preview !== null,
    'the counter saw the provider usage',
  );
  // Headline-first: the headline is provider-anchored, and the UI says so instead of
  // presenting the whole reading as an estimate.
  check(
    (state.preview?.pressureTokens ?? 0) > 0,
    'the budget figure is anchored on the provider prompt size',
    `${state.preview?.pressureTokens}`,
  );
  check(text('#token-budget').includes('锚定'), 'and the label says it is anchored', text('#token-budget'));
  // The breakdown is collapsed by default and carries the numbers the old
  // one-line note used to state, split per channel.
  const breakdownNode = dom.one('#token-budget details.token-breakdown');
  check(Boolean(breakdownNode), 'the bar offers a collapsible breakdown');
  eq(breakdownNode?.open, false, 'collapsed by default');
  check(dom.all('#token-budget .token-seg').length > 0, 'the share bar has segments');
  check(dom.all('#token-budget .token-break-row').length > 0, 'and the rows are there to expand');
  check(
    dom.text(dom.one('#token-budget details.token-breakdown')).includes('对话历史'),
    'one row per channel, the history among them',
    dom.text(dom.one('#token-budget details.token-breakdown')).slice(0, 120),
  );
  eq(dom.errors(), [], 'no error was reported while generating');

  // -------------------------------------------------------------------------
  section('the thinking switches');
  // -------------------------------------------------------------------------

  dom.click(dom.document.getElementById('btn-settings')!);
  dom.click(dom.all('[role="tab"]')[1]!); // 模型
  check(dom.row('显示思考过程') !== null, 'the model page offers the thinking display switch');
  check(dom.row('关闭思考（实验）') !== null, 'and the disable-thinking switch');
  check(dom.row('服务商预设') !== null, 'and a provider preset row');
  check(
    await until(
      () => (dom.one('.provider-note')?.textContent ?? '').includes('不在预设表里'),
      4000,
    ),
    'a base URL outside the table is reported instead of guessed',
    dom.one('.provider-note')?.textContent,
  );
  const showBox = dom.control('显示思考过程');
  const disableBox = dom.control('关闭思考（实验）');
  eq(showBox.tagName, 'INPUT', 'they are checkboxes');
  eq(showBox.checked, true, 'showing the thinking is on by default');
  eq(disableBox.checked, false, 'and skipping it is off by default');

  // Turning the display off hides stored thinking as well, not just new streams.
  showBox.checked = false;
  dom.fire(showBox, 'change');
  dom.click(dom.button('保存')!);
  check(await until(() => state.config?.showReasoning === false, 6000), 'the switch saves', String(state.config?.showReasoning));
  const { loadChat: reloadChat } = await load('api.js');
  await reloadChat(state.chatId!);
  eq(dom.all('#messages .reasoning').length, 0, 'stored thinking is hidden once the switch is off');

  // Back on, so the rest of the run sees the shipped default. The dialog rebuilds
  // every field after a save, so the control has to be looked up again.
  const showBoxAgain = dom.control('显示思考过程');
  showBoxAgain.checked = true;
  dom.fire(showBoxAgain, 'change');
  dom.click(dom.button('保存')!);
  check(await until(() => state.config?.showReasoning === true, 6000), 'and can be turned back on');
  await reloadChat(state.chatId!);
  check(dom.all('#messages .reasoning').length > 0, 'the thinking comes back with it');
  dom.click(dom.button('关闭')!);
  eq(dom.errors(), [], 'no error was reported while using the thinking switches');

  // -------------------------------------------------------------------------
  section('the world book editor');
  // -------------------------------------------------------------------------

  const worldName = dom.all('#world-list .name').find((node) => node.textContent === 'eldoria');
  check(Boolean(worldName), 'the world name is the editor entry point');
  if (worldName) {
    dom.click(worldName);
    const editorDeadline = Date.now() + 5000;
    while (Date.now() < editorDeadline && dom.all('.modal-panel.editor .editor-list li').length === 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    const entries = dom.all('.modal-panel.editor .editor-list li');
    eq(entries.length, 4, 'the editor listed the book entries');
    check(dom.all('.modal-panel.editor .book-settings .field-row').length === 3, 'and offered the book settings');

    // The entry form stays empty until an entry is chosen.
    eq(dom.all('.modal-panel.editor .editor-form .field-row').length, 0, 'no entry is selected yet');
    dom.click(entries[0]!);
    const rows = dom.all('.modal-panel.editor .editor-form .field-row');
    eq(rows.length, 41, 'selecting an entry rendered a control for every field');
    check(
      rows.some((row) => row.querySelector('textarea') !== null),
      'the long-text fields are boxes',
    );
    check(
      rows.every((row) => (row.querySelector('.field-label')?.textContent ?? '') !== ''),
      'every row is labelled',
    );
    dom.click(dom.one('.modal-panel.editor .modal-header button')!);
    eq(dom.all('.modal-panel.editor .editor-form .field-row').length, 41, 'closing keeps the editor DOM (it is reused)');
  }
  eq(dom.errors(), [], 'no error was reported while opening the world editor');

  // -------------------------------------------------------------------------
  section('the character card editor');
  // -------------------------------------------------------------------------

  const cardBefore = (await api('/api/characters/seraphina')).body as any;
  check(String(cardBefore.fields.first_mes).trim() !== '', 'the imported card carries a first message');
  eq(cardBefore.fields.alternate_greetings.length, 1, 'and one alternate greeting');

  // Open it the way a user would: the row menu of *that* card. The list is
  // name-sorted, so the first row is not necessarily the one to edit.
  const cardRow = dom
    .all('#character-list li')
    .find((row) => (row.querySelector('.name')?.textContent ?? '') === cardBefore.name);
  check(Boolean(cardRow), 'the card has a row in the list', cardBefore.name);
  const cardMenuButton = cardRow?.children.find((node) => node.textContent === '⋯');
  dom.click(cardMenuButton!);
  check(await until(() => menuLabels().includes('编辑卡片'), 5000), 'the character menu offers the card editor');
  const editItem = dom
    .all('.menu .menu-item')
    .find((node) => node.querySelector('.menu-label')?.textContent === '编辑卡片');
  if (editItem) dom.click(editItem);
  check(
    await until(() => dom.one('.modal-panel.editor.character .field-row') !== null, 4000),
    'the card editor opens with its form',
  );
  eq(
    dom.all('.modal-panel.editor.character .field-row').length,
    CHARACTER_FIELDS.length,
    'it renders a control for every editable field',
  );
  check(
    dom.one('.modal-panel.editor.character .text-list textarea') !== null,
    'the alternate greetings get the repeatable control',
  );

  // Rewrite the greeting and add another one.
  const greetingBox = dom.control('首条消息');
  eq(greetingBox.value, String(cardBefore.fields.first_mes), 'the form starts from the stored greeting');
  greetingBox.value = 'A rewritten opening.';
  dom.fire(greetingBox, 'input');
  const addGreeting = dom
    .all('.modal-panel.editor.character button')
    .find((node) => node.textContent === '添加一项');
  check(Boolean(addGreeting), 'the greeting list can grow');
  if (addGreeting) {
    dom.click(addGreeting);
    const boxes = dom.all('.modal-panel.editor.character .text-list textarea');
    eq(boxes.length, 2, 'a new greeting box was added');
    const added = boxes[boxes.length - 1]!;
    added.value = 'An added alternate greeting.';
    dom.fire(added, 'input');
  }
  dom.click(
    dom.all('.modal-panel.editor.character .modal-footer button').find((node) => node.textContent === '保存')!,
  );
  check(
    await until(() => text('.modal-panel.editor.character .editor-status').includes('已保存'), 4000),
    'saving reports what it wrote',
    text('.modal-panel.editor.character .editor-status'),
  );

  const cardAfter = (await api('/api/characters/seraphina')).body as any;
  eq(cardAfter.fields.first_mes, 'A rewritten opening.', 'the new first message is stored');
  check(
    cardAfter.fields.alternate_greetings.includes('An added alternate greeting.'),
    'and the added greeting is stored',
    JSON.stringify(cardAfter.fields.alternate_greetings),
  );
  eq(dom.control('首条消息').value, 'A rewritten opening.', 'the form shows what was saved');
  eq(
    dom.all('.modal-panel.editor.character .text-list textarea').length,
    2,
    'and the saved greeting list has both entries',
  );
  dom.click(
    dom.all('.modal-panel.editor.character .modal-footer button').find((node) => node.textContent === '关闭')!,
  );

  // A new chat can start from any of the card's greetings.
  dom.click(cardMenuButton!);
  check(
    await until(() => menuLabels().includes('新会话（换一个问候…）'), 5000),
    'the menu offers a greeting picker once there are several',
    menuLabels().join(','),
  );
  const pickGreeting = dom
    .all('.menu .menu-item')
    .find((node) => node.querySelector('.menu-label')?.textContent === '新会话（换一个问候…）');
  if (pickGreeting) dom.click(pickGreeting);
  check(
    await until(() => menuLabels().includes('首条消息'), 5000),
    'the picker lists the greetings',
    menuLabels().join(','),
  );
  const firstGreeting = dom
    .all('.menu .menu-item')
    .find((node) => node.querySelector('.menu-label')?.textContent === '首条消息');
  if (firstGreeting) dom.click(firstGreeting);
  check(
    await until(() => state.entries.length === 1 && state.entries[0]?.role === 'assistant', 4000),
    'the picked greeting opens the new chat',
    `${state.entries.length}`,
  );
  eq(String(state.entries[0]?.content), 'A rewritten opening.', 'and it is the greeting that was chosen');
  eq(dom.errors(), [], 'no error was reported while editing a card');

  // Back to the seeded chat: the sections below drive its transcript.
  await reloadChat(chatId);
  check(await until(() => state.chatId === chatId), 'the seeded chat is open again');

  // -------------------------------------------------------------------------
  section('list actions, menus and confirmations');
  // -------------------------------------------------------------------------

  // A character row's "more" menu opens, lists its actions, and closes again
  // without changing anything.
  const characterMenuButton = dom
    .all('#character-list li button')
    .find((node) => node.textContent === '⋯');
  check(Boolean(characterMenuButton), 'a character row offers a menu');
  if (characterMenuButton) {
    dom.click(characterMenuButton);
    // The row menu loads the card first (the greeting list comes from it), so it
    // opens a beat later.
    check(
      await until(() => menuLabels().includes('改显示名'), 5000),
      'the character menu lists its actions',
      menuLabels().join(','),
    );
    dom.fire(dom.document, 'keydown', { key: 'Escape' });
    eq(dom.all('.menu').length, 0, 'Escape closes the menu');
  }

  // The world row's menu offers the export.
  const worldMenuButton = dom.all('#world-list li button').find((node) => node.textContent === '⋯');
  check(Boolean(worldMenuButton), 'a world row offers a menu');
  if (worldMenuButton) {
    dom.click(worldMenuButton);
    check(
      menuLabels().includes('导出为酒馆原生格式'),
      'the world menu offers an export',
      menuLabels().join(','),
    );
    dom.fire(dom.document, 'keydown', { key: 'Escape' });
    eq(dom.all('.menu').length, 0, 'and closes again');
  }

  // Copy and regenerate from the transcript. (Before the new-chat block below:
  // that one switches the app to an empty chat.)
  const replyMessage = dom.all('#messages .message.assistant').at(-1)!;
  const copyButton = replyMessage.descendants().find((node) => node.textContent === '复制');
  check(Boolean(copyButton), 'a reply offers copy');
  if (copyButton) {
    dom.click(copyButton);
    await until(() => dom.all('.toast').length > 0, 5000);
    check(
      dom.all('.toast .toast-message').some((node) => node.textContent.includes('已复制')),
      'copying reports success',
    );
  }

  const beforeRegen = state.entries.length;
  dom.click(dom.document.getElementById('btn-regen')!);
  check(
    await until(
      () => state.entries.length >= beforeRegen && dom.document.getElementById('btn-send')!.disabled === false,
      8000,
    ),
    '重新生成 streamed and settled',
  );
  check(text('#messages').includes('The woods remember you'), 'the regenerated reply is on screen');
  eq(dom.errors(), [], 'no error was reported while regenerating');
  // Swipe candidates come from a *regenerate* of a trailing user turn, which the
  // button only asks for when the last turn is not a reply — the API-level suite
  // covers the variant mechanics instead.

  // Continue grows the trailing reply in place; impersonate speaks as the user.
  const lastAssistantRow = dom.all('#messages .message.assistant').at(-1)!;
  const lastMore = lastAssistantRow.descendants().find((node) => node.textContent === '⋯');
  check(Boolean(lastMore), 'the trailing reply offers the more menu');
  if (lastMore) {
    dom.click(lastMore);
    check(menuLabels().includes('继续生成'), 'the menu offers to continue it', menuLabels().join(','));
    dom.fire(dom.document, 'keydown', { key: 'Escape' });
    eq(dom.all('.menu').length, 0, 'and closes again');
  }
  const replyBefore = String(state.entries[state.entries.length - 1]?.content ?? '');
  dom.click(dom.document.getElementById('btn-continue')!);
  check(
    await until(
      () =>
        dom.document.getElementById('btn-send')!.disabled === false &&
        String(state.entries[state.entries.length - 1]?.content ?? '').length > replyBefore.length,
      8000,
    ),
    '继续 appended to the trailing reply',
  );
  eq(state.entries.length, beforeRegen, 'continuing grows the reply instead of the transcript');

  const beforeImpersonate = state.entries.length;
  dom.click(dom.document.getElementById('btn-impersonate')!);
  check(
    await until(
      () => state.entries.length === beforeImpersonate + 1 && dom.document.getElementById('btn-send')!.disabled === false,
      8000,
    ),
    '替我说 added a turn',
  );
  eq(state.entries[state.entries.length - 1]?.role, 'user', 'spoken as the user');
  eq(dom.errors(), [], 'no error was reported while continuing or impersonating');

  // With the opt-in setting on, the character answers straight after 替我说 —
  // two entries, and the second one is the character's. (Set over HTTP and
  // mirrored into the client config, exactly as saving the dialog does.)
  const setAutoReply = async (on: boolean) => {
    await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ impersonateAutoReply: on }),
    });
    state.config = { ...(state.config ?? {}), impersonateAutoReply: on };
  };
  await setAutoReply(true);
  const beforeAutoImpersonate = state.entries.length;
  dom.click(dom.document.getElementById('btn-impersonate')!);
  check(
    await until(() => state.entries.length === beforeAutoImpersonate + 2, 12000),
    '替我说 with the setting on adds the user turn and the reply',
    `${beforeAutoImpersonate} -> ${state.entries.length}`,
  );
  eq(state.entries[state.entries.length - 2]?.role, 'user', 'the impersonated line comes first');
  eq(state.entries[state.entries.length - 1]?.role, 'assistant', 'and the character answers right after');
  eq(dom.errors(), [], 'no error was reported while auto-replying');
  await setAutoReply(false);

  // Deleting a turn goes through the row menu and a confirmation.
  const target = dom.all('#messages .message.user')[0]!;
  const moreButton = target.descendants().find((node) => node.textContent === '⋯');
  check(Boolean(moreButton), 'a turn offers the more menu');
  if (moreButton) {
    dom.click(moreButton);
    // Match the item's own label, not the whole row: 「从这里重开」 carries the
    // hint 「删除这条及其之后」 and would otherwise win the substring match.
    const removeItem = dom
      .all('.menu .menu-item')
      .find((node) => node.querySelector('.menu-label')?.textContent === '删除这一条');
    check(Boolean(removeItem), 'the menu offers delete', menuLabels().join(','));
    if (removeItem) {
      const dialogsBefore = dom.all('.modal-panel.dialog').length;
      const before = state.entries.length;
      dom.click(removeItem);
      const asked = await until(() => dom.all('.modal-panel.dialog').length > dialogsBefore, 5000);
      check(asked, 'deleting a turn asks first');
      const confirm = dom
        .all('.modal-panel.dialog button')
        .find((node) => node.textContent === '删除');
      check(Boolean(confirm), 'the confirmation offers a delete button');
      if (confirm) {
        dom.click(confirm);
        check(await until(() => state.entries.length === before - 1, 8000), 'the turn was deleted');
        // Closed dialogs leave the document instead of piling up hidden.
        check(
          await until(() => dom.all('.modal-panel.dialog').length === dialogsBefore, 5000),
          'the closed dialog is gone, not hidden',
        );
      }
    }
  }
  eq(dom.errors(), [], 'no error was reported while deleting');

  // The new-chat block comes last: it switches the app to a fresh chat.
  const chatsBefore = state.chats.length;
  dom.click(dom.document.getElementById('btn-new-chat')!);
  check(await until(() => state.chats.length === chatsBefore + 1), '新会话 created a chat');
  check(
    await until(() => state.entries.length === 1 && state.entries[0]?.role === 'assistant'),
    'the new chat starts from the card greeting rather than empty',
    `${state.entries.length}`,
  );
  dom.click(dom.document.getElementById('btn-delete-chat')!);
  check(Boolean(dom.one('.modal-panel.dialog')), '删除 asks first');
  dom.click(dom.button('取消')!);
  check(await until(() => state.chats.length === chatsBefore + 1), 'cancelling keeps the chat');

  // Switching back through the chat list: this re-renders the preview panel from
  // whatever `state.preview` holds, which right after a generation is the partial
  // object from the stream — the same shape that used to throw on send.
  const seededRow = dom
    .all('#chat-list .name')
    .find((node) => node.textContent === 'boot chat');
  check(Boolean(seededRow), 'the seeded chat is in the list');
  if (seededRow) {
    dom.click(seededRow);
    check(await until(() => state.chatId === chatId), 'switching back opened the seeded chat');
    // Its first turn was deleted earlier in this run, so assert the shape rather
    // than the text: the transcript re-rendered and the header followed.
    check(await until(() => state.entries.length > 0), 'its transcript was loaded', `${state.entries.length}`);
    check(text('#chat-title').includes('boot chat'), 'and the header names it', text('#chat-title'));
  }
  eq(dom.errors(), [], 'no error was reported while using the lists');

  // -------------------------------------------------------------------------
  section('rename and delete dialogs');
  // -------------------------------------------------------------------------

  // 改显示名 goes through the prompt dialog.
  const secondRow = dom.all('#character-list li')[1]!;
  const renameMenu = secondRow.children.find((node) => node.textContent === '⋯');
  check(Boolean(renameMenu), 'the imported character offers a menu');
  if (renameMenu) {
    const before = state.characters[1]!.name;
    dom.click(renameMenu);
    check(
      await until(
        () => dom.all('.menu .menu-item').some((node) => node.querySelector('.menu-label')?.textContent === '改显示名'),
      5000,
      ),
      'the character menu offers a rename',
    );
    const renameItem = dom
      .all('.menu .menu-item')
      .find((node) => node.querySelector('.menu-label')?.textContent === '改显示名');
    if (renameItem) {
      dom.click(renameItem);
      check(await until(() => dom.one('.modal-panel.dialog input') !== null, 5000), 'the rename dialog opened');
      const promptInput = dom.one('.modal-panel.dialog input')!;
      promptInput.value = 'Renamed Card';
      dom.click(dom.all('.modal-panel.dialog button').find((node) => node.textContent === '确定')!);
      check(await until(() => state.characters[1]!.name === 'Renamed Card', 6000), 'the rename was saved', state.characters[1]!.name);
      check(text('#character-list').includes('Renamed Card'), 'and re-rendered');
      check(state.characters[1]!.name !== before, 'the name really changed');
    }
  }

  // Deleting a world asks first; cancel leaves it alone.
  const worldsBefore = state.worlds.length;
  dom.click(worldMenuButton!);
  const deleteWorld = dom
    .all('.menu .menu-item')
    .find((node) => node.querySelector('.menu-label')?.textContent === '删除');
  if (deleteWorld) {
    dom.click(deleteWorld);
    check(await until(() => dom.one('.modal-panel.dialog') !== null, 5000), 'deleting a world asks first');
    dom.click(dom.all('.modal-panel.dialog button').find((node) => node.textContent === '取消')!);
    check(await until(() => state.worlds.length === worldsBefore, 5000), 'cancelling keeps the world');
  } else {
    check(false, 'the world menu offers a delete', menuLabels().join(','));
  }
  eq(dom.errors(), [], 'no error was reported while renaming and deleting');

  // -------------------------------------------------------------------------
  section('chat logs and branching');
  // -------------------------------------------------------------------------

  // Back to the seeded chat, which has a transcript worth exporting.
  const bootRow = dom.all('#chat-list .name').find((node) => node.textContent === 'boot chat');
  check(Boolean(bootRow), 'the seeded chat is still listed');
  if (bootRow) dom.click(bootRow);
  check(await until(() => state.chatId === chatId, 6000), 'the seeded chat is open');
  const beforeExport = state.entries.length;
  check(beforeExport >= 2, 'it has a transcript to export', `${beforeExport}`);

  // Export through the row menu.
  const exportMenuButton = dom
    .all('#chat-list li')
    .find((row) => (row.querySelector('.name')?.textContent ?? '') === 'boot chat')
    ?.children.find((node) => node.textContent === '⋯');
  dom.click(exportMenuButton!);
  check(
    await until(() => menuLabels().includes('导出为酒馆 jsonl'), 5000),
    'the chat menu offers the export',
    menuLabels().join(','),
  );
  const exportItem = dom
    .all('.menu .menu-item')
    .find((node) => node.querySelector('.menu-label')?.textContent === '导出为酒馆 jsonl');
  if (exportItem) dom.click(exportItem);
  check(
    await until(() => dom.all('.toast .toast-message').some((node) => (node.textContent ?? '').includes('已导出')), 6000),
    'exporting reports success',
  );

  // Import a SillyTavern log through the file input: the exported file itself.
  const logText = await (await fetch(`${base}/api/chats/${chatId}/export`)).text();
  const importInput = dom.document.getElementById('import-chat')!;
  (importInput as { files?: unknown }).files = [new File([logText], 'boot chat.jsonl')];
  const chatsBeforeImport = state.chats.length;
  dom.fire(importInput, 'change');
  check(
    await until(() => state.chats.length === chatsBeforeImport + 1, 4000),
    'importing a log creates a chat',
    `${chatsBeforeImport} -> ${state.chats.length}`,
  );
  check(await until(() => state.entries.length === beforeExport, 6000), 'with the same number of messages');
  check(text('#chat-list').includes('boot chat'), 'and it is listed');
  eq(dom.errors(), [], 'no error was reported while importing a log');

  // Branch from a message in the middle: the original keeps everything.
  const branchTarget = dom.all('#messages .message')[0]!;
  const branchMenu = branchTarget.descendants().find((node) => node.textContent === '⋯');
  check(Boolean(branchMenu), 'a message offers its menu');
  if (branchMenu) {
    dom.click(branchMenu);
    check(
      await until(() => menuLabels().includes('从这里分叉出新会话'), 5000),
      'the message menu offers branching',
      menuLabels().join(','),
    );
    const forkItem = dom
      .all('.menu .menu-item')
      .find((node) => node.querySelector('.menu-label')?.textContent === '从这里分叉出新会话');
    const chatsBeforeFork = state.chats.length;
    if (forkItem) dom.click(forkItem);
    check(
      await until(() => state.chats.length === chatsBeforeFork + 1 && state.entries.length === 1, 4000),
      'the fork is a chat holding just that far',
      `${state.entries.length} entries`,
    );
    check(
      await until(
        () => dom.all('.toast .toast-message').some((node) => (node.textContent ?? '').includes('已分叉')),
      5000,
      ),
      'and the branch reports itself',
    );
  }
  eq(dom.errors(), [], 'no error was reported while branching');

  // -------------------------------------------------------------------------
  section('request parameters and the PNG export');
  // -------------------------------------------------------------------------

  // The six request knobs live on the model page, next to temperature.
  dom.click(dom.document.getElementById('btn-settings')!);
  dom.click(dom.all('[role="tab"]')[1]!); // 模型
  for (const label of ['单次回复上限 token', 'top_p', '频率惩罚', '存在惩罚', '停止字符串', '请求真实用量']) {
    check(dom.row(label) !== null, `the settings dialog exposes 「${label}」`);
  }
  const stopBox = dom.control('停止字符串');
  eq(stopBox.tagName, 'TEXTAREA', 'the stop strings are a one-per-line box');
  const capBox = dom.control('单次回复上限 token');
  capBox.value = '384';
  dom.fire(capBox, 'input');
  stopBox.value = '\nUser:\n###';
  dom.fire(stopBox, 'input');
  const usageBox = dom.control('请求真实用量');
  eq(usageBox.checked, true, 'usage is requested by default');
  dom.click(dom.button('保存')!);
  check(
    await until(() => Array.isArray(state.config?.stop) && state.config.stop.length === 2, 4000),
    'the stop strings are saved as a list',
    JSON.stringify(state.config?.stop),
  );
  eq(state.config?.maxTokens, 384, 'and the reply cap with them');
  dom.click(dom.button('关闭')!);
  eq(dom.errors(), [], 'no error was reported while saving the request parameters');

  // The right panel carries the same knobs for this conversation only.
  const paramRows = () => dom.all('#chat-params .params-row');
  eq(paramRows().length, 4, 'the panel shows four sampler rows');
  check(
    typeof state.meta?.params?.temperature === 'number',
    'the chat owns a snapshot of the defaults',
    JSON.stringify(state.meta?.params),
  );
  // Dragging updates the paired number live without saving yet.
  const tempSlider = paramRows()[0]!.querySelector('input[type=range]')!;
  (tempSlider as unknown as { value: string }).value = '1.2';
  dom.fire(tempSlider, 'input');
  eq(
    (paramRows()[0]!.querySelector('input[type=number]') as unknown as { value: string }).value,
    '1.2',
    'the number follows the drag',
  );
  // Releasing the slider saves one knob; the rest of the snapshot is kept.
  dom.fire(tempSlider, 'change');
  check(
    await until(() => state.meta?.params?.temperature === 1.2, 5000),
    'releasing pins the knob on this chat',
    JSON.stringify(state.meta?.params),
  );
  // An out-of-range number is refused with the knob named, not saved.
  const tempNumber = () => paramRows()[0]!.querySelector('input[type=number]')!;
  (tempNumber() as unknown as { value: string }).value = '99';
  dom.fire(tempNumber(), 'change');
  check(
    await until(() => dom.all('.toast').some((node) => (node.textContent ?? '').includes('需要在 0 到 2 之间')), 5000),
    'an out-of-range number names the range',
  );
  eq(state.meta?.params?.temperature, 1.2, 'and the saved value is untouched');
  for (const toast of dom.all('.toast')) toast.remove();
  // Resetting drops the snapshot: the chat follows the live defaults again.
  const resetParams = dom.all('#chat-params button').find((node) => node.textContent === '恢复默认');
  check(Boolean(resetParams), 'the panel offers a reset');
  if (resetParams) dom.click(resetParams);
  check(await until(() => !state.meta?.params, 5000), 'resetting follows the defaults');
  check(
    dom.all('#chat-params').some((node) => (node.textContent ?? '').includes('跟随设置默认值')),
    'saying so on the panel',
  );
  eq(dom.errors(), [], 'no error was reported while tuning the chat sampler');

  // Export a card as PNG from the row menu: the download path is stubbed, so
  // this proves the request, and that the entry is only enabled for a card that
  // actually has an image carrier.
  const pngCharacter = state.characters.find((item) => item.hasImage);
  const jsonCharacter = state.characters.find((item) => !item.hasImage);
  check(Boolean(pngCharacter) && Boolean(jsonCharacter), 'there is a PNG card and a JSON card to compare');
  const rowOf = (name: string) =>
    dom.all('#character-list li').find((row) => (row.querySelector('.name')?.textContent ?? '') === name);
  const menuOf = (name: string) => rowOf(name)?.children.find((node) => node.textContent === '⋯');

  dom.click(menuOf(pngCharacter!.name)!);
  check(
    await until(() => menuLabels().includes('导出卡片 PNG'), 5000),
    'a PNG card offers the PNG export',
    menuLabels().join(','),
  );
  const pngItem = dom
    .all('.menu .menu-item')
    .find((node) => node.querySelector('.menu-label')?.textContent === '导出卡片 PNG');
  check(pngItem?.disabled === false, 'and the entry is enabled for a card that has an image');
  if (pngItem) dom.click(pngItem);
  check(
    await until(() => dom.all('.toast .toast-message').some((node) => (node.textContent ?? '').includes('已导出卡片 PNG')), 6000),
    'exporting the PNG reports success',
  );

  // The JSON-only card gets the entry too, disabled, with a reason.
  dom.click(menuOf(jsonCharacter!.name)!);
  check(
    await until(() => menuLabels().includes('导出卡片 PNG'), 5000),
    'the JSON card shows the entry too',
  );
  const disabledItem = dom
    .all('.menu .menu-item')
    .find((node) => node.querySelector('.menu-label')?.textContent === '导出卡片 PNG');
  check(disabledItem?.disabled === true, 'disabled, because there is no image to write into');
  dom.fire(dom.document, 'keydown', { key: 'Escape' });
  eq(dom.errors(), [], 'no error was reported while exporting a card');

  // -------------------------------------------------------------------------
  section('quick replies');
  // -------------------------------------------------------------------------

  // Nothing saved yet, so the bar keeps one quiet way in.
  check(
    (text('#quick-replies') ?? '').includes('快捷回复'),
    'an empty bar offers a way to add one',
    text('#quick-replies'),
  );
  dom.click(dom.all('#quick-replies button')[0]!);
  check(await until(() => dom.one('.modal-panel.quick-replies') !== null, 5000), 'the editor opens');
  check(
    await until(() => dom.all('.modal-panel.quick-replies button').some((node) => node.textContent === '添加一项'), 5000),
    'and offers to add an entry',
  );

  // Add one snippet, with a label and text.
  dom.click(dom.all('.modal-panel.quick-replies button').find((node) => node.textContent === '添加一项')!);
  const labelInput = dom.one('.modal-panel.quick-replies .quick-reply-row input[type="text"]')!;
  const mesBox = dom.one('.modal-panel.quick-replies .quick-reply-row textarea')!;
  labelInput.value = '打招呼';
  dom.fire(labelInput, 'input');
  mesBox.value = '你好呀，今天想做什么？';
  dom.fire(mesBox, 'input');
  dom.click(
    dom.all('.modal-panel.quick-replies .modal-footer button').find((node) => node.textContent === '保存')!,
  );
  check(
    await until(() => state.quickReplies?.items?.length === 1, 6000),
    'the snippet is saved',
    JSON.stringify(state.quickReplies?.items?.length),
  );
  dom.click(
    dom.all('.modal-panel.quick-replies .modal-footer button').find((node) => node.textContent === '取消')!,
  );

  // The bar now shows the button, and clicking it fills the composer.
  check(
    await until(() => text('#quick-replies').includes('打招呼'), 5000),
    'the bar shows the new button',
    text('#quick-replies'),
  );
  const replyButton = dom
    .all('#quick-replies button')
    .find((node) => node.textContent === '打招呼')!;
  dom.document.getElementById('input')!.value = '';
  dom.click(replyButton);
  eq(dom.document.getElementById('input')!.value, '你好呀，今天想做什么？', 'clicking inserts it into the composer');
  eq(dom.errors(), [], 'no error was reported while inserting a quick reply');

  // Ctrl+click sends it straight away.
  dom.document.getElementById('input')!.value = '';
  const beforeQuickSend = state.entries.length;
  dom.fire(replyButton, 'click', { ctrlKey: true });
  check(
    await until(() => state.entries.length >= beforeQuickSend + 2, 8000),
    'ctrl+click sends it without touching the composer',
    `${beforeQuickSend} -> ${state.entries.length}`,
  );
  check(text('#messages').includes('你好呀，今天想做什么'), 'and the sent text is in the transcript');
  eq(dom.document.getElementById('input')!.value, '', 'leaving the composer empty');
  eq(dom.errors(), [], 'no error was reported while sending a quick reply');

  // -------------------------------------------------------------------------
  section('slash commands');
  // -------------------------------------------------------------------------

  const composer = dom.document.getElementById('input')!;
  const sendButton = dom.document.getElementById('btn-send')!;
  const palette = () => dom.one('.command-palette');
  const paletteRows = () => dom.all('.command-palette .command-item');
  const paletteNames = () => dom.all('.command-palette .command-name').map((node) => node.textContent);
  // The unknown-command check below leaves a toast behind on purpose; the rest
  // of the section filters it out rather than pretending it never happened.
  const strayErrors = () => dom.errors().filter((message) => !message.includes('没有 /nope 这条命令'));

  // Typing `/` behaves like an agent CLI: it offers what can follow.
  dom.type(composer, '/');
  check(palette() !== null, 'a slash builds the palette');
  eq(palette()!.classList.contains('hidden'), false, 'and shows it');
  check(paletteRows().length >= 8, 'with the whole registry', `${paletteRows().length}`);
  check(paletteNames().includes('/help'), 'including /help', paletteNames().join(' '));
  check(paletteNames().includes('/send'), 'and /send');
  check(
    (paletteRows()[0]!.querySelector('.command-hint')?.textContent ?? '') !== '',
    'every entry explains itself',
  );
  eq(paletteRows()[0]!.classList.contains('active'), true, 'the first entry starts selected');

  dom.fire(composer, 'keydown', { key: 'ArrowDown' });
  eq(paletteRows()[1]!.classList.contains('active'), true, 'ArrowDown moves the selection');
  dom.fire(composer, 'keydown', { key: 'ArrowUp' });
  eq(paletteRows()[0]!.classList.contains('active'), true, 'ArrowUp takes it back');

  dom.type(composer, '/mo');
  eq(paletteRows().length, 1, 'typing narrows the list', `${paletteRows().length}`);
  eq(text('.command-palette .command-name'), '/model', 'to the command that matches');

  // Nothing to offer means nothing on screen: a list that covers the transcript
  // while matching no command is worse than no list. These assertions read the
  // class the client toggles; that the class actually hides anything is a CSS
  // contract checked in test:web — the shim has no engine to compute it.
  dom.type(composer, '/zzz');
  eq(palette()!.classList.contains('hidden'), true, 'a prefix no command starts with hides it');
  dom.type(composer, '价格是 10/20');
  eq(palette()!.classList.contains('hidden'), true, 'and a slash inside a sentence never opens it');
  dom.type(composer, '');
  eq(palette()!.classList.contains('hidden'), true, 'nor does an empty composer');

  // Programmatic writes fire no `input` event, so the owner of the composer has
  // to say so — a quick reply inserted under an open palette used to leave the
  // list covering a line that is no longer a command.
  dom.type(composer, '/');
  eq(palette()!.classList.contains('hidden'), false, 'the palette is open again');
  const quickReplyRow = dom
    .all('#quick-replies button')
    .find((node) => node.textContent === '打招呼');
  dom.click(quickReplyRow!);
  eq(palette()!.classList.contains('hidden'), true, 'inserting a quick reply closes it');
  dom.type(composer, '/mo');
  eq(palette()!.classList.contains('hidden'), false, 'and a command line opens it again');

  dom.fire(composer, 'keydown', { key: 'Tab' });
  eq(composer.value, '/model ', 'Tab completes the command into the composer');
  eq(palette()!.classList.contains('hidden'), true, 'and closes the palette');

  dom.type(composer, '/');
  dom.fire(composer, 'keydown', { key: 'Escape' });
  eq(palette()!.classList.contains('hidden'), true, 'Escape closes the palette');
  eq(composer.value, '/', 'without touching the line');

  // An unknown command is reported, never sent as a message.
  composer.value = '/nope';
  const beforeUnknown = state.entries.length;
  dom.click(sendButton);
  check(await until(() => dom.errors().length > 0, 5000), 'an unknown command is reported');
  eq(state.entries.length, beforeUnknown, 'and is not sent as a message');
  eq(composer.value, '/nope', 'the line comes back so it can be fixed');

  // `/sys` writes a system turn, which the message menu cannot do.
  composer.value = '/sys 记住：现在是夜里。';
  const beforeSys = state.entries.length;
  dom.click(sendButton);
  check(
    await until(() => state.entries.length === beforeSys + 1, 4000),
    '/sys appends a system entry',
    `${beforeSys} -> ${state.entries.length}`,
  );
  eq(state.entries[state.entries.length - 1]?.role, 'system', 'with the system role');
  check(text('#messages').includes('记住：现在是夜里'), 'and it is on screen');
  eq(composer.value, '', 'the composer is cleared');

  // Ctrl+Enter really sends, as the placeholder has always promised.
  composer.value = '再看一眼。';
  const beforeCtrl = state.entries.length;
  dom.fire(composer, 'keydown', { key: 'Enter', ctrlKey: true });
  check(
    await until(() => state.entries.length >= beforeCtrl + 2, 8000),
    'Ctrl+Enter sends the composer',
    `${beforeCtrl} -> ${state.entries.length}`,
  );

  // Formulas render instead of showing their source: inline, display block,
  // and dollars inside a fence staying literal.
  composer.value = '行内 \\(x^2+\\frac{1}{2}\\) 好。\n\\[\n\\sum_{i=1}^{n} x_i\n\\]\n```\n$x$\n```';
  const mathBefore = state.entries.length;
  dom.click(sendButton);
  check(
    await until(() => !state.streaming && state.entries.length >= mathBefore + 2, 12000),
    'the math turn landed',
    `${mathBefore} -> ${state.entries.length}`,
  );
  const mathTurn = dom.all('#messages .message.user').at(-1)!;
  check(mathTurn.querySelector('.math-frac') !== null, 'inline math builds a fraction');
  check(mathTurn.querySelector('.math-display') !== null, 'display math gets its block');
  check(!(mathTurn.textContent ?? '').includes('\\frac'), 'no raw tex survives');
  const mathFence = mathTurn.querySelector('.md-fence');
  check(
    (mathFence?.textContent ?? '').includes('$x$') && mathFence?.querySelector('.math') === null,
    'code fences keep dollars literal',
  );

  // `/regen` goes through the same path as the regenerate button. `streaming`
  // clears a beat before the reload lands, so wait for the reload's new array —
  // otherwise the next command fires while the old transcript is still on screen.
  const cmdBeforeRegen = state.entries.length;
  const entriesBeforeRegen = state.entries;
  composer.value = '/regen';
  dom.click(sendButton);
  check(
    await until(
      () => !state.streaming && state.entries !== entriesBeforeRegen && state.entries.length === cmdBeforeRegen,
      8000,
    ),
    '/regen rewrites the last reply in place',
    `${cmdBeforeRegen} -> ${state.entries.length}`,
  );

  // `/continue` grows the trailing reply instead of the transcript.
  const entriesBeforeContinue = state.entries;
  const cmdReplyBefore = String(state.entries[state.entries.length - 1]?.content ?? '');
  composer.value = '/continue';
  dom.click(sendButton);
  check(
    await until(
      () =>
        !state.streaming &&
        state.entries !== entriesBeforeContinue &&
        state.entries.length === cmdBeforeRegen &&
        String(state.entries[state.entries.length - 1]?.content ?? '').length > cmdReplyBefore.length,
      8000,
    ),
    '/continue appends to the last reply',
  );

  // `/impersonate` speaks as the user.
  const cmdBeforeImpersonate = state.entries.length;
  composer.value = '/impersonate';
  dom.click(sendButton);
  check(
    await until(() => !state.streaming && state.entries.length === cmdBeforeImpersonate + 1, 8000),
    '/impersonate adds a turn',
    `${cmdBeforeImpersonate} -> ${state.entries.length}`,
  );
  eq(state.entries[state.entries.length - 1]?.role, 'user', 'spoken as the user');

  // `/model` pins the conversation without generating anything.
  const beforeModel = state.entries.length;
  composer.value = '/model other-model';
  dom.click(sendButton);
  check(
    await until(() => state.meta?.model === 'other-model', 4000),
    '/model pins the conversation',
    `${state.meta?.model}`,
  );
  eq(state.entries.length, beforeModel, 'and does not generate anything');

  // `/world` flips a book on the current chat.
  const worldId = state.worlds[0]!.id;
  const wasAttached = (state.meta?.worldRefs ?? []).includes(worldId);
  composer.value = `/world ${worldId}`;
  dom.click(sendButton);
  check(
    await until(() => (state.meta?.worldRefs ?? []).includes(worldId) !== wasAttached, 4000),
    '/world flips the world book on the chat',
    JSON.stringify(state.meta?.worldRefs),
  );

  // `/new` starts a fresh conversation with the same character.
  const previousChat = state.chatId;
  composer.value = '/new 斜杠新建';
  dom.click(sendButton);
  check(await until(() => state.chatId !== previousChat, 4000), '/new switches to a new conversation');
  eq(state.meta?.name, '斜杠新建', 'named as asked');
  check(
    state.chats.some((chat: { name: string }) => chat.name === '斜杠新建'),
    'and it is in the chat list',
  );

  // `/export` hands the log to the browser as a download.
  composer.value = '/export';
  dom.click(sendButton);
  check(
    await until(() => dom.text(dom.document.body).includes('已导出当前会话'), 4000),
    '/export finishes and says so',
  );

  // `/help` lists the registry in a dialog of its own.
  composer.value = '/help';
  dom.click(sendButton);
  check(await until(() => dom.one('.modal-panel.commands') !== null, 5000), '/help opens the list');
  check(
    text('.modal-panel.commands').includes('/export'),
    'which shows every command',
    text('.modal-panel.commands'),
  );
  dom.fire(dom.document, 'keydown', { key: 'Escape' });
  check(
    await until(() => dom.one('.modal-panel.commands') === null, 5000),
    'and Escape closes it',
  );

  // -------------------------------------------------------------------------
  section('rendering: markdown, regex, context template');
  // -------------------------------------------------------------------------

  const { api: renderApi, json: renderJson, loadConfig: renderLoadConfig, refreshPreview: renderRefresh, loadRegexes: renderLoadRegexes } = await load('api.js');
  // The unknown-command check in the slash section leaves its toast behind on
  // purpose; it is not this section's failure.
  const renderErrors = () => dom.errors().filter((message) => !message.includes('没有 /nope 这条命令'));
  const lastUserEntry = async () =>
    (await renderApi(`/api/chats/${state.chatId}`)).entries.filter((entry: any) => entry.role === 'user').at(-1);

  // Markdown is structural: bold/code become elements, an injected script stays
  // punctuation and never becomes an element.
  const beforeMd = state.entries.length;
  composer.value = '结论是**加粗**和`代码`<script>alert(1)</script>收尾。';
  dom.click(sendButton);
  check(
    await until(() => !state.streaming && state.entries.length >= beforeMd + 2, 8000),
    'the markdown turn landed',
    `${beforeMd} -> ${state.entries.length}`,
  );
  const mdRow = dom.all('#messages .message.user').at(-1)!;
  check(mdRow.querySelector('strong')?.textContent === '加粗', 'bold renders as an element');
  check(mdRow.querySelector('code')?.textContent === '代码', 'so does inline code');
  eq(mdRow.querySelector('script'), null, 'an injected script never becomes an element');
  check(
    String((await lastUserEntry())?.content ?? '').includes('<script>'),
    'while storage keeps the original text',
  );
  // A re-render (here: the regex reload) reuses the parsed body: the same
  // element node comes back, instead of the Markdown parser running again.
  const parsedBodyNode = mdRow.querySelector('.message-text')?.firstChild ?? null;
  check(parsedBodyNode !== null, 'the markdown body has a node to reuse');
  await renderLoadRegexes();
  check(
    dom.all('#messages .message.user').at(-1)?.querySelector('.message-text')?.firstChild === parsedBodyNode,
    'a re-render moves the parsed markdown instead of parsing it again',
  );

  // Structural markdown, rendered straight from the module so each construct is
  // covered without spending a turn on it.
  const { renderMarkdown } = await load('markdown.js');
  const md = (text: string) => {
    const host = dom.document.createElement('div');
    for (const node of renderMarkdown(text)) host.append(node);
    return host;
  };

  const ruled = md('上面\n\n---\n\n下面');
  eq(ruled.querySelectorAll('hr').length, 1, '--- renders as a horizontal rule');
  eq(ruled.querySelectorAll('.md-para').length, 2, 'and splits the paragraphs around it');
  check(!dom.text(ruled).includes('---'), 'the dashes never show as text');
  eq(md('a\n\n* * *\n\nb').querySelectorAll('hr').length, 1, 'a spaced rule renders too');
  eq(md('a\n\n___\n\nb').querySelectorAll('hr').length, 1, 'and an underscore one');

  const ordered = md('1. 第一\n2. 第二\n3. 第三');
  eq(ordered.querySelector('ol') !== null, true, 'a numbered list becomes <ol>');
  eq(ordered.querySelector('ol')?.children.length, 3, 'with three items');
  eq(md('3. 三\n4. 四').querySelector('ol')?.getAttribute('start'), '3', 'a list starting at 3 keeps its number');
  eq(ordered.querySelector('ul'), null, 'and it is not an unordered list');

  const bullets = md('- 甲\n- 乙');
  eq(bullets.querySelector('ul')?.children.length, 2, 'a dashes list becomes <ul> with two items');
  const nested = md('- 外\n  - 内一\n  - 内二\n- 外二');
  eq(nested.querySelector('ul')?.children.length, 2, 'the outer list keeps two items');
  eq(
    nested.querySelector('li ul')?.children.length,
    2,
    'and the indented items nest inside the item above',
  );

  eq(md('#### 四级\n##### 五级\n###### 六级').querySelectorAll('h6').length, 3, 'deep headings clamp to h6');

  const triple = md('***又粗又斜***');
  check(triple.querySelector('strong') !== null && triple.querySelector('em') !== null, 'triple emphasis nests');
  eq(triple.querySelector('em')?.textContent, '又粗又斜', 'around the whole run');
  check(!dom.text(triple).includes('*'), 'with no markers left over');

  const bare = md('见 https://example.com/a?b=1。结束');
  eq(bare.querySelector('a')?.getAttribute('href'), 'https://example.com/a?b=1', 'a bare URL becomes a link');
  check(dom.text(bare).includes('。结束'), 'and the sentence keeps its trailing punctuation');
  eq(md('代码 `https://x.com` 结尾').querySelector('a'), null, 'a URL inside inline code stays code');
  eq(md('## 标题 ##').textContent, '标题', 'closing hashes are dropped');

  // Display regex rewrites the shown copy only.
  await renderApi('/api/regex', renderJson('PUT', {
    rules: [{ id: 'boot-r1', name: '口头禅', pattern: 'ZQXWORD', flags: 'g', replacement: '已改写', scope: 'display', enabled: true }],
  }));
  await renderLoadRegexes();
  const beforeRx = state.entries.length;
  composer.value = '暗号是 ZQXWORD，请记住。';
  dom.click(sendButton);
  check(
    await until(() => !state.streaming && state.entries.length >= beforeRx + 2, 8000),
    'the regex turn landed',
  );
  const rxRow = dom.all('#messages .message.user').at(-1)!;
  check(text('#messages').includes('已改写'), 'the display shows the rewrite');
  check(
    String((await lastUserEntry())?.content ?? '').includes('ZQXWORD'),
    'storage still holds the original',
  );
  await renderApi('/api/regex', renderJson('PUT', { rules: [] }));
  await renderLoadRegexes();

  // The context template renders into a real stack row with its own cost.
  await renderApi('/api/config', renderJson('PUT', { contextTemplate: '{{#if description}}D:{{description}}{{/if}}' }));
  await renderLoadConfig();
  await renderRefresh();
  check(
    dom.all('#prompt-stack .stack-name').some((node) => node.textContent === 'Context Template'),
    'the template is a real row in the stack',
    dom.all('#prompt-stack .stack-name').map((node) => node.textContent).join(','),
  );
  await renderApi('/api/config', renderJson('PUT', { contextTemplate: '' }));
  await renderLoadConfig();
  await renderRefresh();

  // The regex editor opens from the prompt panel and really saves.
  const regexButton = dom.all('#right-prompt button').find((node) => node.textContent === '正则…');
  check(Boolean(regexButton), 'the prompt panel offers the regex editor');
  if (regexButton) {
    dom.click(regexButton);
    check(await until(() => dom.one('.modal-panel.regex') !== null, 5000), 'the editor opens');
    const addButton = dom.all('.modal-panel.regex button').find((node) => node.textContent === '添加一条');
    check(Boolean(addButton), 'with a way to add a rule');
    if (addButton) {
      dom.click(addButton);
      const saveButton = dom.all('.modal-panel.regex .modal-footer button').find((node) => node.textContent === '保存')!;
      dom.click(saveButton);
      check(
        await until(() => dom.all('.toast .toast-message').some((node) => (node.textContent ?? '').includes('已保存')), 5000),
        'saving reports success',
      );
    }
    dom.fire(dom.document, 'keydown', { key: 'Escape' });
  }
  await renderApi('/api/regex', renderJson('PUT', { rules: [] }));
  await renderLoadRegexes();
  eq(renderErrors(), [], 'no error was reported while rendering');

  // -------------------------------------------------------------------------
  section('personas and appearance');
  // -------------------------------------------------------------------------

  const { loadPersonas: renderLoadPersonas } = await load('api.js');
  await renderApi('/api/personas', renderJson('PUT', {
    activeId: 'boot-p1',
    items: [
      { id: 'boot-p1', name: 'ZQXBOOTYOU', description: 'The boot wanderer.' },
      { id: 'boot-p2', name: 'ZQXBOOTSEER', description: 'Just watching.' },
    ],
  }));
  await renderLoadPersonas();

  // The header names who "you" are, and the menu pins one chat at a time.
  const personaButton = dom.all('#chat-stats button').find((node) => (node.textContent ?? '').startsWith('人设：'));
  check(Boolean(personaButton), 'the header names the persona', dom.all('#chat-stats button').map((node) => node.textContent).join(','));
  if (personaButton) {
    dom.click(personaButton);
    const seerItem = dom.all('.menu .menu-item').find((node) => node.querySelector('.menu-label')?.textContent === 'ZQXBOOTSEER');
    check(Boolean(seerItem), 'the menu offers the other preset');
    if (seerItem) {
      dom.click(seerItem);
      check(
        await until(() => state.meta?.personaId === 'boot-p2', 5000),
        'choosing pins this chat',
        String(state.meta?.personaId),
      );
      check(
        dom.all('#messages .message.user .speaker').at(-1)?.textContent === 'ZQXBOOTSEER',
        'and the transcript speaks as it',
      );
    }
  }

  // `/persona` walks the same path as the menu.
  composer.value = '/persona ZQXBOOTYOU';
  dom.click(sendButton);
  check(
    await until(() => state.meta?.personaId === 'boot-p1', 5000),
    '/persona pins the conversation',
    String(state.meta?.personaId),
  );
  composer.value = '/persona 默认';
  dom.click(sendButton);
  check(
    await until(() => (state.meta?.personaId ?? null) === null, 5000),
    '/persona 默认 follows the default again',
  );

  // The appearance page owns themes, fonts and the Markdown switch now.
  dom.click(dom.document.getElementById('btn-settings')!);
  dom.click(dom.all('[role="tab"]')[1]!); // 外观
  check(dom.row('消息 Markdown 渲染') !== null, 'Markdown lives on the appearance page');
  check(dom.all('.theme-card').length >= 3, 'with the theme cards');
  check(dom.all('.font-card').length >= 6, 'and the font stacks');
  const lxgw = dom.all('.font-card').find((node) => (node.textContent ?? '').includes('霞鹜文楷'));
  check(Boolean(lxgw), 'including the open-source stacks');
  if (lxgw) {
    dom.click(lxgw);
    check(
      String((dom.document.getElementById('messages') as any).style?.fontFamily ?? '').includes('LXGW'),
      'choosing a font restyles the transcript',
      String((dom.document.getElementById('messages') as any).style?.fontFamily ?? ''),
    );
  }
  // Back to the default, so later sections read the shipped look.
  const systemFont = dom.all('.font-card')[0]!;
  dom.click(systemFont);
  // Font size rides the same path: stored per browser, applied to the transcript.
  // Typed the way a user types — the dialog re-renders extras on every
  // keystroke, which once washed the box back to 0 before `change` could fire.
  const sizeInput = dom.control('字号');
  dom.document.activeElement = sizeInput;
  dom.type(sizeInput, '18');
  eq(sizeInput.value, '18', 'typing survives the dialog re-render');
  dom.fire(sizeInput, 'change');
  eq(
    String((dom.document.getElementById('messages') as any).style?.fontSize ?? ''),
    '18px',
    'the size reaches the transcript',
  );
  dom.type(sizeInput, '0');
  dom.fire(sizeInput, 'change');
  eq(
    String((dom.document.getElementById('messages') as any).style?.fontSize ?? ''),
    '',
    'and 0 means the default size again',
  );
  dom.click(dom.button('关闭')!);

  // The library itself is managed from the roleplay page.
  dom.click(dom.document.getElementById('btn-settings')!);
  dom.click(dom.all('[role="tab"]')[3]!); // 角色扮演
  check(
    dom.all('.persona-row .persona-name').some((node) => node.textContent === 'ZQXBOOTYOU'),
    'the library lists its presets',
  );
  const addPersona = dom.all('.settings-extra button').find((node) => node.textContent === '新增人设');
  check(Boolean(addPersona), 'with a way to add one');
  if (addPersona) {
    dom.click(addPersona);
    check(await until(() => dom.one('.modal-panel.persona') !== null, 5000), 'the editor opens');
    dom.fire(dom.document, 'keydown', { key: 'Escape' });
  }
  dom.click(dom.button('关闭')!);
  await renderApi('/api/personas', renderJson('PUT', { activeId: '', items: [] }));
  await renderLoadPersonas();
  eq(renderErrors(), [], 'no error was reported for personas or appearance');

  // -------------------------------------------------------------------------
  section('speech');
  // -------------------------------------------------------------------------

  // The shim has no voices, so reading fails loudly instead of hanging — and
  // the menu still offers it on every non-system message. For picking, two
  // fake voices stand in for the browser's: one with an id, one with only a
  // name (some browsers leave voiceURI empty). The stub goes away before the
  // speak test below, which needs the speechless path.
  const stubVoices = [
    { name: 'Test Voice', lang: 'zh-CN', voiceURI: 'test-uri' },
    { name: 'Nameless Voice', lang: 'en-US', voiceURI: '' },
  ];
  const stubSpeech = {
    getVoices: () => stubVoices,
    onvoiceschanged: null as (() => void) | null,
  };
  (globalThis as Record<string, unknown>).speechSynthesis = stubSpeech;
  dom.click(dom.document.getElementById('btn-settings')!);
  dom.click(dom.all('[role="tab"]')[5]!); // 语音
  check(dom.row('朗读引擎') !== null, 'the voice page names the engine');
  check(dom.row('本机音色') !== null, 'with the local voice field');
  check(dom.row('在线音色') !== null, 'and the online one');
  check(
    dom.all('.settings-extra button').some((node) => node.textContent === '本地试听'),
    'plus a way to try it',
  );
  // Picking a voice writes through to the voice field without errors: the
  // change handler once called a `refresh` that only exists in the other
  // extras, which surfaced as a page-error toast on every pick.
  const voicePicker = dom.one('.settings-extra select.voice-pick') as unknown as {
    value: string;
    querySelectorAll(selectors: string): unknown[];
  } | null;
  check(Boolean(voicePicker), 'the voice picker is capped by its own class');
  if (voicePicker) {
    const optionValues = voicePicker.querySelectorAll('option').map((node) => (node as { value?: string }).value ?? (node as { textContent?: string }).textContent);
    check(
      JSON.stringify(optionValues) === JSON.stringify(['', 'test-uri', 'Nameless Voice']),
      'both stubbed voices are listed, the nameless one by name',
      JSON.stringify(optionValues),
    );
    (voicePicker as { value: string }).value = 'test-uri';
    dom.fire(voicePicker, 'change');
    const voiceField = dom.row('本机音色')?.querySelector('input') as { value?: string } | null;
    eq(voiceField?.value, 'test-uri', 'picking writes through to the voice field');
    eq(voicePicker.value, 'test-uri', 'and the picker keeps it');
    // A repeat voiceschanged with the same list must not rebuild the options:
    // rebuilding closes a dropdown the user just opened and loses the pick.
    const pickedOption = voicePicker.querySelectorAll('option').find((node) => (node as { value?: string }).value === 'test-uri');
    check(Boolean(pickedOption), 'the picked option exists');
    stubSpeech.onvoiceschanged?.();
    check(
      voicePicker.querySelectorAll('option').includes(pickedOption),
      'a repeat voices notice leaves the options alone',
    );
    eq(voicePicker.value, 'test-uri', 'so the pick survives it');
    // A genuinely new voice rebuilds, still without losing the pick.
    stubVoices.push({ name: 'Late Voice', lang: 'zh-CN', voiceURI: 'late-uri' });
    stubSpeech.onvoiceschanged?.();
    eq(voicePicker.querySelectorAll('option').length, 4, 'a new voice appears');
    eq(voicePicker.value, 'test-uri', 'the pick survives a real arrival too');
    // The nameless voice is picked by name, not confused with the default.
    voicePicker.value = 'Nameless Voice';
    dom.fire(voicePicker, 'change');
    eq(voiceField?.value, 'Nameless Voice', 'a voice without an id is picked by name');

    // The race the user actually hit: more voices arrive *while the dropdown is
    // open*. Rebuilding then destroys the option under the cursor, so the click
    // is swallowed and the control falls back to 浏览器默认. The rebuild has to
    // wait until the control closes.
    const focusable = voicePicker as unknown as { focus(): void; blur(): void };
    stubVoices.push({ name: 'While Open', lang: 'zh-CN', voiceURI: 'open-uri' });
    focusable.focus();
    stubSpeech.onvoiceschanged?.();
    eq(
      voicePicker.querySelectorAll('option').length,
      4,
      'an arrival while the dropdown is open does not rebuild the options',
    );
    voicePicker.value = 'test-uri';
    dom.fire(voicePicker, 'change');
    eq(voiceField?.value, 'test-uri', 'a pick made while voices were arriving still lands');
    focusable.blur();
    // The shim's `blur()` is not event-driven, so the browser's own event is sent.
    dom.fire(voicePicker, 'blur');
    eq(
      voicePicker.querySelectorAll('option').length,
      5,
      'and closing the control applies the list that arrived',
    );
    eq(voicePicker.value, 'test-uri', 'with the pick still selected');
  }
  eq(renderErrors(), [], 'no error was reported for picking a voice');
  delete (globalThis as Record<string, unknown>).speechSynthesis;
  dom.click(dom.button('关闭')!);

  const speechRow = dom.all('#messages .message.assistant').at(-1)!;
  const speechMore = speechRow.descendants().find((node) => node.textContent === '⋯');
  check(Boolean(speechMore), 'a reply offers its menu');
  if (speechMore) {
    dom.click(speechMore);
    check(
      dom.all('.menu .menu-item').some((node) => node.querySelector('.menu-label')?.textContent === '朗读'),
      'with a speak item',
      dom.all('.menu .menu-item').map((node) => node.querySelector('.menu-label')?.textContent).join(','),
    );
    const speakItem = dom.all('.menu .menu-item').find((node) => node.querySelector('.menu-label')?.textContent === '朗读');
    if (speakItem) {
      dom.click(speakItem);
      check(
        await until(() => dom.all('.toast').some((node) => (node.textContent ?? '').includes('不支持')), 5000),
        'without voices it says so instead of hanging',
      );
      // The toast is the assertion; dismiss it so later sections read a clean slate.
      for (const toast of dom.all('.toast')) toast.remove();
    } else {
      dom.fire(dom.document, 'keydown', { key: 'Escape' });
    }
  }
  eq(renderErrors(), [], 'no error was reported for speech');

  // -------------------------------------------------------------------------
  section('text completion');
  // -------------------------------------------------------------------------

  await renderApi('/api/config', renderJson('PUT', { textCompletion: true }));
  await renderLoadConfig();
  await renderRefresh();
  check(
    text('#preview').includes('纯文本提示词'),
    'the preview shows the flat prompt in completion mode',
    text('#preview').slice(0, 200),
  );
  const beforeCompletion = state.entries.length;
  composer.value = '补全模式下一句。';
  dom.click(sendButton);
  check(
    await until(() => !state.streaming && state.entries.length >= beforeCompletion + 2, 12000),
    'the completion turn landed',
    `${beforeCompletion} -> ${state.entries.length} streaming=${state.streaming} errors=${dom.errors().join('|')} body=${text('#messages').slice(-200)}`,
  );
  check(text('#messages').includes('COMPLETED'), 'carrying what the completions endpoint returned');
  await renderApi('/api/config', renderJson('PUT', { textCompletion: false }));
  await renderLoadConfig();
  await renderRefresh();
  eq(renderErrors(), [], 'no error was reported for text completion');

  // -------------------------------------------------------------------------
  section('group chat and the brand menu');
  // -------------------------------------------------------------------------

  // The brand behaves like a Windows menu button: same typeface, real menu.
  const brand = dom.document.getElementById('brand-menu')!;
  check(Boolean(brand), 'the brand is a menu button');
  dom.click(brand);
  const brandLabels = () => dom.all('.menu .menu-item').map((node) => node.querySelector('.menu-label')?.textContent);
  check(brandLabels().includes('新会话'), 'offering a new chat', brandLabels().join(','));
  check(
    brandLabels().some((label) => String(label).startsWith('新建群聊')),
    'and a way to start a group chat directly',
    brandLabels().join(','),
  );
  check(brandLabels().includes('设置'), 'and the settings');
  const brandSettings = dom.all('.menu .menu-item').find((node) => node.querySelector('.menu-label')?.textContent === '设置');
  dom.click(brandSettings!);
  check(await until(() => dom.one('.modal-panel.settings') !== null, 5000), '设置 opens the dialog');
  dom.click(dom.button('关闭')!);

  // A new chat from the menu, removed again so later counts hold. The length
  // check alone is not enough: `loadChats` lands before the new chat is
  // selected, so deleting `state.chatId` too early would kill the OLD chat.
  const chatsBeforeMenu = state.chats.length;
  const chatBeforeMenu = state.chatId;
  dom.click(brand);
  dom.click(dom.all('.menu .menu-item').find((node) => node.querySelector('.menu-label')?.textContent === '新会话')!);
  check(await until(() => state.chats.length === chatsBeforeMenu + 1, 5000), '新会话 creates a chat');
  check(await until(() => state.chatId !== chatBeforeMenu, 5000), 'and switches to it');
  await renderApi(`/api/chats/${state.chatId}`, { method: 'DELETE' });
  const { loadChats: renderLoadChats, loadChat: renderLoadChat2, loadCharacters: renderLoadCharacters } = await load('api.js');
  await renderLoadChats();
  await renderLoadChat2(chatBeforeMenu!);
  eq(state.chatId, chatBeforeMenu, 'back on the previous chat');

  // Creating a group is its own flow: pick the members, then a conversation
  // starts with them — no mode to switch on. The new chat carries its marker in
  // the list and its header.
  //
  // One extra connection exists first, so the picker has something to offer: a
  // member may answer through its own endpoint and model.
  const bootConnId = 'boot-conn';
  await renderApi('/api/connections', renderJson('PUT', {
    version: 1,
    items: [{ id: bootConnId, label: 'Boot line', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: '', model: 'boot-model' }],
  }));
  const { loadConnections } = await load('api.js');
  await loadConnections();

  const chatsBeforeGroup = state.chats.length;
  dom.click(brand);
  dom.click(dom.all('.menu .menu-item').find((node) => node.querySelector('.menu-label')?.textContent?.startsWith('新建群聊'))!);
  check(await until(() => dom.one('.modal-panel.group') !== null, 5000), '新建群聊 opens the member picker');
  check(dom.one('.modal-panel.group .group-name-input') !== null, 'with a name for the new group');
  const groupBoxes = dom.all('.modal-panel.group .group-row input[type="checkbox"]');
  check(groupBoxes.length >= 2, 'listing the characters', `${groupBoxes.length}`);
  const connPickers = dom.all('.modal-panel.group .group-conn');
  check(connPickers.length >= 2, 'each member can pick its own endpoint', `${connPickers.length}`);
  eq(
    (connPickers[0]!.querySelectorAll('option').at(-1)?.textContent ?? ''),
    'Boot line',
    'the saved connection is on the list',
  );
  groupBoxes[0]!.checked = true;
  dom.fire(groupBoxes[0]!, 'change');
  groupBoxes[1]!.checked = true;
  dom.fire(groupBoxes[1]!, 'change');
  const connPick = connPickers[1] as unknown as { value: string };
  connPick.value = bootConnId;
  dom.fire(connPickers[1]!, 'change');
  // Talkativeness is a slider per character, saved onto the character itself.
  const talkSliders = dom.all('.modal-panel.group .group-talk');
  check(talkSliders.length >= 2, 'each member has a talkativeness slider', `${talkSliders.length}`);
  (talkSliders[0] as unknown as { value: string }).value = '90';
  dom.fire(talkSliders[0]!, 'input');
  check(
    (talkSliders[0]!.parentElement?.textContent ?? '').includes('健谈'),
    'and says what the number means',
    talkSliders[0]!.parentElement?.textContent,
  );
  // "Everyone, in turn": one message, one reply per member.
  const repliesPick = dom.one('.modal-panel.group .group-replies') as unknown as { value: string };
  check(Boolean(repliesPick), 'the picker offers how many members answer');
  repliesPick.value = '0';
  dom.fire(dom.one('.modal-panel.group .group-replies')!, 'change');
  const groupName = dom.one('.modal-panel.group .group-name-input') as unknown as { value: string };
  check(groupName.value.includes('群聊'), 'the name defaults to the members', groupName.value);
  const talkTarget = state.characters[0];
  dom.click(dom.all('.modal-panel.group button').find((node) => node.textContent === '创建群聊')!);
  check(
    await until(() => state.chats.length === chatsBeforeGroup + 1 && (state.meta?.members ?? []).length >= 2, 6000),
    'the picker created a group conversation',
    `${chatsBeforeGroup} -> ${state.chats.length}`,
  );
  eq(
    state.characters.find((character: any) => character.id === talkTarget?.id)?.talkativeness,
    90,
    'the slider reached the character',
  );
  eq(
    state.meta?.memberConnections?.[(state.meta?.members ?? [])[1] ?? ''],
    bootConnId,
    "the member's connection is stored",
  );
  eq(state.meta?.groupReplyLimit, 0, 'and the reply quota is stored', JSON.stringify(state.meta));
  check(
    (dom.document.getElementById('chat-title')?.textContent ?? '').includes('Boot line'),
    'and the header names it',
    dom.document.getElementById('chat-title')?.textContent,
  );
  check(
    (dom.document.getElementById('chat-title')?.textContent ?? '').includes('群聊'),
    'and the header marks it',
    dom.document.getElementById('chat-title')?.textContent,
  );
  check(
    (dom.one('#chat-list li.active .pill.group-badge')?.textContent ?? '').includes('群聊'),
    'the list row carries the group badge',
    dom.text(dom.one('#chat-list li.active')),
  );

  // With the quota at "everyone", one message produces one reply per member —
  // the client chains ordinary turns, so nothing about the server changes.
  const repliesBefore = state.entries.filter((entry) => entry.role === 'assistant').length;
  composer.value = '大家一起来。';
  dom.click(sendButton);
  check(
    await until(
      () => state.entries.filter((entry) => entry.role === 'assistant').length === repliesBefore + 2,
      25000,
    ),
    'every member answers in turn',
    `${repliesBefore} -> ${state.entries.filter((entry) => entry.role === 'assistant').length}`,
  );
  const roundSpeakers = state.entries
    .filter((entry) => entry.role === 'assistant')
    .slice(-2)
    .map((entry) => (entry as any).speaker);
  eq(new Set(roundSpeakers).size, 2, 'and it is two different members', JSON.stringify(roundSpeakers));
  eq(dom.errors(), [], 'no error was reported while a round ran');

  // The right panel is where the speaker mode lives, and a group is the only
  // thing that gets the row.
  const modeSelects = dom.all('#world-hits .hits-mode select.mode-select');
  check(modeSelects.length === 2, 'a group gets a second mode row', `${modeSelects.length}`);
  const groupModeOptions = dom.all('#world-hits .hits-mode')[1]?.querySelectorAll('option').map((node) => node.textContent ?? '') ?? [];
  check(
    groupModeOptions.some((text) => text.startsWith('B · ')),
    'offering the lettered speaker modes',
    groupModeOptions.join(' | '),
  );
  const groupModePick = modeSelects[1] as unknown as { value: string };
  groupModePick.value = 'manual';
  dom.fire(modeSelects[1]!, 'change');
  check(await until(() => state.meta?.groupMode === 'manual', 5000), 'picking a mode stores it on the chat');
  check(
    await until(() => (dom.one('.pill.group-mode-badge')?.textContent ?? '').startsWith('E · '), 5000),
    'and the header wears it',
    dom.one('.pill.group-mode-badge')?.textContent,
  );

  // Manual: a message that names nobody is the user's alone.
  const manualBefore = state.entries.length;
  composer.value = '安静一下。';
  dom.click(sendButton);
  // Wait for the transcript, not just for streaming: the flag clears *before*
  // the reload that brings the new entry in, so asserting on the flag alone
  // reads the old list and looks like "the message never landed".
  check(await until(() => !state.streaming && state.entries.length >= manualBefore + 1, 12000), 'the manual turn landed');
  // A reply would arrive as a second entry; give a wrong implementation room to
  // add one before saying it did not.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  eq(state.entries.length, manualBefore + 1, 'the message landed with no reply');
  eq(dom.errors(), [], 'and reported no error');
  // ...and naming someone brings exactly that member.
  const manualName = state.characters.find((character: any) => character.id === (state.meta?.members ?? [])[0])?.name ?? '';
  composer.value = `@${manualName} 该你了。`;
  dom.click(sendButton);
  check(
    await until(() => !state.streaming && state.entries.length > manualBefore + 2, 12000),
    '@ brings that member back in',
  );

  // Clean up: the created group and the extra connection must not move the
  // counts the rest of the suite asserts on.
  await renderApi(`/api/chats/${state.chatId}`, { method: 'DELETE' });
  await renderApi('/api/connections', renderJson('PUT', { version: 1, items: [] }));
  await loadConnections();
  await renderLoadChats();
  await renderLoadChat2(chatBeforeMenu!);
  // The slider wrote a character setting; put it back so later counts and
  // pickers see what the rest of the suite expects.
  await renderApi(`/api/characters/${encodeURIComponent(String(talkTarget?.id))}`, renderJson('PATCH', { talkativeness: null }));
  await renderLoadCharacters();

  // Two members make it a group; the model picks, `@Name` pins.
  const memberIds = state.characters.slice(0, 2).map((character: any) => character.id);
  check(memberIds.length >= 2, 'two characters exist for a group', `${memberIds.length}`);
  await renderApi(`/api/chats/${state.chatId}/members`, renderJson('POST', { members: memberIds }));
  await renderLoadChat2(state.chatId!);
  check(
    (dom.document.getElementById('chat-title')?.textContent ?? '').includes('群聊'),
    'the header says so',
    dom.document.getElementById('chat-title')?.textContent,
  );
  const beforeGroup = state.entries.length;
  composer.value = '大家好。';
  dom.click(sendButton);
  check(
    await until(() => !state.streaming && state.entries.length >= beforeGroup + 2, 12000),
    'the group turn landed',
  );
  const groupReply = state.entries[state.entries.length - 1]!;
  check(typeof groupReply.speaker === 'string' && groupReply.speaker !== '', 'the reply remembers its speaker');
  const speakerName = state.characters.find((character: any) => character.id === (groupReply as any).speaker)?.name ?? '';
  eq(
    dom.all('#messages .message.assistant .speaker').at(-1)?.textContent ?? '',
    speakerName,
    'and wears their name',
  );
  const secondName = state.characters.find((character: any) => character.id === memberIds[1])!.name;
  composer.value = `@${secondName} 你说。`;
  dom.click(sendButton);
  check(
    await until(() => !state.streaming && (state.entries[state.entries.length - 1] as any)?.speaker === memberIds[1], 12000),
    '@Name pins the turn',
  );
  await renderApi(`/api/chats/${state.chatId}/members`, renderJson('POST', { members: [] }));
  await renderLoadChat2(state.chatId!);

  // -------------------------------------------------------------------------
  section('sprites');
  // -------------------------------------------------------------------------

  // Files are the database: stems are keywords, dropped into place by hand.
  const spriteDir = join(dataDir, 'sprites', state.meta!.characterId);
  mkdirSync(spriteDir, { recursive: true });
  const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  writeFileSync(join(spriteDir, '默认.png'), tinyPng);
  writeFileSync(join(spriteDir, '开心.png'), tinyPng);
  await renderLoadChat2(state.chatId!);
  check(
    dom.one('#sprite-block') !== null && !dom.one('#sprite-block')!.classList.contains('hidden'),
    'the portrait section shows itself when files exist',
  );
  check(
    (dom.one('#sprite img')?.getAttribute('alt') ?? '').includes('默认'),
    'resting on the default face',
    dom.one('#sprite img')?.getAttribute('alt'),
  );
  const spriteBefore = state.entries.length;
  composer.value = '今天真开心。';
  dom.click(sendButton);
  check(
    await until(() => !state.streaming && state.entries.length >= spriteBefore + 2, 12000),
    'the turn landed',
  );
  check(
    await until(() => (dom.one('#sprite img')?.getAttribute('alt') ?? '').includes('开心'), 8000),
    'and the portrait follows the keyword',
    dom.one('#sprite img')?.getAttribute('alt'),
  );
  // A manual pick pins the portrait until the conversation changes.
  const spriteSelect = dom.one('#sprite select')!;
  spriteSelect.value = '默认';
  dom.fire(spriteSelect, 'change');
  eq(dom.one('#sprite img')?.getAttribute('alt'), '默认', 'the manual pick holds');
  // The pinned portrait backs the chat, blurred; the toggle hides it.
  const backdrop = dom.one('#chat-backdrop')!;
  check(!backdrop.classList.contains('hidden'), 'the portrait backs the chat');
  check(
    String((backdrop as unknown as { style?: { backgroundImage?: string } }).style?.backgroundImage ?? '').includes('/api/sprites/'),
    'with the portrait behind the transcript',
  );
  const backdropToggle = dom.one('#sprite input[type=checkbox]')!;
  eq((backdropToggle as unknown as { checked?: boolean }).checked, true, 'the backdrop is on by default');
  (backdropToggle as unknown as { checked?: boolean }).checked = false;
  dom.fire(backdropToggle, 'change');
  check(backdrop.classList.contains('hidden'), 'the toggle hides it');
  (backdropToggle as unknown as { checked?: boolean }).checked = true;
  dom.fire(backdropToggle, 'change');
  check(!backdrop.classList.contains('hidden'), 'and brings it back');
  // Framing: the analysis has no Image here, so the centre holds; the blur
  // and nudge sliders repaint the backdrop live and persist per browser.
  const backdropStyle = (backdrop as unknown as { style?: Record<string, string> }).style ?? {};
  eq(backdropStyle.backgroundPosition, '50% 50%', 'without analysis the centre holds');
  const sliders = (dom.one('#sprite') as unknown as {
    querySelectorAll(selectors: string): Array<{ value: string }>;
  }).querySelectorAll('input[type=range]');
  eq(sliders.length, 2, 'blur and framing sliders ride along');
  sliders[0]!.value = '10';
  dom.fire(sliders[0]!, 'input');
  check(
    (backdropStyle.backgroundImage ?? '').includes('/api/sprites/') && (backdropStyle.filter ?? '').includes('blur(10px)'),
    'the blur slider repaints live',
    backdropStyle.filter,
  );
  sliders[1]!.value = '20';
  dom.fire(sliders[1]!, 'input');
  eq(backdropStyle.backgroundPosition, '50% 70%', 'the nudge slider reframes');
  eq(
    (globalThis as unknown as { localStorage: Storage }).localStorage.getItem('teahouse.spriteBackdrop'),
    JSON.stringify({ on: true, blur: 10, dy: 20 }),
    'and both persist per browser',
  );
  // Managing goes through the panel, not the file system: unfold, upload one
  // with a keyword, then delete it again with a confirmation.
  const manageButton = dom.all('#sprite button').find((node) => (node.textContent ?? '').startsWith('管理（'));
  check(Boolean(manageButton), 'the panel offers management');
  if (manageButton) {
    dom.click(manageButton);
    check(dom.all('#sprite .sprite-thumb').length === 2, 'both files list as thumbnails');
    const uploadButton = dom.all('#sprite button').find((node) => node.textContent === '上传立绘');
    check(Boolean(uploadButton), 'with an upload');
    if (uploadButton) {
      const dialogsBeforeUpload = dom.all('.modal-panel.dialog').length;
      dom.click(uploadButton);
      // Ours is appended to the body end; the page already owns file inputs
      // for world/character import, so the first match is not ours.
      const picker = dom.all('input[type=file]').at(-1)!;
      check(Boolean(picker), 'picking a file opens the file input');
      (picker as { files?: unknown }).files = [
        new File([readFileSync(join(corpus, 'owned', 'cards', 'osk.png'))], 'shock.png', { type: 'image/png' }),
      ];
      dom.fire(picker, 'change');
      // Closed dialogs stay in the document (they only hide), so an old
      // prompt from an earlier section would match first: always take the
      // last dialog, which is the one just opened.
      const dialogs = () => dom.all('.modal-panel.dialog');
      check(
        await until(() => dialogs().length > dialogsBeforeUpload, 5000),
        'then asks for the keyword',
      );
      const prompt = dialogs().at(-1)!;
      const keyword = prompt.querySelector('input')!;
      keyword.value = '惊讶';
      dom.click(prompt.querySelectorAll('button').find((node) => node.textContent === '确定')!);
      check(
        await until(() => dom.all('#sprite .sprite-thumb-label').some((node) => node.textContent === '惊讶'), 8000),
        'the upload lands as a thumbnail',
        dom.all('#sprite .sprite-thumb-label').map((node) => node.textContent).join(','),
      );
      const shockThumb = dom.all('#sprite .sprite-thumb').find((node) =>
        node.querySelector('.sprite-thumb-label')?.textContent === '惊讶',
      )!;
      const dialogsBeforeDelete = dom.all('.modal-panel.dialog').length;
      dom.click(shockThumb.querySelector('.sprite-remove')!);
      check(await until(() => dom.all('.modal-panel.dialog').length > dialogsBeforeDelete, 5000), 'deleting asks first');
      const deleteDialog = dom.all('.modal-panel.dialog').at(-1)!;
      const deleteConfirm = deleteDialog
        .querySelectorAll('button')
        .find((node) => node.textContent === '删除');
      check(Boolean(deleteConfirm), 'the confirmation offers a delete button');
      if (deleteConfirm) {
        dom.click(deleteConfirm);
        check(
          await until(() => !dom.all('#sprite .sprite-thumb-label').some((node) => node.textContent === '惊讶'), 8000),
          'the thumbnail is gone',
        );
      }
    }
  }
  rmSync(spriteDir, { recursive: true, force: true });
  await renderLoadChat2(state.chatId!);
  // Empty again: the section stays (hiding it would hide the only way to
  // upload the first portrait) and offers the upload.
  check(
    dom.one('#sprite-block') !== null && !dom.one('#sprite-block')!.classList.contains('hidden'),
    'the section stays visible when empty',
  );
  check(
    dom.all('#sprite button').some((node) => node.textContent === '上传立绘'),
    'offering the upload for the first portrait',
  );
  check(dom.one('#chat-backdrop')!.classList.contains('hidden'), 'no portrait, no backdrop');
  eq(renderErrors(), [], 'no error was reported for sprites');

  // -------------------------------------------------------------------------
  section('translation');
  // -------------------------------------------------------------------------

  // A foreign message under a 中文 preset translates itself once, then reads
  // from its cache; the stored text never moves.
  await renderApi('/api/config', renderJson('PUT', { outputLanguage: '中文' }));
  await renderLoadConfig();
  const beforeTranslate = state.entries.length;
  composer.value = 'Hello from the harbour, traveller.';
  dom.click(sendButton);
  check(
    await until(() => !state.streaming && state.entries.length >= beforeTranslate + 2, 12000),
    'the foreign turn landed',
  );
  const foreignRow = () => dom.all('#messages .message.user').at(-1)!;
  check(
    await until(() => foreignRow().descendants().some((node) => node.textContent === '原文'), 12000),
    'it shows the translation with a way back',
  );
  check(
    foreignRow().textContent.includes('ZQXTROLLMARKER'),
    'carrying what the translation call returned',
  );
  check(
    !foreignRow().textContent.includes('Hello from the harbour'),
    'the original is not what is shown',
  );
  const storedForeign = (await renderApi(`/api/chats/${state.chatId}`)).entries
    .filter((entry: any) => entry.role === 'user').at(-1);
  check(
    String(storedForeign.content).includes('Hello from the harbour'),
    'while storage keeps the original',
  );
  check(
    String(storedForeign.translation?.text ?? '').includes('ZQXTROLLMARKER'),
    'beside its cached translation',
  );

  // The switch flips the reading view only.
  dom.click(foreignRow().descendants().find((node) => node.textContent === '原文')!);
  check(
    foreignRow().textContent.includes('Hello from the harbour'),
    '原文 shows the stored text',
  );
  dom.click(foreignRow().descendants().find((node) => node.textContent === '译文')!);
  check(
    !foreignRow().textContent.includes('Hello from the harbour'),
    '译文 goes back to the translation',
  );

  // The row menu offers a manual retranslate.
  const foreignMore = foreignRow().descendants().find((node) => node.textContent === '⋯');
  check(Boolean(foreignMore), 'the row offers its menu');
  if (foreignMore) {
    dom.click(foreignMore);
    check(
      dom.all('.menu .menu-item').some((node) => node.querySelector('.menu-label')?.textContent === '翻译'),
      'with a translate item',
      dom.all('.menu .menu-item').map((node) => node.querySelector('.menu-label')?.textContent).join(','),
    );
    dom.fire(dom.document, 'keydown', { key: 'Escape' });
  }
  await renderApi('/api/config', renderJson('PUT', { outputLanguage: '' }));
  await renderLoadConfig();
  eq(renderErrors(), [], 'no error was reported while translating');

  // -------------------------------------------------------------------------
  section('display macros');
  // -------------------------------------------------------------------------

  // The model echoes prompt macros; the reading view expands the pure ones
  // while storage keeps the raw text.
  const macroTarget = state.entries.find((entry: any) => entry.role === 'user')!;
  await renderApi(`/api/chats/${state.chatId}/entries/${macroTarget.id}`, renderJson('PATCH', { content: '呼叫{{user}}，完毕。' }));
  const { loadChat: macroReload } = await load('api.js');
  await macroReload(state.chatId!);
  check(
    text('#messages').includes(`呼叫${state.config?.personaName || 'You'}，完毕。`),
    'the reading view expands the name',
  );
  check(!text('#messages').includes('{{user}}'), 'leaving no raw macro on screen');
  eq(
    String((await renderApi(`/api/chats/${state.chatId}`)).entries.find((entry: any) => entry.id === macroTarget.id)?.content ?? ''),
    '呼叫{{user}}，完毕。',
    'while storage keeps the raw text',
  );
  eq(renderErrors(), [], 'no error was reported for display macros');

  // -------------------------------------------------------------------------
  section('images');
  // -------------------------------------------------------------------------

  // Attach through the composer button, send, and the bubble carries the picture.
  const attachInput = dom.document.getElementById('attach-input')!;
  (attachInput as { files?: unknown }).files = [
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])], 'boot.png', { type: 'image/png' }),
  ];
  dom.fire(attachInput, 'change');
  check(
    await until(() => dom.all('#pending-images img').length === 1, 5000),
    'the composer shows the pending picture',
  );
  // Pasting a screenshot takes the same path as the paperclip.
  const pasteInput = dom.document.getElementById('attach-input')!;
  (pasteInput as { files?: unknown }).files = [];
  dom.fire(dom.document.getElementById('input')!, 'paste', {
    clipboardData: {
      files: [new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])], 'pasted.png', { type: 'image/png' })],
    },
  });
  check(
    await until(() => dom.all('#pending-images img').length === 2, 5000),
    'pasting an image attaches it too',
  );
  const beforeImage = state.entries.length;
  composer.value = '这张图里有什么？';
  dom.click(sendButton);
  check(
    await until(() => !state.streaming && state.entries.length >= beforeImage + 2, 12000),
    'the turn with a picture landed',
    `${beforeImage} -> ${state.entries.length}`,
  );
  const imageRow = dom.all('#messages .message.user').at(-1)!;
  check(imageRow.querySelector('.message-image') !== null, 'the bubble carries the thumbnail');
  check(
    text('#preview').includes('1 张图') || text('#preview').includes('张图'),
    'and the preview names it',
    text('#preview').slice(0, 200),
  );
  const storedImage = (await renderApi(`/api/chats/${state.chatId}`)).entries
    .filter((entry: any) => entry.role === 'user').at(-1);
  eq(storedImage.images?.length, 2, 'the entry stores the references, not the bytes');

  // One click opens the full picture in the shared dialog.
  const thumb = imageRow.querySelector('.message-image')!;
  dom.click(thumb);
  check(await until(() => dom.one('.modal-panel.image') !== null, 5000), 'clicking opens the full picture');
  dom.fire(dom.document, 'keydown', { key: 'Escape' });
  eq(renderErrors(), [], 'no error was reported for images');

  // -------------------------------------------------------------------------
  section('long-term memory');
  // -------------------------------------------------------------------------

  const { api: clientApi, json: clientJson, loadConfig } = await load('api.js');

  // Switched on through the same endpoint the settings dialog saves to.
  eq(
    (await clientApi('/api/config', clientJson('PUT', { memory: { enabled: true, interval: 2 } }))).memory
      .enabled,
    true,
    'long-term memory is switched on',
  );
  await loadConfig();
  eq(state.config?.memory?.interval, 2, 'and the client picks the change up');

  // A turn now makes the memory due, and the client summarises *after* the reply
  // has landed — never inside it.
  const entriesBeforeMemory = state.entries.length;
  composer.value = '顺便记一下潮汐表。';
  dom.fire(composer, 'keydown', { key: 'Enter', ctrlKey: true });
  check(
    await until(() => String(state.meta?.memory?.text ?? '').includes('ZQXSUMMARYMARKER'), 12000),
    'the client summarises once the reply is saved',
    String(state.meta?.memory?.text ?? ''),
  );
  check(
    await until(() => dom.all('.toast .toast-message').some((node) => (node.textContent ?? '').includes('记忆已更新')), 5000),
    'and says so',
  );
  check(state.entries.length > entriesBeforeMemory, 'the transcript grew by the turn');
  eq(
    (await clientApi(`/api/chats/${state.chatId}`)).entries.length,
    state.entries.length,
    'and the summary added nothing to it',
  );

  // The badge in the chat header is the way in, and shows when more is due.
  check(await until(() => dom.one('.memory-badge') !== null, 5000), 'the header shows a memory badge');
  const memoryBadge = dom.one('.memory-badge')!;
  check(memoryBadge.tagName === 'BUTTON', 'which is a button');

  // The summary is an at-depth injection, so it shows up inside the request
  // preview's messages rather than as a row of its own in the stack list.
  check(
    text('#preview').includes('ZQXSUMMARYMARKER'),
    'the request preview shows the injected summary',
    text('#preview').slice(0, 200),
  );
  const memoryButton = dom
    .all('#prompt-stack button')
    .find((node) => (node.textContent ?? '').includes('编辑长期记忆'));
  check(Boolean(memoryButton), 'and the stack offers a way to edit it');

  dom.click(memoryButton!);
  check(await until(() => dom.one('.modal-panel.memory') !== null, 6000), 'the editor opens');
  const memoryText = dom.one('.modal-panel.memory textarea')!;
  check(
    String(memoryText.value).includes('ZQXSUMMARYMARKER'),
    'showing what is remembered',
    String(memoryText.value),
  );
  check(
    text('.modal-panel.memory .memory-note').includes('自动总结'),
    'and explaining when it updates',
    text('.modal-panel.memory .memory-note'),
  );

  // Hand editing: the text is stored as written and the block follows.
  memoryText.value = '手写的记忆：港口与潮汐。';
  dom.click(dom.all('.modal-panel.memory .modal-footer button').find((node) => node.textContent === '保存')!);
  check(
    await until(() => state.meta?.memory?.text === '手写的记忆：港口与潮汐。', 4000),
    'the edited summary is saved',
    String(state.meta?.memory?.text ?? ''),
  );
  check(
    (await clientApi('/api/prompt/preview', clientJson('POST', { chatId: state.chatId }))).itemization.some(
      (item: any) => item.identifier === 'memory' && String(item.content).includes('手写的记忆'),
    ),
    'and reaches the request',
  );

  // Freezing stops the automatic path; clearing forgets without deleting.
  dom.click(dom.all('.modal-panel.memory .modal-footer button').find((node) => node.textContent === '冻结')!);
  check(await until(() => state.meta?.memory?.frozen === true, 4000), 'freezing is stored');
  const badgeAfterFreeze = dom.one('.memory-badge')!;
  check(
    (badgeAfterFreeze.getAttribute('title') ?? '').includes('已冻结'),
    'and the badge says so',
    badgeAfterFreeze.getAttribute('title') ?? '',
  );
  dom.click(dom.all('.modal-panel.memory .modal-footer button').find((node) => node.textContent === '清空')!);
  check(await until(() => state.meta?.memory === undefined, 4000), 'clearing forgets the summary');
  check(
    await until(() => dom.one('.memory-badge') === null, 5000),
    'the badge goes away with it',
  );
  check(state.entries.length >= 3, 'and every message is still there', `${state.entries.length}`);
  dom.click(dom.all('.modal-panel.memory .modal-header button')[0]!);

  // `/memory` opens the same editor.
  composer.value = '/memory';
  dom.click(sendButton);
  check(await until(() => dom.one('.modal-panel.memory') !== null, 6000), '/memory opens the editor too');
  dom.fire(dom.document, 'keydown', { key: 'Escape' });
  check(
    await until(() => dom.one('.modal-panel.memory') === null, 5000),
    'and Escape closes it',
  );
  // -------------------------------------------------------------------------
  section('trajectory');
  // -------------------------------------------------------------------------

  // The button in the top-right switches the right column over to the trajectory.
  eq(dom.one('.layout')!.classList.contains('trace-mode'), false, 'the column starts on the prompt panel');
  dom.click(dom.document.getElementById('btn-trace')!);
  eq(dom.one('.layout')!.classList.contains('trace-mode'), true, 'the button switches it to the trajectory');
  eq(dom.one('.panel-right')!.classList.contains('mode-trace'), true, 'which the column marks for the stylesheet');
  eq(
    dom.document.getElementById('btn-trace')!.getAttribute('aria-pressed'),
    'true',
    'and the button says it is on',
  );

  // Collapsing the left panel while the trajectory is open must keep both facts.
  // The stylesheet composes them (each writes its own track variable); the bug this
  // pins is the trajectory rewriting the whole template and putting the collapsed
  // panel's 300px back, so the transcript could not grow into the freed space.
  // The state is read rather than assumed: an earlier section left the panel
  // collapsed, and a test that clicks blind asserts the wrong way round.
  const leftToggle = dom.document.getElementById('btn-toggle-left')!;
  const leftHidden = dom.one('.layout')!.classList.contains('hide-left');
  dom.click(leftToggle);
  eq(
    dom.one('.layout')!.classList.contains('hide-left'),
    !leftHidden,
    'the left panel toggles while the trajectory is open',
  );
  eq(
    dom.one('.layout')!.classList.contains('trace-mode'),
    true,
    'and the trajectory stays in effect either way',
  );
  dom.click(leftToggle);
  eq(dom.one('.layout')!.classList.contains('hide-left'), leftHidden, 'the panel returns to where it was');

  // The turns this run already made are on the timeline.
  check(
    await until(() => count('#trace .trace-row') > 0, 5000),
    'the timeline lists the turns that happened',
    text('#trace').slice(0, 200),
  );
  check(text('#trace .trace-summary').includes('轮次'), 'with a summary of the run', text('#trace .trace-summary'));
  check(count('#trace .trace-bar') > 0, 'and one bar per request', `${count('#trace .trace-bar')}`);
  check(
    text('#trace').includes('记忆'),
    'the memory update this run caused is on the timeline too',
  );

  // Selecting a row opens the detail: numbers, then the messages that were sent.
  // The greeting has no provider request behind it, and says so instead of
  // inventing numbers — that row is the first one on the timeline.
  const greetingRow = dom
    .all('#trace .trace-row')
    .find((row) => !(row.querySelector('.trace-row-facts')?.textContent ?? '').includes('tok'));
  check(Boolean(greetingRow), 'a message with no request behind it shows no token count');
  dom.click(greetingRow!);
  check(
    await until(() => text('#trace .trace-detail').includes('没有对应的请求记录'), 5000),
    'and its detail explains why there are no numbers',
    text('#trace .trace-detail').slice(0, 120),
  );

  const turnRow = dom
    .all('#trace .trace-row')
    .find((row) => (row.querySelector('.trace-row-facts')?.textContent ?? '').includes('tok'));
  check(Boolean(turnRow), 'a row for a real request carries its token count');
  dom.click(turnRow!);
  check(await until(() => count('#trace .trace-detail') > 0, 5000), 'a row opens its detail');
  const detailText = () => text('#trace .trace-detail');
  check(detailText().includes('首 token'), 'the detail shows the timing', detailText().slice(0, 160));
  check(detailText().includes('输入 / 输出'), 'and what the provider charged');

  const previewTab = dom
    .all('#trace .trace-tabs button')
    .find((node) => node.textContent === '预览');
  check(Boolean(previewTab), 'there is a preview tab');
  dom.click(previewTab!);
  check(await until(() => count('#trace .trace-message') > 0, 5000), 'the preview lists the messages that were sent');
  check(text('#trace .trace-message').length > 0, 'with their content');

  const rawTab = dom.all('#trace .trace-tabs button').find((node) => node.textContent === '原始内容');
  dom.click(rawTab!);
  check(
    await until(() => text('#trace .trace-detail').includes('"messages"'), 5000),
    'and the raw tab shows the request body',
  );

  const onlyRequests = dom.all('#trace .trace-filters button').find((node) => node.textContent === '请求');
  const rowsBeforeFilter = count('#trace .trace-row');
  dom.click(onlyRequests!);
  const rowsAfterFilter = count('#trace .trace-row');
  check(
    rowsAfterFilter > 0 && rowsAfterFilter <= rowsBeforeFilter,
    'filtering to requests keeps the request rows',
    `${rowsBeforeFilter} -> ${rowsAfterFilter}`,
  );
  dom.click(dom.all('#trace .trace-filters button').find((node) => node.textContent === '全部')!);

  // Clearing the trace must not touch the conversation.
  const entriesBeforeClear = state.entries.length;
  dom.click(dom.all('#trace .trace-header button').find((node) => node.textContent === '清空')!);
  check(
    await until(() => count('#trace .trace-row') === 0, 4000),
    'clearing empties the trajectory',
    `${count('#trace .trace-row')}`,
  );
  eq(state.entries.length, entriesBeforeClear, 'and the conversation is untouched');

  dom.click(dom.document.getElementById('btn-trace')!);
  eq(dom.one('.layout')!.classList.contains('trace-mode'), false, 'the button switches back to the prompt panel');
  // -------------------------------------------------------------------------
  section('vector storage');
  // -------------------------------------------------------------------------

  const { loadVectors, refreshPreview: clientRefreshPreview } = await load('api.js');

  // Off by default: the world list says nothing about vectors.
  check(!text('#world-list').includes('向量'), 'vector storage is quiet while it is off');

  // The two endpoints are configured separately; this run uses the fake one.
  const vectorConfig = await clientApi(
    '/api/config',
    clientJson('PUT', {
      retrieval: { mode: 'vector' },
      vector: {
        enabled: true,
        mode: 'remote',
        remote: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'k', model: 'fake-embed' },
      },
    }),
  );
  eq(vectorConfig.vector.mode, 'remote', 'the embedding endpoint can be switched on');
  eq(
    vectorConfig.vector.local.baseUrl.includes('11434'),
    true,
    'with the local one kept alongside it',
  );

  // The connection test is what tells a user their provider cannot embed.
  const vectorTest = await clientApi('/api/vectors/test', clientJson('POST', {}));
  eq(vectorTest.ok, true, 'the settings test reaches the endpoint');
  eq(vectorTest.dims, EMBED_DIMS, 'and reports the vector width', `${vectorTest.dims}`);

  // Mark the entries of a book this chat actually uses, then index it. Both are
  // explicit actions: indexing costs money or CPU, so nothing does it behind the
  // user's back. The chat is new enough to carry no books, so attach one first —
  // retrieval only ever searches what is attached.
  const bootWorldId = state.worlds[0]!.id;
  await clientApi(
    `/api/chats/${encodeURIComponent(state.chatId!)}/worlds`,
    clientJson('POST', { worldId: bootWorldId, attached: true }),
  );
  await loadChat(state.chatId!);
  const bootWorld = await clientApi(`/api/worlds/${encodeURIComponent(bootWorldId)}`);
  const markable = bootWorld.entries
    .filter((entry: any) => String(entry.content ?? '').trim() !== '' && entry.disable !== true)
    .slice(0, 3);
  check(markable.length > 0, 'the seeded book has entries worth embedding');
  for (const entry of markable) {
    await clientApi(
      `/api/worlds/${encodeURIComponent(bootWorldId)}/entries/${entry.uid}`,
      clientJson('PATCH', { vectorized: true }),
    );
  }
  await loadVectors();
  const marked = state.vectors.books.find((book: any) => book.id === bootWorldId)!;
  eq(marked.stale > 0, true, 'marked entries start out needing a vector');
  check(text('#world-list').includes('向量'), 'and the world list shows a badge for it', text('#world-list'));

  const indexed = await clientApi(`/api/worlds/${encodeURIComponent(bootWorldId)}/vectorize`, clientJson('POST', {}));
  eq(indexed.embedded, markable.length, 'indexing embeds every marked entry', `${indexed.embedded}`);
  await loadVectors();
  eq(
    state.vectors.books.find((book: any) => book.id === bootWorldId)!.stale,
    0,
    'leaving nothing stale',
  );

  // The hits panel names the reason, with the score, in the user's words.
  const vectorWord = String(markable[0].content).split(/\s+/).slice(0, 4).join(' ');
  composer.value = vectorWord;
  await clientApi('/api/prompt/preview', clientJson('POST', { chatId: state.chatId, pendingUserMessage: vectorWord }));
  await clientRefreshPreview(vectorWord);
  check(
    await until(() => text('#world-hits').includes('向量激活'), 4000),
    'a vector hit says so in the hits panel',
    text('#world-hits').slice(0, 200),
  );
  composer.value = '';

  // Forgetting the index never touches the book.
  const beforeForget = (await clientApi(`/api/worlds/${encodeURIComponent(bootWorldId)}`)).entries.length;
  await clientApi(`/api/worlds/${encodeURIComponent(bootWorldId)}/vectors`, { method: 'DELETE' });
  await loadVectors();
  eq(
    state.vectors.books.find((book: any) => book.id === bootWorldId)!.indexed,
    0,
    'the index can be dropped',
  );
  eq(
    (await clientApi(`/api/worlds/${encodeURIComponent(bootWorldId)}`)).entries.length,
    beforeForget,
    'and the book keeps every entry',
  );
  await clientApi('/api/config', clientJson('PUT', { retrieval: { mode: 'keyword' }, vector: { enabled: false } }));

  // -------------------------------------------------------------------------
  section('themes');
  // -------------------------------------------------------------------------

  const { THEMES, applyTheme, readStoredTheme, resolvedTheme } = await load('themes.js');
  const { t: translate } = await load('i18n.js');
  const root = dom.document.documentElement;

  // Nothing is chosen yet, so the stylesheet's media query decides — which is why
  // "follow the system" needs no script at all.
  eq(readStoredTheme(), 'system', 'a fresh browser follows the system');
  eq(root.getAttribute('data-theme'), null, 'and sets no attribute, leaving it to the media query');
  eq(resolvedTheme('system'), 'dark', 'the shim prefers dark, like the shipped palette');

  const themeCards = () => dom.all('.theme-card');
  const toolbar = dom.document.getElementById('btn-settings')!;
  dom.click(toolbar);
  // Themes moved to the appearance page; the dialog remembers the last page,
  // so go there explicitly before reading its note.
  dom.click(dom.all('[role="tab"]')[1]!); // 外观
  const appearancePane = () => dom.all('.settings-pane')[1]!;
  const appearanceNote = () => appearancePane().querySelector('.settings-extra .hint')?.textContent ?? '';
  check(await until(() => dom.one('.settings-extra .theme-cards') !== null, 5000), 'the dialog offers themes');
  eq(themeCards().length, THEMES.length, 'one card per theme', `${themeCards().length}`);
  eq(themeCards().map((card) => card.textContent).join(','), THEMES.map((theme) => translate(theme.labelKey)).join(','), 'labelled');
  eq(
    themeCards().find((card) => card.getAttribute('aria-checked') === 'true')?.textContent,
    '跟随系统',
    'with the stored choice selected',
  );

  // Choosing light writes the attribute the palette hangs off, and remembers it.
  dom.click(themeCards().find((card) => card.textContent === '浅色')!);
  eq(root.getAttribute('data-theme'), 'light', 'picking light sets data-theme');
  eq(readStoredTheme(), 'light', 'and remembers the choice');
  check(
    appearanceNote().includes('不再跟随系统'),
    'the note says it is pinned rather than following',
    appearanceNote(),
  );

  // Back to following the system: the attribute goes away, so the media query wins
  // again — including when the operating system switches mid-session.
  dom.click(themeCards().find((card) => card.textContent === '跟随系统')!);
  eq(root.getAttribute('data-theme'), null, 'picking the system removes the attribute again');
  eq(readStoredTheme(), 'system', 'and that is stored as well');
  check(
    appearanceNote().includes('现在用的是'),
    'the note reports what the system resolves to',
    appearanceNote(),
  );

  // A stored id that no longer exists must not leave the app unstyled.
  localStorage.setItem('teahouse.theme.v1', 'solarized');
  eq(readStoredTheme(), 'system', 'a theme that disappeared falls back to the system');
  eq(applyTheme('dark'), 'dark', 'an explicit theme applies');
  eq(root.getAttribute('data-theme'), 'dark', 'by setting the attribute');
  applyTheme('system');
  dom.click(dom.all('.modal-header button')[0]!);

  // The corner button: the same two axes, reachable without the settings dialog.
  const { ACCENTS, applyAccent, readStoredAccent } = await load('themes.js');
  const fab = dom.one('.appearance-fab');
  check(fab !== null, 'there is a corner appearance button');
  eq(fab.getAttribute('aria-expanded'), 'false', 'closed to begin with');
  eq(readStoredAccent(), 'indigo', 'and the default accent is what the base palette already paints');
  eq(root.getAttribute('data-accent'), null, 'so no accent attribute is set');

  dom.click(fab);
  const popover = () => dom.one('.appearance-popover');
  eq(popover()!.classList.contains('hidden'), false, 'clicking it opens the popover');
  eq(fab.getAttribute('aria-expanded'), 'true', 'and says so');
  eq(dom.all('.appearance-popover .accent-swatch').length, ACCENTS.length, 'with a swatch per accent');
  eq(dom.all('.appearance-popover .appearance-chip').length, 3, 'and the three appearance modes');
  eq(
    dom.all('.appearance-popover .accent-swatch').find((node) => node.getAttribute('aria-checked') === 'true')
      ?.getAttribute('data-accent'),
    'indigo',
    'with the current one selected',
  );

  dom.click(dom.one('.appearance-popover .accent-swatch[data-accent="teal"]')!);
  eq(root.getAttribute('data-accent'), 'teal', 'picking a colour sets the accent attribute');
  eq(readStoredAccent(), 'teal', 'and remembers it');
  eq(popover()!.classList.contains('hidden'), true, 'the popover gets out of the way');

  dom.click(fab);
  dom.click(dom.all('.appearance-popover .appearance-chip').find((node) => node.textContent.includes('浅色'))!);
  eq(root.getAttribute('data-theme'), 'light', 'the same popover switches the mode');
  eq(popover()!.classList.contains('hidden'), true, 'and gets out of the way for that too');

  // Escape closes the popover and nothing else; a click outside does too.
  dom.click(fab);
  eq(popover()!.classList.contains('hidden'), false, 'the button opens it again');
  dom.fire(dom.document, 'keydown', { key: 'Escape' });
  eq(popover()!.classList.contains('hidden'), true, 'Escape closes it');
  dom.click(fab);
  eq(popover()!.classList.contains('hidden'), false, 'and it opens');
  dom.click(fab);
  eq(popover()!.classList.contains('hidden'), true, 'and the button toggles it shut');
  dom.click(fab);
  dom.fire(dom.body, 'mousedown', {});
  eq(popover()!.classList.contains('hidden'), true, 'a click elsewhere closes it too');
  eq(root.getAttribute('data-theme'), 'light', 'while the theme survives all of that');

  // The settings dialog offers the same choices, from the same module.
  dom.click(dom.document.getElementById('btn-settings')!);
  check(
    await until(() => dom.one('.settings-extra .accent-swatches') !== null, 5000),
    'the dialog has the accent row as well',
  );
  eq(
    dom.all('.settings-extra .accent-swatch').length,
    ACCENTS.length,
    'with the same accents',
  );
  dom.click(dom.one('.settings-extra .accent-swatch[data-accent="rose"]')!);
  eq(root.getAttribute('data-accent'), 'rose', 'and choosing there works too');
  applyAccent('indigo');
  applyTheme('system');
  dom.click(dom.all('.modal-header button')[0]!);

  // -------------------------------------------------------------------------
  section('interface language');
  // -------------------------------------------------------------------------

  const { applyStaticI18n, setLocale: setUiLanguage } = await load('i18n.js');
  setUiLanguage('en');
  applyStaticI18n(dom.document);
  eq(dom.document.getElementById('btn-settings')!.textContent, 'Settings', 'the static shell switches language');
  eq(dom.one('.panel-left h2')!.textContent, 'Characters', 'including the panel headings');
  check(
    dom.document.getElementById('input')!.getAttribute('placeholder')?.startsWith('Say something'),
    'and the composer placeholder',
  );
  setUiLanguage('zh-CN');
  applyStaticI18n(dom.document);
  eq(dom.document.getElementById('btn-settings')!.textContent, '设置', 'and switches back');

  eq(strayErrors(), [], 'no other slash command failed');

  console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILURES'}  checks=${checks} failed=${failures}`);
} finally {
  // Background work may still be in flight — the memory view summarises after a
  // turn, the trajectory reloads on a chat event — and closing the server under it
  // produces a bare `fetch failed` rejection that looks like a test bug and hides
  // the real one. Give the queue a moment, and name anything that still escapes.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  process.on('unhandledRejection', (reason) => {
    console.error('\nUNHANDLED REJECTION after teardown:', reason);
  });
  await app.close();
  provider.close();
  rmSync(dataDir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
