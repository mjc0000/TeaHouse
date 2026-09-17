/**
 * Trajectory: what the program actually did, turn by turn.
 *
 * The right column has two modes and this is the second one. It is read-only —
 * the transcript is the record of the conversation, this is the record of the
 * requests — so nothing here can change what the model sees. The events come from
 * `/api/chats/:id/trace`; the messages come from the transcript the app already
 * holds, so a message that predates the trace still gets a row.
 *
 * Layout: a summary line, a per-turn token chart, a filter row, then the timeline
 * with the detail beside it. The list and the detail wrap onto two rows when the
 * column is narrow, which is why they are a wrapping flex row rather than a grid.
 */

import { api, on, state } from '../api.js';
import { emptyState } from '../components/empty-state.js';
import { toastError, toastOk } from '../components/toast.js';
import { copyText, downloadJson } from '../clipboard.js';
import { clear, el } from '../dom.js';
import { onLocaleChange, t } from '../i18n.js';
import { formatTokens } from '../token-budget.js';

const FILTERS = [
  { id: 'all', labelKey: 'trace.filterAll' },
  { id: 'turn', labelKey: 'trace.filterTurn' },
  { id: 'world', labelKey: 'trace.filterWorld' },
  { id: 'memory', labelKey: 'trace.filterMemory' },
  { id: 'edit', labelKey: 'trace.filterEdit' },
];

const NOTE_ICONS = {
  memory: '🧠',
  edit: '✎',
  delete: '🗑',
  truncate: '⤺',
  fork: '⑂',
  import: '⭳',
  swipe: '⇄',
  turn: '▸',
};

const ROLE_KEYS = { user: 'trace.roleUser', assistant: 'trace.roleAssistant', system: 'trace.roleSystem' };

function roleLabel(role) {
  return ROLE_KEYS[role] ? t(ROLE_KEYS[role]) : role;
}

let events = [];
let stats = null;
let loadedFor = null;
let busy = false;
let filter = 'all';
let selectedId = null;
/** 'overview' | 'preview' | 'raw' */
let detailTab = 'overview';

function traceNode() {
  return document.getElementById('trace');
}

function visible() {
  return document.querySelector('.layout')?.classList.contains('trace-mode') === true;
}

/** Refreshes the timeline when it is on screen and belongs to another chat. */
function syncToChat() {
  loadedFor = null;
  if (visible()) void load({ force: true });
}

function eventTime(event) {
  return Date.parse(event.endedAt ?? event.at) || 0;
}

/**
 * The timeline: transcript messages and trace events in one ordered list.
 *
 * Messages are the backbone because they exist for every chat, including imported
 * ones; a turn event is *attached* to the message it produced, so the reply row
 * carries its own numbers. Events that produced no message (a failure, a memory
 * update, a deletion) are rows of their own — which is the whole point of keeping
 * a trace.
 */
function buildRows() {
  const byEntry = new Map();
  for (const event of events) {
    if (event.type === 'turn' && event.entryId) byEntry.set(event.entryId, event);
  }

  const rows = [];
  for (const entry of state.entries) {
    const turn = byEntry.get(entry.id) ?? null;
    if (turn) byEntry.delete(entry.id);
    rows.push({
      id: entry.id,
      kind: 'turn',
      at: Date.parse(entry.createdAt) || 0,
      title: entry.content.trim().split('\n')[0].slice(0, 80) || t('trace.emptyContent'),
      role: entry.role,
      entry,
      turn,
      notes: [],
    });
  }

  // A turn whose message is gone (deleted, or truncated away) is still history.
  for (const turn of byEntry.values()) {
    rows.push({
      id: turn.id,
      kind: 'turn',
      at: eventTime(turn),
      title: turn.failed ? t('chatView.failed', { error: turn.failed }) : t('trace.deletedReply'),
      role: 'assistant',
      entry: null,
      turn,
      notes: [],
    });
  }

  for (const event of events) {
    if (event.type === 'turn') continue;
    rows.push({
      id: event.id,
      kind: event.type === 'memory' ? 'memory' : event.type === 'delete' || event.type === 'edit' ||
        event.type === 'truncate' || event.type === 'fork' || event.type === 'swipe' || event.type === 'import'
        ? 'edit'
        : 'world',
      at: eventTime(event),
      title: event.label,
      role: null,
      entry: null,
      turn: null,
      note: event,
      notes: [],
    });
  }

  return rows.sort((a, b) => a.at - b.at);
}

function matchesFilter(row) {
  if (filter === 'all') return true;
  if (filter === 'turn') return row.kind === 'turn';
  if (filter === 'memory') return row.kind === 'memory';
  if (filter === 'edit') return row.kind === 'edit';
  if (filter === 'world') return row.kind === 'turn' && (row.turn?.worldHits.length ?? 0) > 0;
  return true;
}

function duration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function clockOf(at) {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function renderSummary() {
  const holder = el('div', { class: 'trace-summary' });
  const turns = events.filter((event) => event.type === 'turn');
  const cards = [
    [t('trace.cardTurns'), String(stats?.turns ?? 0)],
    [t('trace.cardFailures'), String(stats?.failures ?? 0)],
    [t('trace.cardTrimmed'), String(stats?.trimmed ?? 0)],
    [t('trace.cardDuration'), duration(stats?.durationMs ?? 0)],
    [t('trace.cardPromptTokens'), formatTokens(stats?.promptTokens ?? 0)],
    [t('trace.cardCompletionTokens'), formatTokens(stats?.completionTokens ?? 0)],
  ];
  for (const [label, value] of cards) {
    holder.append(
      el('div', { class: 'trace-card' }, [
        el('span', { class: 'trace-card-value', text: value }),
        el('span', { class: 'trace-card-label muted small', text: label }),
      ]),
    );
  }
  if (turns.length > (stats?.countedTurns ?? 0)) {
    holder.append(
      el('div', {
        class: 'trace-warning muted small',
        text: t('trace.missingUsage', { count: turns.length - (stats?.countedTurns ?? 0) }),
      }),
    );
  }
  return holder;
}

/** One bar per turn: prompt below, completion above, scaled to the biggest. */
function renderChart() {
  const turns = events.filter((event) => event.type === 'turn');
  const chart = el('div', { class: 'trace-chart' });
  if (turns.length === 0) {
    chart.append(el('div', { class: 'muted small', text: t('trace.noRequests') }));
    return chart;
  }
  const peak = Math.max(1, ...turns.map((turn) => turn.promptTokens + turn.completionTokens));
  for (const turn of turns) {
    const column = el(
      'button',
      {
        class: `trace-bar${turn.failed ? ' failed' : ''}${selectedId === turn.entryId || selectedId === turn.id ? ' active' : ''}`,
        title: t('trace.barTitle', {
          clock: clockOf(turn.at),
          prompt: turn.promptTokens,
          completion: turn.completionTokens,
          duration: duration(turn.durationMs),
          first: turn.firstTokenMs === null ? '' : t('trace.barFirst', { ms: turn.firstTokenMs }),
          trimmed: turn.trimmed ? t('trace.barTrimmed') : '',
          failed: turn.failed ? t('trace.barFailed', { error: turn.failed }) : '',
        }),
        'aria-label': t('trace.barAria', { index: turns.indexOf(turn) + 1 }),
        onclick: () => {
          selectedId = turn.entryId ?? turn.id;
          detailTab = 'overview';
          render();
        },
      },
      [
        el('span', {
          class: 'trace-bar-part completion',
          style: `height: ${Math.round((turn.completionTokens / peak) * 100)}%`,
        }),
        el('span', {
          class: 'trace-bar-part prompt',
          style: `height: ${Math.round((turn.promptTokens / peak) * 100)}%`,
        }),
      ],
    );
    chart.append(column);
  }
  return chart;
}

function renderFilters() {
  const holder = el('div', { class: 'trace-filters' });
  for (const item of FILTERS) {
    holder.append(
      el('button', {
        class: `ghost tiny${filter === item.id ? ' active' : ''}`,
        text: t(item.labelKey),
        'aria-pressed': filter === item.id ? 'true' : 'false',
        onclick: () => {
          filter = item.id;
          render();
        },
      }),
    );
  }
  return holder;
}

function rowTitle(row) {
  if (row.role) return `${roleLabel(row.role)}：${row.title}`;
  return `${NOTE_ICONS[row.note?.type] ?? '·'} ${row.title}`;
}

function renderTimeline(rows) {
  const list = el('div', { class: 'trace-list' });
  const shown = rows.filter(matchesFilter);
  if (shown.length === 0) {
    list.append(el('div', { class: 'muted small', text: t('trace.noRows') }));
    return list;
  }
  for (const row of shown) {
    const turn = row.turn;
    const badges = [];
    if (turn) {
      if (turn.trimmed) badges.push(t('trace.badgeTrimmed'));
      if (turn.worldHits.length > 0) badges.push(t('trace.badgeWorld', { count: turn.worldHits.length }));
      if (turn.reasoningChars > 0) badges.push(t('trace.badgeThinking', { tokens: formatTokens(turn.reasoningChars) }));
      if (turn.failed) badges.push(t('trace.badgeFailed'));
      if (turn.trigger !== 'normal') badges.push(turn.trigger === 'regenerate' ? t('trace.badgeRegenerate') : t('trace.badgeRetry'));
    }
    list.append(
      el(
        'button',
        {
          class: `trace-row${selectedId === row.id ? ' active' : ''}${turn?.failed ? ' failed' : ''}`,
          onclick: () => {
            selectedId = selectedId === row.id ? null : row.id;
            detailTab = 'overview';
            render();
          },
        },
        [
          el('span', { class: 'trace-row-icon', text: turn ? (turn.failed ? '⚠' : '▸') : (NOTE_ICONS[row.note?.type] ?? '·') }),
          el('span', { class: 'trace-row-main' }, [
            el('span', { class: 'trace-row-title', text: rowTitle(row) }),
            badges.length > 0
              ? el('span', { class: 'trace-row-badges muted small', text: badges.join(' · ') })
              : null,
          ]),
          el('span', { class: 'trace-row-facts muted small' }, [
            el('span', { text: clockOf(row.at) }),
            turn
              ? el('span', {
                  text: turn.promptTokens + turn.completionTokens > 0
                    ? `${formatTokens(turn.promptTokens + turn.completionTokens)} tok`
                    : '—',
                })
              : null,
            turn ? el('span', { text: duration(turn.durationMs) }) : null,
          ]),
        ],
      ),
    );
  }
  return list;
}

function kv(label, value) {
  return el('div', { class: 'trace-kv' }, [
    el('span', { class: 'trace-kv-label muted small', text: label }),
    el('span', { class: 'trace-kv-value', text: value }),
  ]);
}

/** A turn's speaker id resolves against the character list, like the transcript. */
function speakerNameOf(id) {
  return state.characters.find((item) => item.id === id)?.name ?? id;
}

function renderMessages(messages) {
  const holder = el('div', { class: 'trace-messages' });
  messages.forEach((message, index) => {
    holder.append(
      el('details', { class: 'trace-message' }, [
        el('summary', {}, [
          el('span', { class: `trace-message-role role-${message.role}`, text: message.role }),
          el('span', { class: 'muted small', text: t('trace.messageLine', { index, chars: formatTokens(message.content.length) }) }),
        ]),
        el('pre', { class: 'trace-message-body', text: message.content }),
      ]),
    );
  });
  return holder;
}

function renderDetail(row) {
  const holder = el('div', { class: 'trace-detail' });
  if (!row) {
    holder.append(el('div', { class: 'muted small', text: t('trace.detailHint') }));
    return holder;
  }

  const tabs = row.turn
    ? [
        { id: 'overview', labelKey: 'trace.tabOverview', enabled: true },
        { id: 'preview', labelKey: 'trace.tabPreview', enabled: row.turn.messages !== undefined },
        { id: 'raw', labelKey: 'trace.tabRaw', enabled: row.turn.messages !== undefined },
      ]
    : [{ id: 'overview', labelKey: 'trace.tabOverview', enabled: true }];
  if (!tabs.some((tab) => tab.id === detailTab && tab.enabled)) detailTab = 'overview';

  const tabRow = el('div', { class: 'trace-tabs' });
  for (const tab of tabs) {
    tabRow.append(
      el('button', {
        class: `ghost tiny${detailTab === tab.id ? ' active' : ''}`,
        text: t(tab.labelKey),
        disabled: !tab.enabled,
        title: tab.enabled ? '' : t('trace.tabDisabledTitle'),
        onclick: () => {
          detailTab = tab.id;
          render();
        },
      }),
    );
  }

  const body = el('div', { class: 'trace-detail-body' });
  const turn = row.turn;

  if (detailTab === 'overview') {
    if (turn) {
      const timing = el('div', { class: 'trace-kv-group' }, [
        kv(t('trace.kvStarted'), clockOf(turn.at)),
        kv(t('trace.kvDuration'), duration(turn.durationMs)),
        kv(t('trace.kvFirstToken'), turn.firstTokenMs === null ? t('trace.kvNoOutput') : `${turn.firstTokenMs}ms`),
        kv(t('trace.kvModel'), turn.model),
        kv(t('trace.kvTokens'), `${turn.promptTokens} / ${turn.completionTokens} tok`),
        kv(t('trace.kvChars'), t('trace.chars', { count: turn.chars })),
        turn.reasoningChars > 0
          ? kv(t('trace.kvReasoning'), t('trace.kvReasoningValue', { count: turn.reasoningChars }))
          : null,
        kv(t('trace.kvTrigger'), turn.trigger === 'normal' ? t('trace.triggerNormal') : turn.trigger === 'regenerate' ? t('trace.triggerRegenerate') : t('trace.triggerRetry')),
        turn.speaker ? kv(t('trace.kvSpeaker'), speakerNameOf(turn.speaker)) : null,
        kv(t('trace.kvPrompt'), turn.trimmed ? t('trace.kvPromptTrimmed') : t('trace.kvPromptFull')),
        turn.failed ? kv(t('trace.kvFailed'), turn.failed) : null,
      ]);
      body.append(timing);
      if (turn.worldHits.length > 0) {
        body.append(el('div', { class: 'trace-section-title muted small', text: t('trace.worldHitsTitle') }));
        const hits = el('div', { class: 'trace-hits' });
        for (const hit of turn.worldHits) {
          hits.append(el('span', { class: 'trace-hit', title: hit.world, text: hit.comment || `#${hit.uid}` }));
        }
        body.append(hits);
      } else {
        body.append(el('div', { class: 'muted small', text: t('trace.noWorldHits') }));
      }
    } else if (row.note) {
      body.append(kv(t('trace.kvTime'), clockOf(row.at)));
      if (row.note.detail) body.append(el('pre', { class: 'trace-message-body', text: row.note.detail }));
    } else if (row.entry) {
      body.append(
        el('div', { class: 'trace-kv-group' }, [
          kv(t('trace.kvRole'), roleLabel(row.entry.role)),
          kv(t('trace.kvTime'), clockOf(row.at)),
          kv(t('trace.kvLength'), t('trace.chars', { count: row.entry.content.length })),
          row.entry.variants && row.entry.variants.length > 1
            ? kv(t('trace.kvVariants'), t('trace.kvVariantsValue', {
              count: row.entry.variants.length,
              index: (row.entry.activeVariant ?? 0) + 1,
            }))
            : null,
        ]),
      );
      body.append(el('div', { class: 'muted small', text: t('trace.noTraceForMessage') }));
    }
  }

  if (detailTab === 'preview' && turn?.messages) {
    body.append(renderMessages(turn.messages));
  }

  if (detailTab === 'raw' && turn?.messages) {
    const raw = JSON.stringify({ model: turn.model, messages: turn.messages }, null, 2);
    body.append(
      el('div', { class: 'trace-raw-actions' }, [
        el('button', {
          class: 'ghost tiny',
          text: t('trace.copyJson'),
          onclick: () => {
            copyText(raw).then(
              () => toastOk(t('trace.copiedRaw')),
              (error) => toastError(error.message),
            );
          },
        }),
        el('button', {
          class: 'ghost tiny',
          text: t('trace.exportJson'),
          onclick: () => downloadJson(`turn-${clockOf(turn.at).replaceAll(':', '')}.json`, JSON.parse(raw)),
        }),
      ]),
    );
    body.append(el('pre', { class: 'trace-message-body', text: raw }));
  }

  holder.append(tabRow, body);
  return holder;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  const container = traceNode();
  if (!container) return;
  clear(container);

  const header = el('div', { class: 'trace-header' }, [
    el('div', { class: 'trace-header-row' }, [
      el('h2', { text: t('trace.title') }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'ghost tiny',
        text: t('trace.refresh'),
        onclick: () => void load({ force: true }),
      }),
      el('button', {
        class: 'ghost tiny',
        text: t('trace.export'),
        onclick: () =>
          downloadJson(`trace-${state.chatId ?? 'chat'}.json`, { stats, events }),
      }),
      el('button', {
        class: 'ghost tiny danger',
        text: t('trace.clear'),
        title: t('trace.clearTitle'),
        onclick: () => void forget(),
      }),
    ]),
    el('p', { class: 'hint', text: t('trace.hint') }),
  ]);
  container.append(header);

  if (!state.chatId) {
    container.append(emptyState({ title: t('trace.emptyChatTitle'), hint: t('trace.emptyChatHint') }));
    return;
  }
  if (events.length === 0) {
    container.append(
      emptyState({
        title: t('trace.emptyTraceTitle'),
        hint: t('trace.emptyTraceHint'),
      }),
    );
    return;
  }

  const rows = buildRows();
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  container.append(
    renderSummary(),
    renderChart(),
    renderFilters(),
    el('div', { class: 'trace-body' }, [renderTimeline(rows), renderDetail(selected)]),
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function load(options = {}) {
  const chatId = state.chatId;
  if (!chatId || busy) return;
  if (!options.force && loadedFor === chatId && !visible()) return;
  busy = true;
  try {
    const data = await api(`/api/chats/${encodeURIComponent(chatId)}/trace`);
    if (state.chatId !== chatId) return;
    events = data.events ?? [];
    stats = data.stats ?? null;
    loadedFor = chatId;
    render();
  } catch (error) {
    toastError(t('trace.loadFailed', { error: error.message }));
  } finally {
    busy = false;
  }
}

async function forget() {
  const chatId = state.chatId;
  if (!chatId) return;
  busy = true;
  try {
    const data = await api(`/api/chats/${encodeURIComponent(chatId)}/trace`, { method: 'DELETE' });
    events = data.events ?? [];
    stats = data.stats ?? null;
    selectedId = null;
    render();
    toastOk(t('trace.cleared'));
  } catch (error) {
    toastError(t('trace.clearFailed', { error: error.message }));
  } finally {
    busy = false;
  }
}

export function initTraceView() {
  // The trajectory follows the conversation: a new chat, a new turn, an edit —
  // all of them arrive as `chat`, and the view reloads only while it is on screen.
  on('chat', syncToChat);
  // The layout controller owns the mode and the panel toggles; it announces every
  // change, so this view reloads exactly when it becomes visible instead of
  // listening to the same buttons a second time.
  on('layout', (info) => {
    if (info?.mode === 'trace' && info.right !== false) syncToChat();
  });
  // Read-only screens still carry text: retranslate them in place.
  onLocaleChange(() => {
    if (visible()) render();
  });
  // A page that loads straight into trace mode never sees a change event.
  if (visible()) void load({ force: true });
}
