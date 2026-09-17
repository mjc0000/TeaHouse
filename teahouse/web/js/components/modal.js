/**
 * Modal shell. Every dialog in the app goes through this, so Escape, focus
 * trapping, focus restoration and scroll locking are implemented once.
 *
 * The component owns its DOM: nothing here is addressed by id from outside.
 */

import { el } from '../dom.js';
import { captureFocus, focusFirst, lockScroll, trapFocus } from '../focus.js';
import { t } from '../i18n.js';
import { pushEscapeLayer } from '../keys.js';

/**
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.subtitle]
 * @param {string} [options.className]  extra class on the panel
 * @param {boolean} [options.persistent] backdrop clicks do not close
 * @param {boolean} [options.removeOnClose] drop the root instead of hiding it.
 *   For one-shot dialogs (confirms, prompts); the reused editors (settings,
 *   world book, card, quick replies) keep their DOM on purpose — a test pins
 *   that the world editor survives closing.
 * @param {() => void} [options.onClose]
 */
export function createModal(options = {}) {
  const titleNode = el('span', { class: 'modal-title', text: options.title ?? '' });
  const subtitleNode = el('span', { class: 'modal-subtitle muted small', text: options.subtitle ?? '' });
  const headerActions = el('div', { class: 'modal-header-actions' });
  const body = el('div', { class: 'modal-content' });
  const footer = el('div', { class: 'modal-footer' });

  const panel = el(
    'div',
    {
      class: `modal-panel ${options.className ?? ''}`.trim(),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': options.title ?? t('modal.dialog'),
      tabindex: '-1',
    },
    [
      el('div', { class: 'modal-header' }, [
        el('div', { class: 'modal-heading' }, [titleNode, subtitleNode]),
        headerActions,
        el('button', {
          class: 'ghost icon-button',
          text: '×',
          'aria-label': t('common.close'),
          title: t('modal.closeEsc'),
          onclick: () => close(),
        }),
      ]),
      body,
      footer,
    ],
  );

  const root = el('div', { class: 'modal hidden' }, [panel]);

  // Attached immediately, while still hidden. Markup moved into a modal body
  // must stay inside the document: appending into a *detached* subtree removes
  // the moved nodes from the document, so every later
  // `document.getElementById(...)` on them returns null. That is exactly how the
  // settings dialog managed to throw before it ever opened.
  document.body.append(root);

  let open = false;
  let releaseScroll = null;
  let releaseEscape = null;
  let restoreFocus = null;

  const onKeydown = (event) => trapFocus(panel, event);
  const onBackdrop = (event) => {
    if (event.target === root && options.persistent !== true) close();
  };

  function close() {
    if (!open) return;
    open = false;
    root.classList.add('hidden');
    panel.removeEventListener('keydown', onKeydown);
    root.removeEventListener('mousedown', onBackdrop);
    releaseEscape?.();
    releaseScroll?.();
    restoreFocus?.();
    releaseEscape = null;
    releaseScroll = null;
    restoreFocus = null;
    options.onClose?.();
    // One-shot dialogs leave the document; a session opens dozens of confirms
    // and prompts, and hidden roots would pile up forever. Reopening a removed
    // shell re-attaches (see show()).
    if (options.removeOnClose === true) root.remove();
  }

  function show() {
    if (open) return;
    open = true;
    if (!root.isConnected) document.body.append(root);
    root.classList.remove('hidden');
    panel.addEventListener('keydown', onKeydown);
    root.addEventListener('mousedown', onBackdrop);
    releaseEscape = pushEscapeLayer(() => close());
    releaseScroll = lockScroll();
    restoreFocus = captureFocus();
    focusFirst(body);
  }

  return {
    root,
    panel,
    body,
    footer,
    headerActions,
    get isOpen() {
      return open;
    },
    open: show,
    close,
    setTitle(text) {
      titleNode.textContent = text;
    },
    setSubtitle(text) {
      subtitleNode.textContent = text ?? '';
    },
    /** Moves focus into the dialog, e.g. onto a text field after opening. */
    focus(node) {
      node?.focus();
    },
  };
}
