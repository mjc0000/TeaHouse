/**
 * Promise-based dialogs replacing window.confirm / window.prompt.
 *
 * Both are keyboard complete: Enter confirms, Escape cancels, focus starts in a
 * sensible place, and Escape returns focus to whatever opened them (handled by
 * the modal shell).
 */

import { el } from '../dom.js';
import { t } from '../i18n.js';
import { createModal } from './modal.js';

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.message]
 * @param {string} [options.detail]      extra, dimmer line (e.g. what will be lost)
 * @param {string} [options.confirmLabel]
 * @param {string} [options.cancelLabel]
 * @param {boolean} [options.danger]
 * @returns {Promise<boolean>}
 */
export function confirmDialog(options) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const modal = createModal({
      title: options.title,
      className: 'dialog',
      removeOnClose: true,
      onClose: () => settle(false),
    });

    const confirmButton = el('button', {
      class: options.danger ? 'primary danger-solid' : 'primary',
      text: options.confirmLabel ?? t('common.confirm'),
      onclick: () => {
        settle(true);
        modal.close();
      },
    });

    modal.body.append(
      el('div', { class: 'dialog-body' }, [
        options.message ? el('p', { class: 'dialog-message', text: options.message }) : null,
        options.detail ? el('p', { class: 'dialog-detail muted small', text: options.detail }) : null,
      ]),
    );

    const cancelButton = el('button', {
      class: 'ghost',
      text: options.cancelLabel ?? t('common.cancel'),
      onclick: () => {
        settle(false);
        modal.close();
      },
    });

    modal.footer.append(cancelButton, confirmButton);

    modal.open();
    // Focus starts on cancel so a stray Enter cannot destroy anything; Escape is
    // handled by the modal shell.
    modal.focus(cancelButton);
  });
}

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.label]
 * @param {string} [options.value]
 * @param {string} [options.placeholder]
 * @param {string} [options.hint]
 * @returns {Promise<string|null>} null when cancelled
 */
export function promptDialog(options) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const input = el('input', {
      type: 'text',
      value: options.value ?? '',
      placeholder: options.placeholder ?? '',
    });

    const submit = () => {
      const value = input.value.trim();
      if (value === '') return;
      settle(value);
      modal.close();
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });

    const modal = createModal({
      title: options.title,
      className: 'dialog',
      removeOnClose: true,
      onClose: () => settle(null),
    });

    modal.body.append(
      el('div', { class: 'dialog-body' }, [
        el('label', { class: 'field-row' }, [
          el('span', { class: 'field-label', text: options.label ?? '' }),
          input,
        ]),
        options.hint ? el('p', { class: 'dialog-detail muted small', text: options.hint }) : null,
      ]),
    );

    modal.footer.append(
      el('button', {
        class: 'ghost',
        text: t('common.cancel'),
        onclick: () => {
          settle(null);
          modal.close();
        },
      }),
      el('button', { class: 'primary', text: options.confirmLabel ?? t('common.confirm'), onclick: submit }),
    );

    modal.open();
    input.focus();
    input.select();
  });
}
