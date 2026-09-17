/**
 * Reading replies aloud, two engines.
 *
 * Local speaks through the browser's own voices (`speechSynthesis`: offline,
 * free, zero configuration); online posts the text to `/api/tts/speak`, which
 * proxies an OpenAI-compatible endpoint so the key never leaves this machine.
 * Only one thing speaks at a time — starting another stops the first, and so
 * does sending a new turn.
 *
 * Nothing here runs at import time: the module is safe to load where neither
 * engine exists (the test shim, a speechless browser), and every missing
 * capability fails with a sentence instead of silence.
 */

import { state } from './api.js';
import { t } from './i18n.js';

/** What is speaking right now, if anything. */
let current = null;

/**
 * TeX to listenable words: commands become their names, braces and scripts
 * become pauses. `\frac{a}{b}` reads "frac a b" — not pretty, but nothing
 * like a backslash does.
 */
export function texWords(tex) {
  return String(tex ?? '')
    .replace(/\\[a-zA-Z]+/g, (command) => ` ${command.slice(1)} `)
    .replace(/[{}^_&]/g, ' ')
    .replace(/\\(.)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Markdown is for eyes, not ears: strip the markers but keep the words, so the
 * voice does not read asterisks aloud.
 */
export function stripForSpeech(text) {
  return String(text ?? '')
    .replace(/\\\[[\s\S]*?\\\]/g, (block) => ` ${texWords(block.slice(2, -2))} `)
    .replace(/\$\$[\s\S]*?\$\$/g, (block) => ` ${texWords(block.slice(2, -2))} `)
    .replace(/\\\([\s\S]*?\\\)/g, (span) => ` ${texWords(span.slice(2, -2))} `)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\W)[*_~]([^*_~\n]+)[*_~]/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

function systemVoices() {
  try {
    return typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices();
  } catch {
    return [];
  }
}

/**
 * What the voice field stores for a system voice. `voiceURI` is the stable
 * id, but some browsers leave it empty — then the name is the only thing
 * that tells options apart (and the only thing a reader can match later).
 */
export function voiceKey(voice) {
  return voice?.voiceURI || voice?.name || '';
}

/** The stored field matches a live voice by id or, failing that, by name. */
export function matchesVoice(voice, stored) {
  if (!stored) return false;
  return voice?.voiceURI === stored || voice?.name === stored;
}

function speakLocal(text, voiceURI, rate) {
  if (typeof speechSynthesis === 'undefined') throw new Error(t('tts.noSpeechSynthesis'));
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = systemVoices();
  const picked = voices.find((voice) => matchesVoice(voice, voiceURI))
    ?? voices.find((voice) => typeof voice.lang === 'string' && voice.lang.toLowerCase().startsWith('zh'))
    ?? null;
  if (picked) utterance.voice = picked;
  if (Number.isFinite(rate) && rate > 0) utterance.rate = rate;
  return { utterance };
}

async function playOnline(text) {
  // Raw fetch on purpose: the shared `api()` helper reads bodies as text,
  // which would corrupt the audio bytes.
  const response = await fetch('/api/tts/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    let message = `HTTP ${response.status}`;
    try {
      message = JSON.parse(detail)?.error ?? message;
    } catch {
      if (detail !== '') message = detail.slice(0, 200);
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  if (typeof Audio === 'undefined') throw new Error(t('tts.noAudio'));
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  try {
    await audio.play();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw new Error(t('tts.playFailed', { error: error.message }));
  }
  return { audio, url };
}

/** Reads one transcript entry; reading it again while it speaks stops it. */
export async function speakEntry(entry, text) {
  if (current && current.entryId === entry.id) {
    stopSpeech();
    return;
  }
  stopSpeech();
  const said = stripForSpeech(text);
  if (said === '') throw new Error(t('tts.nothingToRead'));
  const mode = state.config?.tts?.mode ?? 'local';
  if (mode === 'online') {
    const { audio, url } = await playOnline(said);
    await new Promise((resolve) => {
      const done = () => {
        URL.revokeObjectURL(url);
        if (current?.entryId === entry.id) current = null;
        resolve();
      };
      current = {
        entryId: entry.id,
        stop: () => {
          try {
            audio.pause();
          } finally {
            done();
          }
        },
      };
      audio.onended = done;
      audio.onerror = done;
    });
    return;
  }
  const voiceURI = state.config?.tts?.voice ?? '';
  const rate = Number(state.config?.tts?.rate);
  const { utterance } = speakLocal(said, voiceURI, Number.isFinite(rate) ? rate : 1);
  await new Promise((resolve, reject) => {
    utterance.onend = () => {
      if (current?.entryId === entry.id) current = null;
      resolve();
    };
    utterance.onerror = () => {
      if (current?.entryId === entry.id) current = null;
      reject(new Error(t('tts.interrupted')));
    };
    current = {
      entryId: entry.id,
      stop: () => {
        try {
          speechSynthesis.cancel();
        } finally {
          if (current?.entryId === entry.id) current = null;
          resolve();
        }
      },
    };
    try {
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    } catch (error) {
      if (current?.entryId === entry.id) current = null;
      reject(error);
    }
  });
}

/** The settings page tries each engine with one sentence. */
export async function speakSample(engine, localOpts = {}) {
  stopSpeech();
  if (engine === 'online') {
    const { audio, url } = await playOnline(t('tts.onlineSample'));
    await new Promise((resolve) => {
      const done = () => {
        URL.revokeObjectURL(url);
        current = null;
        resolve();
      };
      current = {
        entryId: null,
        stop: () => {
          try {
            audio.pause();
          } finally {
            done();
          }
        },
      };
      audio.onended = done;
      audio.onerror = done;
    });
    return;
  }
  if (typeof speechSynthesis === 'undefined') throw new Error(t('tts.noSpeechSynthesis'));
  const { utterance } = speakLocal(t('tts.localSample'), localOpts.voice ?? '', localOpts.rate ?? 1);
  await new Promise((resolve, reject) => {
    utterance.onend = () => {
      current = null;
      resolve();
    };
    utterance.onerror = () => {
      current = null;
      reject(new Error(t('tts.interrupted')));
    };
    current = { entryId: null, stop: () => speechSynthesis.cancel() };
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  }).finally(() => {
    current = null;
  });
}

export function isSpeaking(entryId) {
  return current !== null && (entryId === undefined || current.entryId === entryId);
}

export function stopSpeech() {
  const speaking = current;
  current = null;
  try {
    speaking?.stop();
  } catch {
    /* already gone */
  }
  try {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  } catch {
    /* already gone */
  }
}
