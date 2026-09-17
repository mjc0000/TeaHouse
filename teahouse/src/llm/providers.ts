/**
 * Provider presets.
 *
 * The industry settled on one wire format — OpenAI Chat Completions — so
 * "supporting a provider" is mostly data, not code: a base URL, a label, and
 * (only where the vendor documents them) the model's window and output caps.
 * Anything not listed here still works, because the base-URL field takes any
 * compatible endpoint.
 *
 * The numbers are a starting point, not a source of truth: vendors rename and
 * resize models faster than a curated table can follow, so every value stays
 * editable in the settings dialog. `null` means "not known here" — the UI then
 * says so instead of guessing, which is the honest state for most vendors.
 *
 * Labels and notes are bilingual; `providersPayload(..., lang)` flattens them
 * for the route, so the served payload stays the plain shape the client reads.
 */

import type { InterfaceLanguage, LocalizedText } from '../i18n.ts';
import { localize } from '../i18n.ts';
import { normalizeBaseUrl } from './openai-compat.ts';
import { limitKey } from '../engine/limits.ts';

const L = (zh: string, en: string): LocalizedText => ({ 'zh-CN': zh, en });

export interface ProviderModel {
  id: string;
  /** Total context window in tokens, when the vendor documents it. */
  contextWindow: number | null;
  /** Maximum output tokens, when documented (DeepSeek also answers this live). */
  maxTokens: number | null;
}

export interface ProviderPreset {
  id: string;
  label: LocalizedText;
  baseUrl: string;
  /** One line shown under the dropdown: what this endpoint is/needs. */
  note: LocalizedText;
  models: ProviderModel[];
}

/** A preset with its text flattened for one interface language. */
export interface ProviderPresetView {
  id: string;
  label: string;
  baseUrl: string;
  note: string;
  models: ProviderModel[];
}

/** Roughly ordered by how likely a local roleplay user is to want it. */
export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: L('DeepSeek', 'DeepSeek'),
    baseUrl: 'https://api.deepseek.com/v1',
    note: L('官方接口，OpenAI 兼容。模型窗口/输出上限已按官方文档填好，可直接套用', 'Official endpoint, OpenAI-compatible. The model window/output caps are filled in from the official docs and can be applied directly'),
    models: [
      { id: 'deepseek-flash', contextWindow: 1_048_576, maxTokens: 393_216 },
      { id: 'deepseek-v4-pro', contextWindow: 1_048_576, maxTokens: 393_216 },
    ],
  },
  {
    id: 'zhipu',
    label: L('智谱 GLM', 'Zhipu GLM'),
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    note: L('智谱开放平台，OpenAI 兼容；推理开关是 thinking: {type}，本应用已按此发送', 'Zhipu open platform, OpenAI-compatible; the reasoning switch is thinking: {type}, which this app sends'),
    models: [
      { id: 'glm-5.3', contextWindow: null, maxTokens: null },
      { id: 'glm-5.2', contextWindow: null, maxTokens: null },
      { id: 'glm-4.7', contextWindow: null, maxTokens: null },
      { id: 'glm-4.6', contextWindow: null, maxTokens: null },
      { id: 'glm-4.5-air', contextWindow: null, maxTokens: null },
    ],
  },
  {
    id: 'zai',
    label: L('Z.AI（GLM 编码套餐）', 'Z.AI (GLM coding plan)'),
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    note: L('智谱的编码套餐走这个专用端点，接口与 GLM 相同', 'Zhipu’s coding plan uses this dedicated endpoint; the API is the same as GLM'),
    models: [
      { id: 'glm-5.3', contextWindow: null, maxTokens: null },
      { id: 'glm-4.7', contextWindow: null, maxTokens: null },
    ],
  },
  {
    id: 'opencode',
    label: L('OpenCode Zen', 'OpenCode Zen'),
    baseUrl: 'https://opencode.ai/zen/v1',
    note: L('OpenCode 的模型网关，OpenAI 兼容；部分模型也可用其它协议，这里走兼容端点', 'OpenCode’s model gateway, OpenAI-compatible; some models speak other protocols, this uses the compatible endpoint'),
    models: [],
  },
  {
    id: 'opencode-go',
    label: L('OpenCode Go', 'OpenCode Go'),
    baseUrl: 'https://opencode.ai/zen/go/v1',
    note: L('OpenCode Go 套餐端点，OpenAI 兼容（地址取自 pi 的 provider 注册表）', 'The OpenCode Go plan endpoint, OpenAI-compatible (address taken from pi’s provider registry)'),
    models: [],
  },
  {
    id: 'openai',
    label: L('OpenAI', 'OpenAI'),
    baseUrl: 'https://api.openai.com/v1',
    note: L('官方接口；上下文窗口请按所选模型文档填（本表不猜）', 'Official endpoint; fill the context window from the chosen model’s docs (this table does not guess)'),
    models: [
      { id: 'gpt-6-astra', contextWindow: null, maxTokens: null },
      { id: 'gpt-5.2', contextWindow: null, maxTokens: null },
      { id: 'gpt-5.1', contextWindow: null, maxTokens: null },
    ],
  },
  {
    id: 'openrouter',
    label: L('OpenRouter（聚合）', 'OpenRouter (aggregator)'),
    baseUrl: 'https://openrouter.ai/api/v1',
    note: L('一个 Key 通 400+ 模型；它的 /models 自带窗口与输出上限，可在模型列表里看到', 'One key reaches 400+ models; its /models carries the window and output caps, visible in the model list'),
    models: [],
  },
  {
    id: 'gemini',
    label: L('Google Gemini', 'Google Gemini'),
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    note: L('官方 OpenAI 兼容层（地址不含 /v1，本应用会原样使用）', 'Official OpenAI-compatible layer (the URL has no /v1; this app uses it as-is)'),
    models: [{ id: 'gemini-3.8-flash', contextWindow: null, maxTokens: null }],
  },
  {
    id: 'anthropic',
    label: L('Anthropic（OpenAI 兼容层）', 'Anthropic (OpenAI-compatible layer)'),
    baseUrl: 'https://api.anthropic.com/v1',
    note: L('官方兼容层不支持 prompt caching / extended thinking；要用 Claude 全功能需要原生适配器（尚未实现）', 'The official compatibility layer does not support prompt caching / extended thinking; full Claude needs a native adapter (not implemented yet)'),
    models: [
      { id: 'claude-sonnet-4-6', contextWindow: null, maxTokens: null },
      { id: 'claude-opus-4-8', contextWindow: null, maxTokens: null },
    ],
  },
  {
    id: 'moonshot',
    label: L('Moonshot / Kimi', 'Moonshot / Kimi'),
    baseUrl: 'https://api.moonshot.cn/v1',
    note: L('OpenAI 兼容', 'OpenAI-compatible'),
    models: [],
  },
  {
    id: 'qwen',
    label: L('通义千问（DashScope）', 'Qwen (DashScope)'),
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    note: L('百炼的 OpenAI 兼容模式', 'Model Studio’s OpenAI-compatible mode'),
    models: [],
  },
  {
    id: 'siliconflow',
    label: L('硅基流动', 'SiliconFlow'),
    baseUrl: 'https://api.siliconflow.cn/v1',
    note: L('OpenAI 兼容，也能作 embedding 端点', 'OpenAI-compatible; also works as an embedding endpoint'),
    models: [],
  },
  {
    id: 'groq',
    label: L('Groq', 'Groq'),
    baseUrl: 'https://api.groq.com/openai/v1',
    note: L('OpenAI 兼容，速度快', 'OpenAI-compatible, fast'),
    models: [],
  },
  {
    id: 'mistral',
    label: L('Mistral', 'Mistral'),
    baseUrl: 'https://api.mistral.ai/v1',
    note: L('OpenAI 兼容', 'OpenAI-compatible'),
    models: [],
  },
  {
    id: 'xai',
    label: L('xAI Grok', 'xAI Grok'),
    baseUrl: 'https://api.x.ai/v1',
    note: L('OpenAI 兼容', 'OpenAI-compatible'),
    models: [],
  },
  {
    id: 'together',
    label: L('Together AI', 'Together AI'),
    baseUrl: 'https://api.together.ai/v1',
    note: L('OpenAI 兼容', 'OpenAI-compatible'),
    models: [],
  },
  {
    id: 'cerebras',
    label: L('Cerebras', 'Cerebras'),
    baseUrl: 'https://api.cerebras.ai/v1',
    note: L('OpenAI 兼容，推理极快', 'OpenAI-compatible, very fast inference'),
    models: [],
  },
  {
    id: 'fireworks',
    label: L('Fireworks', 'Fireworks'),
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    note: L('OpenAI 兼容', 'OpenAI-compatible'),
    models: [],
  },
  {
    id: 'nvidia',
    label: L('NVIDIA NIM', 'NVIDIA NIM'),
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    note: L('OpenAI 兼容', 'OpenAI-compatible'),
    models: [],
  },
  {
    id: 'huggingface',
    label: L('Hugging Face（Router）', 'Hugging Face (Router)'),
    baseUrl: 'https://router.huggingface.co/v1',
    note: L('OpenAI 兼容聚合路由', 'OpenAI-compatible aggregating router'),
    models: [],
  },
  {
    id: 'baseten',
    label: L('Baseten', 'Baseten'),
    baseUrl: 'https://inference.baseten.co/v1',
    note: L('OpenAI 兼容', 'OpenAI-compatible'),
    models: [],
  },
  {
    id: 'vercel-ai-gateway',
    label: L('Vercel AI Gateway', 'Vercel AI Gateway'),
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    note: L('OpenAI 兼容聚合网关', 'OpenAI-compatible aggregating gateway'),
    models: [],
  },
  {
    id: 'moonshot-ai',
    label: L('Moonshot AI（国际站）', 'Moonshot AI (international)'),
    baseUrl: 'https://api.moonshot.ai/v1',
    note: L('OpenAI 兼容；国内站见上面那条', 'OpenAI-compatible; the mainland endpoint is listed above'),
    models: [],
  },
  {
    id: 'xiaomi',
    label: L('Xiaomi MiMo', 'Xiaomi MiMo'),
    baseUrl: 'https://api.xiaomimimo.com/v1',
    note: L('OpenAI 兼容', 'OpenAI-compatible'),
    models: [],
  },
  {
    id: 'ant-ling',
    label: L('Ant Ling', 'Ant Ling'),
    baseUrl: 'https://api.ant-ling.com/v1',
    note: L('OpenAI 兼容', 'OpenAI-compatible'),
    models: [],
  },
  {
    id: 'zai-coding-cn',
    label: L('Z.AI 编码（国内端点）', 'Z.AI coding (mainland endpoint)'),
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    note: L('智谱编码套餐的国内专用端点，接口与 GLM 相同', 'Zhipu’s coding plan mainland endpoint; the API is the same as GLM'),
    models: [],
  },
  {
    id: 'ollama',
    label: L('Ollama（本机）', 'Ollama (local)'),
    baseUrl: 'http://127.0.0.1:11434/v1',
    note: L('默认端口；不需要 Key', 'Default port; no key needed'),
    models: [],
  },
  {
    id: 'lmstudio',
    label: L('LM Studio（本机）', 'LM Studio (local)'),
    baseUrl: 'http://127.0.0.1:1234/v1',
    note: L('默认端口；不需要 Key', 'Default port; no key needed'),
    models: [],
  },
  {
    id: 'llamacpp',
    label: L('llama.cpp server（本机）', 'llama.cpp server (local)'),
    baseUrl: 'http://127.0.0.1:8080/v1',
    note: L('默认端口；不需要 Key', 'Default port; no key needed'),
    models: [],
  },
];

/** The preset a base URL belongs to, by normalized comparison. */
export function matchProvider(baseUrl: string): ProviderPreset | null {
  const wanted = normalizeBaseUrl(baseUrl ?? '');
  return PROVIDERS.find((provider) => normalizeBaseUrl(provider.baseUrl) === wanted) ?? null;
}

/** The documented model entry for a provider + model id, if there is one. */
export function matchModel(provider: ProviderPreset, modelId: string): ProviderModel | null {
  const id = (modelId ?? '').trim();
  if (id === '') return null;
  return provider.models.find((model) => model.id === id) ?? null;
}

/**
 * The window we can trust for an endpoint+model, or `null`: a value the provider
 * itself told us (learned from an overflow error) beats the shipped table, and
 * an endpoint or model the table does not know yields nothing.
 */
export function knownContextWindow(
  baseUrl: string,
  modelId: string,
  learned: Record<string, { contextWindow: number | null }> = {},
): number | null {
  const known = learned[limitKey(baseUrl, modelId)];
  if (known && typeof known.contextWindow === 'number' && known.contextWindow > 0) return known.contextWindow;
  const provider = matchProvider(baseUrl);
  if (provider === null) return null;
  const model = matchModel(provider, modelId);
  return model && typeof model.contextWindow === 'number' && model.contextWindow > 0
    ? model.contextWindow
    : null;
}

export interface ProviderContext {  provider: string;
  id: string;
  contextWindow: number | null;
  maxTokens: number | null;
  /** Where the numbers came from: the shipped table, or something we learned. */
  source: 'preset' | 'learned';
}

/** Flattens a preset's text for one language. */
function viewOf(provider: ProviderPreset, lang: InterfaceLanguage): ProviderPresetView {
  return {
    id: provider.id,
    label: localize(provider.label, lang),
    baseUrl: provider.baseUrl,
    note: localize(provider.note, lang),
    models: provider.models,
  };
}

/**
 * What the settings dialog needs in one call: the table, which entry the saved
 * base URL matches, and whether the saved model has limits to show. Deciding the
 * match on the server keeps the client free of URL-normalizing logic.
 *
 * `learned` is `store.loadModelLimits()`, keyed by `limitKey`; a window the
 * provider itself told us wins over the shipped table, because the table is
 * curated from documentation and the provider is the authority.
 */
export function providersPayload(
  baseUrl: string,
  modelId: string,
  learned: Record<string, { contextWindow: number | null; maxOutput: number | null }> = {},
  lang: InterfaceLanguage = 'zh-CN',
): {
  providers: ProviderPresetView[];
  active: string | null;
  current: ProviderContext | null;
} {
  const providers = PROVIDERS.map((provider) => viewOf(provider, lang));
  const provider = matchProvider(baseUrl);
  const key = limitKey(baseUrl, modelId);
  const known = learned[key] ?? null;

  // A learned value is shown even for an endpoint the table does not know: it is
  // the only limit we have for a hand-typed provider.
  if (known !== null && (known.contextWindow !== null || known.maxOutput !== null)) {
    return {
      providers,
      active: provider?.id ?? null,
      current: {
        provider: provider?.id ?? '',
        id: (modelId ?? '').trim(),
        contextWindow: known.contextWindow,
        maxTokens: known.maxOutput,
        source: 'learned',
      },
    };
  }
  if (provider === null) return { providers, active: null, current: null };
  const model = matchModel(provider, modelId);
  return {
    providers,
    active: provider.id,
    current: model === null
      ? null
      : {
        provider: provider.id,
        id: model.id,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        source: 'preset',
      },
  };
}
