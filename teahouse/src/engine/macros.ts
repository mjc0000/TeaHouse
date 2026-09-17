/**
 * Macro expansion (`{{char}}`, `{{user}}`, variables, ...).
 *
 * Two rules matter and both come from SillyTavern:
 *   1. expansion happens AFTER world book injection, so `{{user}}` inside a
 *      world book entry is substituted too
 *   2. an unknown macro is left untouched rather than blanked, so typos are
 *      visible instead of silently eating text
 *
 * Single pass, like ST's `substituteParams`: a macro produced by a variable is
 * not re-expanded (prevents infinite recursion).
 */

export interface MacroContext {
  char: string;
  user: string;
  persona: string;
  description: string;
  personality: string;
  scenario: string;
  mesExamples: string;
  /** Mutable: `{{setvar}}`/`{{addvar}}`/`{{incvar}}` write here. */
  variables: Record<string, string>;
  /** Recent user input, for `{{input}}`. */
  input?: string;
  /** Injectable for deterministic tests. */
  now?: Date;
  /** Character names when several are present; `{{charIfNotGroup}}` collapses to one. */
  groupMembers?: string[];
  /** Seeded pick, so `{{pick}}` is stable within a chat turn. */
  random?: () => number;
}

const MACRO_PATTERN = /\{\{([^{}]*?)\}\}/g;

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function expandMacros(text: string, context: MacroContext): string {
  if (!text.includes('{{')) return text;
  const random = context.random ?? Math.random;
  const now = context.now ?? new Date();

  return text.replace(MACRO_PATTERN, (whole, body: string) => {
    const trimmed = body.trim();
    if (trimmed === '') return whole;

    const separator = trimmed.indexOf('::');
    const name = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim();
    const argument = separator === -1 ? '' : trimmed.slice(separator + 2);
    const args = argument.split('::');

    switch (name) {
      case 'char':
        return context.char;
      case 'charIfNotGroup':
        return context.groupMembers && context.groupMembers.length > 1
          ? context.groupMembers.join(', ')
          : context.char;
      case 'user':
        return context.user;
      case 'persona':
        return context.persona;
      case 'description':
        return context.description;
      case 'personality':
        return context.personality;
      case 'scenario':
        return context.scenario;
      case 'mesExamples':
      case 'mes_example':
        return context.mesExamples;
      case 'input':
        return context.input ?? '';
      case 'time':
        return formatTime(now);
      case 'date':
        return formatDate(now);
      case 'isotime':
        return now.toISOString();
      case 'newline':
        return '\n';
      case 'trim':
        return '';
      case 'noop':
      case '//':
        return '';

      case 'getvar': {
        const key = args[0]?.trim() ?? '';
        return context.variables[key] ?? '';
      }
      case 'setvar': {
        const key = args[0]?.trim() ?? '';
        const value = args.slice(1).join('::');
        if (key !== '') context.variables[key] = value;
        return '';
      }
      case 'addvar': {
        const key = args[0]?.trim() ?? '';
        const value = args.slice(1).join('::');
        if (key !== '') context.variables[key] = (context.variables[key] ?? '') + value;
        return '';
      }
      case 'incvar': {
        const key = args[0]?.trim() ?? '';
        const current = Number(context.variables[key] ?? 0);
        const next = (Number.isFinite(current) ? current : 0) + 1;
        if (key !== '') context.variables[key] = String(next);
        return String(next);
      }
      case 'decvar': {
        const key = args[0]?.trim() ?? '';
        const current = Number(context.variables[key] ?? 0);
        const next = (Number.isFinite(current) ? current : 0) - 1;
        if (key !== '') context.variables[key] = String(next);
        return String(next);
      }
      case 'random': {
        const options = argument.split(',').map((option) => option.trim());
        if (options.length === 0) return whole;
        return options[Math.floor(random() * options.length)] ?? whole;
      }
      case 'pick': {
        const options = argument.split(',').map((option) => option.trim());
        if (options.length === 0) return whole;
        // ST keeps `pick` stable per chat; a seeded RNG gives the same property.
        return options[Math.floor(random() * options.length)] ?? whole;
      }

      default:
        // Unknown macro: leave it alone so the user can see it.
        return whole;
    }
  });
}

export interface DisplayMacroContext {
  char: string;
  user: string;
  persona: string;
  description: string;
  personality: string;
  scenario: string;
  mesExamples: string;
  variables?: Record<string, string>;
  groupMembers?: string[];
  now?: Date;
}

/**
 * Display-time macros: what the transcript shows for `{{user}}` the model
 * echoed back.
 *
 * SillyTavern only does this for the first message (and writes it back into
 * the chat). Here every message renders it, but purely: the allowlist holds
 * no writers (`setvar` et al would corrupt state on every re-render) and no
 * dice (`random`/`pick` would flicker between renders). Anything else —
 * writers, dice, `{{input}}`, the unknown — stays literal, and storage never
 * changes: editing and copying keep seeing the raw text.
 */
export function expandDisplayMacros(text: string, context: DisplayMacroContext): string {
  if (!text.includes('{{')) return text;
  const now = context.now ?? new Date();
  const variables = context.variables ?? {};
  return text.replace(MACRO_PATTERN, (whole, body: string) => {
    const trimmed = body.trim();
    if (trimmed === '') return whole;
    const separator = trimmed.indexOf('::');
    const name = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim();
    const argument = separator === -1 ? '' : trimmed.slice(separator + 2);
    switch (name) {
      case 'char':
        return context.char;
      case 'charIfNotGroup':
        return context.groupMembers && context.groupMembers.length > 1
          ? context.groupMembers.join(', ')
          : context.char;
      case 'user':
        return context.user;
      case 'persona':
        return context.persona;
      case 'description':
        return context.description;
      case 'personality':
        return context.personality;
      case 'scenario':
        return context.scenario;
      case 'mesExamples':
      case 'mes_example':
        return context.mesExamples;
      case 'time':
        return formatTime(now);
      case 'date':
        return formatDate(now);
      case 'isotime':
        return now.toISOString();
      case 'newline':
        return '\n';
      case 'trim':
      case 'noop':
      case '//':
        return '';
      case 'getvar': {
        const key = argument.split('::')[0]?.trim() ?? '';
        return variables[key] ?? '';
      }
      default:
        return whole;
    }
  });
}

/** Names this engine understands; used by the UI to document what is supported. */
export const SUPPORTED_MACROS = [  'char',
  'charIfNotGroup',
  'user',
  'persona',
  'description',
  'personality',
  'scenario',
  'mesExamples',
  'input',
  'time',
  'date',
  'isotime',
  'newline',
  'getvar',
  'setvar',
  'addvar',
  'incvar',
  'decvar',
  'random',
  'pick',
] as const;
