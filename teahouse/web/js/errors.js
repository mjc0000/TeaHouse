/**
 * Error surface.
 *
 * A no-build client has no bundler to catch mistakes, and a failure inside an
 * event handler is invisible: the button simply does nothing. Every uncaught
 * error and rejected promise is reported as a toast (so it is visible without a
 * console) and to the console (so it is inspectable).
 */

import { toastError } from './components/toast.js';
import { t } from './i18n.js';

const seen = new Map();

function report(source, error) {
  const message = error instanceof Error ? error.message : String(error);
  const detail = error instanceof Error && error.stack ? error.stack.split('\n')[1]?.trim() : '';
  const key = `${source}:${message}`;

  // Repeated failures (a render loop, for instance) should not spam the corner.
  const count = (seen.get(key) ?? 0) + 1;
  seen.set(key, count);
  if (count > 3) return;

  console.error(`[teahouse] ${source}:`, error);
  try {
    toastError(t('errors.line', { source, message }), {
      detail: count > 1 ? t('errors.repeat', { count, detail: detail ?? '' }) : detail,
      duration: 9000,
    });
  } catch {
    /* the toast host itself may not be reachable yet; the console line stands */
  }
}

/** Reports an error that was caught somewhere else (bootstrap, for instance). */
export function reportError(source, error) {
  report(source, error);
}

export function installErrorSurface() {
  window.addEventListener('error', (event) => {
    report(t('errors.pageError'), event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    report(t('errors.unhandledRejection'), event.reason);
  });
}

/**
 * Wraps a handler so a throw inside it becomes a visible report instead of a
 * dead control. Used for the top-level click handlers.
 */
export function guard(label, handler) {
  return (...args) => {
    try {
      const result = handler(...args);
      if (result instanceof Promise) {
        result.catch((error) => report(label, error));
      }
      return result;
    } catch (error) {
      report(label, error);
      return undefined;
    }
  };
}
