/**
 * Expression sprites: the portrait above the prompt stack.
 *
 * The server matches the newest messages against the filenames and names the
 * current emotion; the panel only shows it. A manual pick pins the portrait
 * until the conversation changes or auto is re-selected — a pin that silently
 * went stale would be worse than no pin.
 *
 * Files get here through the upload below (or dropped into data/sprites by
 * hand, same result): the keyword is asked at upload time and becomes the
 * filename, so there is never a file whose emotion nobody knows.
 */

import { api, on, state } from '../api.js';
import { confirmDialog, promptDialog } from '../components/confirm.js';
import { emptyState } from '../components/empty-state.js';
import { toastError, toastOk } from '../components/toast.js';
import { clear, el } from '../dom.js';
import { t } from '../i18n.js';
import { focusFromPixels, nudgeFocus } from '../sprite-focus.js';

/** Whether the manage grid (thumbnails, delete, upload) is unfolded. */
let managing = false;

/**
 * Chat backdrop: the shown portrait behind the transcript. The settings live
 * in this browser's localStorage (like the theme, not the chat): on/off,
 * blur in px, and a manual vertical nudge in percentage points. An old plain
 * boolean (from the toggle-only days) still reads as the switch.
 */
const BACKDROP_KEY = 'teahouse.spriteBackdrop';

function readBackdrop() {
  const fallback = { on: true, blur: 26, dy: 0 };
  try {
    const parsed = JSON.parse(localStorage.getItem(BACKDROP_KEY) ?? 'null');
    if (typeof parsed === 'boolean') return { ...fallback, on: parsed };
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      on: parsed.on !== false,
      blur: Number.isFinite(Number(parsed.blur)) ? Math.min(40, Math.max(0, Number(parsed.blur))) : 26,
      dy: Number.isFinite(Number(parsed.dy)) ? Math.min(30, Math.max(-30, Number(parsed.dy))) : 0,
    };
  } catch {
    return fallback;
  }
}

function writeBackdrop(next) {
  try {
    localStorage.setItem(BACKDROP_KEY, JSON.stringify(next));
  } catch {
    /* a full or blocked store keeps the session value */
  }
}

/** Vertical focus per image, 0 (top) to 100 (bottom); 50 until analysed. */
const focusCache = new Map();

function analyseFocus(url) {
  if (typeof Image === 'undefined') return;
  const img = new Image();
  img.onload = () => {
    try {
      const width = 48;
      const height = Math.max(1, Math.round((48 * img.naturalHeight) / img.naturalWidth));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      focusCache.set(url, focusFromPixels(data, width, height));
      // The analysis lands after paint; re-aim if this is still the portrait.
      const shown = currentShown();
      if (shown && shown.url === url) paintBackdrop(shown);
    } catch {
      /* a tainted canvas or a missing 2d context keeps the centre */
    }
  };
  img.src = url;
}

function focusY(url) {
  const cached = focusCache.get(url);
  if (cached !== undefined) return cached;
  focusCache.set(url, 50);
  try {
    analyseFocus(url);
  } catch {
    /* no Image or canvas here (tests): the centre holds */
  }
  return 50;
}

function paintBackdrop(shown) {
  const backdrop = document.getElementById('chat-backdrop');
  if (!backdrop) return;
  const opts = readBackdrop();
  if (!opts.on || !shown) {
    backdrop.classList.add('hidden');
    backdrop.style.backgroundImage = '';
    return;
  }
  backdrop.style.backgroundImage = `url("${shown.url}")`;
  backdrop.style.filter = `blur(${opts.blur}px) brightness(0.9) saturate(1.2)`;
  backdrop.style.backgroundPosition = `50% ${nudgeFocus(focusY(shown.url), opts.dy)}%`;
  backdrop.classList.remove('hidden');
}

function renderBackdrop(shown) {
  paintBackdrop(shown);
}

export async function loadSprite() {
  if (!state.chatId) {
    state.sprite = null;
    return state.sprite;
  }
  try {
    state.sprite = await api(`/api/chats/${encodeURIComponent(state.chatId)}/sprite`);
  } catch {
    state.sprite = null;
  }
  return state.sprite;
}

async function refresh() {
  await loadSprite();
  render();
}

function uploadSprite() {
  const input = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file || !state.chatId) return;
    const stem = file.name.includes('.') ? file.name.slice(0, file.name.lastIndexOf('.')) : file.name;
    const emotion = await promptDialog({
      title: t('sprite.uploadTitle'),
      label: t('sprite.emotionLabel'),
      value: stem.trim().slice(0, 48),
      hint: t('sprite.emotionHint'),
    });
    if (emotion === null || !state.chatId) return;
    try {
      // Raw bytes like the chat image upload; the server sniffs the format.
      const response = await fetch(
        `/api/chats/${encodeURIComponent(state.chatId)}/sprite-files?emotion=${encodeURIComponent(emotion)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      toastOk(t('sprite.uploaded', { emotion: body.emotion }));
    } catch (error) {
      toastError(t('sprite.uploadFailed', { error: error.message }));
      return;
    }
    await refresh();
  });
  input.click();
}

async function deleteSprite(file) {
  const ok = await confirmDialog({
    title: t('sprite.deleteTitle'),
    message: t('sprite.deleteMessage', { emotion: file.emotion }),
    detail: t('sprite.deleteDetail'),
    confirmLabel: t('common.delete'),
    danger: true,
  });
  if (!ok || !state.chatId) return;
  try {
    await api(
      `/api/chats/${encodeURIComponent(state.chatId)}/sprite-files?file=${encodeURIComponent(file.file)}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    toastError(t('sprite.deleteFailed', { error: error.message }));
    return;
  }
  if (state.ui.spriteOverride?.emotion === file.emotion) state.ui.spriteOverride = null;
  await refresh();
}

function renderManage(holder, files) {
  holder.append(
    el('button', {
      class: 'ghost',
      type: 'button',
      text: managing ? t('sprite.collapse') : t('sprite.manage', { count: files.length }),
      onclick: () => {
        managing = !managing;
        render();
      },
    }),
  );
  if (!managing) return;
  const grid = el('div', { class: 'sprite-grid' });
  for (const file of files) {
    grid.append(
      el('div', { class: 'sprite-thumb' }, [
        el('img', { src: file.url, alt: file.emotion, title: file.emotion }),
        el('span', { class: 'sprite-thumb-label', text: file.emotion }),
        el('button', {
          class: 'ghost sprite-remove',
          type: 'button',
          text: '×',
          title: t('sprite.deleteThumb', { emotion: file.emotion }),
          onclick: () => deleteSprite(file),
        }),
      ]),
    );
  }
  holder.append(grid);
  holder.append(
    el('button', { class: 'ghost', type: 'button', text: t('sprite.upload'), onclick: uploadSprite }),
  );
}

function render() {
  const holder = document.getElementById('sprite');
  const block = document.getElementById('sprite-block');
  clear(holder);
  const files = state.sprite?.files ?? [];
  // No sprites yet: say so with an upload button, instead of hiding the
  // whole section — a hidden section hides its only entry point too, and
  // nobody can find where to upload the first portrait.
  if (files.length === 0) {
    block.classList.remove('hidden');
    holder.append(emptyState({
      title: t('sprite.emptyTitle'),
      hint: t('sprite.emptyHint'),
      action: { label: t('sprite.upload'), onClick: uploadSprite },
    }));
    renderBackdrop(null);
    return;
  }
  block.classList.remove('hidden');

  const shown = currentShown();
  if (!shown) return;

  const img = el('img', {
    class: 'sprite-image',
    src: shown.url,
    alt: shown.emotion,
    title: shown.manual
      ? t('sprite.manualTitle', { emotion: shown.emotion })
      : t('sprite.autoTitle', { emotion: shown.emotion }),
  });
  // A deleted file degrades to its name instead of breaking the column.
  img.addEventListener('error', () => {
    img.replaceWith(el('span', { class: 'muted small', text: t('sprite.imageMissing', { emotion: shown.emotion }) }));
  });
  holder.append(img);

  const select = el(
    'select',
    {
      class: 'sprite-select',
      title: t('sprite.selectTitle'),
      onchange: () => {
        const value = select.value;
        state.ui.spriteOverride = value === '' ? null : { chatId: state.chatId, emotion: value };
        render();
      },
    },
    [
      el('option', { value: '', text: t('sprite.autoOption', { emotion: state.sprite.current?.emotion ?? t('sprite.autoNone') }) }),
      ...files.map((file) => el('option', { value: file.emotion, text: file.emotion })),
    ],
  );
  select.value = currentManual()?.emotion ?? '';
  holder.append(select);
  renderBackdropControls(holder, readBackdrop());
  renderManage(holder, files);
  renderBackdrop(shown);
}

/** The manual pin, if it still names a file. */
function currentManual() {
  const files = state.sprite?.files ?? [];
  const override = state.ui.spriteOverride?.chatId === state.chatId ? state.ui.spriteOverride : null;
  return override && files.some((file) => file.emotion === override.emotion) ? override : null;
}

/** What the panel (and the backdrop) shows right now, if anything. */
function currentShown() {
  const files = state.sprite?.files ?? [];
  const manual = currentManual();
  if (manual) {
    return { emotion: manual.emotion, url: files.find((file) => file.emotion === manual.emotion).url, manual: true };
  }
  return state.sprite?.current ? { ...state.sprite.current, manual: false } : null;
}

/** Backdrop switch plus blur and framing sliders; sliders repaint live. */
function renderBackdropControls(holder, opts) {
  const repaint = () => paintBackdrop(currentShown());
  const backdropToggle = el('input', {
    type: 'checkbox',
    checked: opts.on,
    title: t('sprite.backdropTitle'),
    onchange: () => {
      writeBackdrop({ ...readBackdrop(), on: backdropToggle.checked });
      render();
    },
  });
  holder.append(el('label', { class: 'sprite-backdrop-row' }, [backdropToggle, t('sprite.backdropLabel')]));
  const blur = el('input', {
    type: 'range', min: '0', max: '40', value: String(opts.blur),
    title: t('sprite.blurTitle', { px: opts.blur }),
    'aria-label': t('sprite.blurAria'),
    oninput: () => {
      writeBackdrop({ ...readBackdrop(), blur: Number(blur.value) });
      blur.title = t('sprite.blurTitle', { px: blur.value });
      repaint();
    },
  });
  holder.append(el('label', { class: 'sprite-backdrop-row' }, [blur, t('sprite.blurLabel')]));
  const shift = el('input', {
    type: 'range', min: '-30', max: '30', value: String(opts.dy),
    title: t('sprite.shiftTitle'),
    'aria-label': t('sprite.shiftAria'),
    oninput: () => {
      writeBackdrop({ ...readBackdrop(), dy: Number(shift.value) });
      repaint();
    },
  });
  holder.append(el('label', { class: 'sprite-backdrop-row' }, [shift, t('sprite.shiftLabel')]));
}

export function initSpriteView() {
  state.ui.spriteOverride = null;
  // Only `chat`: the sprite endpoint derives the current portrait from the
  // stored messages, so it can only move when a chat is (re)loaded. `preview`
  // fires several times per turn and never changes it — subscribing to both
  // only doubled the local fetch.
  on('chat', async () => {
    state.ui.spriteOverride = null;
    managing = false;
    await loadSprite();
    render();
  });
}
