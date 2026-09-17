/**
 * Context template ("story string"): a user-editable template that renders the
 * slow-changing fields — description, personality, scenario, persona and the
 * world-info buckets — into one prompt block.
 *
 * The shape is borrowed from SillyTavern's context preset
 * (`power-user.js: defaultStoryString`): `{{field}}` placeholders plus
 * `{{#if field}}…{{/if}}` conditionals, rendered with no HTML escaping. Only
 * the fields below exist; anything else is reported, never silently dropped.
 * `loreBefore`/`loreAfter` are accepted as aliases of `wiBefore`/`wiAfter`,
 * because that is what older presets call them.
 */

import { notice, type Notice } from '../i18n.ts';

export const STORY_FIELDS = [
  'system',
  'description',
  'personality',
  'scenario',
  'persona',
  'char',
  'user',
  'wiBefore',
  'wiAfter',
] as const;

export type StoryField = (typeof STORY_FIELDS)[number];

const ALIASES: Record<string, StoryField> = {
  loreBefore: 'wiBefore',
  loreAfter: 'wiAfter',
};

/** SillyTavern's own default, so "restore default" means something shared. */
export const DEFAULT_STORY_TEMPLATE =
  '{{#if system}}{{system}}\n{{/if}}' +
  '{{#if description}}{{description}}\n{{/if}}' +
  "{{#if personality}}{{char}}'s personality: {{personality}}\n{{/if}}" +
  '{{#if scenario}}Scenario: {{scenario}}\n{{/if}}' +
  '{{#if persona}}{{persona}}\n{{/if}}';

export type StoryParams = Record<StoryField, string>;

export interface RenderedStory {
  text: string;
  /** Unknown tags, unclosed blocks, and content the template leaves out. */
  warnings: Notice[];
}

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'if'; name: string }
  | { kind: 'endif' };

function tokenize(template: string, warnings: Notice[]): Token[] {
  const tokens: Token[] = [];
  const pattern = /\{\{([\s\S]*?)\}\}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    if (match.index > last) tokens.push({ kind: 'text', value: template.slice(last, match.index) });
    const inner = match[1]!.trim();
    if (inner.startsWith('#if ')) {
      tokens.push({ kind: 'if', name: inner.slice(4).trim() });
    } else if (inner === '/if') {
      tokens.push({ kind: 'endif' });
    } else if (/^[A-Za-z][A-Za-z0-9_]*$/.test(inner)) {
      tokens.push({ kind: 'var', name: inner });
    } else {
      // Not a tag we understand (a macro, a stray brace, …): leave it for the
      // macro pass downstream rather than eating it here.
      tokens.push({ kind: 'text', value: match[0] });
    }
    last = match.index + match[0].length;
  }
  if (last < template.length) tokens.push({ kind: 'text', value: template.slice(last) });
  return tokens;
}

function resolve(name: string): StoryField | null {
  if ((STORY_FIELDS as readonly string[]).includes(name)) return name as StoryField;
  return ALIASES[name] ?? null;
}

/**
 * Renders the template against already-assembled field text. Falsy for `{{#if}}`
 * means blank after trimming — an empty description contributes nothing, which
 * is exactly what the conditionals are for.
 */
export function renderStoryTemplate(template: string, params: StoryParams): RenderedStory {
  const warnings: Notice[] = [];
  const tokens = tokenize(template, warnings);
  const unknown = new Set<string>();
  let output = '';
  // The stack of enclosing `{{#if}}` states; a block renders only while every
  // level on the stack is truthy.
  const stack: boolean[] = [];
  let open = 0;
  const active = (): boolean => stack.every(Boolean);

  for (const token of tokens) {
    if (token.kind === 'text') {
      if (active()) output += token.value;
    } else if (token.kind === 'var') {
      const field = resolve(token.name);
      if (!field) {
        unknown.add(token.name);
        continue;
      }
      if (active()) output += params[field] ?? '';
    } else if (token.kind === 'if') {
      open++;
      const field = resolve(token.name);
      if (!field) {
        unknown.add(token.name);
        stack.push(false);
        continue;
      }
      stack.push((params[field] ?? '').trim() !== '');
    } else {
      if (open === 0) {
        warnings.push(notice('contextTemplate.strayEndif', '模板里有多余的 {{/if}}，已忽略'));
        continue;
      }
      open--;
      stack.pop();
    }
  }
  if (open > 0) {
    warnings.push(notice('contextTemplate.unclosedIf', `模板里有 ${open} 个未闭合的 {{#if}}，按闭合处理`, { count: open }));
  }
  if (unknown.size > 0) {
    const fields = [...unknown].sort().join('、');
    warnings.push(notice('contextTemplate.unknownFields', `模板引用了未知字段：${fields}（已按空处理）`, { fields }));
  }

  // Like SillyTavern's validateStoryString: say so when the template leaves out
  // content that exists, instead of letting a field silently vanish.
  const mentioned = new Set<string>();
  for (const token of tokens) {
    if (token.kind === 'var' || token.kind === 'if') {
      const field = resolve(token.name);
      if (field) mentioned.add(field);
    }
  }
  const missing: string[] = [];
  for (const field of ['system', 'description', 'personality', 'scenario', 'persona', 'wiBefore', 'wiAfter'] as const) {
    if (!mentioned.has(field) && (params[field] ?? '').trim() !== '') missing.push(field);
  }
  if (missing.length > 0) {
    const fields = missing.map((name) => `{{${name}}}`).join('、');
    warnings.push(notice('contextTemplate.missingContent', `这些内容不在模板里，本轮不会发出：${fields}`, { fields }));
  }

  return { text: output.replace(/^\n+/, ''), warnings };
}
