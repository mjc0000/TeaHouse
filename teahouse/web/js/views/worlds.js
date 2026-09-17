/**
 * Left panel, section 2: world books.
 */

import { api, emit, json, loadVectors, loadWorlds, on, refreshPreview, state } from '../api.js';
import { confirmDialog } from '../components/confirm.js';
import { emptyState } from '../components/empty-state.js';
import { openMenu } from '../components/menu.js';
import { attachTooltip } from '../components/tooltip.js';
import { toastError, toastOk } from '../components/toast.js';
import { downloadJson } from '../clipboard.js';
import { clear, el } from '../dom.js';
import { t } from '../i18n.js';

/** Opens the entry editor. Published as an event so this view stays independent. */
function openEditor(worldId, scrollToHit = false) {
  emit('open-world-editor', { worldId, scrollToHit });
}

function run(promise) {
  promise.catch((error) => toastError(error.message));
}

async function toggleWorld(worldId, attached) {
  if (!state.chatId) {
    toastError(t('worlds.needChat'));
    await loadWorlds();
    return;
  }
  // The server owns the attachment list, so a stale client cannot drop the other
  // attachments by echoing an old array.
  state.meta = await api(`/api/chats/${state.chatId}/worlds`, json('POST', { worldId, attached }));
  renderWorlds();
  await refreshPreview();
}

async function deleteWorld(world) {
  const ok = await confirmDialog({
    title: t('worlds.deleteTitle', { name: world.name }),
    message: t('worlds.deleteMessage', { count: world.entries }),
    detail: t('worlds.deleteDetail'),
    confirmLabel: t('common.delete'),
    danger: true,
  });
  if (!ok) return;
  await api(`/api/worlds/${encodeURIComponent(world.id)}`, { method: 'DELETE' });
  await loadWorlds();
  renderWorlds();
  await refreshPreview();
  toastOk(t('worlds.deleted'));
}

/** Downloads the book converted to SillyTavern's native shape. */
async function exportStNative(world) {
  const payload = await api(`/api/worlds/${encodeURIComponent(world.id)}/st-native`);
  downloadJson(`${world.id}.st-native.json`, payload);
  toastOk(t('worlds.exported'));
}

function worldMenu(world, anchor, attached) {
  openMenu({
    anchor,
    items: [
      {
        label: t('worlds.menuEdit'),
        hint: t('worlds.menuEditHint', { count: world.entries }),
        disabled: Boolean(world.error),
        onSelect: () => openEditor(world.id),
      },
      {
        label: attached ? t('worlds.menuDetach') : t('worlds.menuAttach'),
        disabled: Boolean(world.error),
        onSelect: () => run(toggleWorld(world.id, !attached)),
      },
      {
        label: t('worlds.menuExport'),
        hint: t('worlds.menuExportHint'),
        disabled: Boolean(world.error),
        onSelect: () => run(exportStNative(world)),
      },
      {
        label: t('common.delete'),
        danger: true,
        separatorBefore: true,
        onSelect: () => run(deleteWorld(world)),
      },
    ],
  });
}

/**
 * How far this book is from being searchable by meaning. Only shown when the
 * feature is on: a badge nobody asked for is noise.
 */
function vectorBadge(world) {
  const overview = state.vectors;
  if (!overview?.settings?.enabled) return null;
  const book = (overview.books ?? []).find((entry) => entry.id === world.id);
  if (!book || book.marked === 0) return null;
  const behind = book.outdated || book.stale > 0;
  const stale = book.stale > 0 ? t('worlds.vectorStale', { count: book.stale }) : '';
  return el('span', {
    class: `badge vector-badge${behind ? ' behind' : ''}`,
    text: book.outdated
      ? t('worlds.vectorRebuild')
      : book.stale > 0
        ? t('worlds.vectorIndexedOf', { indexed: book.indexed, marked: book.marked })
        : t('worlds.vectorIndexed', { indexed: book.indexed }),
    title: book.outdated
      ? t('worlds.vectorTitleOutdated', { model: book.model })
      : t('worlds.vectorTitle', { indexed: book.indexed, marked: book.marked, stale }),
    onclick: (event) => {
      event.stopPropagation();
      run(
        api(`/api/worlds/${encodeURIComponent(world.id)}/vectorize`, json('POST', {})).then(
          async (result) => {
            await loadVectors();
            toastOk(
              result.embedded > 0
                ? t('worlds.vectorRebuilt', { name: world.name, count: result.embedded })
                : t('worlds.vectorFresh', { name: world.name }),
            );
          },
        ),
      );
    },
  });
}

function hitBadge(world) {
  const bucket = state.ui.hits?.byWorld?.get(world.id);
  if (!bucket || bucket.count === 0) return null;
  const slots = [...bucket.slots].join(t('commands.join'));
  return el('span', {
    class: 'badge hit-badge',
    text: t('worlds.hits', { count: bucket.count }),
    title: t('worlds.hitsTitle', { count: bucket.count, slots }),
    onclick: (event) => {
      event.stopPropagation();
      openEditor(world.id, true);
    },
  });
}

export function renderWorlds() {
  const list = document.getElementById('world-list');
  clear(list);

  if (state.worlds.length === 0) {
    list.append(
      el('li', { class: 'panel-empty' }, [
        emptyState({
          title: t('worlds.emptyTitle'),
          hint: t('worlds.emptyHint'),
          action: {
            label: t('worlds.emptyAction'),
            onClick: () => document.getElementById('import-world').click(),
          },
        }),
      ]),
    );
    return;
  }

  const attached = new Set(state.meta?.worldRefs ?? []);
  for (const world of state.worlds) {
    const broken = typeof world.error === 'string' && world.error !== '';
    const isAttached = attached.has(world.id);

    const name = el('span', {
      class: 'name',
      text: world.name,
      onclick: () => {
        if (broken) {
          toastError(t('worlds.brokenToast', { error: world.error }));
          return;
        }
        openEditor(world.id);
      },
    });
    attachTooltip(
      name,
      broken
        ? t('worlds.tooltipBroken', { error: world.error })
        : t('worlds.tooltipName', { name: world.name, format: world.format, count: world.entries }),
    );

    const meta = broken
      ? el('span', { class: 'meta bad', text: t('worlds.metaBroken') })
      : el('span', { class: 'meta', text: t('worlds.meta', { count: world.entries, format: world.format }) });
    attachTooltip(
      meta,
      broken
        ? t('worlds.tooltipBroken', { error: world.error })
        : t('worlds.tooltipMeta', { format: world.format, count: world.entries }),
    );

    list.append(
      el('li', {}, [
        el('input', {
          type: 'checkbox',
          checked: isAttached,
          disabled: broken,
          title: broken
            ? t('worlds.checkboxBroken')
            : isAttached
              ? t('worlds.checkboxAttached')
              : t('worlds.checkboxDetached'),
          'aria-label': t(isAttached ? 'worlds.detachAria' : 'worlds.attachAria', { name: world.name }),
          onclick: (event) => {
            event.stopPropagation();
            run(toggleWorld(world.id, event.target.checked));
          },
        }),
        name,
        vectorBadge(world),
        hitBadge(world),
        meta,
        el('button', {
          class: 'ghost tiny icon-button',
          text: '⋯',
          'aria-label': t('worlds.moreActionsAria', { name: world.name }),
          'aria-haspopup': 'menu',
          title: t('characters.moreActions'),
          onclick: (event) => {
            event.stopPropagation();
            worldMenu(world, event.currentTarget, isAttached);
          },
        }),
      ]),
    );
  }
}

export function initWorldView() {
  document.getElementById('import-world').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const name = file.name.replace(/\.[^.]+$/, '') || `world-${Date.now()}`;
    try {
      const result = await api(`/api/worlds/import?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/json' },
        body: file,
      });
      await loadWorlds();
      toastOk(t('worlds.imported', { name, count: result.entries, format: result.format }));
      if (state.chatId) await toggleWorld(result.id, true);
    } catch (error) {
      toastError(t('worlds.importFailed', { error: error.message }));
    } finally {
      event.target.value = '';
    }
  });

  on('worlds', renderWorlds);
  // `chat` is deliberately absent: a chat load always refreshes the preview
  // right after (see `loadChat`), and the list reads the per-book hit badges
  // from it — subscribing to both rebuilt the whole list twice per switch.
  on('preview', renderWorlds);
  on('vectors', renderWorlds);
  // The badge says whether a book is ready to be searched by meaning; the status
  // itself never touches the embedding endpoint, so reading it here is cheap.
  void loadVectors().catch((error) => toastError(t('worlds.vectorStatusFailed', { error: error.message })));
}
