/**
 * Context-template preset exchange with SillyTavern.
 *
 * A context preset there is JSON carrying (at least) `story_string`; here the
 * template is one config string. Both directions are pure functions so
 * `test:web` can pin them without touching the DOM.
 *
 * `DEFAULT_STORY_TEMPLATE` deliberately duplicates the server's
 * (`src/engine/story-template.ts`): the browser cannot import TypeScript, and
 * `test:web` asserts the two stay byte-identical, so neither side can drift.
 */

import { t } from './i18n.js';

export const DEFAULT_STORY_TEMPLATE =
  '{{#if system}}{{system}}\n{{/if}}' +
  '{{#if description}}{{description}}\n{{/if}}' +
  "{{#if personality}}{{char}}'s personality: {{personality}}\n{{/if}}" +
  '{{#if scenario}}Scenario: {{scenario}}\n{{/if}}' +
  '{{#if persona}}{{persona}}\n{{/if}}';

/** Pulls the template out of an uploaded file. Throws when there is none. */
export function parseContextPreset(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    throw new Error(t('contextTemplate.notJson'));
  }
  const candidates = [parsed?.story_string, parsed?.storyString, parsed?.context?.story_string];
  const template = candidates.find((value) => typeof value === 'string' && value !== '');
  if (template === undefined) throw new Error(t('contextTemplate.noStoryString'));
  return template;
}

/** Our side of the exchange, for going back the other way. */
export function toContextPreset(template, name = 'teahouse') {
  return { name, story_string: String(template ?? '') };
}
