/**
 * World book hits for the current turn, derived from a prompt preview.
 *
 * Deriving instead of fetching keeps the badge, the highlight and the hit panel
 * showing the same thing by construction: they are three readings of one object.
 */

import { t } from './i18n.js';

/**
 * @param {object|null} preview response of POST /api/prompt/preview
 * @returns {{all: object[], byWorld: Map<string, {count: number, uids: Set<number>,
 *           keys: Map<number, {matched: string[], secondary: string[]}>, slots: Set<string>}>,
 *           skipped: object[]}}
 */
export function deriveHits(preview) {
  const byWorld = new Map();
  const all = [];

  for (const item of preview?.itemization ?? []) {
    for (const hit of item.worldHits ?? []) {
      const enriched = { ...hit, slot: item.identifier };
      all.push(enriched);

      const bucket = byWorld.get(hit.world) ?? {
        count: 0,
        uids: new Set(),
        keys: new Map(),
        slots: new Set(),
      };
      bucket.count++;
      bucket.uids.add(hit.uid);
      bucket.slots.add(item.identifier);
      bucket.keys.set(hit.uid, {
        matched: hit.matchedKeys ?? [],
        secondary: hit.matchedSecondaryKeys ?? [],
      });
      byWorld.set(hit.world, bucket);
    }
  }

  return { all, byWorld, skipped: preview?.skipped ?? [] };
}

/** Explains an empty hit list instead of just saying nothing matched. */
export function explainNoHits(scan) {
  if (!scan) return t('hits.noScan');
  if (scan.overflowed) return t('hits.overflow');
  const suppressed = (scan.skipped ?? []).filter((item) =>
    /cooldown|delay|disabled|递归/.test(item.reason ?? ''),
  );
  if (suppressed.length > 0) {
    return t('hits.suppressed', {
      count: suppressed.length,
      examples: suppressed
        .slice(0, 2)
        .map((item) => `#${item.uid} ${item.reason}`)
        .join(t('hits.join')),
    });
  }
  return t('hits.none');
}
