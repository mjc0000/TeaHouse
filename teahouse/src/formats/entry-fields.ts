/**
 * Declarative description of every editable world book entry field.
 *
 * One source of truth, used by:
 *   - `coerceEntryPatch` on the server, to validate and type a client patch
 *   - `GET /api/worlds/fields`, which the world editor renders its form from
 *
 * Adding a field therefore means adding one entry here: the API accepts it and
 * the editor grows a control for it, with no second list to keep in sync.
 *
 * Labels are bilingual (`LocalizedText`); `localizedEntryFields(lang)` flattens
 * them for the route, so the served payload stays the plain shape the client
 * already renders. Validation never looks at text.
 *
 * Fields the compatibility layer deliberately does not let a client write
 * (`raw`, `uid`, `extensions`, `displayIndex`) are simply absent, and a patch
 * naming them is rejected rather than silently ignored.
 */

import type { InterfaceLanguage, LocalizedText } from '../i18n.ts';
import { localize } from '../i18n.ts';
import { splitKeyList } from './key-list.ts';
import { GENERATION_TRIGGERS, type WorldEntry } from './types.ts';

export type EntryFieldType = 'line' | 'text' | 'keys' | 'number' | 'boolean' | 'enum' | 'triggers';

const L = (zh: string, en: string): LocalizedText => ({ 'zh-CN': zh, en });

export const ENTRY_FIELD_GROUPS = [
  'basic',
  'activation',
  'matching',
  'timing',
  'recursion',
  'group',
  'meta',
] as const;
export type EntryFieldGroup = (typeof ENTRY_FIELD_GROUPS)[number];

export const GROUP_LABELS: Record<EntryFieldGroup, LocalizedText> = {
  basic: L('内容', 'Content'),
  activation: L('触发', 'Activation'),
  matching: L('匹配', 'Matching'),
  timing: L('时效', 'Timing'),
  recursion: L('递归', 'Recursion'),
  group: L('包含组', 'Inclusion group'),
  meta: L('其它', 'Other'),
};

export interface FieldOption {
  value: number | string;
  label: LocalizedText;
}

export interface EntryFieldSpec {
  field: keyof WorldEntry;
  label: LocalizedText;
  type: EntryFieldType;
  group: EntryFieldGroup;
  /** Number/nullable fields: an empty value means "inherit the global setting". */
  nullable?: boolean;
  options?: FieldOption[];
  min?: number;
  max?: number;
  hint?: LocalizedText;
  /** Rendered read-only: derived or not safe to hand-edit. */
  readOnly?: boolean;
}

/** The wire shape `GET /api/worlds/fields` answers with: plain strings. */
export interface LocalizedFieldOption {
  value: number | string;
  label: string;
}

export interface LocalizedEntryField {
  field: keyof WorldEntry;
  label: string;
  type: EntryFieldType;
  group: EntryFieldGroup;
  nullable?: boolean;
  options?: LocalizedFieldOption[];
  min?: number;
  max?: number;
  hint?: string;
  readOnly?: boolean;
}

export const POSITION_OPTIONS: FieldOption[] = [
  { value: 0, label: L('角色定义前 ↑Char', 'Before character ↑Char') },
  { value: 1, label: L('角色定义后 ↓Char', 'After character ↓Char') },
  { value: 2, label: L('作者注顶部 ↑AT', 'Author’s note top ↑AT') },
  { value: 3, label: L('作者注底部 ↓AT', 'Author’s note bottom ↓AT') },
  { value: 4, label: L('绝对深度 @D', 'Absolute depth @D') },
  { value: 5, label: L('示例消息顶部 ↑EM', 'Example messages top ↑EM') },
  { value: 6, label: L('示例消息底部 ↓EM', 'Example messages bottom ↓EM') },
  { value: 7, label: L('命名出口 outlet', 'Named outlet') },
];

export const ROLE_OPTIONS: FieldOption[] = [
  { value: 0, label: L('system', 'system') },
  { value: 1, label: L('user', 'user') },
  { value: 2, label: L('assistant', 'assistant') },
];

export const SELECTIVE_LOGIC_OPTIONS: FieldOption[] = [
  { value: 0, label: L('AND ANY（任一命中）', 'AND ANY (any matches)') },
  { value: 1, label: L('NOT ALL（并非全部命中）', 'NOT ALL (not every one matches)') },
  { value: 2, label: L('NOT ANY（全部未命中）', 'NOT ANY (none matches)') },
  { value: 3, label: L('AND ALL（全部命中）', 'AND ALL (all match)') },
];

export const TRIGGER_OPTIONS: FieldOption[] = GENERATION_TRIGGERS.map((trigger) => ({
  value: trigger,
  label: L(trigger, trigger),
}));

export const ENTRY_FIELD_SPECS: EntryFieldSpec[] = [
  // --- content ------------------------------------------------------------
  { field: 'comment', label: L('备注', 'Comment'), type: 'line', group: 'basic', hint: L('列表里显示的名字，不进入提示词', 'The name shown in the list; not sent to the prompt') },
  { field: 'content', label: L('内容', 'Content'), type: 'text', group: 'basic' },
  { field: 'addMemo', label: L('显示备注列', 'Show the comment column'), type: 'boolean', group: 'basic' },

  // --- activation ---------------------------------------------------------
  { field: 'key', label: L('主键', 'Primary keys'), type: 'keys', group: 'activation', hint: L('逗号分隔；/正则/标志 会被当成正则，且覆盖大小写与整词设置', 'Comma-separated; /regex/flags is treated as a regex and overrides the case and whole-word settings') },
  { field: 'keysecondary', label: L('次键', 'Secondary keys'), type: 'keys', group: 'activation' },
  { field: 'selective', label: L('启用次键', 'Use secondary keys'), type: 'boolean', group: 'activation' },
  { field: 'selectiveLogic', label: L('次键逻辑', 'Secondary logic'), type: 'enum', group: 'activation', options: SELECTIVE_LOGIC_OPTIONS },
  { field: 'constant', label: L('常驻', 'Constant'), type: 'boolean', group: 'activation', hint: L('不看键，永远注入', 'Injected always, ignoring the keys') },
  { field: 'disable', label: L('禁用', 'Disabled'), type: 'boolean', group: 'activation' },
  { field: 'triggers', label: L('限定生成类型', 'Limit to generation types'), type: 'triggers', group: 'activation', options: TRIGGER_OPTIONS, hint: L('留空表示不限', 'Empty means no limit') },

  // --- matching -----------------------------------------------------------
  { field: 'caseSensitive', label: L('区分大小写', 'Case sensitive'), type: 'boolean', nullable: true, group: 'matching' },
  { field: 'matchWholeWords', label: L('整词匹配', 'Whole words only'), type: 'boolean', nullable: true, group: 'matching' },
  { field: 'scanDepth', label: L('扫描深度', 'Scan depth'), type: 'number', nullable: true, min: 0, max: 1000, group: 'matching', hint: L('往前扫几条消息，留空用全局值', 'How many messages back to scan; empty uses the global value') },
  { field: 'probability', label: L('触发概率 %', 'Trigger probability %'), type: 'number', min: 0, max: 100, group: 'matching' },
  { field: 'useProbability', label: L('使用概率', 'Use probability'), type: 'boolean', group: 'matching' },
  { field: 'matchPersonaDescription', label: L('同时扫描 persona', 'Also scan the persona'), type: 'boolean', group: 'matching' },
  { field: 'matchCharacterDescription', label: L('同时扫描角色描述', 'Also scan the character description'), type: 'boolean', group: 'matching' },
  { field: 'matchCharacterPersonality', label: L('同时扫描角色性格', 'Also scan the character personality'), type: 'boolean', group: 'matching' },
  { field: 'matchCharacterDepthPrompt', label: L('同时扫描角色深度提示', 'Also scan the character depth prompt'), type: 'boolean', group: 'matching' },
  { field: 'matchScenario', label: L('同时扫描场景', 'Also scan the scenario'), type: 'boolean', group: 'matching' },
  { field: 'matchCreatorNotes', label: L('同时扫描作者注', 'Also scan the creator notes'), type: 'boolean', group: 'matching' },
  {
    field: 'vectorized',
    label: L('向量化', 'Vectorized'),
    type: 'boolean',
    group: 'matching',
    hint: L('勾上就参与向量检索（设置 → 世界书 → 向量检索）；没建索引的条目不会生效', 'Tick to include it in vector search (Settings → World book → Vector search); an entry without an index does nothing'),
  },
  { field: 'useRegex', label: L('use_regex', 'use_regex'), type: 'boolean', group: 'matching', readOnly: true, hint: L('酒馆导出角色书时写入的字段，酒馆扫描器自己也不读它', 'A field SillyTavern writes when exporting a character book; its own scanner does not read it either') },

  // --- insertion ----------------------------------------------------------
  { field: 'position', label: L('注入位置', 'Injection position'), type: 'enum', group: 'basic', options: POSITION_OPTIONS },
  { field: 'depth', label: L('注入深度', 'Injection depth'), type: 'number', min: 0, max: 10000, group: 'basic', hint: L('仅「绝对深度」使用', 'Only used by “absolute depth”') },
  { field: 'role', label: L('注入角色', 'Injection role'), type: 'enum', group: 'basic', options: ROLE_OPTIONS, hint: L('仅「绝对深度」使用', 'Only used by “absolute depth”') },
  { field: 'order', label: L('顺序', 'Order'), type: 'number', group: 'basic', hint: L('越大越先占用预算，也越先被注入', 'Higher numbers claim the budget first and are injected first') },
  { field: 'ignoreBudget', label: L('无视预算', 'Ignore budget'), type: 'boolean', group: 'basic' },

  // --- timing -------------------------------------------------------------
  { field: 'sticky', label: L('sticky（驻留轮数）', 'sticky (turns to linger)'), type: 'number', nullable: true, min: 1, max: 10000, group: 'timing' },
  { field: 'cooldown', label: L('cooldown（冷却轮数）', 'cooldown (turns)'), type: 'number', nullable: true, min: 1, max: 10000, group: 'timing' },
  { field: 'delay', label: L('delay（延迟轮数）', 'delay (turns)'), type: 'number', nullable: true, min: 1, max: 10000, group: 'timing', hint: L('对话不足这么多条消息时不触发', 'Not triggered until the conversation has this many messages') },

  // --- recursion ----------------------------------------------------------
  { field: 'excludeRecursion', label: L('不被递归激活', 'Excluded from recursion'), type: 'boolean', group: 'recursion' },
  { field: 'preventRecursion', label: L('内容不参与递归', 'Content does not recurse'), type: 'boolean', group: 'recursion' },
  { field: 'delayUntilRecursion', label: L('延迟到递归层级', 'Delay until recursion level'), type: 'number', min: 0, max: 100, group: 'recursion', hint: L('0 表示不延迟；true 等价于 1', '0 means no delay; true is equivalent to 1') },

  // --- inclusion groups ---------------------------------------------------
  { field: 'group', label: L('包含组', 'Inclusion group'), type: 'line', group: 'group', hint: L('多个组用逗号分隔；同组只会有一条胜出', 'Separate groups with commas; only one entry per group wins') },
  { field: 'groupWeight', label: L('组内权重', 'Group weight'), type: 'number', group: 'group' },
  { field: 'groupOverride', label: L('组内优先', 'Group override'), type: 'boolean', group: 'group' },
  { field: 'useGroupScoring', label: L('参与组内评分', 'Use group scoring'), type: 'boolean', nullable: true, group: 'group' },

  // --- meta ---------------------------------------------------------------
  { field: 'automationId', label: L('automationId', 'automationId'), type: 'line', group: 'meta', hint: L('酒馆脚本自动化用，这里只保存不执行', 'For SillyTavern script automation; stored here, never executed') },
  { field: 'outletName', label: L('outlet 名称', 'outlet name'), type: 'line', group: 'meta', hint: L('位置为 outlet 时的槽位名', 'The slot name when the position is outlet') },
  { field: 'displayIndex', label: L('displayIndex', 'displayIndex'), type: 'number', group: 'meta', readOnly: true },
];

/** Flattens the bilingual text for one language, ready to serve over HTTP. */
export function localizedEntryFields(lang: InterfaceLanguage): {
  groups: { name: EntryFieldGroup; label: string }[];
  fields: LocalizedEntryField[];
} {
  return {
    groups: ENTRY_FIELD_GROUPS.map((name) => ({ name, label: localize(GROUP_LABELS[name], lang) })),
    fields: ENTRY_FIELD_SPECS.map((spec) => {
      const field: LocalizedEntryField = {
        field: spec.field,
        label: localize(spec.label, lang),
        type: spec.type,
        group: spec.group,
      };
      if (spec.nullable !== undefined) field.nullable = spec.nullable;
      if (spec.min !== undefined) field.min = spec.min;
      if (spec.max !== undefined) field.max = spec.max;
      if (spec.readOnly !== undefined) field.readOnly = spec.readOnly;
      if (spec.hint) field.hint = localize(spec.hint, lang);
      if (spec.options) {
        field.options = spec.options.map((option) => ({ value: option.value, label: localize(option.label, lang) }));
      }
      return field;
    }),
  };
}

const SPECS_BY_FIELD = new Map<string, EntryFieldSpec>(
  ENTRY_FIELD_SPECS.map((spec) => [String(spec.field), spec]),
);

export function entryFieldSpec(field: string): EntryFieldSpec | undefined {
  return SPECS_BY_FIELD.get(field);
}

export interface PatchProblem {
  field: string;
  message: string;
}

export class EntryPatchError extends Error {
  readonly problems: PatchProblem[];

  constructor(problems: PatchProblem[]) {
    super(problems.map((problem) => `${problem.field}: ${problem.message}`).join('; '));
    this.name = 'EntryPatchError';
    this.problems = problems;
  }
}

function coerceOne(spec: EntryFieldSpec, value: unknown, problems: PatchProblem[]): unknown {
  const fail = (message: string): undefined => {
    problems.push({ field: String(spec.field), message });
    return undefined;
  };

  const isEmpty = value === null || value === undefined || value === '';
  if (spec.nullable && isEmpty) return spec.type === 'number' ? null : null;

  switch (spec.type) {
    case 'line':
    case 'text': {
      if (typeof value !== 'string') return fail('must be a string');
      return value;
    }
    case 'keys': {
      // Split with the regex-aware splitter on both paths, so pasting
      // "a, b, /c{1,2}/" works whether it arrives as a string or as one line of
      // a textarea. A naive split would tear `/a{1,2}/` into two keys.
      if (Array.isArray(value)) {
        if (!value.every((item) => typeof item === 'string')) return fail('must be a list of strings');
        return (value as string[]).flatMap((item) => splitKeyList(item));
      }
      if (typeof value === 'string') return splitKeyList(value);
      return fail('must be a list of strings or a comma-separated string');
    }
    case 'number': {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed)) return fail('must be a number');
      if (spec.min !== undefined && parsed < spec.min) return fail(`must be >= ${spec.min}`);
      if (spec.max !== undefined && parsed > spec.max) return fail(`must be <= ${spec.max}`);
      return parsed;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === 0) return value === 1;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return fail('must be a boolean');
    }
    case 'enum': {
      const allowed = (spec.options ?? []).map((option) => option.value);
      if (typeof value === 'number' && allowed.includes(value)) return value;
      if (typeof value === 'string') {
        const asNumber = Number(value);
        if (Number.isFinite(asNumber) && allowed.includes(asNumber)) return asNumber;
        if (allowed.includes(value)) return value;
      }
      return fail(`must be one of ${allowed.join(', ')}`);
    }
    case 'triggers': {
      if (!Array.isArray(value)) return fail('must be a list');
      const known = new Set<string>(TRIGGER_OPTIONS.map((option) => String(option.value)));
      const unknown = value.filter((item) => !known.has(String(item)));
      if (unknown.length > 0) return fail(`unknown trigger(s): ${unknown.join(', ')}`);
      return value.map((item) => String(item));
    }
    default:
      return fail('unsupported field type');
  }
}

/**
 * Validates and types a client patch.
 * Unknown fields and read-only fields are reported instead of being dropped, so
 * a typo in the editor surfaces instead of quietly doing nothing.
 */
export function coerceEntryPatch(patch: Record<string, unknown>): Partial<WorldEntry> {
  const problems: PatchProblem[] = [];
  const out: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(patch)) {
    const spec = SPECS_BY_FIELD.get(field);
    if (!spec) {
      problems.push({ field, message: 'unknown or non-editable field' });
      continue;
    }
    if (spec.readOnly) {
      problems.push({ field, message: 'field is read-only' });
      continue;
    }
    const coerced = coerceOne(spec, value, problems);
    if (coerced !== undefined || (spec.nullable && (value === null || value === ''))) {
      out[field] = coerced;
    }
  }

  if (problems.length > 0) throw new EntryPatchError(problems);
  return out as Partial<WorldEntry>;
}
