/**
 * Settings dialog.
 *
 * One long form became unusable as soon as the config grew past a screen: the
 * fields for the provider, the token counter, the persona, the reply language
 * and the world book scan all competed for the same scroll. Here they are split
 * into pages, with a category list on the left, so each page is short enough to
 * read at once and a new option has an obvious home.
 *
 * The pages, their fields and the save payload all come from
 * `settings-schema.js`; this module only builds DOM. Every page's controls are
 * built together, so switching pages never discards an edit, and saving sends
 * the whole configuration in one request.
 *
 * Like the world book editor, the dialog owns its DOM (no ids looked up from
 * outside) and takes its shell from components/modal.js.
 */

import { api, json, loadConfig, loadModels, loadPersonas, loadVectors, on, saveConnections, savePersonas, state, testConnection } from '../api.js';
import { FONT_STACKS, applyFonts, readStoredFont, writeStoredFont } from '../fonts.js';
import { accentSwatches } from '../components/accent-swatches.js';
import {
  THEMES,
  applyTheme,
  readStoredTheme,
  resolvedTheme,
  themeById,
} from '../themes.js';
import { createFieldRows, readFields } from '../components/form-field.js';
import { icon } from '../components/icon.js';
import { createModal } from '../components/modal.js';
import { createModelPicker } from '../components/model-picker.js';
import { toastError, toastOk } from '../components/toast.js';
import { clear, el } from '../dom.js';
import { downloadText } from '../clipboard.js';
import { newPersonaId } from '../persona.js';
import { connectionItems, newConnectionId } from '../connections.js';
import { matchesVoice, speakSample, voiceKey } from '../tts.js';
import { DEFAULT_STORY_TEMPLATE, parseContextPreset, toContextPreset } from '../context-template.js';
import { guard } from '../errors.js';
import { renderLanguageInstruction } from '../language.js';
import { formatNumber, locale, onLocaleChange, t } from '../i18n.js';
import {
  LANGUAGE_PRESETS,
  SETTINGS_PAGES,
  buildPatch,
  changedFields,
  hasRetrievalMode,
  retrievalMigrationNotice,
  retrievalModeLabel,
  validateValues,
  valuesFromConfig,
} from '../settings-schema.js';
import { budgetFromPreview } from '../token-budget.js';

/** Built on first open; the dialog is a singleton. */
let ui = null;
/** Remembered across openings, so reopening lands where you left off. */
let activePageId = SETTINGS_PAGES[0].id;
/** Controls of the currently rendered panes, by config key. */
let fields = new Map();

// ---------------------------------------------------------------------------
// Extra blocks: the parts of a page that are not a plain config field
// ---------------------------------------------------------------------------

/** How tokens are counted right now, plus the connection test and model list. */
function countingExtra() {
  const countingText = el('span', { class: 'field-hint' });
  const connection = el('span', { class: 'muted small' });
  const button = el('button', {
    class: 'ghost',
    type: 'button',
    text: t('settings.extras.counting.testConnection'),
    title: t('settings.extras.counting.testConnectionTitle'),
    onclick: guard(t('guard.testConnection'), () => testConnection()),
  });

  // Provider-fetched ids become the candidates for the free-text model field.
  // The picker is the themed replacement for the native `<datalist>`, whose
  // popup is browser-drawn and cannot follow the dark theme.
  const modelField = () => fields.get('model')?.control;
  const pickerHolder = el('span', { class: 'model-picker-slot' });
  const modelNote = el('span', { class: 'muted small' });
  const modelButton = el('button', {
    class: 'ghost',
    type: 'button',
    text: t('settings.extras.counting.fetchModels'),
    title: t('settings.extras.counting.fetchModelsTitle'),
    onclick: guard(t('guard.loadModels'), async () => {
      modelNote.className = 'muted small';
      modelNote.textContent = t('settings.extras.counting.fetching');
      await loadModels();
      refresh();
    }),
  });
  const picker = createModelPicker({
    className: 'model-picker-settings',
    fallback: t('common.none'),
    title: t('settings.extras.counting.selectModel'),
    items: () => {
      const current = modelField()?.value ?? '';
      return [
        ...(state.models ?? []).map((model) => ({
          label: model,
          hint: model === current ? t('settings.extras.counting.current') : '',
          onSelect: () => selectModel(model),
        })),
        ...((state.models?.length ?? 0) === 0
          ? [{ label: t('settings.extras.counting.noModelsYet'), disabled: true }]
          : []),
        {
          label: state.modelsError
            ? t('settings.extras.counting.fetchFailedRetry', { error: state.modelsError })
            : t('settings.extras.counting.fetchModels'),
          separatorBefore: true,
          onSelect: () => loadModels(),
        },
      ];
    },
  });
  pickerHolder.append(picker.node);

  const node = el('div', { class: 'settings-extra' }, [
    settingsRow({
      label: t('settings.extras.counting.currentLabel'),
      text: countingText,
    }),
    settingsRow({
      label: t('settings.extras.counting.connectionLabel'),
      hint: t('settings.extras.counting.connectionHint'),
      control: el('span', { class: 'connection-row' }, [button, connection]),
    }),
    settingsRow({
      label: t('settings.extras.counting.defaultModelLabel'),
      hint: t('settings.extras.counting.defaultModelHint'),
      control: el('span', { class: 'connection-row' }, [pickerHolder, modelButton, modelNote]),
    }),
  ]);

  /** Writes the picked id into the model field, exactly as if it were typed. */
  function selectModel(model) {
    const input = modelField();
    if (input) input.value = model;
    refreshChanged();
    refreshDynamic();
  }

  function refresh() {
    const counting = budgetFromPreview(state.config ?? {}, state.preview ?? {}).counting;
    countingText.textContent = state.preview
      ? `${counting.text}${t('settings.extras.counting.thisTurn')}`
      : `${counting.text}${t('settings.extras.counting.noChat')}`;

    const current = modelField()?.value ?? '';
    picker.setLabel(current === '' ? t('common.none') : current);
    picker.node.title = current === ''
      ? t('settings.extras.counting.selectModel')
      : t('settings.extras.counting.modelTitle', { model: current });
    if (state.models?.length) {
      modelNote.className = 'small ok';
      modelNote.textContent = state.modelsCached
        ? t('settings.extras.counting.candidatesCached', { count: state.models.length })
        : t('settings.extras.counting.candidates', { count: state.models.length });
    } else if (state.modelsError) {
      modelNote.className = 'small bad';
      modelNote.textContent = t('settings.extras.counting.fetchFailed', { error: state.modelsError });
    } else {
      modelNote.className = 'muted small';
      modelNote.textContent = t('settings.extras.counting.notFetched');
    }

    const status = state.ui.connection ?? { status: 'idle' };
    if (status.status === 'testing') {
      connection.className = 'muted small';
      connection.textContent = t('settings.extras.counting.testing');
      return;
    }
    if (status.status === 'ok') {
      const known = status.modelKnown === false ? t('settings.extras.counting.modelUnknown') : '';
      connection.className = 'small ok';
      connection.textContent =
        t('settings.extras.counting.connected', {
          count: status.modelCount,
          ms: status.elapsedMs,
        }) + known;
      return;
    }
    if (status.status === 'error') {
      connection.className = 'small bad';
      connection.textContent = t('settings.extras.counting.connectFailed', { error: status.error });
      return;
    }
    connection.className = 'muted small';
    connection.textContent = t('settings.extras.counting.untested');
  }

  return { node, refresh };
}

/**
 * Provider presets: pick a vendor, get its base URL (and, when the vendor
 * documents them, the model's window and output caps).
 *
 * The table and the URL matching live on the server (`GET /api/providers`), so
 * the dialog does no normalizing of its own and the same data can be asserted
 * over HTTP. Nothing is saved here: choosing a preset only types into the
 * fields, and the dialog's own 保存 does the rest.
 */
function providerExtra() {
  const note = el('div', { class: 'hint provider-note' });
  const limits = el('div', { class: 'hint provider-limits' });

  const select = el('select', {
    onchange: () => {
      const preset = providers.find((item) => item.id === select.value) ?? null;
      const base = fields.get('baseUrl')?.control;
      if (preset && base) base.value = preset.baseUrl;
      const input = fields.get('model')?.control;
      if (preset && input && preset.models.length > 0 && !preset.models.some((m) => m.id === input.value)) {
        // Only fill a blank or clearly-foreign model; a hand-typed id stays put.
        input.value = input.value.trim() === '' ? preset.models[0].id : input.value;
      }
      refreshChanged();
      void load();
    },
  });

  let providers = [];
  let active = null;
  let current = null;
  /** The option list is built once: rebuilding it under an open native popup
   *  can swallow the click, and resetting the value would undo the choice. */
  let populated = false;

  /** What the base URL field currently holds, decided by the server. */
  async function load() {
    const base = fields.get('baseUrl')?.control?.value ?? '';
    const model = fields.get('model')?.control?.value ?? '';
    try {
      const payload = await api(
        `/api/providers?baseUrl=${encodeURIComponent(base)}&model=${encodeURIComponent(model)}`
        + `&lang=${encodeURIComponent(locale())}`,
      );
      providers = Array.isArray(payload.providers) ? payload.providers : [];
      active = payload.active ?? null;
      current = payload.current ?? null;
    } catch {
      providers = [];
      active = null;
      current = null;
    }
    if (!populated && providers.length > 0) {
      select.append(el('option', { value: '', text: t('settings.extras.provider.custom') }));
      for (const provider of providers) {
        select.append(el('option', { value: provider.id, text: provider.label }));
      }
      select.value = active ?? '';
      populated = true;
    }
    render();
  }

  /** The note and the limits only — never touches the select, so the user's
   *  choice survives the re-renders that every other field edit triggers. */
  function render() {
    const provider = providers.find((item) => item.id === active) ?? null;
    clear(note);
    note.append(el('span', {
      text: provider
        ? t('settings.extras.provider.known', { label: provider.label, note: provider.note })
        : t('settings.extras.provider.unknown'),
    }));

    clear(limits);
    if (current && (current.contextWindow !== null || current.maxTokens !== null)) {
      const window = current.contextWindow === null
        ? t('settings.extras.provider.notRecorded')
        : formatNumber(current.contextWindow);
      const output = current.maxTokens === null
        ? t('settings.extras.provider.notRecorded')
        : formatNumber(current.maxTokens);
      const origin = current.source === 'learned'
        ? t('settings.extras.provider.measured')
        : t('settings.extras.provider.documented');
      limits.append(
        el('span', {
          text: t('settings.extras.provider.limits', {
            id: current.id,
            origin,
            window,
            output,
          }),
        }),
        el('button', {
          class: 'ghost tiny',
          type: 'button',
          text: t('settings.extras.provider.applyWindow'),
          title: t('settings.extras.provider.applyWindowTitle'),
          onclick: () => {
            const control = fields.get('maxContext')?.control;
            if (!control || current.contextWindow === null) return;
            control.value = String(current.contextWindow);
            refreshChanged();
            toastOk(t('settings.extras.provider.applied', {
              value: formatNumber(current.contextWindow),
            }));
          },
        }),
      );
    } else if (provider) {
      limits.append(el('span', { text: t('settings.extras.provider.noWindow') }));
    }
  }

  const node = el('div', { class: 'settings-extra' }, [
    settingsRow({
      label: t('settings.extras.provider.label'),
      hint: t('settings.extras.provider.hint'),
      control: select,
    }),
    note,
    limits,
  ]);

  void load();
  return { node, refresh: render, beforeFields: true };
}

/**
 * Extra connections: named endpoints a group member can speak through.
 *
 * They live in their own file (`data/connections.json`), so this block saves
 * itself instead of riding the dialog's config payload — the same choice the
 * persona and quick-reply blocks make. A `***` in the key box means "unchanged":
 * the server keeps the stored key rather than writing the mask over it.
 */
function connectionsExtra() {
  const rows = el('div', { class: 'conn-rows' });
  const status = el('span', { class: 'muted small' });
  let draft = connectionItems(state.connections).map((item) => ({ ...item }));
  let savedKey = draftKey(draft);
  let dirty = false;

  const save = el('button', {
    class: 'primary',
    type: 'button',
    text: t('settings.extras.connections.save'),
    onclick: guard(t('settings.extras.connections.guardSave'), async () => {
      savedKey = draftKey(draft);
      const file = await saveConnections({ version: 1, items: draft });
      draft = connectionItems(file).map((item) => ({ ...item }));
      savedKey = draftKey(draft);
      dirty = false;
      render();
      toastOk(t('settings.extras.connections.saved'));
    }),
  });

  const add = el('button', {
    class: 'ghost',
    type: 'button',
    text: t('settings.extras.connections.add'),
    onclick: () => {
      draft.push({ id: newConnectionId(), label: '', baseUrl: '', apiKey: '', model: '' });
      dirty = true;
      render();
    },
  });

  function draftKey(items) {
    return JSON.stringify(items.map((item) => [item.id, item.label, item.baseUrl, item.apiKey, item.model]));
  }

  function field(item, key, label, placeholder) {
    const input = el('input', {
      type: key === 'apiKey' ? 'password' : 'text',
      class: 'conn-input',
      placeholder,
      'aria-label': label,
      oninput: () => {
        item[key] = input.value;
        dirty = true;
        refreshStatus();
      },
    });
    input.value = item[key] ?? '';
    return input;
  }

  function refreshStatus() {
    save.disabled = !dirty;
    status.textContent = dirty
      ? t('settings.extras.connections.dirty')
      : t('settings.extras.connections.clean');
  }

  function render() {
    clear(rows);
    if (draft.length === 0) {
      rows.append(el('div', { class: 'muted small', text: t('settings.extras.connections.none') }));
    }
    draft.forEach((item, index) => {
      rows.append(
        el('div', { class: 'conn-row' }, [
          field(item, 'label', t('settings.extras.connections.nameLabel'), t('settings.extras.connections.namePlaceholder')),
          field(item, 'baseUrl', t('settings.extras.connections.urlLabel'), t('settings.extras.connections.urlPlaceholder')),
          field(item, 'apiKey', t('settings.extras.connections.keyLabel'), '***'),
          field(item, 'model', t('settings.extras.connections.modelLabel'), t('settings.extras.connections.modelPlaceholder')),
          el('button', {
            class: 'ghost tiny icon-button',
            type: 'button',
            text: '×',
            'aria-label': t('settings.extras.connections.removeAria', { index: index + 1 }),
            title: t('common.delete'),
            onclick: () => {
              draft.splice(index, 1);
              dirty = true;
              render();
            },
          }),
        ]),
      );
    });
    refreshStatus();
  }

  const node = el('div', { class: 'settings-extra' }, [
    settingsRow({
      label: t('settings.extras.connections.label'),
      hint: t('settings.extras.connections.hint'),
      control: el('span', { class: 'connection-row' }, [add, save, status]),
    }),
    rows,
  ]);

  render();

  /**
   * Adopt the server copy only when it really changed and the user is not
   * typing here — this block is rebuilt on every keystroke elsewhere in the
   * dialog, and washing the boxes would make it impossible to fill in.
   */
  function refresh() {
    if (document.activeElement !== null && rows.contains(document.activeElement)) return;
    const serverKey = draftKey(connectionItems(state.connections));
    if (serverKey === savedKey) return;
    draft = connectionItems(state.connections).map((item) => ({ ...item }));
    savedKey = serverKey;
    dirty = false;
    render();
  }

  return { node, refresh };
}

/** One row in the same shape the generated fields use: text left, control right. */
function settingsRow({ label, hint, text, control }) {
  return el('div', { class: 'field-row' }, [
    el('span', { class: 'field-text' }, [
      el('span', { class: 'field-label', text: label }),
      text ?? (hint ? el('span', { class: 'field-hint', text: hint }) : null),
    ]),
    control ?? null,
  ]);
}

/** Presets and a live preview of the instruction line that will be sent. */
function languageExtra() {
  const preview = el('div', { class: 'hint language-preview' });

  const preset = el(
    'select',
    {
      onchange: () => {
        const control = fields.get('outputLanguage')?.control;
        if (control && preset.value !== '') {
          control.value = preset.value;
          // Back to the placeholder, so the same preset can be applied again
          // after the field has been edited by hand.
          preset.value = '';
          refreshChanged();
          refresh();
        }
      },
    },
    [
      el('option', { value: '', text: t('settings.extras.language.choosePreset') }),
      ...LANGUAGE_PRESETS.map((value) => el('option', { value, text: value })),
    ],
  );

  const node = el('div', { class: 'settings-extra' }, [
    settingsRow({
      label: t('settings.extras.language.presetsLabel'),
      hint: t('settings.extras.language.presetsHint'),
      control: preset,
    }),
    preview,
  ]);

  function refresh() {
    const values = readFields(fields);
    const line = renderLanguageInstruction({
      outputLanguage: values.outputLanguage,
      languageInstruction: values.languageInstruction,
      defaultInstruction: state.languageInstructionTemplate,
    });
    clear(preview);
    if (line === '') {
      preview.append(el('span', { text: t('settings.extras.language.empty') }));
      return;
    }
    preview.append(el('span', { text: t('settings.extras.language.actual') }), el('code', { text: line }));
  }

  return { node, refresh };
}

/**
 * The migration heads-up for a config that predates `retrieval.mode`: its old
 * `vector.enabled` / `scan.modelSelect` flags are live-looking but dead. Shown on
 * the world page, and hidden whenever there is nothing to say.
 */
function retrievalNoticeExtra() {
  const node = el('p', { class: 'settings-extra migration-notice hint' });

  function refresh() {
    const notice = retrievalMigrationNotice(state.config);
    node.textContent = notice ?? '';
    node.classList.toggle('hidden', notice === null);
  }

  return { node, refresh };
}

/**
 * Vector storage: whether the endpoint answers, how far behind each book is, and
 * the buttons that fix both. The index is built by an explicit click, never as a
 * side effect of saving a book — it costs CPU or money.
 */
function vectorsExtra() {
  const status = el('span', { class: 'muted small' });
  const bookList = el('div', { class: 'vector-books' });
  const probeText = el('input', { type: 'text', placeholder: t('settings.extras.vectors.probePlaceholder') });
  const probeResult = el('div', { class: 'vector-probe muted small' });

  const testButton = el('button', {
    class: 'ghost',
    type: 'button',
    text: t('settings.extras.vectors.test'),
    title: t('settings.extras.vectors.testTitle'),
    onclick: guard(t('guard.testVectors'), async () => {
      status.className = 'muted small';
      status.textContent = t('settings.extras.vectors.testing');
      try {
        const result = await api('/api/vectors/test', json('POST', {}));
        status.className = result.ok ? 'small ok' : 'small bad';
        status.textContent = result.ok
          ? t('settings.extras.vectors.connected', { model: result.model, dims: result.dims, ms: result.ms })
          : t('settings.extras.vectors.unreachable', { error: result.error });
      } catch (error) {
        status.className = 'small bad';
        status.textContent = t('settings.extras.vectors.testFailed', { error: error.message });
      }
    }),
  });

  const rebuildButton = el('button', {
    class: 'ghost',
    type: 'button',
    text: t('settings.extras.vectors.rebuild'),
    title: t('settings.extras.vectors.rebuildTitle'),
    onclick: guard(t('guard.rebuildVectors'), async () => {
      status.className = 'muted small';
      status.textContent = t('settings.extras.vectors.rebuilding');
      try {
        const result = await api('/api/vectors/rebuild', json('POST', {}));
        const embedded = (result.books ?? []).reduce((sum, book) => sum + (book.embedded ?? 0), 0);
        const failed = (result.books ?? []).filter((book) => book.error);
        status.className = failed.length > 0 ? 'small bad' : 'small ok';
        status.textContent = failed.length > 0
          ? t('settings.extras.vectors.rebuildPartial', {
            count: embedded,
            books: failed.length,
            error: failed[0].error,
          })
          : t('settings.extras.vectors.rebuilt', { count: embedded });
        await loadVectors();
        refresh();
      } catch (error) {
        status.className = 'small bad';
        status.textContent = t('settings.extras.vectors.rebuildFailed', { error: error.message });
      }
    }),
  });

  const probeButton = el('button', {
    class: 'ghost',
    type: 'button',
    text: t('settings.extras.vectors.probe'),
    title: t('settings.extras.vectors.probeTitle'),
    onclick: guard(t('guard.probeVector'), async () => {
      const text = probeText.value.trim();
      if (text === '') return;
      clear(probeResult);
      probeResult.append(el('span', { text: t('settings.extras.vectors.querying') }));
      try {
        const result = await api('/api/vectors/query', json('POST', { text }));
        clear(probeResult);
        if (!result.ok) {
          probeResult.append(el('span', { class: 'bad', text: result.error }));
          return;
        }
        if (result.hits.length === 0) {
          probeResult.append(
            el('span', { text: t('settings.extras.vectors.noHits') }),
          );
          return;
        }
        for (const hit of result.hits.slice(0, 8)) {
          probeResult.append(
            el('div', { class: 'vector-hit' }, [
              el('span', { class: 'score', text: hit.score.toFixed(3) }),
              el('span', { text: `${hit.world} #${hit.uid} ${hit.comment}` }),
            ]),
          );
        }
      } catch (error) {
        clear(probeResult);
        probeResult.append(
          el('span', { class: 'bad', text: t('settings.extras.vectors.queryFailed', { error: error.message }) }),
        );
      }
    }),
  });

  const node = el('div', { class: 'settings-extra' }, [
    settingsRow({
      label: t('settings.extras.vectors.serviceLabel'),
      hint: t('settings.extras.vectors.serviceHint'),
      control: el('span', { class: 'connection-row' }, [testButton, status]),
    }),
    settingsRow({
      label: t('settings.extras.vectors.indexLabel'),
      hint: t('settings.extras.vectors.indexHint'),
      control: el('span', { class: 'connection-row' }, [rebuildButton]),
    }),
    bookList,
    settingsRow({
      label: t('settings.extras.vectors.probeLabel'),
      hint: t('settings.extras.vectors.probeHint'),
      control: el('span', { class: 'connection-row' }, [probeText, probeButton]),
    }),
    probeResult,
  ]);

  function refresh() {
    clear(bookList);
    const overview = state.vectors;
    if (!overview) {
      status.className = 'muted small';
      status.textContent = t('settings.extras.vectors.noStatus');
      return;
    }
    const { settings, books } = overview;
    // The mode, not the retired `vector.enabled` switch, decides whether a
    // search ever runs: say which one it is so "索引建了却不生效" is explained.
    const mode = hasRetrievalMode(state.config?.retrieval?.mode)
      ? state.config.retrieval.mode
      : 'keyword';
    if (mode !== 'vector') {
      status.className = 'muted small';
      status.textContent = t('settings.extras.vectors.modeKeyword', { mode: retrievalModeLabel(mode) });
    } else if (status.textContent === '' || status.textContent === t('settings.extras.vectors.noStatus')) {
      status.className = 'muted small';
      status.textContent = t('settings.extras.vectors.using', {
        mode: settings.mode === 'local'
          ? t('settings.extras.vectors.localMode')
          : t('settings.extras.vectors.remoteMode'),
        model: settings.model || t('settings.extras.vectors.noModel'),
      });
    }

    if (books.length === 0) {
      bookList.append(el('div', { class: 'muted small', text: t('settings.extras.vectors.noBooks') }));
      return;
    }
    for (const book of books) {
      const state_ = book.outdated
        ? t('settings.extras.vectors.needRebuild')
        : book.stale > 0
          ? t('settings.extras.vectors.stale', { count: book.stale })
          : book.indexed > 0
            ? t('settings.extras.vectors.upToDate')
            : t('settings.extras.vectors.noIndex');
      bookList.append(
        el('div', { class: 'vector-book' }, [
          el('span', { class: 'name', text: book.name }),
          el('span', {
            class: `muted small${book.stale > 0 || book.outdated ? ' bad' : ''}`,
            text: book.dims > 0
              ? t('settings.extras.vectors.bookDims', {
                indexed: book.indexed,
                marked: book.marked,
                state: state_,
                dims: book.dims,
              })
              : t('settings.extras.vectors.bookLine', {
                indexed: book.indexed,
                marked: book.marked,
                state: state_,
              }),
          }),
        ]),
      );
    }
  }

  return { node, refresh };
}

/**
 * Appearance: which palette this browser uses.
 *
 * A card per theme rather than a dropdown, because a theme is recognised by eye
 * before it is read. The list comes from `themes.js`, so a theme added there shows
 * up here with no change to this file.
 */
function appearanceExtra() {
  const cards = el('div', { class: 'theme-cards', role: 'radiogroup', 'aria-label': t('settings.extras.appearance.themeAria') });
  const swatchRow = accentSwatches({});
  const note = el('div', { class: 'hint' });

  const node = el('div', { class: 'settings-extra' }, [
    settingsRow({
      label: t('settings.extras.appearance.label'),
      hint: t('settings.extras.appearance.hint'),
      control: cards,
    }),
    settingsRow({
      label: t('settings.extras.appearance.accentLabel'),
      hint: t('settings.extras.appearance.accentHint'),
      control: swatchRow,
    }),
    note,
  ]);

  function render() {
    const current = readStoredTheme();
    clear(cards);
    for (const theme of THEMES) {
      const active = theme.id === current;
      cards.append(
        el(
          'button',
          {
            class: `theme-card${active ? ' active' : ''}`,
            type: 'button',
            role: 'radio',
            'aria-checked': active ? 'true' : 'false',
            title:
              theme.id === 'system'
                ? t('settings.extras.appearance.followsSystem', {
                  mode: t(resolvedTheme('system') === 'light'
                    ? 'settings.extras.appearance.light'
                    : 'settings.extras.appearance.dark'),
                })
                : t('settings.extras.appearance.themeName', { name: t(theme.labelKey) }),
            onclick: () => {
              applyTheme(theme.id);
              render();
            },
          },
          [
            el('span', { class: 'theme-card-icon' }, [icon(theme.icon, { size: 20 })]),
            el('span', { class: 'theme-card-label', text: t(theme.labelKey) }),
          ],
        ),
      );
    }

    const resolved = resolvedTheme(current);
    const mode = t(resolved === 'light'
      ? 'settings.extras.appearance.light'
      : 'settings.extras.appearance.dark');
    note.textContent =
      current === 'system'
        ? t('settings.extras.appearance.followingSystemNote', { mode })
        : t('settings.extras.appearance.fixedNote', { name: t(themeById(current).labelKey) });
  }

  return { node, refresh: render };
}

/**
 * Context template helpers: import a SillyTavern context preset, restore its
 * default, or export ours for the trip back. The template itself lives in the
 * textarea field above; these buttons only fill it or take it away.
 */
function contextTemplateExtra() {
  const note = el('span', { class: 'muted small' });
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const template = parseContextPreset(String(reader.result ?? ''));
        const control = fields.get('contextTemplate')?.control;
        if (control) {
          control.value = template;
          refreshChanged();
          refresh();
          toastOk(t('settings.extras.contextTemplate.imported'));
        }
      } catch (error) {
        toastError(t('settings.extras.contextTemplate.importFailed', { error: error.message }));
      }
      fileInput.value = '';
    };
    reader.readAsText(file);
  });

  const node = el('div', { class: 'settings-extra' }, [
    settingsRow({
      label: t('settings.extras.contextTemplate.presetLabel'),
      hint: t('settings.extras.contextTemplate.presetHint'),
      control: el('span', { class: 'connection-row' }, [
        el('button', {
          class: 'ghost',
          type: 'button',
          text: t('settings.extras.contextTemplate.import'),
          onclick: () => fileInput.click(),
        }),
        el('button', {
          class: 'ghost',
          type: 'button',
          text: t('settings.extras.contextTemplate.restore'),
          title: t('settings.extras.contextTemplate.restoreTitle'),
          onclick: () => {
            const control = fields.get('contextTemplate')?.control;
            if (!control) return;
            control.value = DEFAULT_STORY_TEMPLATE;
            refreshChanged();
            refresh();
          },
        }),
        el('button', {
          class: 'ghost',
          type: 'button',
          text: t('settings.extras.contextTemplate.export'),
          title: t('settings.extras.contextTemplate.exportTitle'),
          onclick: () => {
            const values = readFields(fields);
            downloadText(
              'context-preset.json',
              `${JSON.stringify(toContextPreset(values.contextTemplate), null, 2)}\n`,
              'application/json;charset=utf-8',
            );
            toastOk(t('settings.extras.contextTemplate.exported'));
          },
        }),
        fileInput,
      ]),
    }),
    settingsRow({ label: t('settings.extras.contextTemplate.statusLabel'), control: note }),
  ]);

  function refresh() {
    const values = readFields(fields);
    const template = String(values.contextTemplate ?? '');
    note.textContent = template.trim() === ''
      ? t('settings.extras.contextTemplate.empty')
      : t('settings.extras.contextTemplate.filled');
  }

  return { node, refresh };
}

/**
 * Persona library: several named "you"s with one default. The two plain
 * fields above stay the fallback for chats made before the library existed;
 * each row here can be applied to the current turn, edited, or removed.
 */
function personasExtra() {
  const list = el('div', { class: 'persona-list' });
  const note = el('span', { class: 'muted small' });

  const node = el('div', { class: 'settings-extra' }, [
    settingsRow({
      label: t('settings.extras.personas.label'),
      hint: t('settings.extras.personas.hint'),
      control: el('span', { class: 'connection-row' }, [
        el('button', {
          class: 'ghost',
          type: 'button',
          text: t('settings.extras.personas.add'),
          onclick: () => void editPreset({ id: newPersonaId(), name: '', description: '' }, true),
        }),
      ]),
    }),
    list,
    settingsRow({ label: t('settings.extras.personas.statusLabel'), control: note }),
  ]);

  function items() {
    return Array.isArray(state.personas?.items) ? state.personas.items : [];
  }

  function render() {
    clear(list);
    const activeId = state.personas?.activeId ?? '';
    for (const item of items()) {
      const isActive = item.id === activeId;
      list.append(
        el('div', { class: 'persona-row' }, [
          el('span', { class: 'persona-name', text: item.name }),
          isActive ? el('span', { class: 'pill', text: t('settings.extras.personas.activePill') }) : null,
          el('span', { class: 'spacer' }),
          el('button', {
            class: 'ghost tiny', type: 'button', text: t('common.apply'), title: t('settings.extras.personas.applyTitle'),
            disabled: isActive,
            onclick: () => guard(t('guard.applyPersona'), async () => {
              await savePersonas({ ...state.personas, activeId: item.id });
              refresh();
            })(),
          }),
          el('button', {
            class: 'ghost tiny', type: 'button', text: t('common.edit'),
            onclick: () => void editPreset(item, false),
          }),
          el('button', {
            class: 'ghost tiny danger', type: 'button', text: t('common.delete'),
            onclick: () => guard(t('guard.deletePersona'), async () => {
              await savePersonas({
                ...state.personas,
                activeId: activeId === item.id ? '' : activeId,
                items: items().filter((candidate) => candidate.id !== item.id),
              });
              refresh();
            })(),
          }),
        ]),
      );
    }
    if (items().length === 0) {
      list.append(el('div', { class: 'muted small', text: t('settings.extras.personas.empty') }));
    }
    note.textContent = t('settings.extras.personas.note', { count: items().length });
  }

  async function editPreset(preset, isNew) {
    const editor = createFieldRows(
      [
        { key: 'name', labelKey: 'settings.extras.personas.nameLabel', type: 'line', hintKey: 'settings.extras.personas.nameHint' },
        { key: 'description', labelKey: 'settings.extras.personas.descriptionLabel', type: 'text', rows: 5, hintKey: 'settings.extras.personas.descriptionHint' },
      ],
      { name: preset.name, description: preset.description },
      { hint: 'inline' },
    );
    const modal = createModal({ className: 'persona', title: isNew ? t('settings.extras.personas.newTitle') : t('settings.extras.personas.editTitle'), removeOnClose: true });
    modal.body.append(...editor.rows);
    modal.footer.append(
      el('button', { class: 'ghost', type: 'button', text: t('common.cancel'), onclick: () => modal.close() }),
      el('button', {
        class: 'primary', type: 'button', text: t('common.save'),
        onclick: () => guard(t('guard.savePersona'), async () => {
          const values = readFields(editor.fields);
          const name = String(values.name ?? '').trim();
          if (name === '') {
            toastError(t('settings.extras.personas.nameRequired'));
            return;
          }
          const next = isNew
            ? [...items(), { id: preset.id, name, description: String(values.description ?? '') }]
            : items().map((candidate) => candidate.id === preset.id
              ? { ...candidate, name, description: String(values.description ?? '') }
              : candidate);
          await savePersonas({ ...state.personas, items: next });
          modal.close();
          refresh();
          toastOk(t('settings.extras.personas.saved', { name }));
        })(),
      }),
    );
    modal.open();
  }

  on('personas', render);
  render();
  return { node, refresh: render };
}

/**
 * Fonts: which typeface (and size) the transcript reads in.
 *
 * Nothing is vendored: the named stacks apply when the machine has those
 * open-source families, and anything else comes from `data/fonts/` — dropped
 * there by hand or uploaded here. The choice lives in this browser (like the
 * theme), so it never touches `data/config.json`.
 */
function fontsExtra() {
  const list = el('div', { class: 'font-list', role: 'radiogroup', 'aria-label': t('settings.extras.fonts.aria') });
  const filesRow = el('div', { class: 'font-files' });
  const sizeInput = el('input', { type: 'number', min: '0', max: '28', step: '1', value: '0' });
  const fileInput = el('input', { type: 'file', accept: '.woff2,.woff,.ttf,.otf', hidden: true });
  let files = [];

  const node = el('div', { class: 'settings-extra' }, [
    settingsRow({
      label: t('settings.extras.fonts.label'),
      hint: t('settings.extras.fonts.hint'),
      control: list,
    }),
    settingsRow({
      label: t('settings.extras.fonts.sizeLabel'),
      hint: t('settings.extras.fonts.sizeHint'),
      control: sizeInput,
    }),
    settingsRow({
      label: t('settings.extras.fonts.uploadLabel'),
      hint: t('settings.extras.fonts.uploadHint'),
      control: el('span', { class: 'connection-row' }, [
        el('button', {
          class: 'ghost', type: 'button', text: t('settings.extras.fonts.uploadButton'),
          onclick: () => fileInput.click(),
        }),
        fileInput,
      ]),
    }),
    settingsRow({ label: t('settings.extras.fonts.uploadedLabel'), control: filesRow }),
  ]);

  function current() {
    return readStoredFont();
  }

  function choose(stack) {
    writeStoredFont({ ...current(), stack });
    applyFonts(files);
    render();
  }

  function render() {
    const stored = current();
    clear(list);
    for (const stack of FONT_STACKS) {
      const active = stored.stack === stack.id;
      list.append(
        el('button', {
          class: `font-card${active ? ' active' : ''}`,
          type: 'button',
          role: 'radio',
          'aria-checked': active ? 'true' : 'false',
          title: t(stack.noteKey),
          onclick: () => choose(stack.id),
        }, [
          el('span', { class: 'font-sample', text: t('settings.extras.fonts.sample'), style: `font-family: ${stack.family}` }),
          el('span', { class: 'font-label', text: `${t(stack.labelKey)} · ${t(stack.noteKey)}` }),
        ]),
      );
    }
    for (const file of files) {
      const key = `file:${file.name}`;
      const active = stored.stack === key;
      list.append(
        el('button', {
          class: `font-card${active ? ' active' : ''}`,
          type: 'button',
          role: 'radio',
          'aria-checked': active ? 'true' : 'false',
          title: `${(file.bytes / 1024 / 1024).toFixed(1)}MB · ${file.url}`,
          onclick: () => choose(key),
        }, [
          el('span', { class: 'font-sample', text: t('settings.extras.fonts.sample'), style: `font-family: "${file.family}", sans-serif` }),
          el('span', { class: 'font-label', text: t('settings.extras.fonts.uploadedFont', { name: file.name }) }),
        ]),
      );
    }
    // The settings dialog re-renders extras on every keystroke anywhere; never
    // wash the box the user is typing in — that is exactly what made the size
    // "not respond": each keystroke reset it before `change` could fire.
    if (document.activeElement !== sizeInput) sizeInput.value = String(stored.size ?? 0);

    clear(filesRow);
    if (files.length === 0) {
      filesRow.append(el('span', { class: 'muted small', text: t('settings.extras.fonts.none') }));
    }
    for (const file of files) {
      filesRow.append(
        el('span', { class: 'font-file' }, [
          el('span', { class: 'muted small', text: t('settings.extras.fonts.fileSize', { name: file.name, size: (file.bytes / 1024 / 1024).toFixed(1) }) }),
          el('button', {
            class: 'ghost tiny danger', type: 'button', text: t('common.delete'),
            onclick: () => guard(t('guard.deleteFont'), async () => {
              const result = await api(`/api/fonts/${encodeURIComponent(file.name)}`, { method: 'DELETE' });
              files = result.files ?? [];
              if (current().stack === `file:${file.name}`) choose('system');
              applyFonts(files);
              render();
            })(),
          }),
        ]),
      );
    }
  }

  sizeInput.addEventListener('change', () => {
    const size = Math.max(0, Math.min(28, Number(sizeInput.value) || 0));
    sizeInput.value = String(size);
    writeStoredFont({ ...current(), size });
    applyFonts(files);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    guard(t('guard.uploadFont'), async () => {
      const response = await fetch(`/api/fonts?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      files = body.files ?? [];
      applyFonts(files);
      render();
      toastOk(t('settings.extras.fonts.uploadedToast', { name: file.name }));
    })();
    fileInput.value = '';
  });

  async function load() {
    try {
      const result = await api('/api/fonts');
      files = result.files ?? [];
    } catch {
      files = [];
    }
    applyFonts(files);
    render();
  }
  void load();

  return { node, refresh: render };
}

/**
 * Speech: which system voice the local engine uses, and whether the online
 * endpoint answers. The voice list belongs to this browser, so it is read
 * live (and re-read when the browser finishes loading voices); picking one
 * fills the voice field exactly like a language preset does.
 */
function ttsExtra() {
  const picker = el('select', { class: 'voice-pick', title: t('settings.extras.tts.pickerTitle') });
  const status = el('span', { class: 'muted small' });
  const voiceNote = el('div', { class: 'hint tts-voice-note' });

  const node = el('div', { class: 'settings-extra' }, [
    settingsRow({
      label: t('settings.extras.tts.voiceLabel'),
      hint: t('settings.extras.tts.voiceHint'),
      control: picker,
    }),
    voiceNote,
    settingsRow({
      label: t('settings.extras.tts.previewLabel'),
      hint: t('settings.extras.tts.previewHint'),
      control: el('span', { class: 'connection-row' }, [
        el('button', {
          class: 'ghost',
          type: 'button',
          text: t('settings.extras.tts.localPreview'),
          onclick: () => guard(t('guard.localPreview'), async () => {
            status.textContent = '';
            await speakSample('local');
            status.textContent = t('settings.extras.tts.localOk');
          })(),
        }),
        el('button', {
          class: 'ghost',
          type: 'button',
          text: t('settings.extras.tts.onlinePreview'),
          onclick: () => guard(t('guard.onlinePreview'), async () => {
            status.textContent = t('settings.extras.tts.requesting');
            await speakSample('online');
            status.textContent = t('settings.extras.tts.onlineOk');
          })(),
        }),
        status,
      ]),
    }),
  ]);

  function voices() {
    try {
      return typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices();
    } catch {
      return [];
    }
  }

  // The browser fires `voiceschanged` every time more voices arrive, which
  // for a hundred online voices is several times per session. Rebuilding the
  // options on each firing destroys a dropdown the user just opened (the
  // option they clicked no longer exists, so the pick is lost and the select
  // falls back to the default) — so an unchanged list only re-syncs the
  // selected value, and a *changed* list waits until the control is closed.
  let builtKey = null;
  let pendingRebuild = false;

  function listKey(list) {
    return list.map((voice) => `${voiceKey(voice)}\n${voice.lang ?? ''}`).join('\n');
  }

  function syncSelection(currentValue) {
    const options = [...picker.querySelectorAll('option')];
    if (options.some((option) => option.value === currentValue)) picker.value = currentValue;
  }

  /** Says which voice the stored value landed on — or that it is not here. */
  function writeNote(currentValue, list) {
    clear(voiceNote);
    const stored = String(currentValue ?? '');
    if (stored === '') {
      voiceNote.append(el('span', { text: t('settings.extras.tts.browserDefaultNote') }));
      return;
    }
    const match = list.find((voice) => matchesVoice(voice, stored));
    voiceNote.append(el('span', {
      text: match === undefined
        ? t('settings.extras.tts.storedMissing', { value: stored })
        : t('settings.extras.tts.current', { name: match.name ?? stored }),
    }));
  }

  function render() {
    const current = fields.get('ttsVoice')?.control;
    const currentValue = current ? current.value : '';
    const list = voices();
    const key = listKey(list);
    if (builtKey === key && picker.querySelectorAll('option').length === list.length + 1) {
      syncSelection(currentValue);
      writeNote(currentValue, list);
      return;
    }
    if (document.activeElement === picker) {
      // Never rebuild under an open dropdown: the click would land on an option
      // that no longer exists, and the choice would be silently dropped.
      pendingRebuild = true;
      return;
    }
    builtKey = key;
    clear(picker);
    picker.append(el('option', { value: '', text: t('settings.extras.tts.browserDefault') }));
    for (const voice of list) {
      // System voice names are long ("Microsoft … Desktop - Chinese …");
      // the row keeps the label readable by capping the select width, so the
      // option shows the name and the language lives in the tooltip.
      picker.append(el('option', {
        value: voiceKey(voice),
        text: voice.name,
        title: `${voice.name}（${voice.lang}）`,
      }));
    }
    syncSelection(currentValue);
    writeNote(currentValue, list);
  }

  picker.addEventListener('change', () => {
    const control = fields.get('ttsVoice')?.control;
    if (control) {
      control.value = picker.value;
      refreshChanged();
      render();
    }
  });
  picker.addEventListener('blur', () => {
    if (!pendingRebuild) return;
    pendingRebuild = false;
    render();
  });
  try {
    if (typeof speechSynthesis !== 'undefined' && speechSynthesis.onvoiceschanged !== undefined) {
      speechSynthesis.onvoiceschanged = () => render();
    }
  } catch {
    /* some browsers throw on assignment; the list is still read once below */
  }
  render();

  return { node, refresh: render };
}

const EXTRA_BUILDERS = {
  counting: countingExtra,
  language: languageExtra,
  appearance: appearanceExtra,
  provider: providerExtra,
  connections: connectionsExtra,
  retrievalNotice: retrievalNoticeExtra,
  vectors: vectorsExtra,
  contextTemplate: contextTemplateExtra,
  personas: personasExtra,
  fonts: fontsExtra,
  tts: ttsExtra,
};

// ---------------------------------------------------------------------------
// Component construction
// ---------------------------------------------------------------------------

function build() {
  const nav = el('nav', {
    class: 'settings-nav',
    role: 'tablist',
    'aria-orientation': 'vertical',
    'aria-label': t('settings.navAria'),
  });
  const panes = el('div', { class: 'settings-panes' });
  const status = el('span', {
    class: 'muted small settings-status',
    role: 'status',
    'aria-live': 'polite',
  });

  const modal = createModal({ title: t('settings.title'), className: 'settings' });
  modal.body.append(el('div', { class: 'settings-layout' }, [nav, panes]));

  const saveButton = el('button', {
    class: 'primary',
    type: 'button',
    text: t('common.save'),
    onclick: guard(t('guard.saveSettings'), () => save()),
  });
  const closeButton = el('button', {
    class: 'ghost',
    type: 'button',
    text: t('common.close'),
    onclick: () => modal.close(),
  });
  modal.footer.append(status, closeButton, saveButton);

  const tabs = new Map();
  const panesById = new Map();

  for (const page of SETTINGS_PAGES) {
    const tab = el(
      'button',
      {
        class: 'settings-nav-item',
        type: 'button',
        role: 'tab',
        id: `settings-tab-${page.id}`,
        'aria-controls': `settings-pane-${page.id}`,
        'aria-selected': 'false',
        tabindex: '-1',
        onclick: () => selectPage(page.id),
        onkeydown: (event) => onNavKey(event, page.id),
      },
      [
        icon(page.icon, { className: 'settings-nav-icon' }),
        el('span', { class: 'settings-nav-label', text: t(page.labelKey) }),
        el('span', { class: 'settings-nav-dot hidden', title: t('settings.unsaved') }),
      ],
    );
    const section = el('section', {
      class: 'settings-pane',
      role: 'tabpanel',
      id: `settings-pane-${page.id}`,
      'aria-labelledby': `settings-tab-${page.id}`,
      tabindex: '0',
      hidden: true,
    });
    tabs.set(page.id, tab);
    panesById.set(page.id, section);
    nav.append(tab);
    panes.append(section);
  }

  // Edits anywhere refresh the "changed" dots, the language preview and any
  // validation mark that no longer applies.
  panes.addEventListener('input', onFieldEdited);
  panes.addEventListener('change', onFieldEdited);

  ui = { modal, nav, panes, tabs, panesById, status, saveButton, closeButton, live: {} };
  refreshShell();
  return ui;
}

/**
 * Re-translates the parts that are built once and reused: the dialog title, the
 * footer buttons, the category names and the unsaved marks. Called at build time
 * and again on every language change.
 */
function refreshShell() {
  if (!ui) return;
  ui.modal.setTitle(t('settings.title'));
  ui.saveButton.textContent = t('common.save');
  ui.closeButton.textContent = t('common.close');
  ui.nav.setAttribute('aria-label', t('settings.navAria'));
  for (const page of SETTINGS_PAGES) {
    const tab = ui.tabs.get(page.id);
    tab.querySelector('.settings-nav-label').textContent = t(page.labelKey);
    tab.querySelector('.settings-nav-dot').title = t('settings.unsaved');
  }
}

function setStatus(text, isError = false) {
  if (!ui) return;
  ui.status.textContent = text;
  ui.status.className = `small settings-status ${isError ? 'bad' : 'muted'}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Rebuilds every pane from the current config. */
function renderPanes() {
  if (!ui) return;
  const values = valuesFromConfig(state.config);
  fields = new Map();
  ui.live = {};

  for (const page of SETTINGS_PAGES) {
    const section = ui.panesById.get(page.id);
    clear(section);

    const built = createFieldRows(page.fields, values, { hint: 'inline' });
    for (const [key, field] of built.fields) fields.set(key, field);

    section.append(el('p', { class: 'settings-pane-hint muted small', text: t(page.hintKey) }));

    // A page may carry more than one block that is not a plain field (the general
    // page has both the reply-language preview and the theme picker), so `extras`
    // is read as a list. An extra that returns `beforeFields` belongs *above* the
    // fields — the provider preset fills the page's first field, so it is useless
    // at the bottom where the normal extras live.
    const extras = [];
    for (const name of page.extras ?? []) {
      const builder = EXTRA_BUILDERS[name];
      if (!builder) continue;
      const extra = builder();
      extras.push(extra);
      ui.live[name] = extra.refresh;
    }
    for (const extra of extras) {
      if (extra.beforeFields) section.append(extra.node);
    }

    // Rows are grouped: a run of related rows gets a small heading, which is
    // what keeps a twelve-row page (the world book scan) readable. `rows` comes
    // back in spec order, so the two lists stay in step.
    const rows = [];
    let group = null;
    page.fields.forEach((spec, index) => {
      if (spec.groupKey && spec.groupKey !== group) {
        group = spec.groupKey;
        rows.push(el('h4', { class: 'field-group', text: t(`settings.groups.${group}`) }));
      }
      if (built.rows[index]) rows.push(built.rows[index]);
    });
    section.append(el('div', { class: 'field-rows' }, rows));

    for (const extra of extras) {
      if (!extra.beforeFields) section.append(extra.node);
    }
  }

  refreshChanged();
  refreshDynamic();
}

/** Lets the "extra" blocks follow state that changes elsewhere. */
function refreshDynamic() {
  if (!ui) return;
  for (const refresh of Object.values(ui.live)) refresh?.();
}

/** The dot on a category that holds unsaved edits. */
function refreshChanged() {
  if (!ui) return new Set();
  const changed = new Set(changedFields(readFields(fields), state.config));
  for (const page of SETTINGS_PAGES) {
    const touched = page.fields.some((field) => changed.has(field.key));
    ui.tabs.get(page.id).querySelector('.settings-nav-dot').classList.toggle('hidden', !touched);
  }
  return changed;
}

function onFieldEdited(event) {
  const row = event.target.closest?.('.field-row');
  if (row) {
    row.classList.remove('invalid');
    const next = row.nextElementSibling;
    if (next?.classList.contains('field-problem')) next.remove();
  }
  refreshChanged();
  refreshDynamic();
}

function selectPage(id) {
  if (!ui) return;
  activePageId = id;
  for (const [pageId, tab] of ui.tabs) {
    const selected = pageId === id;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    ui.panesById.get(pageId).hidden = !selected;
  }
}

/** Arrow keys walk the category list, the way a tab list is expected to. */
function onNavKey(event, id) {
  const index = SETTINGS_PAGES.findIndex((page) => page.id === id);
  const last = SETTINGS_PAGES.length - 1;
  let target = null;

  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') target = index === last ? 0 : index + 1;
  else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') target = index === 0 ? last : index - 1;
  else if (event.key === 'Home') target = 0;
  else if (event.key === 'End') target = last;
  else return;

  event.preventDefault();
  const next = SETTINGS_PAGES[target].id;
  selectPage(next);
  ui.tabs.get(next).focus();
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

function labelOf(key) {
  for (const page of SETTINGS_PAGES) {
    const field = page.fields.find((item) => item.key === key);
    if (field) return t(field.labelKey);
  }
  return key;
}

/** Marks the offending fields and jumps to the first page that has one. */
function showProblems(problems) {
  for (const problem of problems) {
    const field = fields.get(problem.key);
    if (!field) continue;
    // A second failed save must not stack a second message under the same row.
    const next = field.node.nextElementSibling;
    if (next?.classList.contains('field-problem')) next.remove();
    field.node.classList.add('invalid');
    field.node.after(el('div', { class: 'field-problem small', text: problem.message }));
  }

  const first = problems[0];
  selectPage(first.pageId ?? SETTINGS_PAGES[0].id);
  const field = fields.get(first.key);
  field?.node.scrollIntoView({ block: 'center' });
  field?.control?.focus();
  setStatus(
    problems
      .map((item) => t('settings.status.problemLine', { label: labelOf(item.key), message: item.message }))
      .join(t('settings.status.problemSeparator')),
    true,
  );
}

async function save() {
  const values = readFields(fields);
  if (!state.config) {
    setStatus(t('settings.status.notLoaded'), true);
    return;
  }
  const problems = validateValues(values);
  if (problems.length > 0) {
    showProblems(problems);
    return;
  }

  const changed = changedFields(values, state.config);
  if (changed.length === 0) {
    setStatus(t('settings.status.noChanges'));
    return;
  }

  ui.saveButton.disabled = true;
  setStatus(t('settings.status.saving'));
  try {
    await api('/api/config', json('PUT', buildPatch(values)));
    // The config event re-renders the panes from what the server stored, so a
    // masked field and any value the server normalised are shown as they are.
    await loadConfig();
    // A changed endpoint or key invalidates the fetched model list; refresh it.
    if (state.config?.apiKey) loadModels();
    setStatus(t('settings.status.saved', { count: changed.length }));
    toastOk(t('settings.status.savedToast'));
  } catch (error) {
    setStatus(t('settings.status.saveFailed', { error: error.message }), true);
    toastError(t('settings.status.saveFailedToast'), { detail: error.message });
  } finally {
    ui.saveButton.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function open() {
  if (ui === null) build();
  renderPanes();
  selectPage(activePageId);
  setStatus('');
  ui.modal.open();
}

export async function initSettingsView() {
  document.getElementById('btn-settings').addEventListener('click', guard(t('guard.openSettings'), () => open()));
  // The brand menu opens the same dialog without knowing it exists.
  on('open-settings', () => guard(t('guard.openSettings'), () => open())());

  // A language switch retranslates the reusable shell and every pane while the
  // dialog is open; the docked button and menu entries are retranslated by app.js.
  onLocaleChange(() => {
    refreshShell();
    if (ui?.modal.isOpen) renderPanes();
  });

  // The token counter's numbers and the budget both come from the last preview,
  // so they are refreshed whenever it changes. The language preview needs the
  // stack, which carries the server's default wording.
  //
  // The config itself only changes on load and on save, and the panes are built
  // from it: opening the dialog before the first load has landed would otherwise
  // leave every field blank, and saving that blank form would erase the config.
  on('config', () => {
    if (!ui?.modal.isOpen) return;
    renderPanes();
  });
  on('preview', () => ui?.modal.isOpen && refreshDynamic());
  on('connection', () => ui?.modal.isOpen && refreshDynamic());
  on('models', () => ui?.modal.isOpen && refreshDynamic());
  on('stack', () => ui?.modal.isOpen && refreshDynamic());
}
