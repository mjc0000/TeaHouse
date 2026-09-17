/**
 * Minimal Markdown for the transcript, without a parser dependency and without
 * `innerHTML`.
 *
 * The XSS story matters more than the feature list: every character of the
 * message first becomes a text node, and only the constructs below become
 * elements — all created with `document.createElement` through `dom.js`, with
 * no attribute ever taken from the message except a vetted `href`. A card that
 * smuggles `<img onerror>` or `[x](javascript:…)` gets its punctuation shown,
 * not executed.
 *
 * Supported: fenced code blocks, inline code, **bold**, *italic*, ***both***,
 * ~~strikethrough~~, `> quote`, `#`…`######` headings (clamped to h4–h6 so they
 * sit under the page's own headings), `-`/`*`/`1.` lists including one level of
 * indented nesting (`<ol>` keeps a non-1 start), `---` / `***` / `___` thematic
 * breaks, `[text](http(s)://…)` links, `\(…\)` inline math and `\[…\]`/`$$…$$`
 * display math (a LaTeX subset, rendered by math.js), and newlines.
 *
 * Deliberately not CommonMark: a line of text followed by `---` becomes a rule
 * rather than a setext heading (a chat is not documentation, and `---` is what
 * people type to draw a line). `![alt](url)` is left as text: loading a remote
 * image from a model reply would leak the reader's IP to whoever the model named.
 * Everything else is plain text.
 *
 * No bare text nodes escape: plain runs are wrapped in `<span>`, which is also
 * what the boot suite's "no naked text in a message body" assertion pins.
 */

import { el } from './dom.js';
import { mathNodes } from './math.js';

function span(text) {
  return el('span', { text });
}

/** Inline runs of one block of text. Never returns a bare string. */
export function inlineNodes(text) {
  const out = [];
  // code, math, bold, italic, strike, link — leftmost match wins, code first
  // so its contents are never re-scanned, math next so `*` and `_` inside a
  // formula are never emphasis.
  const pattern = /(`[^`\n]+`)|(\\\[.+?\\\])|(\$\$.+?\$\$)|(\\\((.+?)\\\))|(\\\$)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[.+?\]\(https?:\/\/[^\s)]+\))|(\*\*\*[^*\n]+\*\*\*)|(https?:\/\/[^\s<>()\u3000-\u303f\uff00-\uffef]+)/g;
  let last = 0;
  let match;
  const flush = (piece) => {
    if (piece !== '') out.push(span(piece));
  };
  while ((match = pattern.exec(text)) !== null) {
    flush(text.slice(last, match.index));
    const [whole, code, dispA, dispB, inlineP, inlineInner, escDollar, boldA, boldB, italicA, italicB, strike, link, triple, bareUrl] = match;
    if (code) {
      out.push(el('code', { class: 'md-code', text: code.slice(1, -1) }));
    } else if (dispA || dispB) {
      const inner = (dispA ?? dispB).slice(2, -2);
      for (const node of mathNodes(inner, true)) out.push(node);
    } else if (inlineP) {
      for (const node of mathNodes(inlineInner, false)) out.push(node);
    } else if (escDollar) {
      flush('$');
    } else if (boldA || boldB) {
      const inner = (boldA ?? boldB).slice(2, -2);
      out.push(el('strong', {}, inlineNodes(inner)));
    } else if (italicA || italicB) {
      const inner = (italicA ?? italicB).slice(1, -1);
      out.push(el('em', {}, inlineNodes(inner)));
    } else if (strike) {
      out.push(el('del', {}, inlineNodes(strike.slice(2, -2))));
    } else if (link) {
      const divider = link.lastIndexOf('](');
      const label = link.slice(1, divider);
      const href = link.slice(divider + 2, -1);
      const anchor = el('a', { href, target: '_blank', rel: 'noopener' });
      for (const node of inlineNodes(label)) anchor.append(node);
      out.push(anchor);
    } else if (triple) {
      out.push(el('strong', {}, [el('em', {}, inlineNodes(triple.slice(3, -3)))]));
    } else if (bareUrl) {
      // A plain `https://…` becomes a link too, but the sentence's own trailing
      // punctuation stays text: "see https://x.com。" must not put 。 in the href.
      const href = bareUrl.replace(/[.,;:!?”’）)。，；：！？]+$/, '');
      const anchor = el('a', { href, target: '_blank', rel: 'noopener' });
      anchor.append(span(href));
      out.push(anchor);
      if (href.length < bareUrl.length) flush(bareUrl.slice(href.length));
    } else {
      flush(whole);
    }
    last = match.index + whole.length;
  }
  flush(text.slice(last));
  if (out.length === 0) out.push(span(''));
  return out;
}

/** Thematic break: three or more `-`, `*` or `_`, spaces allowed between them. */
function isRule(line) {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function heading(line) {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!match) return null;
  // The transcript lives inside a page that already has h1–h3, so a message's
  // headings start at h4; deeper ones clamp rather than break the outline.
  const level = Math.min(match[1].length, 3);
  // CommonMark allows closing hashes (`## 标题 ##`); they are punctuation, not text.
  return el(`h${level + 3}`, { class: 'md-heading' }, inlineNodes(match[2].replace(/\s+#+\s*$/, '')));
}

/**
 * A list run, one level of nesting deep: a more-indented item becomes a child of
 * the item above it. Ordered runs render as `<ol>` (keeping a non-1 start), the
 * rest as `<ul>`; mixing markers or indentation levels ends the run.
 */
function listBlock(lines, start) {
  const first = /^(\s*)(?:([-*])|(\d+)[.)])\s+(.*)$/.exec(lines[start]);
  if (first === null) return { node: el('ul', { class: 'md-list' }), next: start };
  const baseIndent = first[1].length;
  const ordered = first[3] !== undefined;
  const items = [];
  let i = start;

  while (i < lines.length) {
    const match = /^(\s*)(?:([-*])|(\d+)[.)])\s+(.*)$/.exec(lines[i]);
    if (!match) break;
    const indent = match[1].length;
    if (indent > baseIndent) {
      if (items.length === 0) break;
      const nested = listBlock(lines, i);
      if (nested.next === i) break;
      items[items.length - 1].children.push(nested.node);
      i = nested.next;
      continue;
    }
    if (indent < baseIndent) break;
    if ((match[3] !== undefined) !== ordered) break;
    const item = { content: match[4], children: [] };
    items.push(item);
    i++;
    // Indented, non-item lines continue the item's own text.
    while (i < lines.length && lines[i].trim() !== '' && !/^\s*(?:[-*]|\d+[.)])\s+/.test(lines[i]) && /^\s{2,}/.test(lines[i])) {
      item.content += `\n${lines[i].trim()}`;
      i++;
    }
  }

  const node = el(ordered ? 'ol' : 'ul', { class: 'md-list' },
    items.map((item) => {
      const li = el('li', {}, paragraphNodes(item.content));
      for (const child of item.children) li.append(child);
      return li;
    }));
  if (ordered) {
    const startsAt = Number(first[3]);
    if (Number.isFinite(startsAt) && startsAt !== 1) node.setAttribute('start', String(startsAt));
  }
  return { node, next: i };
}

/**
 * One message's visible body. The caller appends the returned nodes into
 * `.message-text`; editing and copying keep using the raw stored text.
 */
export function renderMarkdown(text) {
  const lines = String(text).split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block.
    if (/^```/.test(line.trim())) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        body.push(lines[i]);
        i++;
      }
      i++; // past the closing fence (or the end, for an unclosed one)
      blocks.push(el('pre', { class: 'md-fence' }, [el('code', { text: body.join('\n') })]));
      continue;
    }
    // Quote run.
    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push(el('blockquote', { class: 'md-quote' }, paragraphNodes(quoted.join('\n'))));
      continue;
    }
    // Thematic break, before lists so `- - -` is a rule rather than an item.
    if (isRule(line)) {
      blocks.push(el('hr', { class: 'md-rule' }));
      i++;
      continue;
    }
    // List run (ordered, unordered, and one level of indentation).
    if (/^\s*(?:[-*]|\d+[.)])\s+/.test(line)) {
      const list = listBlock(lines, i);
      blocks.push(list.node);
      i = list.next;
      continue;
    }
    // Display math run: `\[` (or `$$`) alone on a line through its closer.
    // Single-line forms never reach here — inlineNodes already took them.
    const mathOpen = line.trim();
    if (mathOpen === '\\[' || mathOpen === '$$') {
      const closer = mathOpen === '\\[' ? '\\]' : '$$';
      const body = [];
      i++;
      while (i < lines.length && lines[i].trim() !== closer) {
        body.push(lines[i]);
        i++;
      }
      i++; // past the closer (or the end, for an unclosed one)
      for (const node of mathNodes(body.join('\n'), true)) blocks.push(node);
      continue;
    }
    const head = heading(line.trim());
    if (head) {
      blocks.push(head);
      i++;
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    // Paragraph run: consecutive plain lines joined with line breaks.
    const run = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i].trim()) &&
      !/^(\\\[|\$\$)\s*$/.test(lines[i].trim()) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*(?:[-*]|\d+[.)])\s+/.test(lines[i]) &&
      !isRule(lines[i]) &&
      !heading(lines[i].trim())
    ) {
      run.push(lines[i]);
      i++;
    }
    blocks.push(el('p', { class: 'md-para' }, paragraphNodes(run.join('\n'))));
  }
  if (blocks.length === 0) blocks.push(el('p', { class: 'md-para' }, [span('')]));
  return blocks;
}

/** Inline nodes for paragraph text, honouring single newlines as breaks. */
function paragraphNodes(text) {
  const parts = String(text).split('\n');
  const out = [];
  parts.forEach((part, index) => {
    for (const node of inlineNodes(part)) out.push(node);
    if (index < parts.length - 1) out.push(el('br'));
  });
  return out;
}
