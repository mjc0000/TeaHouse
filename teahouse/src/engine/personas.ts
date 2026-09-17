/**
 * Persona library: several "who you are" presets instead of one.
 *
 * `config.personaName`/`personaDescription` stay the fallback (and the only
 * thing older data knows), so every previously saved chat keeps working. On
 * top of that:
 *
 *   - the library (`data/personas.json`) holds any number of named presets;
 *   - `activeId` names the default for new turns;
 *   - `meta.personaId` pins one conversation to a preset (`null`/missing means
 *     "follow the active one", exactly like the per-chat model override).
 *
 * A deleted preset never breaks a chat: resolution falls back to the active
 * preset, then to the config fields.
 */

export interface PersonaPreset {
  id: string;
  name: string;
  description: string;
}

export interface PersonaFile {
  version: 1;
  activeId: string;
  items: PersonaPreset[];
}

export const EMPTY_PERSONAS: PersonaFile = { version: 1, activeId: '', items: [] };

function coercePreset(raw: unknown): PersonaPreset {
  const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    id: typeof item.id === 'string' ? item.id : '',
    name: typeof item.name === 'string' ? item.name : '',
    description: typeof item.description === 'string' ? item.description : '',
  };
}

/**
 * Validates a whole file for saving. Names may repeat (two "旅人" for two
 * stories is fine) but ids may not, and the active id must name something.
 */
export function coercePersonaFile(body: unknown): { file: PersonaFile; problems: string[] } {
  const root = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const raws = Array.isArray(root.items) ? root.items : [];
  const items = raws.map(coercePreset);
  const problems: string[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const where = item.name.trim() !== '' ? `「${item.name}」` : `第 ${index + 1} 套`;
    if (item.id === '') problems.push(`${where}没有 id`);
    else if (seen.has(item.id)) problems.push(`有两套人设用了同一个 id：${item.id}`);
    else seen.add(item.id);
    if (item.name.trim() === '') problems.push(`${where}没有名字`);
  });
  const activeId = typeof root.activeId === 'string' ? root.activeId : '';
  if (activeId !== '' && !items.some((item) => item.id === activeId)) {
    problems.push('默认人设指向了不存在的条目');
  }
  return { file: { version: 1, activeId, items }, problems };
}

export interface EffectivePersona {
  name: string;
  description: string;
  /** Where it came from: a pinned chat, the library default, or the old config fields. */
  source: 'chat' | 'active' | 'config';
}

/**
 * Who "you" are for one assembly. `chatPersonaId` is `meta.personaId`
 * (`null`/missing follows the active preset); `fallback` is the config pair.
 */
export function effectivePersona(
  file: PersonaFile,
  chatPersonaId: string | null | undefined,
  fallback: { name: string; description: string },
): EffectivePersona {
  if (typeof chatPersonaId === 'string' && chatPersonaId !== '') {
    const pinned = file.items.find((item) => item.id === chatPersonaId);
    if (pinned) return { name: pinned.name, description: pinned.description, source: 'chat' };
  }
  if (file.activeId !== '') {
    const active = file.items.find((item) => item.id === file.activeId);
    if (active) return { name: active.name, description: active.description, source: 'active' };
  }
  return { name: fallback.name, description: fallback.description, source: 'config' };
}
