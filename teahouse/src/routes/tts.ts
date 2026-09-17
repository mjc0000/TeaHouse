/**
 * Reading aloud, online half.
 *
 * `POST /api/tts/speak { text }` proxies an OpenAI-compatible
 * `/audio/speech` endpoint and hands the bytes back. Proxying (rather than
 * calling the provider from the browser) keeps the key on this machine and
 * dodges provider CORS entirely; the client only ever sees audio bytes.
 *
 * The local half needs no endpoint at all: the browser's own voices speak
 * through `speechSynthesis`, offline and free.
 */

import { badRequest, readJson } from '../http/respond.ts';
import type { Router } from '../http/router.ts';
import { normalizeBaseUrl } from '../llm/openai-compat.ts';
import type { Store } from '../store/db.ts';

/** One message is one call; longer texts are refused, not silently cut. */
export const MAX_SPEAK_CHARS = 4000;
/** 10 MiB of audio is already several minutes; more is not a chat message. */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export function registerTtsRoutes(router: Router, store: Store): void {
  router.add('POST', '/api/tts/speak', async ({ request, response }) => {
    const body = await readJson<{ text?: unknown }>(request);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text === '') throw badRequest('text is required');
    if (text.length > MAX_SPEAK_CHARS) {
      throw badRequest(`text is too long (${text.length} chars, max ${MAX_SPEAK_CHARS})`);
    }

    const tts = store.loadConfig().tts;
    if (tts.mode !== 'online') throw badRequest('online speech is switched off');
    if (tts.apiKey.trim() === '') throw badRequest('no API key configured');
    const base = normalizeBaseUrl(tts.baseUrl ?? '');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let upstream: Response;
    try {
      upstream = await fetch(`${base}/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tts.apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: tts.model || 'tts-1',
          input: text,
          voice: tts.onlineVoice || 'alloy',
          response_format: 'mp3',
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw badRequest(`speech provider unreachable: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      throw badRequest(`speech provider returned ${upstream.status}: ${detail.slice(0, 300)}`);
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length === 0) throw badRequest('speech provider returned no audio');
    if (bytes.length > MAX_AUDIO_BYTES) throw badRequest('speech audio is larger than 10 MiB');
    response.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') ?? 'audio/mpeg',
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store, must-revalidate',
    });
    response.end(bytes);
  });
}
