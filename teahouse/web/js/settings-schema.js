/**
 * Settings schema: the single declaration behind the dialog's navigation, its
 * forms and its save payload.
 *
 * Replaces what used to be four parallel descriptions of the same fields —
 * `CONFIG_FIELDS`, `SCAN_FIELDS`, `NUMERIC_CONFIG`/`NUMERIC_SCAN` and the
 * hand-written markup in index.html — which had to be edited together and could
 * silently disagree.
 *
 * Text is declared as translation keys (`labelKey`, `hintKey`, `placeholderKey`,
 * `groupKey`, option `labelKey`) and resolved by the renderer, so the schema
 * stays DOM-free and language-neutral. The keys live in `js/locales/`; `test:web`
 * checks every key resolves in every locale.
 *
 * DOM-free on purpose: `test:web` unit tests the payload rules, and checks every
 * key against the server's `DEFAULT_CONFIG` so a typo cannot ship.
 */

import { locales, t } from './i18n.js';

/**
 * @typedef {object} SettingsField
 * @property {string} key            config key, also the payload key
 * @property {string} labelKey       translation key for the label
 * @property {'line'|'password'|'text'|'number'|'boolean'|'enum'|'keys'} type
 * @property {'config'|'scan'} scope where the key lives in the payload
 * @property {string} [hintKey]      translation key for the hint (shown under the label)
 * @property {string} [groupKey]     translation key for the heading of a run of rows
 * @property {string} [placeholderKey]
 * @property {number} [step]
 * @property {number} [rows]
 * @property {{value: number|string, label?: string, labelKey?: string}[]} [options]
 * @property {boolean} [secret]      never echoed back; '***' means "unchanged"
 */

/**
 * The pages, each narrow enough to read without scrolling: the interface and
 * reply language, the provider and its budget, then the world book scan.
 *
 * @type {{id: string, labelKey: string, hintKey: string, icon: string, fields: SettingsField[], extras?: string[]}[]}
 */
export const SETTINGS_PAGES = [
  {
    id: 'general',
    labelKey: 'settings.pages.general.label',
    hintKey: 'settings.pages.general.hint',
    icon: 'sliders',
    fields: [
      {
        key: 'uiLanguage',
        labelKey: 'settings.fields.uiLanguage.label',
        hintKey: 'settings.fields.uiLanguage.hint',
        type: 'enum',
        scope: 'config',
        // Options come from the registry, so a new locale shows up here with no
        // change to this file; its own name is never translated.
        options: locales().map((entry) => ({ value: entry.id, label: entry.nativeLabel })),
      },
      {
        key: 'outputLanguage',
        labelKey: 'settings.fields.outputLanguage.label',
        hintKey: 'settings.fields.outputLanguage.hint',
        placeholderKey: 'settings.fields.outputLanguage.placeholder',
        type: 'line',
        scope: 'config',
      },
      {
        key: 'languageInstruction',
        labelKey: 'settings.fields.languageInstruction.label',
        hintKey: 'settings.fields.languageInstruction.hint',
        placeholderKey: 'settings.fields.languageInstruction.placeholder',
        type: 'text',
        scope: 'config',
        rows: 3,
      },
      {
        key: 'autoTranslate',
        labelKey: 'settings.fields.autoTranslate.label',
        hintKey: 'settings.fields.autoTranslate.hint',
        type: 'boolean',
        scope: 'config',
      },
      {
        key: 'impersonateAutoReply',
        labelKey: 'settings.fields.impersonateAutoReply.label',
        hintKey: 'settings.fields.impersonateAutoReply.hint',
        type: 'boolean',
        scope: 'config',
      },
    ],
    extras: ['language'],
  },
  {
    id: 'appearance',
    labelKey: 'settings.pages.appearance.label',
    hintKey: 'settings.pages.appearance.hint',
    icon: 'palette',
    fields: [
      {
        key: 'markdown',
        labelKey: 'settings.fields.markdown.label',
        hintKey: 'settings.fields.markdown.hint',
        type: 'boolean',
        scope: 'config',
        groupKey: 'reading',
      },
    ],
    extras: ['appearance', 'fonts'],
  },
  {
    id: 'model',
    labelKey: 'settings.pages.model.label',
    hintKey: 'settings.pages.model.hint',
    icon: 'chip',
    fields: [
      {
        key: 'baseUrl',
        labelKey: 'settings.fields.baseUrl.label',
        hintKey: 'settings.fields.baseUrl.hint',
        placeholderKey: 'settings.fields.baseUrl.placeholder',
        type: 'line',
        scope: 'config',
        groupKey: 'endpoint',
      },
      {
        key: 'apiKey',
        labelKey: 'settings.fields.apiKey.label',
        hintKey: 'settings.fields.apiKey.hint',
        placeholderKey: 'settings.fields.apiKey.placeholder',
        type: 'password',
        scope: 'config',
        groupKey: 'endpoint',
        secret: true,
      },
      {
        key: 'model',
        labelKey: 'settings.fields.model.label',
        placeholderKey: 'settings.fields.model.placeholder',
        type: 'line',
        scope: 'config',
        groupKey: 'endpoint',
      },
      {
        key: 'vectorMode',
        name: 'mode',
        labelKey: 'settings.fields.vectorMode.label',
        hintKey: 'settings.fields.vectorMode.hint',
        type: 'enum',
        scope: 'vector',
        groupKey: 'vectorService',
        options: [
          { value: 'local', labelKey: 'settings.fields.vectorMode.options.local' },
          { value: 'remote', labelKey: 'settings.fields.vectorMode.options.remote' },
        ],
      },
      {
        key: 'vectorLocalBaseUrl',
        name: 'local.baseUrl',
        labelKey: 'settings.fields.vectorLocalBaseUrl.label',
        hintKey: 'settings.fields.vectorLocalBaseUrl.hint',
        placeholderKey: 'settings.fields.vectorLocalBaseUrl.placeholder',
        type: 'line',
        scope: 'vector',
        groupKey: 'vectorService',
      },
      {
        key: 'vectorLocalModel',
        name: 'local.model',
        labelKey: 'settings.fields.vectorLocalModel.label',
        hintKey: 'settings.fields.vectorLocalModel.hint',
        placeholderKey: 'settings.fields.vectorLocalModel.placeholder',
        type: 'line',
        scope: 'vector',
        groupKey: 'vectorService',
      },
      {
        key: 'vectorRemoteBaseUrl',
        name: 'remote.baseUrl',
        labelKey: 'settings.fields.vectorRemoteBaseUrl.label',
        hintKey: 'settings.fields.vectorRemoteBaseUrl.hint',
        placeholderKey: 'settings.fields.vectorRemoteBaseUrl.placeholder',
        type: 'line',
        scope: 'vector',
        groupKey: 'vectorService',
      },
      {
        key: 'vectorRemoteModel',
        name: 'remote.model',
        labelKey: 'settings.fields.vectorRemoteModel.label',
        placeholderKey: 'settings.fields.vectorRemoteModel.placeholder',
        type: 'line',
        scope: 'vector',
        groupKey: 'vectorService',
      },
      {
        key: 'vectorRemoteKey',
        name: 'remote.apiKey',
        labelKey: 'settings.fields.vectorRemoteKey.label',
        hintKey: 'settings.fields.vectorRemoteKey.hint',
        type: 'password',
        scope: 'vector',
        groupKey: 'vectorService',
      },
      {
        key: 'temperature',
        labelKey: 'settings.fields.temperature.label',
        hintKey: 'settings.fields.temperature.hint',
        type: 'number',
        scope: 'config',
        groupKey: 'sampling',
        step: 0.05,
      },
      {
        key: 'maxContext',
        labelKey: 'settings.fields.maxContext.label',
        hintKey: 'settings.fields.maxContext.hint',
        type: 'number',
        scope: 'config',
        groupKey: 'sampling',
      },
      {
        key: 'responseReserve',
        labelKey: 'settings.fields.responseReserve.label',
        hintKey: 'settings.fields.responseReserve.hint',
        type: 'number',
        scope: 'config',
        groupKey: 'sampling',
      },
      {
        key: 'maxTokens',
        labelKey: 'settings.fields.maxTokens.label',
        hintKey: 'settings.fields.maxTokens.hint',
        type: 'number',
        scope: 'config',
        groupKey: 'sampling',
      },
      {
        key: 'topP',
        labelKey: 'settings.fields.topP.label',
        hintKey: 'settings.fields.topP.hint',
        type: 'number',
        scope: 'config',
        groupKey: 'sampling',
        step: 0.05,
      },
      {
        key: 'frequencyPenalty',
        labelKey: 'settings.fields.frequencyPenalty.label',
        hintKey: 'settings.fields.frequencyPenalty.hint',
        type: 'number',
        scope: 'config',
        groupKey: 'sampling',
        step: 0.05,
      },
      {
        key: 'presencePenalty',
        labelKey: 'settings.fields.presencePenalty.label',
        hintKey: 'settings.fields.presencePenalty.hint',
        type: 'number',
        scope: 'config',
        groupKey: 'sampling',
        step: 0.05,
      },
      {
        key: 'stop',
        labelKey: 'settings.fields.stop.label',
        hintKey: 'settings.fields.stop.hint',
        type: 'keys',
        scope: 'config',
        groupKey: 'sampling',
      },
      {
        key: 'textCompletion',
        labelKey: 'settings.fields.textCompletion.label',
        hintKey: 'settings.fields.textCompletion.hint',
        type: 'boolean',
        scope: 'config',
        groupKey: 'endpoint',
      },
      {
        key: 'tokenizerPath',
        labelKey: 'settings.fields.tokenizerPath.label',
        hintKey: 'settings.fields.tokenizerPath.hint',
        placeholderKey: 'settings.fields.tokenizerPath.placeholder',
        type: 'line',
        scope: 'config',
        groupKey: 'tokenCounting',
      },
      {
        key: 'requestUsage',
        labelKey: 'settings.fields.requestUsage.label',
        hintKey: 'settings.fields.requestUsage.hint',
        type: 'boolean',
        scope: 'config',
        groupKey: 'tokenCounting',
      },
      {
        key: 'showReasoning',
        labelKey: 'settings.fields.showReasoning.label',
        hintKey: 'settings.fields.showReasoning.hint',
        type: 'boolean',
        scope: 'config',
        groupKey: 'thinking',
      },
      {
        key: 'disableThinking',
        labelKey: 'settings.fields.disableThinking.label',
        hintKey: 'settings.fields.disableThinking.hint',
        type: 'boolean',
        scope: 'config',
        groupKey: 'thinking',
      },
    ],
    extras: ['provider', 'connections', 'counting'],
  },
  {
    id: 'persona',
    labelKey: 'settings.pages.persona.label',
    hintKey: 'settings.pages.persona.hint',
    icon: 'user',
    fields: [
      { key: 'personaName', labelKey: 'settings.fields.personaName.label', type: 'line', scope: 'config' },
      { key: 'personaDescription', labelKey: 'settings.fields.personaDescription.label', type: 'text', scope: 'config', rows: 5 },
      {
        key: 'memoryEnabled',
        name: 'enabled',
        labelKey: 'settings.fields.memoryEnabled.label',
        hintKey: 'settings.fields.memoryEnabled.hint',
        type: 'boolean',
        scope: 'memory',
        groupKey: 'memory',
      },
      {
        key: 'memoryInterval',
        name: 'interval',
        labelKey: 'settings.fields.memoryInterval.label',
        hintKey: 'settings.fields.memoryInterval.hint',
        type: 'number',
        scope: 'memory',
        groupKey: 'memory',
      },
      {
        key: 'memoryWords',
        name: 'words',
        labelKey: 'settings.fields.memoryWords.label',
        hintKey: 'settings.fields.memoryWords.hint',
        type: 'number',
        scope: 'memory',
        groupKey: 'memory',
      },
      {
        key: 'memoryTemplate',
        name: 'template',
        labelKey: 'settings.fields.memoryTemplate.label',
        hintKey: 'settings.fields.memoryTemplate.hint',
        placeholderKey: 'settings.fields.memoryTemplate.placeholder',
        type: 'line',
        scope: 'memory',
        groupKey: 'memory',
      },
      {
        key: 'memoryDepth',
        name: 'depth',
        labelKey: 'settings.fields.memoryDepth.label',
        hintKey: 'settings.fields.memoryDepth.hint',
        type: 'number',
        scope: 'memory',
        groupKey: 'memory',
      },
      {
        key: 'memoryRole',
        name: 'role',
        labelKey: 'settings.fields.memoryRole.label',
        type: 'enum',
        scope: 'memory',
        groupKey: 'memory',
        options: [
          { value: 'system', labelKey: 'settings.fields.memoryRole.options.system' },
          { value: 'user', labelKey: 'settings.fields.memoryRole.options.user' },
          { value: 'assistant', labelKey: 'settings.fields.memoryRole.options.assistant' },
        ],
      },
      {
        key: 'memoryModel',
        name: 'model',
        labelKey: 'settings.fields.memoryModel.label',
        hintKey: 'settings.fields.memoryModel.hint',
        type: 'line',
        scope: 'memory',
        groupKey: 'memory',
      },
      {
        key: 'memoryPrompt',
        name: 'prompt',
        labelKey: 'settings.fields.memoryPrompt.label',
        hintKey: 'settings.fields.memoryPrompt.hint',
        type: 'text',
        scope: 'memory',
        groupKey: 'memory',
        rows: 4,
      },
      {
        key: 'contextTemplate',
        labelKey: 'settings.fields.contextTemplate.label',
        hintKey: 'settings.fields.contextTemplate.hint',
        placeholderKey: 'settings.fields.contextTemplate.placeholder',
        type: 'text',
        scope: 'config',
        groupKey: 'contextTemplate',
        rows: 6,
      },
    ],
    extras: ['personas', 'contextTemplate'],
  },
  {
    id: 'world',
    labelKey: 'settings.pages.world.label',
    hintKey: 'settings.pages.world.hint',
    icon: 'book',
    extras: ['retrievalNotice', 'vectors'],
    fields: [
      {
        key: 'vectorAllEntries',
        name: 'allEntries',
        labelKey: 'settings.fields.vectorAllEntries.label',
        hintKey: 'settings.fields.vectorAllEntries.hint',
        type: 'boolean',
        scope: 'vector',
        groupKey: 'vectorSearch',
      },
      {
        key: 'vectorThreshold',
        name: 'threshold',
        labelKey: 'settings.fields.vectorThreshold.label',
        hintKey: 'settings.fields.vectorThreshold.hint',
        type: 'number',
        scope: 'vector',
        groupKey: 'vectorSearch',
        step: 0.01,
      },
      {
        key: 'vectorMaxEntries',
        name: 'maxEntries',
        labelKey: 'settings.fields.vectorMaxEntries.label',
        hintKey: 'settings.fields.vectorMaxEntries.hint',
        type: 'number',
        scope: 'vector',
        groupKey: 'vectorSearch',
      },
      {
        key: 'vectorQueryMessages',
        name: 'queryMessages',
        labelKey: 'settings.fields.vectorQueryMessages.label',
        hintKey: 'settings.fields.vectorQueryMessages.hint',
        type: 'number',
        scope: 'vector',
        groupKey: 'vectorSearch',
      },
      {
        key: 'vectorBatchSize',
        name: 'batchSize',
        labelKey: 'settings.fields.vectorBatchSize.label',
        hintKey: 'settings.fields.vectorBatchSize.hint',
        type: 'number',
        scope: 'vector',
        groupKey: 'vectorSearch',
      },
      {
        key: 'depth',
        labelKey: 'settings.fields.depth.label',
        hintKey: 'settings.fields.depth.hint',
        type: 'number',
        scope: 'scan',
        groupKey: 'scanRange',
      },
      {
        key: 'minActivations',
        labelKey: 'settings.fields.minActivations.label',
        hintKey: 'settings.fields.minActivations.hint',
        type: 'number',
        scope: 'scan',
        groupKey: 'scanRange',
      },
      {
        key: 'minActivationsDepthMax',
        labelKey: 'settings.fields.minActivationsDepthMax.label',
        hintKey: 'settings.fields.minActivationsDepthMax.hint',
        type: 'number',
        scope: 'scan',
        groupKey: 'scanRange',
      },
      {
        key: 'budgetPercent',
        labelKey: 'settings.fields.budgetPercent.label',
        hintKey: 'settings.fields.budgetPercent.hint',
        type: 'number',
        scope: 'scan',
        groupKey: 'budget',
      },
      {
        key: 'budgetCap',
        labelKey: 'settings.fields.budgetCap.label',
        hintKey: 'settings.fields.budgetCap.hint',
        type: 'number',
        scope: 'scan',
        groupKey: 'budget',
      },
      {
        key: 'recursive',
        labelKey: 'settings.fields.recursive.label',
        hintKey: 'settings.fields.recursive.hint',
        type: 'boolean',
        scope: 'scan',
        groupKey: 'recursion',
      },
      {
        key: 'maxRecursionSteps',
        labelKey: 'settings.fields.maxRecursionSteps.label',
        hintKey: 'settings.fields.maxRecursionSteps.hint',
        type: 'number',
        scope: 'scan',
        groupKey: 'recursion',
      },
      {
        key: 'includeNames',
        labelKey: 'settings.fields.includeNames.label',
        hintKey: 'settings.fields.includeNames.hint',
        type: 'boolean',
        scope: 'scan',
        groupKey: 'compat',
      },
      {
        key: 'caseSensitive',
        labelKey: 'settings.fields.caseSensitive.label',
        hintKey: 'settings.fields.caseSensitive.hint',
        type: 'boolean',
        scope: 'scan',
        groupKey: 'compat',
      },
      {
        key: 'matchWholeWords',
        labelKey: 'settings.fields.matchWholeWords.label',
        hintKey: 'settings.fields.matchWholeWords.hint',
        type: 'boolean',
        scope: 'scan',
        groupKey: 'compat',
      },
      {
        key: 'useGroupScoring',
        labelKey: 'settings.fields.useGroupScoring.label',
        hintKey: 'settings.fields.useGroupScoring.hint',
        type: 'boolean',
        scope: 'scan',
        groupKey: 'compat',
      },
      {
        key: 'characterStrategy',
        labelKey: 'settings.fields.characterStrategy.label',
        hintKey: 'settings.fields.characterStrategy.hint',
        type: 'enum',
        scope: 'scan',
        groupKey: 'compat',
        options: [
          { value: 0, labelKey: 'settings.fields.characterStrategy.options.0' },
          { value: 1, labelKey: 'settings.fields.characterStrategy.options.1' },
          { value: 2, labelKey: 'settings.fields.characterStrategy.options.2' },
        ],
      },
      {
        key: 'retrievalMode',
        labelKey: 'settings.fields.retrievalMode.label',
        hintKey: 'settings.fields.retrievalMode.hint',
        type: 'enum',
        scope: 'retrieval',
        name: 'mode',
        groupKey: 'backgroundInjection',
        options: [
          { value: 'keyword', labelKey: 'settings.fields.retrievalMode.options.keyword' },
          { value: 'all', labelKey: 'settings.fields.retrievalMode.options.all' },
          { value: 'vector', labelKey: 'settings.fields.retrievalMode.options.vector' },
          { value: 'select', labelKey: 'settings.fields.retrievalMode.options.select' },
          { value: 'agent', labelKey: 'settings.fields.retrievalMode.options.agent' },
        ],
      },
      {
        key: 'fullIncludeWorlds',
        labelKey: 'settings.fields.fullIncludeWorlds.label',
        hintKey: 'settings.fields.fullIncludeWorlds.hint',
        type: 'boolean',
        scope: 'retrieval',
        name: 'fullIncludeWorlds',
        groupKey: 'backgroundInjection',
      },
      {
        key: 'fullForceOnConflict',
        labelKey: 'settings.fields.fullForceOnConflict.label',
        hintKey: 'settings.fields.fullForceOnConflict.hint',
        type: 'boolean',
        scope: 'retrieval',
        name: 'fullForceOnConflict',
        groupKey: 'backgroundInjection',
      },
      {
        key: 'modelSelectMax',
        labelKey: 'settings.fields.modelSelectMax.label',
        hintKey: 'settings.fields.modelSelectMax.hint',
        type: 'number',
        scope: 'scan',
        name: 'modelSelectMax',
        groupKey: 'backgroundInjection',
      },
      {
        key: 'agentMaxRounds',
        labelKey: 'settings.fields.agentMaxRounds.label',
        hintKey: 'settings.fields.agentMaxRounds.hint',
        type: 'number',
        scope: 'retrieval',
        name: 'agentMaxRounds',
        groupKey: 'backgroundInjection',
      },
      {
        key: 'agentMaxFiles',
        labelKey: 'settings.fields.agentMaxFiles.label',
        hintKey: 'settings.fields.agentMaxFiles.hint',
        type: 'number',
        scope: 'retrieval',
        name: 'agentMaxFiles',
        groupKey: 'backgroundInjection',
      },
    ],
  },
  {
    id: 'voice',
    labelKey: 'settings.pages.voice.label',
    hintKey: 'settings.pages.voice.hint',
    icon: 'speech',
    fields: [
      {
        key: 'ttsMode',
        name: 'mode',
        labelKey: 'settings.fields.ttsMode.label',
        hintKey: 'settings.fields.ttsMode.hint',
        type: 'enum',
        scope: 'tts',
        groupKey: 'engine',
        options: [
          { value: 'local', labelKey: 'settings.fields.ttsMode.options.local' },
          { value: 'online', labelKey: 'settings.fields.ttsMode.options.online' },
        ],
      },
      {
        key: 'ttsVoice',
        name: 'voice',
        labelKey: 'settings.fields.ttsVoice.label',
        hintKey: 'settings.fields.ttsVoice.hint',
        placeholderKey: 'settings.fields.ttsVoice.placeholder',
        type: 'line',
        scope: 'tts',
        groupKey: 'local',
      },
      {
        key: 'ttsRate',
        name: 'rate',
        labelKey: 'settings.fields.ttsRate.label',
        hintKey: 'settings.fields.ttsRate.hint',
        type: 'number',
        scope: 'tts',
        groupKey: 'local',
        step: 0.1,
      },
      {
        key: 'ttsBaseUrl',
        name: 'baseUrl',
        labelKey: 'settings.fields.ttsBaseUrl.label',
        hintKey: 'settings.fields.ttsBaseUrl.hint',
        placeholderKey: 'settings.fields.ttsBaseUrl.placeholder',
        type: 'line',
        scope: 'tts',
        groupKey: 'online',
      },
      {
        key: 'ttsKey',
        name: 'apiKey',
        labelKey: 'settings.fields.ttsKey.label',
        hintKey: 'settings.fields.ttsKey.hint',
        placeholderKey: 'settings.fields.ttsKey.placeholder',
        type: 'password',
        scope: 'tts',
        groupKey: 'online',
        secret: true,
      },
      {
        key: 'ttsModel',
        name: 'model',
        labelKey: 'settings.fields.ttsModel.label',
        placeholderKey: 'settings.fields.ttsModel.placeholder',
        type: 'line',
        scope: 'tts',
        groupKey: 'online',
      },
      {
        key: 'ttsOnlineVoice',
        name: 'onlineVoice',
        labelKey: 'settings.fields.ttsOnlineVoice.label',
        hintKey: 'settings.fields.ttsOnlineVoice.hint',
        placeholderKey: 'settings.fields.ttsOnlineVoice.placeholder',
        type: 'line',
        scope: 'tts',
        groupKey: 'online',
      },
    ],
    extras: ['tts'],
  },
];

/** Presets for the reply-language page. These are values, not labels. */
export const LANGUAGE_PRESETS = [
  '中文',
  'English',
  '日本語',
  '한국어',
  '文言文',
  '繁體中文',
  '火星文',
];

export function settingsPage(id) {
  return SETTINGS_PAGES.find((page) => page.id === id) ?? null;
}

/** Every field across every page, in page order. */
export function schemaFields() {
  return SETTINGS_PAGES.flatMap((page) => page.fields);
}

/** Which page a field lives on; used to jump to a page when a save fails. */
export function pageOfField(key) {
  return SETTINGS_PAGES.find((page) => page.fields.some((field) => field.key === key))?.id ?? null;
}

/**
 * The retrieval modes the client knows about. Kept as ids (not labels) so the
 * localized names can be looked up on every render; `test:web` checks the ids
 * against the server's `RETRIEVAL_MODES`.
 */
const RETRIEVAL_MODE_IDS = ['keyword', 'all', 'vector', 'select', 'agent'];

export function hasRetrievalMode(mode) {
  return RETRIEVAL_MODE_IDS.includes(mode);
}

/** The localized display name of one mode, falling back to the default's. */
export function retrievalModeLabel(mode) {
  return t(`settings.retrievalModes.${hasRetrievalMode(mode) ? mode : 'keyword'}`);
}

/** Display names for every mode, in the order the server declares them. */
export function retrievalModeLabels() {
  return Object.fromEntries(RETRIEVAL_MODE_IDS.map((mode) => [mode, retrievalModeLabel(mode)]));
}

/**
 * The group speaker modes the client knows about, in the order the picker
 * letters them (A–E). Kept as ids (not labels) so the localized names can be
 * looked up on every render; `test:web` checks the ids against the server's
 * `GROUP_MODES`.
 */
const GROUP_MODE_IDS = ['round', 'natural', 'list', 'pooled', 'manual'];

export function hasGroupMode(mode) {
  return GROUP_MODE_IDS.includes(mode);
}

/** The mode a chat answers with: an unknown or missing pin means `round`. */
export function effectiveGroupMode(mode) {
  return hasGroupMode(mode) ? mode : 'round';
}

/** The mode's letter (`A`–`E`), taken from its place in the list. */
export function groupModeLetter(mode) {
  return String.fromCharCode(65 + GROUP_MODE_IDS.indexOf(effectiveGroupMode(mode)));
}

/** The localized display name of one mode, without its letter. */
export function groupModeLabel(mode) {
  return t(`settings.groupModes.${effectiveGroupMode(mode)}`);
}

/** Every mode as it appears in the picker: `A · 依次回复`, `B · 自然`, … */
export function groupModeLabels() {
  return Object.fromEntries(GROUP_MODE_IDS.map((mode) => [
    mode,
    t('settings.groupModes.option', { letter: groupModeLetter(mode), name: groupModeLabel(mode) }),
  ]));
}

/**
 * The migration notice for the switches the retrieval mode absorbed.
 *
 * A config written before the mode existed carries `vector.enabled` and/or
 * `scan.modelSelect`. Once any save writes a `retrieval` section the mode wins,
 * so those flags can only *look* active while doing nothing at all. This returns
 * the sentence to show, or `null` when there is nothing to warn about.
 */
export function retrievalMigrationNotice(config) {
  if (!config) return null;
  const mode = hasRetrievalMode(config.retrieval?.mode) ? config.retrieval.mode : 'keyword';
  const stale = [];
  if (config.vector?.enabled === true && mode !== 'vector') stale.push(t('settings.extras.migration.staleVector'));
  if (config.scan?.modelSelect === true && mode !== 'select') stale.push(t('settings.extras.migration.staleSelect'));
  if (stale.length === 0) return null;
  const wanted = [];
  if (config.vector?.enabled === true && mode !== 'vector') wanted.push(t('settings.extras.migration.wantedVector'));
  if (config.scan?.modelSelect === true && mode !== 'select') wanted.push(t('settings.extras.migration.wantedSelect'));
  return t('settings.extras.migration.notice', {
    stale: stale.join(''),
    mode: retrievalModeLabel(mode),
    wanted: wanted.join(''),
  });
}

/**
 * The config section a field lives in. Scopes exist because the config has
 * sections of their own (`scan`, `memory`); everything else is at the root.
 */
  function scopeOf(field, config) {
    if (field.scope === 'scan') return config?.scan ?? {};
    if (field.scope === 'memory') return config?.memory ?? {};
    if (field.scope === 'vector') return config?.vector ?? {};
    if (field.scope === 'tts') return config?.tts ?? {};
    if (field.scope === 'retrieval') return config?.retrieval ?? {};
    return config ?? {};
  }

/**
 * Reads a dotted field name out of a section (`local.baseUrl`), so the two vector
 * endpoints can each keep their own keys without inventing a scope per level.
 */
function readPath(source, path) {
  let current = source;
  for (const part of String(path).split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/** The mirror of `readPath`, creating the objects it needs. */
function writePath(target, path, value) {
  const parts = String(path).split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof current[part] !== 'object' || current[part] === null) current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function displayValue(field, config) {
  const source = scopeOf(field, config);
  // `name` is the key inside the scope (possibly dotted); `key` stays the field's
  // unique id, so `scan.depth` and `memory.depth` cannot collide in the values map
  // the dialog keeps.
  const value = readPath(source, field.name ?? field.key);
  if (field.type === 'boolean') return value === true;
  if (field.type === 'number') return value === null || value === undefined ? '' : value;
  // Lists stay lists. Stringifying them here would make an untouched field look
  // changed on every save (`[]` reads back as `""`).
  if (field.type === 'keys') return Array.isArray(value) ? value : [];
  return value === null || value === undefined ? '' : String(value);
}

/** Field values for rendering a config, keyed by field key. */
export function valuesFromConfig(config) {
  const out = {};
  for (const field of schemaFields()) out[field.key] = displayValue(field, config);
  return out;
}

/**
 * The value a field contributes to the payload, or `undefined` when it
 * contributes nothing.
 *
 * Three rules, all of which the previous hand-written save got wrong or had to
 * special-case inline:
 *   - text fields are always sent, including empty ones, otherwise clearing a
 *     field (the reply language, say) silently keeps the old value
 *   - numbers are only sent when they hold a finite value, so an emptied number
 *     box does not turn into 0
 *   - a secret field showing '***' means "unchanged" and is not sent
 */
function payloadValue(field, value) {
  if (field.secret && value === '***') return undefined;

  if (field.type === 'number') {
    if (value === '' || value === null || value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (field.type === 'boolean') return value === true;

  // Enums send exactly what their options declare: a number for the world book
  // strategy, a string for the memory role. A value that is not on the list is
  // dropped rather than sent, so a stale or hand-typed value cannot reach the
  // server. The numeric branch stays because the control reads back as a string.
  if (field.type === 'enum') {
    const offered = (field.options ?? []).map((option) => option.value);
    if (offered.includes(value)) return value;
    const parsed = Number(value);
    return offered.some((option) => Number(option) === parsed) && Number.isFinite(parsed)
      ? parsed
      : undefined;
  }

  // A list control (the stop strings) reads back as an array; sending it as a
  // string would turn two sequences into one comma-joined one.
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((item) => item !== '');
  }

  return typeof value === 'string' ? value : String(value ?? '');
}

/** The PUT payload for the current field values. */
export function buildPatch(values) {
  const payload = { scan: {}, memory: {}, vector: {}, tts: {}, retrieval: {} };
  for (const field of schemaFields()) {
    const value = payloadValue(field, values[field.key]);
    if (value === undefined) continue;
    assign(payload, field, value);
  }
  return payload;
}

function assign(payload, field, value) {
  const name = field.name ?? field.key;
  if (field.scope === 'scan') payload.scan[name] = value;
  else if (field.scope === 'memory') payload.memory[name] = value;
  else if (field.scope === 'vector') writePath(payload.vector ?? (payload.vector = {}), name, value);
  else if (field.scope === 'tts') payload.tts[name] = value;
  else if (field.scope === 'retrieval') payload.retrieval[name] = value;
  else payload[field.key] = value;
}

/**
 * Fields whose value differs from the stored one, for the "unsaved" marker.
 *
 * Defined in terms of the payload rather than the raw control value: a field
 * whose value would not be sent at all (an emptied number box) is not a change,
 * which is exactly what the save would do with it.
 */
export function changedFields(values, config) {
  const stored = valuesFromConfig(config);
  const out = [];
  for (const field of schemaFields()) {
    const next = payloadValue(field, values[field.key]);
    if (next === undefined) continue;
    const before = stored[field.key];
    const differs = Array.isArray(next) || Array.isArray(before)
      ? JSON.stringify(next ?? []) !== JSON.stringify(before ?? [])
      : typeof next === 'boolean'
        ? next !== before
        : String(next) !== String(before);
    if (differs) out.push(field.key);
  }
  return out;
}

/**
 * Per-field rules, checked before a save. Each returns a translation key or
 * `null`; the message is resolved when the problem is shown.
 *
 * The server merges whatever it is given, so a mistyped context window would
 * otherwise be accepted and turn into silently broken budgeting. Numbers only:
 * the text fields have no invalid state worth blocking on.
 */
const FIELD_RULES = {
  maxContext: (value) => (value > 0 ? null : 'settings.validation.positive'),
  responseReserve: (value) => (value >= 0 ? null : 'settings.validation.nonNegative'),
  temperature: (value) => (value >= 0 && value <= 2 ? null : 'settings.validation.temperature'),
  maxTokens: (value) => (value >= 0 ? null : 'settings.validation.nonNegative'),
  topP: (value) => (value > 0 && value <= 1 ? null : 'settings.validation.topP'),
  frequencyPenalty: (value) => (value >= -2 && value <= 2 ? null : 'settings.validation.penalty'),
  presencePenalty: (value) => (value >= -2 && value <= 2 ? null : 'settings.validation.penalty'),
  depth: (value) => (value >= 0 && value <= 1000 ? null : 'settings.validation.depth'),
  budgetPercent: (value) => (value >= 0 && value <= 100 ? null : 'settings.validation.percent'),
  budgetCap: (value) => (value >= 0 ? null : 'settings.validation.nonNegative'),
  maxRecursionSteps: (value) => (value >= 0 ? null : 'settings.validation.nonNegative'),
    minActivations: (value) => (value >= 0 ? null : 'settings.validation.nonNegative'),
    minActivationsDepthMax: (value) => (value >= 0 ? null : 'settings.validation.nonNegative'),
    ttsRate: (value) => (value >= 0.5 && value <= 2 ? null : 'settings.validation.rate'),
  };

/**
 * @returns {{key: string, pageId: string|null, message: string}[]} empty when valid
 */
export function validateValues(values) {
  const problems = [];
  for (const field of schemaFields()) {
    const rule = FIELD_RULES[field.key];
    if (!rule || field.type !== 'number') continue;
    const raw = values[field.key];
    if (raw === '' || raw === null || raw === undefined) continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      problems.push({ key: field.key, pageId: pageOfField(field.key), message: t('settings.validation.notNumber') });
      continue;
    }
    const message = rule(parsed);
    if (message) problems.push({ key: field.key, pageId: pageOfField(field.key), message: t(message) });
  }
  return problems;
}
