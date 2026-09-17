/**
 * Where the context window goes.
 *
 * The bar above says how full the window is; this says *what* fills it: one row
 * per channel (prompt stack, world book, memory, agent reads, history, pictures)
 * with a token count and a share of the window, and the per-block / per-entry
 * detail underneath, so "which entry is eating my context" has an answer that is
 * visible rather than inferred.
 *
 * Pure: no DOM, no state, so `test:web` can pin the arithmetic. The category
 * sums are checked against the provider-anchored `used` figure and anything left
 * over is reported as its own row instead of being silently dropped.
 */

import { t } from './i18n.js';

/** Display order; the segments of the mini bar follow it too. */
export const BREAKDOWN_CATEGORIES = ['stack', 'world', 'memory', 'agent', 'history', 'images'];

/** Children per category before the rest are folded into one row. */
const MAX_CHILDREN = 12;

const LABELS = {
  stack: 'budget.breakdown.stack',
  world: 'budget.breakdown.world',
  memory: 'budget.breakdown.memory',
  agent: 'budget.breakdown.agent',
  history: 'budget.breakdown.history',
  images: 'budget.breakdown.images',
  other: 'budget.breakdown.other',
};

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function biggestFirst(children) {
  if (children.length <= MAX_CHILDREN) return { rows: children, hidden: 0 };
  const sorted = [...children].sort((a, b) => b.tokens - a.tokens);
  return {
    rows: sorted.slice(0, MAX_CHILDREN),
    hidden: sorted.length - MAX_CHILDREN,
    hiddenTokens: sorted.slice(MAX_CHILDREN).reduce((sum, child) => sum + child.tokens, 0),
  };
}

/**
 * @param {object|null} preview `POST /api/prompt/preview` response
 * @param {object|null} config  the saved config (for the window and the reserve)
 * @returns {null|object} `{ window, reserve, used, rows, segments, rest }`
 */
export function tokenBreakdown(preview, config) {
  if (preview === null || preview === undefined) return null;

  const window = count(config?.maxContext);
  const reserve = count(config?.responseReserve);
  const used = count(preview.projectedTokens ?? preview.totalTokens);

  const tokens = { stack: 0, world: 0, memory: 0, agent: 0, history: 0, images: 0 };
  const detail = { stack: [], world: [], memory: [], agent: [], history: [], images: [] };

  for (const item of preview.itemization ?? []) {
    if (item.enabled === false || item.skippedReason !== undefined) continue;
    const itemTokens = count(item.tokens);

    if (item.kind === 'history') {
      tokens.history += itemTokens;
      for (const message of item.messages ?? []) {
        detail.history.push({
          label: `${message.role} · ${String(message.preview ?? '').replace(/\s+/g, ' ').trim()}`,
          tokens: count(message.tokens),
        });
      }
      continue;
    }

    const hits = Array.isArray(item.worldHits) ? item.worldHits : [];
    if (hits.length > 0) {
      let fromWorld = 0;
      for (const hit of hits) {
        const hitTokens = count(hit.tokens);
        fromWorld += hitTokens;
        detail.world.push({
          label: hit.comment || `${hit.world}#${hit.uid}`,
          sublabel: hit.world,
          tokens: hitTokens,
          source: hit.activatedBy,
        });
      }
      tokens.world += fromWorld;
      // A depth injection carries the entry text next to its own words; only the
      // world part is the world book, so the remainder is credited to the stack.
      if (itemTokens > fromWorld) {
        tokens.stack += itemTokens - fromWorld;
        detail.stack.push({ label: item.name, tokens: itemTokens - fromWorld });
      }
      continue;
    }

    if (item.identifier === 'memory') {
      tokens.memory += itemTokens;
      detail.memory.push({ label: item.name, tokens: itemTokens });
      continue;
    }
    if (item.identifier === 'agentSkillFiles') {
      tokens.agent += itemTokens;
      detail.agent.push({ label: item.name, tokens: itemTokens });
      continue;
    }

    tokens.stack += itemTokens;
    detail.stack.push({ label: item.name, tokens: itemTokens, skipped: item.kind === 'injection' });
  }

  tokens.images = count(preview.imageTokens);
  for (const image of preview.images ?? []) {
    detail.images.push({ label: String(image.name ?? ''), tokens: 1024 });
  }

  const share = (value) => (window > 0 ? (value / window) * 100 : 0);
  const rows = [];
  for (const key of BREAKDOWN_CATEGORIES) {
    if (tokens[key] === 0) continue;
    const packed = biggestFirst(detail[key]);
    rows.push({
      key,
      label: t(LABELS[key]),
      tokens: tokens[key],
      percent: share(tokens[key]),
      children: packed.rows,
      hidden: packed.hidden,
      hiddenTokens: packed.hiddenTokens ?? 0,
    });
  }

  // The provider-anchored figure is the one the bar shows; if the categories do
  // not add up to it, the difference is said out loud rather than hidden.
  const summed = rows.reduce((sum, row) => sum + row.tokens, 0);
  const rest = Math.max(0, used - summed);
  if (rest > 0) {
    rows.push({ key: 'other', label: t(LABELS.other), tokens: rest, percent: share(rest), children: [], hidden: 0, hiddenTokens: 0 });
  }

  return {
    window,
    reserve,
    used,
    usable: Math.max(0, window - reserve),
    remaining: Math.max(0, window - reserve - used),
    rows,
    segments: rows.map((row) => ({
      key: row.key,
      percent: Math.max(0, Math.min(100, row.percent)),
      label: row.label,
      tokens: row.tokens,
    })),
  };
}
