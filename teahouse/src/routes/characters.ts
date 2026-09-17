/**
 * Character cards: list, import, inspect, export, rename, re-key, delete.
 *
 * Renaming has two meanings and both are supported explicitly:
 *   PATCH { name }  changes the card's display name (safe, keeps the id)
 *   PATCH { id }    moves the character to a new id and repoints its chats
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { cardToV2JSON, cardGreetings, EDITABLE_CARD_FIELDS } from '../formats/character-card.ts';
import { parseSkillFile } from '../formats/skill.ts';
import { EntryPatchError } from '../formats/entry-fields.ts';
import { badRequest, conflict, notFound, readBody, readJson, sendJson, sendBytes } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import { sanitizeId, type Store } from '../store/db.ts';
import { seedDefaultSprite } from './sprites.ts';

function cardSummary(card: { id: string; spec: string; name: string; books: { entries: unknown[] }[] }, warnings: number) {
  return {
    id: card.id,
    spec: card.spec,
    name: card.name,
    warnings,
    books: card.books.map((book) => ({ entries: book.entries.length })),
  };
}

export function registerCharacterRoutes(router: Router, store: Store): void {
  /** A missing character is a 404, not a server fault. */
  const loadCardOr404 = (id: string) => {
    try {
      return store.loadCharacter(id).card;
    } catch {
      throw notFound(`character not found: ${id}`);
    }
  };

  router.add('GET', '/api/characters', ({ response }) => {
    sendJson(response, 200, store.listCharacters());
  });

  router.add('POST', '/api/characters/import', async ({ request, url, response }) => {
    const source = url.searchParams.get('name') ?? '';
    const name = sanitizeId(source || `character-${Date.now().toString(36)}`);
    const bytes = await readBody(request);
    if (bytes.length === 0) throw badRequest('empty file');

    // A PNG card carries its own artwork: plant it as the resting face unless
    // this character already has one (uploaded, dropped in, or seeded before).
    if (bytes.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n') {
      const card = store.importCharacter(name, bytes, 'png');
      seedDefaultSprite(store, name, bytes);
      sendJson(response, 200, cardSummary(card, card.warnings.length));
      return;
    }

    const trimmed = bytes.toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const card = store.importCharacter(name, bytes, 'json');
      sendJson(response, 200, cardSummary(card, card.warnings.length));
      return;
    }

    // Anything else — a `SKILL.md`, a zip of one, or plain Markdown — is an
    // Agent Skill, mapped onto an ordinary card with its original kept beside it.
    try {
      const { card, original } = parseSkillFile(bytes, name, source);
      const stored = store.importSkill(name, card, original);
      sendJson(response, 200, cardSummary(stored, stored.warnings.length));
    } catch (error) {
      throw badRequest(`无法识别这份文件：${(error as Error).message}`, 'characters.unreadable', { error: (error as Error).message });
    }
  });

  router.add('GET', '/api/characters/:id/avatar', ({ params, response }) => {
    const image = store.characterImage(params.id!);
    if (!image) throw notFound('no image for this character');
    sendBytes(response, 200, image.bytes, image.contentType);
  });

  /**
   * Exports a card. JSON by default; `?format=png` streams the PNG carrier,
   * which already holds the current card data because every edit is written back
   * through it. A card that came from JSON has no image to put that data in, and
   * says so instead of returning a broken file.
   */
  router.add('GET', '/api/characters/:id/export', ({ params, url, response }) => {
    const id = params.id!;
    const card = loadCardOr404(id);
    if (url.searchParams.get('format') === 'png') {
      const image = store.characterImage(id);
      if (!image) {
        throw notFound('this card has no PNG carrier; export it as JSON instead');
      }
      sendBytes(response, 200, image.bytes, 'image/png');
      return;
    }
    sendJson(response, 200, cardToV2JSON(card));
  });

  router.add('GET', '/api/characters/:id', ({ params, response }) => {
    const id = params.id!;
    const card = loadCardOr404(id);
    sendJson(response, 200, {
      id: card.id,
      spec: card.spec,
      name: card.name,
      fields: {
        description: card.description,
        personality: card.personality,
        scenario: card.scenario,
        first_mes: card.first_mes,
        mes_example: card.mes_example,
        system_prompt: card.system_prompt,
        post_history_instructions: card.post_history_instructions,
        creator_notes: card.creator_notes,
        alternate_greetings: card.alternate_greetings,
        tags: card.tags,
      },
      depthPrompt: card.depthPrompt,
      books: card.books.map((book) => ({ id: book.id, name: book.name, entries: book.entries.length })),
      warnings: card.warnings,
      talkativeness: store.characterTalkativeness(card.id),
      chats: store.chatsForCharacter(card.id).map((chat) => ({ id: chat.id, name: chat.name })),
    });
  });

  /**
   * Edits a card. Three kinds of key, all explicit:
   *   - `name` / `id` move the character (see the module comment)
   *   - the content fields in `EDITABLE_CARD_FIELDS` are written back through the
   *     same lossless path the importer uses, so a PNG stays a PNG and unknown
   *     fields survive
   *   - anything else is a 400, so a typo cannot look like a successful save
   */
  router.add('PATCH', '/api/characters/:id', async ({ request, params, response }) => {
    const id = params.id!;
    const body = await readJson<Record<string, unknown>>(request);
    const card = loadCardOr404(id);

    const problems: { field: string; message: string }[] = [];
    let touchedContent = false;

    for (const [field, value] of Object.entries(body)) {
      if (field === 'name' || field === 'id') continue;
      // Talkativeness is a setting *about* the character, not a card field: it
      // is kept in the sidecar, so writing it never rewrites the card.
      if (field === 'talkativeness') continue;
      const kind = EDITABLE_CARD_FIELDS[field];
      if (kind === undefined) {
        problems.push({ field, message: 'unknown field' });
        continue;
      }
      if (kind === 'string') {
        if (typeof value !== 'string') {
          problems.push({ field, message: 'must be a string' });
          continue;
        }
        (card as unknown as Record<string, unknown>)[field] = value;
        touchedContent = true;
        continue;
      }
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        problems.push({ field, message: 'must be an array of strings' });
        continue;
      }
      // Blank entries are dropped rather than stored: an empty greeting is not a
      // greeting, and an empty tag is noise in every list that shows it.
      (card as unknown as Record<string, unknown>)[field] = (value as string[])
        .map((item) => item.trim())
        .filter((item) => item !== '');
      touchedContent = true;
    }

    if (problems.length > 0) throw new EntryPatchError(problems);

    // How readily this character speaks in a group (0–100). `null` clears the
    // override and follows the card again, which is the same split the per-chat
    // model and persona pins use.
    if ('talkativeness' in body) {
      const value = body.talkativeness;
      if (value === null) {
        store.saveCharacterMeta(id, { talkativeness: undefined });
      } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw badRequest('talkativeness must be a number between 0 and 100');
      } else {
        store.saveCharacterMeta(id, { talkativeness: Math.round(value) });
      }
    }

    if (typeof body.name === 'string' && body.name.trim() === '') {
      throw badRequest('name must be a non-empty string');
    }
    if (touchedContent && body.name === undefined) {
      // Write the content now; a rename below writes again with the new name.
      store.writeCharacter(id, card);
    }

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        throw badRequest('name must be a non-empty string');
      }
      card.name = body.name.trim();
      store.writeCharacter(id, card);
    }

    let currentId = id;
    let chatsUpdated = 0;
    if (body.id !== undefined) {
      if (typeof body.id !== 'string' || body.id.trim() === '') {
        throw badRequest('id must be a non-empty string');
      }
      const target = sanitizeId(body.id);
      if (target !== id && existsSync(join(store.charactersDir, target))) {
        throw conflict(`a character with id "${target}" already exists`);
      }
      // The card carries its own id in `_meta`/data; keep it consistent.
      const moved = store.moveCharacter(id, target);
      currentId = moved.id;
      chatsUpdated = moved.chatsUpdated;
    }

    const { card: updated } = store.loadCharacter(currentId);
    sendJson(response, 200, {
      ...cardSummary(updated, updated.warnings.length),
      talkativeness: store.characterTalkativeness(currentId),
      previousId: id,
      idChanged: currentId !== id,
      chatsUpdated,
    });
  });

  router.add('DELETE', '/api/characters/:id', ({ params, url, response }) => {
    const id = params.id!;
    if (!store.characterExists(id)) throw notFound(`character not found: ${id}`);

    const cascade = url.searchParams.get('cascade') === 'true';
    const chats = store.chatsForCharacter(id);
    // Losing a transcript silently is worse than one more confirmation, so the
    // delete is refused until the caller says it means it.
    if (chats.length > 0 && !cascade) {
      throw conflict(`character has ${chats.length} chat(s); pass cascade=true to delete them too`);
    }

    const result = store.deleteCharacter(id, { cascade });
    sendJson(response, 200, { ok: true, ...result });
  });
}
