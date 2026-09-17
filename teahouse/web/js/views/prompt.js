/**
 * Right panel: context budget, prompt stack in collapsible groups, world book
 * hits, and the assembled request.
 *
 * The stack is a real override: toggling a block sends the modified stack to the
 * server for both preview and generation. Which groups are collapsed is a local
 * preference; both live in localStorage under one key.
 */

import { api, json, on, emit, refreshPreview, refreshScan, state } from '../api.js';
import { emptyState } from '../components/empty-state.js';
import { hitCard } from '../components/hit-card.js';
import { previewItem } from '../components/preview-item.js';
import { groupStack, stackGroup } from '../components/stack-group.js';
import { tokenBar } from '../components/token-bar.js';
import { toastError, toastOk } from '../components/toast.js';
import { copyText, downloadJson } from '../clipboard.js';
import { clear, el } from '../dom.js';
import { guard } from '../errors.js';
import { explainNoHits } from '../hits.js';
import { attributeTokens } from '../preview-tokens.js';
import { effectiveGroupMode, groupModeLabel, groupModeLabels, hasRetrievalMode, retrievalModeLabel, retrievalModeLabels } from '../settings-schema.js';
import { budgetFromPreview, formatTokens } from '../token-budget.js';
import { noticeText, onLocaleChange, t } from '../i18n.js';

const STORAGE_KEY = 'teahouse.stack.v1';

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStored() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      blocks: state.stack.map((block) => ({
        identifier: block.identifier,
        enabled: block.enabled,
        content: block.content,
        injection_position: block.injection_position,
        injection_depth: block.injection_depth,
      })),
      collapsed: state.ui.stackCollapsed,
    }));
  } catch {
    /* storage may be unavailable; the stack still works for this session */
  }
}

/** Applies saved overrides onto the freshly fetched default stack. */
function applyStored(blocks) {
  const saved = loadStored().blocks;
  if (!Array.isArray(saved)) return blocks;
  const byId = new Map(saved.map((item) => [item.identifier, item]));
  return blocks.map((block) => {
    const override = byId.get(block.identifier);
    if (!override) return block;
    // The story block carries the template source, which the server re-renders
    // on every assembly: a stored copy would show a stale template after the
    // setting changed, so only its switch survives a reload.
    const content = block.identifier === 'story' || typeof override.content !== 'string'
      ? block.content
      : override.content;
    return {
      ...block,
      enabled: override.enabled ?? block.enabled,
      content,
      injection_position: override.injection_position ?? block.injection_position,
      injection_depth: override.injection_depth ?? block.injection_depth,
    };
  });
}

function hydrateLocalPreferences() {
  state.stack = applyStored(state.stack);
  state.ui.stackCollapsed = loadStored().collapsed ?? {};
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

function renderBudget() {
  const holder = document.getElementById('token-budget');
  clear(holder);
  if (!state.chatId) return;

  const budget = budgetFromPreview(state.config ?? {}, state.preview ?? {});
  holder.append(
    tokenBar(budget, {
      onShowTrimmed: () =>
        document.getElementById('messages')?.scrollTo({ top: 0, behavior: 'smooth' }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

function renderStack() {
  const list = document.getElementById('prompt-stack');
  clear(list);

  if (state.stack.length === 0) {
    list.append(emptyState({ title: t('prompt.stackEmptyTitle'), hint: t('prompt.stackEmptyHint') }));
    return;
  }

  for (const group of groupStack(state.stack, state.preview?.itemization)) {
    list.append(
      stackGroup(group, {
        collapsed: state.ui.stackCollapsed[group.id] === true,
        itemization: state.preview?.itemization,
        onToggleBlock: (identifier) => {
          const block = state.stack.find((item) => item.identifier === identifier);
          if (!block) return;
          block.enabled = !block.enabled;
          saveStored();
          renderStack();
          refreshPreview().catch((error) => toastError(error.message));
        },
        onToggleGroup: (id, collapsed) => {
          state.ui.stackCollapsed[id] = collapsed;
          saveStored();
        },
      }),
    );
  }

  const skipped = (state.preview?.itemization ?? []).filter((item) => item.skippedReason);
  if (skipped.length > 0) {
    list.append(
      el('div', {
        class: 'stack-footnote muted small',
        text: t('prompt.stackSkipped', { count: skipped.length }),
      }),
    );
  }

  // The memory block is a real row in the stack above; this is the way in to read
  // or rewrite it, next to the evidence of what it costs.
  if (String(state.meta?.memory?.text ?? '').trim() !== '') {
    list.append(
      el('button', {
        class: 'ghost tiny stack-footnote',
        text: t('prompt.editMemory'),
        onclick: () => emit('open-memory-editor', {}),
      }),
    );
  }
  list.append(
    el('button', {
      class: 'ghost tiny stack-footnote',
      text: t('prompt.regex'),
      title: t('prompt.regexTitle'),
      onclick: () => emit('open-regex-editor', {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// Sampler
// ---------------------------------------------------------------------------

/**
 * Per-chat sampler knobs,Ranges mirror the server (`chats.ts`) and the
 * settings defaults: the panel writes the snapshot, never the defaults.
 */
const PARAM_ROWS = [
  { key: 'temperature', labelKey: 'prompt.paramTemperature', min: 0, max: 2, step: 0.1 },
  { key: 'frequencyPenalty', labelKey: 'prompt.paramFrequencyPenalty', min: -2, max: 2, step: 0.1 },
  { key: 'presencePenalty', labelKey: 'prompt.paramPresencePenalty', min: -2, max: 2, step: 0.1 },
  { key: 'topP', labelKey: 'prompt.paramTopP', min: 0.05, max: 1, step: 0.05 },
];

const PARAM_DEFAULTS = { temperature: 1, topP: 1, frequencyPenalty: 0, presencePenalty: 0 };

/** This conversation's effective value: its own pin, else the live default. */
function effectiveParam(key) {
  const own = state.meta?.params?.[key];
  if (typeof own === 'number' && Number.isFinite(own)) return own;
  const fallback = state.config?.[key];
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
  return PARAM_DEFAULTS[key];
}

async function saveParam(key, value) {
  if (!state.chatId) return;
  try {
    const updated = await api(
      `/api/chats/${encodeURIComponent(state.chatId)}`,
      json('PUT', { params: { [key]: value } }),
    );
    // A stale server (not restarted after the endpoint learned `params`)
    // would answer 200 without changing anything; fail loudly instead.
    if (updated?.params?.[key] !== value) {
      throw new Error(t('app.staleServer'));
    }
    state.meta = updated;
    renderParams();
  } catch (error) {
    toastError(t('prompt.paramSaveFailed', { error: error.message }));
    renderParams();
  }
}

async function resetParams() {
  if (!state.chatId) return;
  try {
    const updated = await api(
      `/api/chats/${encodeURIComponent(state.chatId)}`,
      json('PUT', { params: null }),
    );
    if (updated?.params) {
      throw new Error(t('app.staleServer'));
    }
    state.meta = updated;
    renderParams();
    toastOk(t('prompt.paramsResetToast'));
  } catch (error) {
    toastError(t('prompt.paramSaveFailed', { error: error.message }));
  }
}

function renderParams() {
  const holder = document.getElementById('chat-params');
  clear(holder);
  if (!state.meta) {
    holder.append(emptyState({ title: t('prompt.stackEmptyTitle') }));
    return;
  }
  const following = !state.meta.params;
  for (const row of PARAM_ROWS) {
    const label = t(row.labelKey);
    const value = effectiveParam(row.key);
    const slider = el('input', {
      type: 'range', min: String(row.min), max: String(row.max), step: String(row.step),
      value: String(value), 'aria-label': label,
      oninput: () => {
        number.value = slider.value;
      },
      onchange: () => saveParam(row.key, Number(slider.value)),
    });
    const number = el('input', {
      type: 'number', min: String(row.min), max: String(row.max), step: String(row.step),
      value: String(value), 'aria-label': t('prompt.numberAria', { label }),
      onchange: () => {
        const next = Number(number.value);
        if (!Number.isFinite(next) || next < row.min || next > row.max) {
          toastError(t('prompt.rangeError', { label, min: row.min, max: row.max }));
          number.value = String(effectiveParam(row.key));
          return;
        }
        slider.value = number.value;
        saveParam(row.key, next);
      },
    });
    holder.append(
      el('div', { class: 'params-row' }, [
        el('span', { class: 'params-label', text: label }),
        slider,
        number,
      ]),
    );
  }
  holder.append(
    el('div', { class: 'params-foot muted small' }, [
      el('span', { text: following ? t('prompt.paramsFollow') : t('prompt.paramsOverride') }),
      following
        ? null
        : el('button', { class: 'ghost tiny', type: 'button', text: t('prompt.paramsReset'), onclick: resetParams }),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Hits
// ---------------------------------------------------------------------------

async function rescan() {
  const pending = document.getElementById('input').value.trim();
  const value = pending === '' ? undefined : pending;
  await refreshScan(value);
  await refreshPreview(value);
}

/**
 * Which extra entries this chat injects, on top of the keyword scan. Empty means
 * "follow the configured default"; the pin is per conversation, like the model
 * and the persona.
 */
function retrievalModeControl() {
  const fallback = hasRetrievalMode(state.config?.retrieval?.mode) ? state.config.retrieval.mode : 'keyword';
  const pinned = hasRetrievalMode(state.meta?.retrievalMode) ? state.meta.retrievalMode : '';
  const select = el('select', {
    class: 'mode-select',
    title: t('prompt.modeTitle'),
    onchange: () => {
      const value = select.value;
      api(`/api/chats/${encodeURIComponent(state.chatId)}`, json('PUT', { retrievalMode: value === '' ? null : value }))
        .then(async (updated) => {
          state.meta = updated;
          toastOk(value === ''
            ? t('prompt.modeFollowDefault', { mode: retrievalModeLabel(fallback) })
            : t('prompt.modeThisChat', { mode: retrievalModeLabel(value) }));
          await refreshPreview();
          renderHits();
        })
        .catch((error) => toastError(error.message));
    },
  });
  select.append(el('option', { value: '', text: t('prompt.modeFollowDefault', { mode: retrievalModeLabel(fallback) }) }));
  for (const [value, label] of Object.entries(retrievalModeLabels())) {
    select.append(el('option', { value, text: label }));
  }
  select.value = pinned;
  return el('div', { class: 'hits-mode' }, [
    el('span', { class: 'muted small', text: t('prompt.modeLabel') }),
    select,
  ]);
}

/**
 * Who takes the turn in a group conversation (`A · 依次回复` … `E · 手动`).
 *
 * Only rendered for a lineup of two or more, because that is what a group is.
 * There is no "follow the default" row: `round` *is* the default, so picking
 * it stores nothing and the two behave identically.
 */
function groupModeControl() {
  const pinned = effectiveGroupMode(state.meta?.groupMode);
  const select = el('select', {
    class: 'mode-select',
    title: t('prompt.groupModeTitle'),
    onchange: () => {
      const value = select.value;
      api(`/api/chats/${encodeURIComponent(state.chatId)}`, json('PUT', { groupMode: value }))
        .then(async (updated) => {
          state.meta = updated;
          toastOk(t('prompt.groupModeSet', { mode: groupModeLabels()[value] ?? groupModeLabel(value) }));
          await refreshPreview();
          renderHits();
        })
        .catch((error) => toastError(error.message));
    },
  });
  for (const [value, label] of Object.entries(groupModeLabels())) {
    select.append(el('option', { value, text: label }));
  }
  select.value = pinned;
  return el('div', { class: 'hits-mode' }, [
    el('span', { class: 'muted small', text: t('prompt.groupModeLabel') }),
    select,
  ]);
}

/** Whether this conversation is a group (two or more members). */
function isGroupChat() {
  return Array.isArray(state.meta?.members) && state.meta.members.length >= 2;
}

function renderHits() {
  const container = document.getElementById('world-hits');
  clear(container);

  if (!state.chatId) {
    container.append(emptyState({ title: t('prompt.stackEmptyTitle') }));
    return;
  }

  container.append(retrievalModeControl());
  if (isGroupChat()) container.append(groupModeControl());
  const hits = state.ui.hits?.all ?? [];
  if (hits.length === 0) {
    container.append(
      emptyState({
        title: t('prompt.hitsEmptyTitle'),
        hint: explainNoHits(state.scan),
        action: {
          label: t('prompt.hitsRescan'),
          onClick: () => rescan().catch((error) => toastError(error.message)),
        },
      }),
    );
    return;
  }

  const total = hits.reduce((sum, hit) => sum + (hit.tokens ?? 0), 0);
  container.append(
    el('div', { class: 'hits-summary muted small', text: t('prompt.hitsSummary', { count: hits.length, tokens: formatTokens(total) }) }),
  );
  for (const hit of hits) container.append(hitCard(hit));
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function renderPreview() {
  const container = document.getElementById('preview');
  clear(container);

  const preview = state.preview;
  if (!preview) {
    container.append(
      emptyState({ title: t('prompt.previewEmptyTitle'), hint: t('prompt.previewEmptyHint') }),
    );
    return;
  }
  if (preview.error) {
    container.append(el('div', { class: 'error', text: preview.error }));
    return;
  }

  // A preview can be partial. The `prompt` frame the stream sends before the
  // first delta carries the itemization and the token count but no `messages`
  // yet — and on a freshly loaded page there is no earlier preview to merge it
  // with, so reading `.length` off `preview.messages` threw, the panel never
  // rendered, and the transcript kept the error until the page was reloaded.
  const messages = preview.messages ?? [];
  const budget = budgetFromPreview(state.config ?? {}, preview);
  const imageNote = Array.isArray(preview.images) && preview.images.length > 0
    ? t('prompt.previewImages', {
      count: preview.images.length,
      tokens: formatTokens(preview.imageTokens ?? preview.images.length * 1024),
    })
    : '';
  container.append(
    el('div', { class: 'preview-header' }, [
      el('span', {
        class: 'muted small',
        text: messages.length > 0
          ? t('prompt.previewMessages', { count: messages.length, tokens: formatTokens(preview.totalTokens), images: imageNote })
          : t('prompt.previewStreaming', { tokens: formatTokens(preview.totalTokens), images: imageNote }),
      }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'ghost tiny',
        text: t('prompt.previewExport'),
        title: t('prompt.previewExportTitle'),
        onclick: () => {
          downloadJson(`request-${Date.now()}.json`, {
            model: state.config?.model ?? null,
            counting: budget.counting.text,
            totalTokens: preview.totalTokens,
            maxContext: preview.maxContext,
            messages,
            itemization: preview.itemization,
          });
          toastOk(t('prompt.previewExported'));
        },
      }),
    ]),
  );

  for (const warning of preview.warnings ?? []) {
    container.append(el('div', { class: 'warn small', text: noticeText(warning) }));
  }

  // Text-completion mode sends one flat prompt, not the message list above:
  // show exactly that, so the panel never claims a shape that is not sent.
  if (preview.completion && typeof preview.completion.prompt === 'string') {
    const full = el('pre', { class: 'completion-text', text: preview.completion.prompt });
    container.append(
      el('details', { class: 'preview-completion', open: false }, [
        el('summary', {
          text: t('prompt.completionSummary', { tokens: formatTokens(preview.completion.totalTokens ?? 0) }),
        }),
        full,
      ]),
    );
  }

  const rowTokens = attributeTokens(preview);

  messages.forEach((message, index) => {
    container.append(
      previewItem({
        index,
        message,
        tokens: rowTokens[index] ?? 0,
        expanded: state.ui.previewExpanded.has(index),
        onToggle: (target) => {
          if (state.ui.previewExpanded.has(target)) state.ui.previewExpanded.delete(target);
          else state.ui.previewExpanded.add(target);
          renderPreview();
        },
        onCopy: async (target) => {
          const ok = await copyText(messages[target].content);
          if (ok) toastOk(t('prompt.copied', { index: target }));
          else toastError(t('prompt.copyFailed'));
        },
      }),
    );
  });
}

// ---------------------------------------------------------------------------

export async function initPromptView() {
  document.getElementById('btn-preview').addEventListener('click', guard(t('prompt.guardPreview'), () => rescan()));

  on('stack', () => {
    hydrateLocalPreferences();
    renderStack();
  });
  on('config', () => {
    renderBudget();
    renderPreview();
    renderParams();
  });
  hydrateLocalPreferences();

  // `chat` only moves the sampler snapshot. The stack, hits, budget and preview
  // all read what `loadChat` refreshes immediately after (the preview), so
  // rendering them on `chat` was a second full rebuild of the same rows on every
  // chat switch.
  on('chat', () => {
    renderParams();
  });
  on('preview', () => {
    renderStack();
    renderHits();
    renderBudget();
    renderPreview();
  });
  on('scan', renderHits);

  // The panel is rebuilt from state on every change; a language switch is just
  // one more reason to rebuild the rows that carry text.
  onLocaleChange(() => {
    renderStack();
    renderHits();
    renderParams();
    renderBudget();
    renderPreview();
  });

  if (state.stack.length > 0) renderStack();
}
