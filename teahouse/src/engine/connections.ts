/**
 * Extra connections: more places a reply can come from.
 *
 * The chat endpoint in `config.json` stays the default (and the only thing older
 * data knows). On top of it this file holds any number of named connections —
 * `{ id, label, baseUrl, apiKey, model }` — and a group member may point at one
 * in `meta.memberConnections`, so Enola can answer through one provider while
 * Haena answers through another.
 *
 * The key never travels back to the client: routes mask it exactly like the
 * main one (`GET` returns `***`), and a save that sends `***` keeps the stored
 * value instead of overwriting it with the mask.
 *
 * Resolution order for a turn: the speaker's connection → the chat's own model
 * override → the configured default. A connection that has been deleted, or a
 * member with no connection, falls back the same way — a chat never breaks
 * because a setting moved.
 */

export interface Connection {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ConnectionFile {
  version: 1;
  items: Connection[];
}

export const EMPTY_CONNECTIONS: ConnectionFile = { version: 1, items: [] };

/** What the client is allowed to see: the key is present but masked. */
export function maskConnections(file: ConnectionFile): ConnectionFile {
  return {
    version: 1,
    items: file.items.map((item) => ({ ...item, apiKey: item.apiKey === '' ? '' : '***' })),
  };
}

function coerceConnection(raw: unknown): Connection {
  const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    id: typeof item.id === 'string' ? item.id : '',
    label: typeof item.label === 'string' ? item.label : '',
    baseUrl: typeof item.baseUrl === 'string' ? item.baseUrl : '',
    apiKey: typeof item.apiKey === 'string' ? item.apiKey : '',
    model: typeof item.model === 'string' ? item.model : '',
  };
}

/**
 * Validates a file for saving. An endpoint and a model are what make a
 * connection usable, so both are required; the key is optional (a local runtime
 * needs none). Ids must be unique, and `***` keeps the stored key of that id.
 */
export function coerceConnectionFile(
  body: unknown,
  stored: Connection[] = [],
): { file: ConnectionFile; problems: string[] } {
  const root = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const raws = Array.isArray(root.items) ? root.items : [];
  const items = raws.map(coerceConnection).map((item) => {
    if (item.apiKey !== '***') return item;
    const previous = stored.find((candidate) => candidate.id === item.id);
    return { ...item, apiKey: previous?.apiKey ?? '' };
  });
  const problems: string[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const where = item.label.trim() !== '' ? `「${item.label}」` : `第 ${index + 1} 条连接`;
    if (item.id === '') problems.push(`${where}没有 id`);
    else if (seen.has(item.id)) problems.push(`有两条连接用了同一个 id：${item.id}`);
    else seen.add(item.id);
    if (item.label.trim() === '') problems.push(`${where}没有名字`);
    if (item.baseUrl.trim() === '') problems.push(`${where}没有接口地址`);
    if (item.model.trim() === '') problems.push(`${where}没有模型名`);
  });
  return { file: { version: 1, items }, problems };
}

/** The endpoint shape the LLM layer needs, plus where it came from. */
export interface ResolvedConnection {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** The connection's id and label, or empty strings for the chat default. */
  id: string;
  label: string;
}

/** A chat-level model override or the configured default, with no connection. */
function chatDefault(
  config: { baseUrl?: string; apiKey?: string; model?: string },
  chatModel: string,
): ResolvedConnection {
  return {
    baseUrl: config.baseUrl ?? '',
    apiKey: config.apiKey ?? '',
    model: chatModel,
    id: '',
    label: '',
  };
}

/**
 * The connection a turn actually uses: the one named by `connectionId`, else the
 * chat's own endpoint and model. An id that no longer exists is ignored rather
 * than fatal — a chat never breaks because a connection was deleted.
 */
export function resolveConnection(
  config: { baseUrl?: string; apiKey?: string; model?: string },
  connections: Connection[],
  connectionId: string | null | undefined,
  chatModel: string,
): ResolvedConnection {
  if (typeof connectionId === 'string' && connectionId !== '') {
    const found = connections.find((candidate) => candidate.id === connectionId);
    if (found) {
      return {
        baseUrl: found.baseUrl,
        apiKey: found.apiKey,
        model: found.model,
        id: found.id,
        label: found.label,
      };
    }
  }
  return chatDefault(config, chatModel);
}
