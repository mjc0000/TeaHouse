/**
 * One message in the transcript.
 *
 * Owns its own DOM and its editing draft; it never talks to the API. Actions are
 * reported through `onAction(action, entry, payload)` and the view decides what
 * to do, which keeps this component free of state and of request logic.
 *
 * Keyboard: the component is focusable (tabindex=0) so the message shortcuts
 * (edit / copy / retry / menu) work without a mouse.
 */

import { el } from '../dom.js';
import { t } from '../i18n.js';
import { renderMarkdown } from '../markdown.js';
import { createModal } from './modal.js';
import { openMenu } from './menu.js';

const ROLE_LABELS = { user: 'user', assistant: 'assistant', system: 'system' };

function variantControls(entry, onAction) {
  const variants = entry.variants ?? [];
  if (entry.role !== 'assistant' || variants.length <= 1) return null;
  const active = entry.activeVariant ?? 0;
  return el('div', { class: 'variant-controls' }, [
    el('button', {
      class: 'ghost tiny',
      text: '◀',
      title: t('message.prevVariant'),
      onclick: (event) => {
        event.stopPropagation();
        onAction('variant', entry, { index: (active - 1 + variants.length) % variants.length });
      },
    }),
    el('span', { class: 'variant-count', text: `${active + 1}/${variants.length}` }),
    el('button', {
      class: 'ghost tiny',
      text: '▶',
      title: t('message.nextVariant'),
      onclick: (event) => {
        event.stopPropagation();
        onAction('variant', entry, { index: (active + 1) % variants.length });
      },
    }),
  ]);
}

function menuItems(entry, options, onAction) {
  return [
    {
      label: t('message.copyBody'),
      hint: 'Ctrl+Shift+C',
      onSelect: () => onAction('copy', entry),
    },
    {
      label: t('message.edit'),
      hint: options.canEdit ? 'Ctrl+E' : t('message.notEditable'),
      disabled: !options.canEdit,
      onSelect: () => onAction('edit', entry),
    },
    {
      label: t('message.retryTitle'),
      hint: 'Ctrl+Shift+R',
      disabled: !options.canRetry,
      onSelect: () => onAction('retry', entry),
    },
    {
      label: t('message.translate'),
      hint: t('message.translateHint'),
      disabled: !options.canTranslate,
      onSelect: () => onAction('translate', entry),
    },
    {
      label: options.speaking === true ? t('message.stopSpeak') : t('message.speak'),
      hint: options.speaking === true ? t('message.stopSpeakHint') : t('message.speakHint'),
      disabled: !options.canSpeak,
      onSelect: () => onAction('speak', entry),
    },
    {
      label: t('message.continue'),
      hint: t('message.continueHint'),
      disabled: !options.canContinue,
      onSelect: () => onAction('continue', entry),
    },
    {
      label: t('message.fork'),
      hint: t('message.forkHint'),
      disabled: options.streaming,
      separatorBefore: true,
      onSelect: () => onAction('fork', entry),
    },
    {
      label: t('message.truncate'),
      hint: t('message.truncateHint'),
      disabled: options.streaming,
      onSelect: () => onAction('truncate', entry),
    },
    {
      label: t('message.remove'),
      hint: t('message.removeHint'),
      danger: true,
      disabled: options.streaming,
      onSelect: () => onAction('remove', entry),
    },
  ];
}

/**
 * The model's thinking, kept from the stream and stored on the message.
 *
 * Collapsed by default — it is context for the answer, not the answer. One slot
 * per candidate reply, so swiping shows the thinking that produced the text
 * being shown.
 */
function reasoningBlock(entry, options) {  if (options.showReasoning !== true) return null;
  const reasoning = entry.reasonings?.[entry.activeVariant ?? 0] ?? '';
  if (reasoning === '') return null;
  return el('details', { class: 'reasoning' }, [
    el('summary', { text: t('message.reasoning', { count: reasoning.length }) }),
    el('div', { class: 'reasoning-body', text: reasoning }),
  ]);
}

/** One click on a thumbnail: the full picture in the shared dialog shell. */
function openImage(image) {
  const modal = createModal({ className: 'image', title: image.name ?? image.id, removeOnClose: true });
  modal.body.append(
    el('img', {
      class: 'message-image-full',
      src: `/api/images/${encodeURIComponent(image.id)}`,
      alt: image.name ?? image.id,
    }),
  );
  modal.footer.append(el('button', { class: 'ghost', text: t('common.close'), onclick: () => modal.close() }));
  modal.open();
}

/**
 * Parsed message bodies, one slot per entry.
 *
 * A re-render (a config change, a translation toggle, the reload after every
 * turn) used to run the Markdown and math parsers over every message again.
 * The parsed nodes are pure structure with no listeners, so the same ones move
 * into the new bubble instead — and are replaced the moment the shown text or
 * the Markdown switch moves, so nothing stale can be served.
 */
const bodyCache = new Map();
const BODY_CACHE_LIMIT = 512;

function bodyNodes(entry, content, markdown) {
  const key = `${markdown ? 'md' : 'text'}\u0000${content}`;
  const hit = bodyCache.get(entry.id);
  if (hit && hit.key === key) return hit.nodes;
  const nodes = markdown ? renderMarkdown(content) : [document.createTextNode(content)];
  // Re-inserting moves the slot to the end, so eviction takes the oldest entry.
  bodyCache.delete(entry.id);
  bodyCache.set(entry.id, { key, nodes });
  if (bodyCache.size > BODY_CACHE_LIMIT) {
    const oldest = bodyCache.keys().next().value;
    if (oldest !== undefined) bodyCache.delete(oldest);
  }
  return nodes;
}

/** Drops every cached body; the chat view calls this when the chat changes. */
export function clearBodyCache() {
  bodyCache.clear();
}

export function messageNode(entry, options) {
  const content = options.content ?? entry.content;
  const speaker = options.speaker ?? ROLE_LABELS[entry.role] ?? entry.role;
  const editing = options.isEditing === true;

  const body = el('div', { class: 'message-body' });

  // `content` is the shown copy (display regex may have rewritten it); the draft
  // always starts from what is stored, so saving an unedited draft changes nothing.
  const textarea = editing
    ? el('textarea', { class: 'message-editor', rows: Math.min(20, Math.max(3, entry.content.split('\n').length + 1)) })
    : null;
  if (textarea) textarea.value = entry.content;

  const editor = editing
    ? el('div', { class: 'message-editing' }, [
        textarea,
        el('div', { class: 'message-editing-actions' }, [
          el('button', {
            class: 'primary',
            text: t('common.save'),
            onclick: () => options.onSave?.(entry, textarea.value),
          }),
          el('button', { class: 'ghost', text: t('common.cancel'), onclick: () => options.onCancelEdit?.() }),
          el('span', { class: 'muted small', text: t('message.editorHint') }),
        ]),
      ])
    : null;

  if (editor) {
    textarea.addEventListener('keydown', (event) => {
      // Stop propagation so the global Ctrl+Enter (send) does not also fire, and
      // so Escape exits editing instead of closing something above it.
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.stopPropagation();
        options.onSave?.(entry, textarea.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        options.onCancelEdit?.();
      }
    });
    body.append(editor);
  } else {
    // Appended conditionally: the native `append` would turn a `null` block into
    // the literal text "null", which is exactly what it used to do here.
    const reasoning = reasoningBlock(entry, options);
    if (reasoning) body.append(reasoning);
    // Markdown builds element nodes only (never innerHTML), so a card smuggling
    // `<script>` gets punctuation, not execution. Editing and copying keep the
    // raw text; only the reading view is rendered.
    const textBox = el('div', { class: 'message-text' });
    for (const node of bodyNodes(entry, content, options.markdown === true)) textBox.append(node);
    body.append(textBox);
    // Attached pictures, if any: thumbnails in the bubble, the full image one
    // click away. The files live under `data/images/`; the entry only holds
    // references, so a missing file degrades to its name instead of a break.
    if (Array.isArray(entry.images) && entry.images.length > 0) {
      const gallery = el('div', { class: 'message-images' });
      for (const image of entry.images) {
        const thumb = el('img', {
          class: 'message-image',
          src: `/api/images/${encodeURIComponent(image.id)}`,
          alt: image.name ?? image.id,
          title: t('message.imageZoom', { name: image.name ?? image.id }),
          onclick: () => openImage(image),
        });
        thumb.addEventListener('error', () => {
          thumb.replaceWith(el('span', { class: 'muted small', text: t('message.imageMissing', { name: image.name ?? image.id }) }));
        });
        gallery.append(thumb);
      }
      body.append(gallery);
    }
  }

  const actions = editing
    ? []
    : [
        // A translated message carries its own switch: the stored text never
        // moves, only the reading view flips between the two.
        ...(options.translation
          ? [
              el('button', {
                class: 'ghost tiny',
                text: options.translation === 'translated' ? t('message.original') : t('message.translated'),
                title: options.translation === 'translated' ? t('message.seeOriginal') : t('message.seeTranslated'),
                disabled: options.streaming,
                onclick: () => options.onToggleTranslation?.(entry),
              }),
            ]
          : []),
        el('button', {
          class: 'ghost tiny',
          text: t('message.copy'),
          title: t('message.copyBody'),
          disabled: options.streaming,
          onclick: () => options.onAction('copy', entry),
        }),
        el('button', {
          class: 'ghost tiny',
          text: t('message.edit'),
          title: options.canEdit ? t('message.editTitle') : t('message.editDisabledTitle'),
          disabled: !options.canEdit,
          onclick: () => options.onAction('edit', entry),
        }),
        el('button', {
          class: 'ghost tiny',
          text: t('message.retry'),
          title: options.canRetry ? t('message.retryTitle') : t('message.retryDisabledTitle'),
          disabled: !options.canRetry || options.streaming,
          onclick: () => options.onAction('retry', entry),
        }),
        el('button', {
          class: 'ghost tiny',
          text: '⋯',
          title: t('message.more'),
          'aria-haspopup': 'menu',
          onclick: (event) => {
            event.stopPropagation();
            openMenu({
              anchor: event.currentTarget,
              items: menuItems(entry, options, options.onAction),
            });
          },
        }),
      ];

  const node = el(
    'div',
    {
      class: `message ${entry.role}${editing ? ' editing' : ''}`,
      dataset: { id: entry.id },
      tabindex: '0',
      oncontextmenu: (event) => {
        event.preventDefault();
        openMenu({
          x: event.clientX,
          y: event.clientY,
          items: menuItems(entry, options, options.onAction),
        });
      },
    },
    [
      el('div', { class: 'message-head' }, [
        el('span', { class: `speaker ${entry.role}`, text: speaker }),
        el('span', { class: 'role-badge', text: ROLE_LABELS[entry.role] ?? entry.role }),
        variantControls(entry, options.onAction),
        el('span', { class: 'spacer' }),
        el('div', { class: 'message-actions' }, actions),
      ]),
      body,
    ],
  );

  if (editing) setTimeout(() => textarea?.focus(), 0);
  return node;
}
