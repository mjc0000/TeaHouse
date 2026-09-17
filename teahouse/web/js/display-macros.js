/**
 * Display-time macros for the transcript.
 *
 * Mirrors the server's `expandDisplayMacros` (`src/engine/macros.ts`): the
 * pure allowlist only (identity, time, `getvar`), so re-rendering never writes
 * state and never rolls dice. `test:web` runs both copies on the same inputs.
 */

const MACRO_PATTERN = /\{\{([^{}]*?)\}\}/g;

function formatTime(date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date) {
  return date.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function expandDisplayMacros(text, context) {
  if (!String(text).includes('{{')) return String(text);
  const now = context?.now ?? new Date();
  const variables = context?.variables ?? {};
  return String(text).replace(MACRO_PATTERN, (whole, body) => {
    const trimmed = String(body).trim();
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
      // Card-body fields are unknown to the reading view (it never fetched the
      // card), so they stay literal instead of blanking to nothing.
      case 'description':
        return context.description ?? whole;
      case 'personality':
        return context.personality ?? whole;
      case 'scenario':
        return context.scenario ?? whole;
      case 'mesExamples':
      case 'mes_example':
        return context.mesExamples ?? whole;
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
