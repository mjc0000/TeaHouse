/**
 * Agent Skills compatibility layer.
 *
 * A skill is a directory with a `SKILL.md` (YAML frontmatter + instructions),
 * often shipped as a zip of that directory. This reads either shape and maps it
 * onto an ordinary v2 character card, because that is what the rest of the app
 * already knows how to store, chat with and export:
 *
 *   - the SKILL.md body           -> `description` (the always-on character)
 *   - frontmatter `description`   -> `creator_notes` (a note, not a prompt)
 *   - `author` / `version`        -> `creator` / `character_version`
 *   - `references/*.md`           -> one embedded character book
 *   - the original file           -> kept verbatim beside the card
 *
 * Unknown frontmatter survives in `extensions.tavern.skill`, and nothing here
 * fails on odd input: the worst case is a card with the whole text as its
 * description.
 */

import { parseCardJSON } from './character-card.ts';
import { isZip, readZipEntries } from './zip.ts';
import { asString, asStringArray, type CardParseResult } from './types.ts';

/** One `references/*.md` file, kept as a book entry. */
interface SkillReference {
  path: string;
  title: string;
  text: string;
}

export interface SkillParseResult extends CardParseResult {
  /** Written next to the card verbatim (`skill.md` or `skill.zip`). */
  original: { name: string; bytes: Buffer };
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Top-level `key: value`, `|`/`>` blocks, inline `[a, b]` and one nested map. */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: normalized };
  return {
    data: parseYamlSubset(normalized.slice(4, end)),
    body: normalized.slice(end + 4).replace(/^\n+/, ''),
  };
}

function parseYamlSubset(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index++;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    // Only top-level keys start a new value; indented lines belong to the one above.
    if (/^\s/.test(line)) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const rest = line.slice(separator + 1).trim();
    if (key === '') continue;

    if (rest === '' ) {
      // Either a block scalar's header on the next line, or a nested map.
      const nested: Record<string, unknown> = {};
      let sawNested = false;
      while (index < lines.length && /^\s+\S/.test(lines[index])) {
        const part = lines[index].trim();
        index++;
        const at = part.indexOf(':');
        if (at === -1) continue;
        nested[part.slice(0, at).trim()] = scalar(part.slice(at + 1).trim());
        sawNested = true;
      }
      if (sawNested) out[key] = nested;
      continue;
    }
    if (rest === '|' || rest === '>' || /^[|>][+-]?$/.test(rest)) {
      const block: string[] = [];
      let indent = -1;
      while (index < lines.length) {
        const candidate = lines[index];
        if (candidate.trim() === '') {
          block.push('');
          index++;
          continue;
        }
        const leading = candidate.length - candidate.trimStart().length;
        if (indent === -1) indent = leading;
        if (leading < indent) break;
        block.push(candidate.slice(indent));
        index++;
      }
      while (block.length > 0 && block[block.length - 1].trim() === '') block.pop();
      out[key] = rest.startsWith('>') ? block.join(' ').trim() : block.join('\n');
      continue;
    }
    out[key] = scalar(rest);
  }
  return out;
}

function scalar(value: string): unknown {
  if (value === '') return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((part) => unquote(part.trim()))
      .filter((part) => part !== '');
  }
  return unquote(value);
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function firstHeading(body: string): string {
  const match = /^#{1,6}\s+(.+)$/m.exec(body);
  return match ? match[1].trim() : '';
}

function stem(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Picks the skill's own file: root wins, then the shallowest, then the first. */
function chooseSkillFile(entries: { name: string }[]): { index: number; warning: boolean } {
  const candidates = entries
    .map((entry, index) => ({ index, path: entry.name, depth: entry.name.split('/').length }))
    .filter((item) => item.path.split('/').pop()?.toLowerCase() === 'skill.md');
  if (candidates.length === 0) {
    // No SKILL.md: a package with a single markdown file is still a skill.
    const markdown = entries
      .map((entry, index) => ({ index, path: entry.name, depth: entry.name.split('/').length }))
      .filter((item) => item.path.toLowerCase().endsWith('.md'));
    if (markdown.length === 1) return { index: markdown[0].index, warning: true };
    throw new Error('zip contains no SKILL.md');
  }
  candidates.sort((a, b) => a.depth - b.depth || a.path.length - b.path.length);
  return { index: candidates[0].index, warning: candidates.length > 1 };
}

export function parseSkillFile(buffer: Buffer, id = 'skill', sourceName = 'skill'): SkillParseResult {
  let text: string;
  let originalName: string;
  let files: string[] = [];
  let references: SkillReference[] = [];
  let extraWarning: string | null = null;

  if (isZip(buffer)) {
    originalName = 'skill.zip';
    const entries = readZipEntries(buffer);
    const chosen = chooseSkillFile(entries);
    if (chosen.warning) {
      extraWarning = 'the zip has several SKILL.md files (or no dedicated one); the shallowest was used';
    }
    text = entries[chosen.index].bytes.toString('utf8');
    const chosenPath = entries[chosen.index].name;
    const root = chosenPath.includes('/') ? chosenPath.slice(0, chosenPath.lastIndexOf('/') + 1) : '';
    files = entries.map((entry) => entry.name).filter((name) => name !== chosenPath);
    references = entries
      .filter((entry) => entry !== entries[chosen.index])
      .filter((entry) => entry.name.startsWith(root))
      .filter((entry) => entry.name.toLowerCase().endsWith('.md'))
      .filter((entry) => entry.bytes.length <= MAX_TEXT_BYTES)
      .map((entry) => {
        const body = entry.bytes.toString('utf8');
        return { path: entry.name.slice(root.length) || entry.name, title: firstHeading(body), text: body };
      });
  } else {
    if (buffer.length > MAX_TEXT_BYTES) throw new Error('skill file is too large');
    text = buffer.toString('utf8');
    // A binary that is neither PNG nor zip has no business becoming a card.
    if (text.includes('\u0000')) throw new Error('not a text file');
    // Stored under a fixed name: the client-supplied one never reaches the fs.
    originalName = 'skill.md';
  }

  const { data, body } = parseFrontmatter(text);
  const description = singleLine(asString(data.description, ''));
  const name = asString(data.name, '') || firstHeading(body) || stem(sourceName) || 'skill';
  const bookName = `${name} references`;

  const payload: Record<string, unknown> = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description: body.trim(),
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      creator_notes: description,
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: asStringArray(data.tags),
      creator: asString(data.author, '') || asString(data.creator, ''),
      character_version: asString(data.version, ''),
      extensions: {
        tavern: {
          skill: {
            source: isZip(buffer) ? 'skill-zip' : 'skill-md',
            name,
            description,
            frontmatter: data,
            files,
          },
        },
      },
      character_book:
        references.length === 0
          ? undefined
          : {
              name: bookName,
              description: `Reference material from the ${name} skill`,
              extensions: {},
              entries: references.map((reference, index) => ({
                keys: reference.title ? [stem(reference.path), reference.title] : [stem(reference.path)],
                secondary_keys: [],
                comment: reference.path,
                content: reference.text,
                enabled: true,
                insertion_order: 100 + index,
                position: 'before_char',
                extensions: { tavern: { skillFile: reference.path } },
              })),
            },
    },
  };

  const parsed = parseCardJSON(payload, id);
  const warnings = [...parsed.card.warnings];
  if (extraWarning !== null) warnings.push({ code: 'skill-ambiguous', message: extraWarning });
  if (description === '') {
    warnings.push({ code: 'skill-no-description', message: 'skill has no frontmatter description' });
  }
  parsed.card.warnings = warnings;
  return { card: parsed.card, image: null, original: { name: originalName, bytes: buffer } };
}
