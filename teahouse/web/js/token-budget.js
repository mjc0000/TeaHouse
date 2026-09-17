/**
 * Token budget arithmetic. No DOM, no state: pure functions, so it can be unit
 * tested in Node and so the centre stats, the right-panel bar and the request
 * preview cannot drift apart — they all call this.
 */

import { t } from './i18n.js';
import { tokenBreakdown } from './token-breakdown.js';

/** 1234 -> "1.2k", 999 -> "999". */
export function formatTokens(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) < 1000) return String(number);
  const thousands = number / 1000;
  return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`;
}

export const BUDGET_LEVELS = { ok: 'ok', warn: 'warn', over: 'over' };

/**
 * Describes how full the context window is.
 *
 * `usable` excludes the reserve held back for the reply: that is the size the
 * server actually trims to, so it is the honest denominator for "how full am I".
 */
export function describeBudget(input) {
  const total = Math.max(0, Number(input.maxContext) || 0);
  const reserve = Math.max(0, Number(input.responseReserve) || 0);
  const usable = Math.max(1, total - reserve);
  const used = Math.max(0, Number(input.totalTokens) || 0);
  const ratio = used / usable;

  const level = ratio > 1 ? BUDGET_LEVELS.over : ratio >= 0.8 ? BUDGET_LEVELS.warn : BUDGET_LEVELS.ok;
  const remaining = Math.max(0, usable - used);

  return {
    used,
    total,
    reserve,
    usable,
    remaining,
    ratio,
    percent: Math.round(ratio * 100),
    level,
    /** Fill width, clamped so an over-budget bar still renders. */
    fillPercent: Math.max(0, Math.min(100, Math.round(ratio * 100))),
    usedLabel: formatTokens(used),
    totalLabel: formatTokens(total),
    usableLabel: formatTokens(usable),
    remainingLabel: formatTokens(remaining),
    summary: t('budget.summary', {
      used: formatTokens(used),
      total: formatTokens(total),
      remaining: formatTokens(remaining),
    }),
  };
}

/**
 * How the number was produced, in the interface's words.
 *
 * The estimate is not a defect to apologize for: its total is anchored to the
 * provider's reported prompt size after every request, and only the composition
 * (what the prompt is made of) stays a fixed ~4-characters-per-token guess. The
 * label says which of the two is in play, and the exact-tokenizer branch stays
 * available for deployments that configure one.
 */
export function describeCounting(input) {
  const model = input.model && input.model !== '' ? input.model : t('budget.noModel');
  const mode = input.mode === 'exact' ? 'exact' : 'estimate';
  const calibrations = Number(input.calibrations) || 0;
  const divergence = Number(input.divergence);
  const pressureTokens = Number(input.pressureTokens) || 0;
  const anchored = pressureTokens > 0;

  if (mode === 'exact') {
    const suspicious = Number.isFinite(divergence) && calibrations > 0 && Math.abs(divergence - 1) > 0.15;
    return {
      mode,
      label: t('budget.countingExact'),
      anchored: false,
      suspicious,
      text: suspicious
        ? t('budget.exactSuspicious', { model, percent: Math.round((divergence - 1) * 100) })
        : t('budget.exact', { model }),
    };
  }

  return {
    mode,
    label: t('budget.countingEstimate'),
    anchored,
    suspicious: false,
    text: anchored
      ? t('budget.anchored', { model, tokens: formatTokens(pressureTokens) })
      : t('budget.estimate', { model }),
  };
}

/** One call for everything the token UIs need. */
export function budgetFromPreview(config, preview) {
  // The occupancy figure prefers the provider-anchored projection and only
  // falls back to the raw heuristic when no request has reported usage yet.
  const usedTokens = preview?.projectedTokens ?? preview?.totalTokens;
  const budget = describeBudget({
    maxContext: config?.maxContext,
    responseReserve: config?.responseReserve,
    totalTokens: usedTokens,
  });
  const counting = describeCounting({
    // The preview carries the chat's effective model (override or default).
    model: preview?.model ?? config?.model,
    mode: preview?.mode,
    calibrations: preview?.calibrations,
    divergence: preview?.divergence,
    pressureTokens: preview?.pressureTokens,
    projectedTokens: preview?.projectedTokens,
  });
  const trimmed = Number(preview?.trimmed) || 0;
  // Provider-anchored and exact figures are not guesses; everything else is.
  const usedPrefix = counting.anchored || counting.mode === 'exact' ? '' : '~';
  return {
    ...budget,
    counting,
    trimmed,
    warnings: preview?.warnings ?? [],
    usedPrefix,
    /** Where the used figure comes from, for the collapsible panel. */
    breakdown: tokenBreakdown(preview, config),
    summary: t('budget.summary', {
      used: `${usedPrefix}${budget.usedLabel}`,
      total: budget.totalLabel,
      remaining: budget.remainingLabel,
    }),
  };
}
