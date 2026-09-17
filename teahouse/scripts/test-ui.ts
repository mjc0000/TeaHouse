/**
 * Interaction suite: the settings dialog and the shared form controls, really
 * executed against the DOM test double in `shim-dom.ts`.
 *
 * Why this suite exists: "the settings button does nothing" has already happened
 * twice, and neither time was a syntax error — the module parsed, the imports
 * resolved, the ids matched. What broke was a runtime detail inside a click
 * handler, which no amount of source inspection can catch and which is invisible
 * without a browser. So here the dialog is really opened, every control is
 * really read and written, a save is really attempted, and anything the client's
 * own error surface reports fails the run.
 *
 * Covered:
 *   1. opening builds five categories; exactly one is selected and its pane shown
 *   2. keyboard access: arrow/Home/End walk the categories, Tab stays trapped in
 *      the dialog, controls in hidden panes are not reachable, Esc closes it
 *   3. fields are filled from the config and read back as the payload the server
 *      expects (masked secret skipped, emptied number omitted, enums numeric)
 *   4. an out-of-range number is refused, explained, and its category is shown
 *   5. the reply-language preview agrees with the server's own renderer
 *   6. every real entry-field spec renders a sensible control through
 *      components/form-field.js and round-trips its value
 *
 * Run: node scripts/test-ui.ts
 */

import { DEFAULT_CONFIG } from '../src/store/db.ts';
import { DEFAULT_LANGUAGE_INSTRUCTION, renderLanguageInstruction } from '../src/engine/prompt-stack.ts';
import { localizedEntryFields } from '../src/formats/entry-fields.ts';
import { SETTINGS_PAGES } from '../web/js/settings-schema.js';
import { applyStaticI18n, setLocale, t } from '../web/js/i18n.js';
import { providersPayload } from '../src/llm/providers.ts';
import { installDom, type ShimDom, type ShimElement } from './shim-dom.ts';

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

/** Identity comparison: DOM nodes cannot be JSON-stringified. */
function same(actual: unknown, expected: unknown, label: string): void {
  check(actual === expected, label, actual === expected ? '' : 'not the same node');
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// The page, the provider, and the client
// ---------------------------------------------------------------------------

const dog: ShimDom = installDom();

/** What the client's `api.js` needs from `fetch`. */
interface FetchLike {
  (path: string, init?: { method?: string; body?: string }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

/** A stand-in for the server: same config contract as src/routes/meta.ts. */
function createServer() {
  const initial = { ...DEFAULT_CONFIG, apiKey: 'sk-test-key' };
  let stored = structuredClone(initial);
  const requests: { path: string; method: string; body: Record<string, unknown> | null }[] = [];

  const response = (body: unknown) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  });

  const fetchStub: FetchLike = async (path, init = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({ path, method, body });

    if (path === '/api/config' && method === 'GET') {
      // Never echo the key back, exactly as the server does.
      return response({ ...stored, apiKey: stored.apiKey === '' ? '' : '***' });
    }
    if (path === '/api/config' && method === 'PUT') {
      const patch = { ...(body as Record<string, unknown>) };
      if (patch.apiKey === '***') delete patch.apiKey;
      stored = {
        ...stored,
        ...patch,
        scan: { ...stored.scan, ...((patch.scan as Record<string, unknown>) ?? {}) },
      };
      return response({ ...stored, apiKey: '***' });
    }
    if (path.startsWith('/api/providers')) {
      // Same contract as the server: the query names the values to judge.
      const url = new URL(`http://shim${path}`);
      const baseUrl = url.searchParams.get('baseUrl') ?? String(stored.baseUrl ?? '');
      const model = url.searchParams.get('model') ?? String(stored.model ?? '');
      return response(providersPayload(baseUrl, model));
    }
    if (path === '/api/config/test') {
      return response({ ok: true, elapsedMs: 42, modelCount: 7, modelKnown: true });
    }
    if (path === '/api/prompt/stack') {
      return response({
        blocks: [],
        macros: [],
        defaultLanguageInstruction: DEFAULT_LANGUAGE_INSTRUCTION,
      });
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  };

  globalThis.fetch = fetchStub;
  return { requests, get stored() { return stored; } };
}

const server = createServer();

// The static anchor the page owns: the settings button.
const settingsButton = dog.document.createElement('button');
settingsButton.setAttribute('id', 'btn-settings');
dog.document.body.append(settingsButton);

// Imported after the shim is installed: the client modules are plain browser
// modules, and a future top-level DOM access must not run against nothing.
const load = (name: string) => import(new URL(`../web/js/${name}`, import.meta.url).href);
const { installKeys, escapeStackDepth } = await load('keys.js');
const { focusableWithin } = await load('focus.js');
const { state, loadConfig, loadStack } = await load('api.js');
const { initSettingsView } = await load('views/settings.js');
const { createField } = await load('components/form-field.js');

installKeys();
await loadConfig();
await loadStack();
await initSettingsView();

const openDialog = () => dog.click(settingsButton);
const panel = () => dog.one('.modal-panel.settings')!;
/** The dialog is built lazily, so "closed" also covers "not built yet". */
const isOpen = () => {
  const panelNode = dog.one('.modal-panel.settings');
  return Boolean(panelNode) && !(panelNode!.parentNode as ShimElement).classList.contains('hidden');
};
const tabs = () => dog.all('[role="tab"]');
const panes = () => dog.all('[role="tabpanel"]');
const selectedTab = () => tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')!;
const visiblePanes = () => panes().filter((pane) => !pane.hidden);
const statusText = () => dog.one('.settings-status')?.textContent ?? '';
const languagePreview = () => dog.one('.language-preview')?.textContent ?? '';

// ---------------------------------------------------------------------------
section('opening the dialog');
// ---------------------------------------------------------------------------

check(!isOpen(), 'the dialog starts closed');
openDialog();

check(isOpen(), 'the settings button opens the dialog');
eq(tabs().length, 6, 'six categories are built');
eq(panes().length, 6, 'six panes are built');
check(
  tabs().every((tab) => panes().some((pane) => pane.getAttribute('id') === tab.getAttribute('aria-controls'))),
  'every tab points at a pane that exists',
);
check(
  panes().every((pane) => tabs().some((tab) => tab.getAttribute('id') === pane.getAttribute('aria-labelledby'))),
  'every pane is labelled by its tab',
);
eq(selectedTab().getAttribute('id'), 'settings-tab-general', 'the first category opens by default');
eq(visiblePanes().length, 1, 'exactly one pane is visible');
eq(tabs().filter((tab) => tab.tabIndex === 0).length, 1, 'only the selected category is in the tab order');

// Categories and their rows both follow the schema, including the icons.
eq(
  tabs().map((tab) => tab.querySelector('.settings-nav-label')?.textContent),
  ['通用设置', '外观', '模型', '角色扮演', '世界书', '语音'],
  'the categories are the ones the schema declares, in order',
);
eq(dog.all('.settings-nav-item svg').length, 6, 'every category is drawn with an icon');
check(
  dog.all('.settings-nav-item svg').every((svg) => svg.getAttribute('viewBox') === '0 0 24 24'),
  'the icons are real inline SVG, not a font',
);
check(
  dog.all('.settings-nav-item svg').every((svg) => svg.querySelector('path') !== null),
  'and each one carries a path',
);
eq(
  panes().map((pane) => pane.querySelector('.settings-pane-hint')?.textContent),
  SETTINGS_PAGES.map((page) => t(page.hintKey)),
  'each pane opens with the hint its page declares',
);

// Every config field the schema declares ended up somewhere in the dialog.
const labels = dog.all('.field-row').map((row) => row.querySelector('.field-label')?.textContent ?? '');
for (const expected of [
  '接口地址', 'API Key', '模型', '温度', '频率惩罚', '存在惩罚', '上下文窗口', '回复预留 token', 'tokenizer.json 路径',
  '你的名字（{{user}}）', '你的人设', '回复语言', '自定义指令模板', '常用预设', '消息 Markdown 渲染',
  '扫描深度', '预算百分比', '预算上限 token', '递归扫描', '最大递归步数', '最小激活数',
  '最小激活最大深度', '把说话人名字算进匹配', '区分大小写', '全词匹配', '分组打分', '多本书插入顺序',
]) {
  check(labels.includes(expected), `there is a control for 「${expected}」`);
}
eq(new Set(labels).size, labels.length, 'no label is rendered twice');

// The row style from the reference dialog: text on the left, control right.
const addressRow = dog.row('接口地址')!;
eq(addressRow.children.length, 2, 'a row is the text block plus the control');
eq(addressRow.children[0]!.classList.contains('field-text'), true, 'the text block comes first');
check(
  addressRow.querySelector('.field-hint')?.textContent ===
    t(SETTINGS_PAGES.flatMap((page) => page.fields).find((field) => field.key === 'baseUrl')?.hintKey ?? ''),
  'the explanation is shown in the row, not only as a tooltip',
);
check(dog.control('接口地址') === addressRow.children[1], 'the control is the last thing in the row');
eq(dog.row('你的人设')!.classList.contains('field-row-text'), true, 'a long text row is marked as such');
eq(dog.row('递归扫描')!.classList.contains('field-row-boolean'), true, 'a boolean row is marked as such');

// Group headings keep the longest page readable.
dog.click(tabs()[4]!);
eq(
  panes()[4]!.querySelectorAll('.field-group').map((heading) => heading.textContent),
  ['向量检索', '扫描范围', '预算', '递归', '兼容开关', '背景注入'],
  'the world book page groups its rows',
);
check(
  panes()[4]!.querySelector('.settings-extra') !== null,
  'and carries the vector storage panel',
);
const migrationNotice = panes()[4]!.querySelector('.migration-notice');
check(migrationNotice !== null, 'and a slot for the retired-switch notice');
check(migrationNotice!.classList.contains('hidden'), 'hidden while no retired switch is set');
dog.click(tabs()[0]!);

// ---------------------------------------------------------------------------
section('keyboard access');
// ---------------------------------------------------------------------------

const focusable = () => focusableWithin(panel());
/** A control on the last page, used to check that hidden panes are skipped. */
const scanning = () => dog.control('扫描深度');

check(focusable().includes(tabs()[0]!), 'the categories are reachable');
check(focusable().includes(scanning()) === false, 'controls in a hidden pane are not reachable');
const last = focusable()[focusable().length - 1]!;
dog.document.activeElement = last;
const tabEvent = dog.fire(panel(), 'keydown', { key: 'Tab' });
same(dog.document.activeElement, focusable()[0]!, 'Tab from the last control wraps to the first');
check(tabEvent.defaultPrevented, 'wrapping is prevented, so Tab cannot leave the dialog');
const first = focusable()[0]!;
dog.document.activeElement = first;
dog.fire(panel(), 'keydown', { key: 'Tab', shiftKey: true });
same(dog.document.activeElement, focusable()[focusable().length - 1]!, 'Shift+Tab wraps the other way');

dog.fire(tabs()[0]!, 'keydown', { key: 'ArrowDown' });
eq(selectedTab().getAttribute('id'), 'settings-tab-appearance', 'ArrowDown selects the next category');
dog.fire(tabs()[1]!, 'keydown', { key: 'End' });
eq(selectedTab().getAttribute('id'), 'settings-tab-voice', 'End selects the last category');
dog.click(tabs()[4]!);
check(focusable().includes(scanning()), 'the newly shown pane becomes reachable');
dog.fire(tabs()[4]!, 'keydown', { key: 'ArrowDown' });
eq(selectedTab().getAttribute('id'), 'settings-tab-voice', 'ArrowDown steps to the voice page');
dog.fire(tabs()[5]!, 'keydown', { key: 'ArrowDown' });
eq(selectedTab().getAttribute('id'), 'settings-tab-general', 'ArrowDown wraps around');
dog.fire(tabs()[0]!, 'keydown', { key: 'Home' });
eq(selectedTab().getAttribute('id'), 'settings-tab-general', 'Home returns to the first category');
dog.click(tabs()[3]!);
eq(selectedTab().getAttribute('id'), 'settings-tab-persona', 'clicking a category selects it');
eq(visiblePanes().length, 1, 'one pane stays visible after switching');

eq(escapeStackDepth(), 1, 'opening the dialog pushes one escape layer');
dog.fire(dog.document, 'keydown', { key: 'Escape' });
check(!isOpen(), 'Escape closes the dialog');
eq(escapeStackDepth(), 0, 'closing releases the escape layer');
openDialog();

// ---------------------------------------------------------------------------
section('values, in the dialog and in the payload');
// ---------------------------------------------------------------------------

eq(dog.control('接口地址').value, DEFAULT_CONFIG.baseUrl, 'the base URL comes from the config');
eq(dog.control('上下文窗口').value, String(DEFAULT_CONFIG.maxContext), 'the context window comes from the config');
eq(dog.control('API Key').value, '***', 'the API key is shown masked, never in full');
eq(dog.control('递归扫描').checked, DEFAULT_CONFIG.scan.recursive, 'a boolean reflects the config');
eq(dog.control('多本书插入顺序').value, String(DEFAULT_CONFIG.scan.characterStrategy), 'an enum reflects the config');
eq(dog.control('你的人设').tagName, 'TEXTAREA', 'a long text field is a box');

// An untouched form is not a change.
dog.click(dog.button('保存')!);
await settle();
eq(server.requests.filter((request) => request.method === 'PUT').length, 0, 'an unchanged form sends nothing');
eq(statusText(), '没有改动', 'and says so');

// The general page previews the line the server would inject.
dog.click(tabs()[0]!);
check(languagePreview().includes('不会往提示词里加任何语言指令'), 'an empty language explains itself');
dog.type(dog.control('回复语言'), '中文');
eq(
  dog.one('.language-preview code')?.textContent,
  renderLanguageInstruction({ outputLanguage: '中文' }),
  'the preview matches the server renderer byte for byte',
);
const preset = dog.control('常用预设');
preset.value = '火星文';
dog.fire(preset, 'change');
eq(dog.control('回复语言').value, '火星文', 'a preset fills the language field');
eq(preset.value, '', 'the preset selector returns to its placeholder');
check(languagePreview().includes('火星文'), 'the preview follows the preset');
check(dog.row('常用预设') !== null, 'the preset selector sits in a row like every other setting');
check(
  tabs()[0]!.querySelector('.settings-nav-dot')?.classList.contains('hidden') === false,
  'the edited category is marked as unsaved',
);

// A plain boolean is a checkbox, and toggling it is a change on its own page.
dog.click(tabs()[4]!);
const scoring = dog.control('分组打分');
eq(scoring.tagName, 'INPUT', 'a plain boolean is a checkbox');
eq(scoring.checked, false, 'and starts unchecked');
scoring.checked = true;
dog.fire(scoring, 'change');
check(
  tabs()[4]!.querySelector('.settings-nav-dot')?.classList.contains('hidden') === false,
  'toggling a checkbox on another page marks that category',
);

// The model page explains how tokens are counted, and can test the link.
dog.click(tabs()[2]!);
const countingPane = panes()[2]!;
check(countingPane.textContent.includes('估算'), 'the counting section names the current mode');
check(dog.row('当前计数方式') !== null, 'the counting status is a row, not a footnote');
check(dog.row('连接测试') !== null, 'and so is the connection test');
dog.click(dog.button('测试连接')!);
await settle();
check(countingPane.textContent.includes('连接正常'), 'the connection result is reported', countingPane.textContent);

// Provider presets: choosing one types its base URL into the field above.
await settle();
const providerPreset = dog.control('服务商预设');
check(dog.row('服务商预设') !== null, 'the provider preset sits in a row like every other setting');
eq(providerPreset.tagName, 'SELECT', 'and is a dropdown');
eq(providerPreset.value, 'deepseek', 'preselected from the saved base URL');
// It fills the page's first field, so it has to sit above the fields rather
// than at the bottom with the other extras.
const modelRows = panes()[2]!.querySelectorAll('.field-row');
check(
  modelRows.indexOf(providerPreset) < modelRows.indexOf(dog.row('接口地址')!),
  'the preset sits above the fields it fills',
  `${modelRows.indexOf(providerPreset)} < ${modelRows.indexOf(dog.row('接口地址')!)}`,
);
providerPreset.value = 'zhipu';
dog.fire(providerPreset, 'change');
// The change bubbles to the dialog's own edit handler, which re-renders the
// extras; the picked value must survive that or the control looks dead.
eq(providerPreset.value, 'zhipu', 'the picked preset stays picked through the re-render');
await settle();
eq(
  dog.control('接口地址').value,
  'https://open.bigmodel.cn/api/paas/v4',
  'a preset fills the base URL',
);

// Extra connections: the block starts empty and can add a draft row.
check(dog.row('额外连接') !== null, 'the model page offers extra connections');
eq(dog.all('.conn-row').length, 0, 'with none saved yet');
dog.click(dog.button('添加连接')!);
eq(dog.all('.conn-row').length, 1, 'adding one adds a row of inputs');
eq(dog.all('.conn-row input').length, 4, 'name, URL, key and model');
dog.click(dog.all('.conn-row .icon-button')[0]!);
eq(dog.all('.conn-row').length, 0, 'and it can be removed again');

// ---------------------------------------------------------------------------
section('an invalid value cannot be saved');
// ---------------------------------------------------------------------------

dog.click(tabs()[2]!);
dog.type(dog.control('上下文窗口'), '0');
dog.click(dog.button('保存')!);
await settle();

eq(server.requests.filter((request) => request.method === 'PUT').length, 0, 'nothing is sent while invalid');
eq(selectedTab().getAttribute('id'), 'settings-tab-model', 'the offending category is shown');
const problem = dog.one('.field-problem');
eq(problem?.textContent, '需要大于 0', 'the problem is explained next to the field');
check(statusText().includes('上下文窗口'), 'the footer names the offending field', statusText());
same(dog.document.activeElement, dog.control('上下文窗口'), 'focus moves to the offending control');
check(
  dog.control('上下文窗口').closest('.field-row')?.classList.contains('invalid') === true,
  'the offending row is marked',
);

// A field on another page jumps there instead.
dog.type(dog.control('上下文窗口'), String(DEFAULT_CONFIG.maxContext));
dog.click(tabs()[4]!);
dog.type(dog.control('预算百分比'), '250');
dog.click(dog.button('保存')!);
await settle();
eq(selectedTab().getAttribute('id'), 'settings-tab-world', 'an error on another page jumps to that page');
check(statusText().includes('预算百分比'), 'the footer names that field', statusText());

// Editing clears the mark again.
dog.type(dog.control('预算百分比'), '25');
check(dog.one('.field-problem') === null, 'editing clears the problem message');

// ---------------------------------------------------------------------------
section('saving');
// ---------------------------------------------------------------------------

dog.type(dog.control('上下文窗口'), '32000');
dog.type(dog.control('你的名字（{{user}}）'), '旅人');
dog.click(dog.button('保存')!);
await settle();

const puts = server.requests.filter((request) => request.method === 'PUT');
eq(puts.length, 1, 'a valid form is sent once');
const payload = puts[0]!.body ?? {};
eq(payload.maxContext, 32000, 'an edited number is sent as a number');
eq(payload.personaName, '旅人', 'an edited text field is sent');
eq(payload.outputLanguage, '火星文', 'the reply language is sent');
eq('apiKey' in payload, false, 'the masked API key is not sent');
eq(payload.scan?.budgetPercent, 25, 'scan fields are nested under scan');
eq(payload.scan?.characterStrategy, DEFAULT_CONFIG.scan.characterStrategy, 'an enum is sent as a number');
check(statusText().includes('已保存'), 'the footer confirms the save', statusText());
eq(dog.all('.settings-nav-dot.hidden').length, SETTINGS_PAGES.length, 'no category is marked once saved');
eq(dog.control('API Key').value, '***', 'the key is still masked after the reload');
eq(dog.control('上下文窗口').value, '32000', 'the saved value is what the form now shows');

// An emptied number box is not a change the server should see.
dog.type(dog.control('上下文窗口'), '');
dog.click(dog.button('保存')!);
await settle();
eq(server.requests.filter((request) => request.method === 'PUT').length, 1, 'an emptied number box sends nothing');
eq(server.stored.maxContext, 32000, 'and the stored value is left alone');

// ---------------------------------------------------------------------------
section('reopening');
// ---------------------------------------------------------------------------

dog.click(dog.button('关闭')!);
check(!isOpen(), 'the close button closes the dialog');
openDialog();
eq(tabs().length, SETTINGS_PAGES.length, 'reopening does not duplicate the categories');
eq(dog.all('.field-row').length, labels.length, 'and does not duplicate the fields');

// ---------------------------------------------------------------------------
section('shared form controls (every real entry field)');
// ---------------------------------------------------------------------------

const ENTRY_FIELDS = localizedEntryFields('zh-CN').fields;
const sampleFor = (spec: (typeof ENTRY_FIELDS)[number]): unknown => {
  switch (spec.type) {
    case 'line':
      return 'hello';
    case 'text':
      return 'line one\nline two';
    case 'keys':
      return ['first', 'second'];
    case 'number':
      return spec.nullable ? null : 7;
    case 'boolean':
      return spec.nullable ? null : true;
    case 'enum':
      return spec.options![0]!.value;
    case 'triggers':
      return [spec.options![0]!.value];
    default:
      return '';
  }
};

for (const spec of ENTRY_FIELDS) {
  const sample = sampleFor(spec);
  const field = createField(spec, sample);
  const tag = field.node.tagName;

  if (spec.type === 'line') check(tag === 'INPUT', `${spec.field}: a single line field is an input`, tag);
  if (spec.type === 'text') check(tag === 'TEXTAREA', `${spec.field}: a long text field is a textarea`, tag);
  if (spec.type === 'keys') check(tag === 'TEXTAREA', `${spec.field}: a key list is a textarea`, tag);
  if (spec.type === 'number') check(tag === 'INPUT', `${spec.field}: a number field is an input`, tag);
  if (spec.type === 'enum') check(tag === 'SELECT', `${spec.field}: an enum is a select`, tag);
  if (spec.type === 'triggers') check(tag === 'DIV', `${spec.field}: a trigger set is a checkbox group`, tag);
  if (spec.type === 'boolean') {
    check(
      tag === (spec.nullable ? 'SELECT' : 'INPUT'),
      `${spec.field}: a boolean is ${spec.nullable ? 'a tri-state select' : 'a checkbox'}`,
      tag,
    );
  }
  eq(field.read(), sample, `${spec.field}: the value round-trips (${spec.type})`);

  if (spec.readOnly) eq(field.node.disabled, true, `${spec.field}: a read-only field is disabled`);

  if (spec.type === 'number') {
    field.node.value = '';
    eq(
      field.read(),
      spec.nullable ? null : 0,
      `${spec.field}: a blank number reads as ${spec.nullable ? 'null (inherit)' : '0'}`,
    );
  }
}

// ---------------------------------------------------------------------------
section('interface translation');
// ---------------------------------------------------------------------------

// `data-i18n*` attributes are the static-markup half of the dictionary: the
// mechanism that lets index.html follow the language without a build step.
const staticHost = dog.document.createElement('div');
const textNode = dog.document.createElement('span');
textNode.setAttribute('data-i18n', 'settings.title');
const titleNode = dog.document.createElement('button');
titleNode.setAttribute('data-i18n-title', 'settings.unsaved');
const placeholderNode = dog.document.createElement('input');
placeholderNode.setAttribute('data-i18n-placeholder', 'settings.fields.model.placeholder');
staticHost.append(textNode, titleNode, placeholderNode);
dog.document.body.append(staticHost);

applyStaticI18n(staticHost);
eq(textNode.textContent, t('settings.title'), 'data-i18n writes the text');
eq(titleNode.getAttribute('title'), t('settings.unsaved'), 'data-i18n-title writes the attribute');
eq(
  placeholderNode.getAttribute('placeholder'),
  t('settings.fields.model.placeholder'),
  'data-i18n-placeholder writes the attribute',
);

setLocale('en');
applyStaticI18n(staticHost);
eq(textNode.textContent, 'Settings', 're-applying follows the new locale');
eq(dog.document.documentElement.getAttribute('lang'), 'en', 'the document language follows the locale');
eq(dog.document.documentElement.getAttribute('dir'), 'ltr', 'and so does the writing direction');
eq(
  dog.all('.settings-nav-item')[0]?.querySelector('.settings-nav-label')?.textContent,
  'General',
  'the settings dialog follows the switch too',
);

setLocale('zh-CN');
applyStaticI18n(staticHost);
eq(textNode.textContent, '设置', 'and switches back');
eq(dog.document.documentElement.getAttribute('lang'), 'zh-CN', 'the document language switches back too');
staticHost.remove();

// ---------------------------------------------------------------------------
section('client error surface');
// ---------------------------------------------------------------------------

const errors = dog.errors();
eq(errors, [], 'no error was reported while driving the dialog');

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILURES'}  checks=${checks} failed=${failures}`);
process.exit(failures === 0 ? 0 : 1);
