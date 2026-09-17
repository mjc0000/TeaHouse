/**
 * Regex editor: the list of find/replace rules, each with a scope and a
 * switch, plus a scratch box that tries one rule without storing anything.
 *
 * Storage is always the original text — on both sides. Display rules rewrite
 * the shown copy (the transcript re-renders on save); prompt rules rewrite the
 * assembled request (the preview names what fired). The editor refuses to save
 * a rule that cannot compile, and the "试一条" box answers before anything is
 * stored.
 */

import { api, json, loadRegexes, on, refreshPreview, state } from '../api.js';
import { createModal } from '../components/modal.js';
import { toastError, toastOk } from '../components/toast.js';
import { clear, el } from '../dom.js';
import { guard } from '../errors.js';
import { t } from '../i18n.js';

let editorOpen = false;

const SCOPES = [
  { value: 'display', labelKey: 'regexEditor.scopeDisplay' },
  { value: 'prompt', labelKey: 'regexEditor.scopePrompt' },
  { value: 'both', labelKey: 'regexEditor.scopeBoth' },
];

function newId() {
  return `rx-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function ruleRow(rule, onChange, onRemove) {
  const name = el('input', { type: 'text', value: rule.name, placeholder: t('regexEditor.namePlaceholder') });
  const pattern = el('input', { type: 'text', value: rule.pattern, placeholder: t('regexEditor.patternPlaceholder') });
  const flags = el('input', { type: 'text', value: rule.flags ?? '', placeholder: t('regexEditor.flagsPlaceholder') });
  const replacement = el('input', { type: 'text', value: rule.replacement ?? '', placeholder: t('regexEditor.replacementPlaceholder') });
  const scope = el(
    'select',
    { onchange: () => onChange(read()) },
    SCOPES.map((option) => el('option', { value: option.value, text: t(option.labelKey) })),
  );
  scope.value = rule.scope ?? 'display';
  const enabled = el('input', { type: 'checkbox' });
  enabled.checked = rule.enabled !== false;

  function read() {
    return {
      ...rule,
      name: name.value,
      pattern: pattern.value,
      flags: flags.value,
      replacement: replacement.value,
      scope: scope.value,
      enabled: enabled.checked,
    };
  }
  for (const control of [name, pattern, flags, replacement, enabled]) {
    control.addEventListener('input', () => onChange(read()));
    control.addEventListener('change', () => onChange(read()));
  }

  return {
    node: el('div', { class: 'regex-rule' }, [
      el('label', { class: 'regex-cell grow' }, [t('regexEditor.labelName'), name]),
      el('label', { class: 'regex-cell grow' }, [t('regexEditor.labelPattern'), pattern]),
      el('label', { class: 'regex-cell short' }, [t('regexEditor.labelFlags'), flags]),
      el('label', { class: 'regex-cell grow' }, [t('regexEditor.labelReplacement'), replacement]),
      el('label', { class: 'regex-cell short' }, [t('regexEditor.labelScope'), scope]),
      el('label', { class: 'regex-cell check' }, [t('regexEditor.labelEnabled'), enabled]),
      el('button', { class: 'ghost danger tiny', type: 'button', text: t('common.delete'), onclick: onRemove }),
    ]),
    read,
  };
}

export async function openRegexEditor() {
  if (editorOpen) return;
  editorOpen = true;
  let rules;
  try {
    rules = (await loadRegexes()).rules.map((rule) => ({ ...rule }));
  } catch (error) {
    toastError(t('regexEditor.loadFailed', { error: error.message }));
    editorOpen = false;
    return;
  }

  const list = el('div', { class: 'regex-list' });
  const status = el('div', { class: 'muted small' });
  const sample = el('textarea', { rows: 3, placeholder: t('regexEditor.samplePlaceholder') });
  const sampleResult = el('div', { class: 'muted small' });
  let readers = [];

  function renderRows() {
    clear(list);
    readers = rules.map((rule, index) =>
      ruleRow(
        rule,
        (next) => {
          rules[index] = next;
        },
        () => {
          rules.splice(index, 1);
          renderRows();
        },
      ),
    );
    for (const reader of readers) list.append(reader.node);
    if (rules.length === 0) {
      list.append(el('div', { class: 'muted small', text: t('regexEditor.empty') }));
    }
    status.textContent = t('regexEditor.status', {
      count: rules.length,
      display: rules.filter((rule) => rule.enabled !== false && rule.scope !== 'prompt').length,
    });
  }
  renderRows();

  async function save() {
    const payload = { version: 1, rules: readers.map((reader) => reader.read()) };
    try {
      await api('/api/regex', json('PUT', payload));
      await loadRegexes();
      // Display rules change the reading view; prompt rules change the next
      // assembly. Both refresh from here so nothing shows a stale number.
      if (state.chatId) await refreshPreview();
      toastOk(t('regexEditor.saved', { count: payload.rules.length }));
      modal.close();
    } catch (error) {
      toastError(t('regexEditor.saveFailed', { error: error.message }));
    }
  }

  async function trySample() {
    const text = sample.value;
    const current = readers.length > 0 ? readers[readers.length - 1].read() : null;
    if (!current || text.trim() === '') {
      sampleResult.textContent = t('regexEditor.sampleNeed');
      return;
    }
    try {
      const result = await api(
        '/api/regex/test',
        json('POST', { pattern: current.pattern, flags: current.flags, replacement: current.replacement, text }),
      );
      clear(sampleResult);
      sampleResult.append(
        el('span', { text: t('regexEditor.sampleRewrote', { count: result.count }) }),
        el('code', { text: String(result.result).slice(0, 200) }),
      );
    } catch (error) {
      sampleResult.textContent = t('regexEditor.sampleFailed', { error: error.message });
    }
  }

  const modal = createModal({
      className: 'regex',
      removeOnClose: true,
    title: t('regexEditor.title'),
    subtitle: t('regexEditor.subtitle'),
    onClose: () => {
      editorOpen = false;
    },
  });
  modal.body.append(
    list,
    el('div', { class: 'row' }, [
      el('button', {
        class: 'ghost',
        type: 'button',
        text: t('regexEditor.add'),
        onclick: () => {
          rules.push({ id: newId(), name: '', pattern: '', flags: 'g', replacement: '', scope: 'display', enabled: false });
          renderRows();
        },
      }),
      el('button', { class: 'ghost', type: 'button', text: t('regexEditor.tryOne'), onclick: () => void trySample() }),
    ]),
    sample,
    sampleResult,
    status,
  );
  modal.footer.append(
    el('button', { class: 'ghost', type: 'button', text: t('common.close'), onclick: () => modal.close() }),
    el('button', { class: 'primary', type: 'button', text: t('common.save'), onclick: guard(t('regexEditor.guardSave'), () => save()) }),
  );
  modal.open();
}

export function initRegexView() {
  // Opened from the prompt panel's footnote via event, like the memory editor.
  on('open-regex-editor', () => {
    openRegexEditor().catch((error) => toastError(error.message));
  });
}
