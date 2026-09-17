/**
 * A LaTeX subset for chat math, without a typesetting dependency.
 *
 * `parseMath` is pure (plain-object AST, importable in node) while
 * `mathNodes` builds guarded DOM through `dom.js`, like the Markdown
 * renderer: message text only ever becomes text content, never markup.
 * Anything outside the subset degrades to literal text — a formula never
 * throws and never vanishes.
 *
 * Delimiters (`\(…\)`, `\[…\]`, `$$…$$`) belong to the Markdown renderer;
 * this module sees the inside only. Supported inside: ^{}/_{} scripts,
 * \frac \binom \sqrt \sum \prod \int \lim and friends, \left…\right,
 * \boxed, \text and friends, \overline and accents, aligned/cases/matrix
 * environments, and a working set of Greek letters, operators, relations
 * and arrows.
 */

import { el } from './dom.js';

/** Command name to one character, for the working set. */
const SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'θ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
  varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ',
  varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', Upsilon: 'ϒ',
  pm: '±', mp: '∓', times: '×', div: '÷', ast: '∗', star: '★', circ: '∘',
  bullet: '•', cdot: '⋅', cap: '∩', cup: '∪', uplus: '⊎', sqcap: '⊓',
  sqcup: '⊔', vee: '∨', wedge: '∧', neg: '¬', oplus: '⊕', ominus: '⊖',
  otimes: '⊗', oslash: '⊘', odot: '⊙', bigcirc: '○', dagger: '†',
  ddagger: '‡', sharp: '♯', flat: '♭', natural: '♮',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', equiv: '≡', models: '⊧',
  approx: '≈', cong: '≅', sim: '∼', simeq: '≃', propto: '∝', perp: '⊥',
  parallel: '∥', mid: '∣', prec: '≺', succ: '≻', preceq: '≼', succeq: '≽',
  ll: '≪', gg: '≫', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  sqsubset: '⊏', sqsupset: '⊐', sqsubseteq: '⊑', sqsupseteq: '⊒',
  in: '∈', ni: '∋', notin: '∉', neq: '≠', ne: '≠', doteq: '≐',
  to: '→', gets: '←', leftrightarrow: '↔', uparrow: '↑', downarrow: '↓',
  Leftarrow: '⇐', Rightarrow: '⇒', Leftrightarrow: '⇔', mapsto: '↦',
  longleftarrow: '⟵', longrightarrow: '⟶', longleftrightarrow: '⟷',
  hookrightarrow: '↪', updownarrow: '↕', nwarrow: '↖', nearrow: '↗',
  ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃',
  emptyset: '∅', varnothing: '∅', hbar: 'ħ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ',
  aleph: 'ℵ', prime: '′', angle: '∠', surd: '√', top: '⊤', bot: '⊥',
  vdash: '⊢', dashv: '⊣', wr: '≀', bigtriangleup: '△', bigtriangledown: '▽',
  diamond: '⋄', triangle: '△', backslash: '\\', colon: ':', less: '<', gt: '>',
  lvert: '|', rvert: '|', vert: '|', Vert: '‖',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
  degree: '°',
};

/** Large operators and named functions, rendered upright. */
const OPERATORS = {
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', oint: '∮',
  lim: 'lim', log: 'log', ln: 'ln', sin: 'sin', cos: 'cos', tan: 'tan',
  sec: 'sec', csc: 'csc', cot: 'cot', sinh: 'sinh', cosh: 'cosh', tanh: 'tanh',
  min: 'min', max: 'max', sup: 'sup', inf: 'inf', det: 'det', gcd: 'gcd',
  exp: 'exp', arg: 'arg', deg: 'deg', dim: 'dim', hom: 'hom', ker: 'ker',
};

/** Operators whose limits sit below/above in display mode. */
const DISPLAY_LIMITS = new Set(['sum', 'prod', 'coprod', 'lim', 'sup', 'inf', 'min', 'max']);

/** Combining marks for single-token accents. */
const ACCENTS = {
  hat: '̂', tilde: '̃', vec: '⃗', dot: '̇', ddot: '̈', dddot: '⃛',
  bar: '̄', breve: '̆', check: '̌', acute: '́', grave: '̀', ring: '̊', mathring: '̊',
};

/** Environments: rows of cells, with optional outer brackets. */
const ENVIRONMENTS = {
  aligned: null, matrix: null, pmatrix: ['(', ')'], bmatrix: ['[', ']'],
  Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], cases: ['{', null],
};

/** \mathbb capitals that have single code points. */
const BLACKBOARD = {
  A: '𝔸', B: '𝔹', C: 'ℂ', D: '𝔻', E: '𝔼', F: '𝔽', G: '𝔾', H: 'ℍ', I: '𝕀',
  J: '𝕁', K: '𝕂', L: '𝕃', M: '𝕄', N: 'ℕ', O: '𝕆', P: 'ℙ', Q: 'ℚ', R: 'ℝ',
  S: '𝕊', T: '𝕋', U: '𝕌', V: '𝕍', W: '𝕎', X: '𝕏', Y: '𝕐', Z: 'ℤ',
};

/**
 * Split a string on a two-character separator, honouring brace depth and
 * same-environment nesting. Used for `\\` rows and `&` cells.
 */
export function splitBalanced(text, separator) {
  const parts = [];
  let depth = 0;
  let envDepth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '{') depth++;
    else if (char === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && text.startsWith('\\begin', i)) envDepth++;
    if (depth === 0 && text.startsWith('\\end', i) && envDepth > 0) envDepth--;
    if (depth === 0 && envDepth === 0 && text.startsWith(separator, i)) {
      parts.push(current);
      current = '';
      i += separator.length - 1;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function skipSpaces(state) {
  while (state.i < state.s.length && /\s/.test(state.s[state.i])) state.i++;
}

/** Reads `{…}` or a single token; missing braces degrade to empty. */
function readGroup(state) {
  skipSpaces(state);
  if (state.s[state.i] === '{') {
    state.i++;
    const items = parseSeq(state, true);
    if (state.s[state.i] === '}') state.i++;
    return items;
  }
  return [readAtom(state)].filter(Boolean);
}

/** Reads `[…]`; returns null when absent. */
function readBracket(state) {
  skipSpaces(state);
  if (state.s[state.i] !== '[') return null;
  let out = '';
  state.i++;
  while (state.i < state.s.length && state.s[state.i] !== ']') {
    out += state.s[state.i] === '\\' && state.s[state.i + 1] === ']' ? (state.i++, ']') : state.s[state.i];
    state.i++;
  }
  if (state.s[state.i] === ']') state.i++;
  return out;
}

/** Reads raw text to the matching `}` (for \text and friends). */
function readRaw(state) {
  skipSpaces(state);
  if (state.s[state.i] !== '{') return '';
  state.i++;
  let depth = 1;
  let out = '';
  while (state.i < state.s.length && depth > 0) {
    const char = state.s[state.i];
    if (char === '\\' && (state.s[state.i + 1] === '{' || state.s[state.i + 1] === '}')) {
      out += state.s[state.i + 1];
      state.i += 2;
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        state.i++;
        break;
      }
    }
    out += char;
    state.i++;
  }
  return out;
}

function textNode(s) {
  return s === '' ? null : { t: 'text', s };
}

/** One atom: group, command, or a single character. */
function readAtom(state) {
  const char = state.s[state.i];
  if (char === undefined) return null;
  if (char === '{') return { t: 'group', items: readGroup(state) };
  if (char === '\\') return readCommand(state);
  state.i++;
  return textNode(char);
}

function readCommand(state) {
  state.i++; // the backslash
  const rest = state.s.slice(state.i);
  const name = (/^[a-zA-Z]+/.exec(rest) ?? [rest[0] ?? ''])[0];
  state.i += name.length;
  if (name === '') return textNode('\\');
  if (Object.hasOwn(SYMBOLS, name)) return { t: 'text', s: SYMBOLS[name] };
  if (Object.hasOwn(OPERATORS, name)) return { t: 'op', name, label: OPERATORS[name] };
  if (Object.hasOwn(ACCENTS, name)) {
    const body = readGroup(state);
    return { t: 'accent', mark: ACCENTS[name], body };
  }
  switch (name) {
    case 'frac':
    case 'dfrac':
    case 'tfrac':
    case 'cfrac': {
      const num = readGroup(state);
      const den = readGroup(state);
      return { t: 'frac', num, den };
    }
    case 'binom':
    case 'tbinom': {
      const num = readGroup(state);
      const den = readGroup(state);
      return { t: 'binom', num, den };
    }
    case 'sqrt': {
      const n = readBracket(state);
      return { t: 'sqrt', n, body: readGroup(state) };
    }
    case 'overline':
      return { t: 'line', over: true, body: readGroup(state) };
    case 'underline':
      return { t: 'line', over: false, body: readGroup(state) };
    case 'boxed':
      return { t: 'box', body: readGroup(state) };
    case 'text':
    case 'mbox':
    case 'mathrm':
      return { t: 'styled', style: 'roman', s: readRaw(state) };
    case 'mathbf':
    case 'boldsymbol':
    case 'bm':
      return { t: 'styled', style: 'bold', s: readRaw(state) };
    case 'mathit':
      return { t: 'styled', style: 'italic', s: readRaw(state) };
    case 'mathsf':
      return { t: 'styled', style: 'sans', s: readRaw(state) };
    case 'mathtt':
      return { t: 'styled', style: 'mono', s: readRaw(state) };
    case 'mathcal':
    case 'mathscr':
      return { t: 'styled', style: 'calligraphic', s: readRaw(state) };
    case 'mathfrak':
      return { t: 'styled', style: 'roman', s: readRaw(state) };
    case 'mathbb': {
      const raw = readRaw(state);
      return { t: 'styled', style: 'roman', s: [...raw].map((c) => BLACKBOARD[c] ?? c).join('') };
    }
    case 'operatorname':
      return { t: 'styled', style: 'roman', s: readRaw(state) };
    case 'overset':
    case 'underset': {
      const over = readGroup(state);
      const base = readGroup(state);
      return { t: name === 'overset' ? 'over' : 'under', over, base };
    }
    case 'left':
    case 'right': {
      skipSpaces(state);
      if (state.s[state.i] === '.') {
        state.i++;
        return null;
      }
      const delim = readAtom(state);
      const s = delim && delim.t === 'text' ? delim.s : '';
      return s === '' ? null : { t: 'delim', s };
    }
    case 'begin':
      return readEnvironment(state);
    case 'end':
      return textNode('\\end');
    case ' ':
    case ',':
      return { t: 'space', s: ' ' };
    case ';':
      return { t: 'space', s: ' ' };
    case ':':
      return { t: 'space', s: ' ' };
    case '!':
      return null;
    case '/':
      return null;
    case '\\':
      return { t: 'br' };
    case 'quad':
      return { t: 'space', s: ' ' };
    case 'qquad':
      return { t: 'space', s: '  ' };
    default:
      return textNode(`\\${name}`);
  }
}

function readEnvironment(state) {
  const name = readRaw(state);
  if (!Object.hasOwn(ENVIRONMENTS, name)) {
    return textNode(`\\begin{${name}}`);
  }
  const closer = `\\end{${name}}`;
  let i = state.i;
  let depth = 0;
  let end = -1;
  while (i < state.s.length) {
    if (state.s.startsWith(`\\begin{${name}}`, i)) {
      depth++;
      i += `\\begin{${name}}`.length;
      continue;
    }
    if (state.s.startsWith(closer, i)) {
      if (depth === 0) {
        end = i;
        break;
      }
      depth--;
      i += closer.length;
      continue;
    }
    i++;
  }
  if (end === -1) {
    return textNode(`\\begin{${name}}`);
  }
  const inner = state.s.slice(state.i, end);
  state.i = end + closer.length;
  const rows = splitBalanced(inner, '\\\\').map((row) =>
    splitBalanced(row, '&').map((cell) => parseMath(cell)),
  );
  return { t: 'env', name, brackets: ENVIRONMENTS[name], rows };
}

/** A script target: `{…}` or one atom. */
function readScript(state) {
  skipSpaces(state);
  if (state.s[state.i] === '{') return readGroup(state);
  const atom = readAtom(state);
  return atom ? [atom] : [];
}

function parseSeq(state, inGroup) {
  const out = [];
  let text = '';
  const flush = () => {
    if (text !== '') {
      out.push({ t: 'text', s: text });
      text = '';
    }
  };
  for (;;) {
    skipSpaces(state);
    const char = state.s[state.i];
    if (char === undefined) break;
    if (char === '}') {
      if (inGroup) break;
      text += char;
      state.i++;
      continue;
    }
    if (char === '^' || char === '_') {
      state.i++;
      const body = readScript(state);
      flush();
      const base = out.pop() ?? { t: 'group', items: [] };
      const prev = base.t === 'scripts' ? base : { t: 'scripts', base, sub: null, sup: null };
      if (char === '^') prev.sup = [...(prev.sup ?? []), ...body];
      else prev.sub = [...(prev.sub ?? []), ...body];
      out.push(prev);
      continue;
    }
    if (char === "'") {
      state.i++;
      flush();
      out.push({ t: 'text', s: '′' });
      continue;
    }
    if (char === '{') {
      flush();
      const node = readAtom(state);
      if (node) out.push(node);
      continue;
    }
    if (char === '\\') {
      flush();
      const node = readCommand(state);
      if (node) out.push(node);
      continue;
    }
    text += char;
    state.i++;
  }
  flush();
  return out;
}

/**
 * Parses TeX into plain data. Total: unknown commands, stray braces and
 * unclosed groups degrade to literal text rather than throwing.
 */
export function parseMath(input) {
  const state = { s: String(input ?? ''), i: 0 };
  return parseSeq(state, false);
}

// ---------------------------------------------------------------------------
// DOM building (needs a document; the parser above does not).
// ---------------------------------------------------------------------------

function buildAll(items, display) {
  const out = [];
  for (const item of items) {
    const node = build(item, display);
    if (node) out.push(node);
  }
  return out;
}

function textSpan(s) {
  return el('span', { text: s });
}

function build(item, display) {
  switch (item.t) {
    case 'text':
      return textSpan(item.s);
    case 'space':
      return textSpan(item.s);
    case 'br':
      return el('br');
    case 'group':
      return el('span', {}, buildAll(item.items, display));
    case 'frac':
      return el('span', { class: 'math-frac' }, [
        el('span', { class: 'math-num' }, buildAll(item.num, display)),
        el('span', { class: 'math-den' }, buildAll(item.den, display)),
      ]);
    case 'binom': {
      const inner = el('span', { class: 'math-frac math-binom' }, [
        el('span', { class: 'math-num' }, buildAll(item.num, display)),
        el('span', { class: 'math-den' }, buildAll(item.den, display)),
      ]);
      return el('span', {}, [textSpan('('), inner, textSpan(')')]);
    }
    case 'sqrt': {
      const parts = [textSpan('√')];
      if (item.n !== null && item.n !== undefined && item.n !== '') {
        parts.unshift(el('sup', { class: 'math-root', text: item.n }));
      }
      parts.push(el('span', { class: 'math-radicand' }, buildAll(item.body, display)));
      return el('span', { class: 'math-sqrt' }, parts);
    }
    case 'scripts': {
      const parts = [...buildAll([item.base], display)];
      if (item.sub) parts.push(el('sub', {}, buildAll(item.sub, display)));
      if (item.sup) parts.push(el('sup', {}, buildAll(item.sup, display)));
      return el('span', { class: 'math-scripts' }, parts);
    }
    case 'op': {
      const blocked = item.sub ?? [];
      const raised = item.sup ?? [];
      if (display && DISPLAY_LIMITS.has(item.name) && (blocked.length > 0 || raised.length > 0)) {
        return el('span', { class: 'math-limits' }, [
          raised.length > 0 ? el('span', { class: 'math-over' }, buildAll(raised, display)) : null,
          el('span', { class: 'math-op math-op-big', text: item.label }),
          blocked.length > 0 ? el('span', { class: 'math-under' }, buildAll(blocked, display)) : null,
        ]);
      }
      const parts = [el('span', { class: 'math-op', text: item.label })];
      if (blocked.length > 0) parts.push(el('sub', {}, buildAll(blocked, display)));
      if (raised.length > 0) parts.push(el('sup', {}, buildAll(raised, display)));
      return el('span', {}, parts);
    }
    case 'delim':
      return el('span', { class: 'math-delim', text: item.s });
    case 'line':
      return el('span', { class: item.over ? 'math-overline' : 'math-underline' }, buildAll(item.body, display));
    case 'accent': {
      const body = buildAll(item.body, display);
      if (body.length === 1 && body[0].textContent.length === 1) {
        return textSpan(`${body[0].textContent}${item.mark}`);
      }
      return el('span', {}, [...body, textSpan(item.mark)]);
    }
    case 'box':
      return el('span', { class: 'math-boxed' }, buildAll(item.body, display));
    case 'over':
      return el('span', { class: 'math-limits' }, [
        el('span', { class: 'math-over' }, buildAll(item.over, display)),
        el('span', {}, buildAll(item.base, display)),
      ]);
    case 'under':
      return el('span', { class: 'math-limits' }, [
        el('span', {}, buildAll(item.base, display)),
        el('span', { class: 'math-under' }, buildAll(item.under, display)),
      ]);
    case 'styled': {
      if (item.style === 'bold') return el('b', { class: 'math-text' }, [textSpan(item.s)]);
      if (item.style === 'italic') return el('i', { class: 'math-text' }, [textSpan(item.s)]);
      return el('span', { class: `math-text math-${item.style}` }, [textSpan(item.s)]);
    }
    case 'env':
      return buildEnv(item, display);
    default:
      return null;
  }
}

function buildEnv(item, display) {
  const table = el('table', { class: 'math-env' });
  const body = el('tbody');
  for (const row of item.rows) {
    const tr = el('tr');
    for (const cell of row) {
      tr.append(el('td', { class: 'math-cell' }, buildAll(cell, display)));
    }
    body.append(tr);
  }
  table.append(body);
  if (!item.brackets) return table;
  const [open, close] = item.brackets;
  const parts = [];
  if (open) parts.push(el('span', { class: 'math-delim math-delim-big', text: open }));
  parts.push(table);
  if (close) parts.push(el('span', { class: 'math-delim math-delim-big', text: close }));
  return el('span', { class: 'math-env-wrap' }, parts);
}

/**
 * TeX to guarded nodes. `display` centres the formula as its own block;
 * otherwise it flows with the sentence.
 */
export function mathNodes(tex, display) {
  let items;
  try {
    items = parseMath(tex);
  } catch {
    items = [{ t: 'text', s: String(tex ?? '') }];
  }
  return [el('span', { class: display ? 'math-display' : 'math' }, buildAll(items, display))];
}
