/**
 * Panel layout: which side panels are showing, what the right one is showing,
 * and how wide the columns are.
 *
 * IDE-like collapse, with the state persisted and the buttons kept in sync, so
 * the two toggles behave like real view toggles rather than one-off buttons.
 * Works on the `.layout` grid through its CSS variables and classes; it never
 * writes `grid-template-columns` itself.
 *
 * The right column has two modes — the prompt panel (`prompt`) and the trajectory
 * (`trace`). The mode lives here rather than in a view because it is a layout
 * fact: it decides which content fills the column and how wide the column is,
 * and each mode remembers its own width.
 */

import { registerKey } from '../keys.js';
import { t } from '../i18n.js';

const STORAGE_KEY = 'teahouse.layout.v1';

export const PANELS = { left: 'left', right: 'right' };

/** What the right column shows. */
export const RIGHT_MODES = { prompt: 'prompt', trace: 'trace' };

/** Drag limits in CSS pixels. The centre never drops below its own minimum. */
const MIN_LEFT = 200;
const MIN_RIGHT = 280;
const MIN_CENTER = 360;
/** Width of one divider track, matching `--gutter-*` in the stylesheet. */
const GUTTER = 6;
/** Arrow-key resize step. */
const KEY_STEP = 16;

/** The state key a side's width is stored under; the right one is per mode. */
function widthKey(side, mode) {
  if (side === PANELS.left) return 'leftWidth';
  return mode === RIGHT_MODES.trace ? 'traceWidth' : 'promptWidth';
}

function loadState() {
  const fallback = { left: true, right: true, mode: RIGHT_MODES.prompt };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    const width = (value) => (Number.isFinite(value) && value > 0 ? value : undefined);
    return {
      left: parsed.left !== false,
      right: parsed.right !== false,
      mode: parsed.mode === RIGHT_MODES.trace ? RIGHT_MODES.trace : RIGHT_MODES.prompt,
      leftWidth: width(parsed.leftWidth),
      promptWidth: width(parsed.promptWidth),
      traceWidth: width(parsed.traceWidth),
    };
  } catch {
    return fallback;
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage may be unavailable; collapsing still works for this session */
  }
}

/** Sets or clears one CSS custom property, without assuming `setProperty`. */
function setVar(node, name, value) {
  const style = node.style;
  if (value === '') {
    if (typeof style.removeProperty === 'function') style.removeProperty(name);
    else delete style[name];
    return;
  }
  if (typeof style.setProperty === 'function') style.setProperty(name, value);
  else style[name] = value;
}

export function createLayoutController(options = {}) {
  const visibility = loadState();
  const layout = document.querySelector('.layout');
  const panel = document.querySelector('.panel-right');
  const resizers = {
    left: document.querySelector('.resizer-left'),
    right: document.querySelector('.resizer-right'),
  };
  const buttons = {
    left: document.getElementById('btn-toggle-left'),
    right: document.getElementById('btn-toggle-right'),
  };
  const traceButton = document.getElementById('btn-trace');

  const panelWidth = (selector) => {
    const node = document.querySelector(selector);
    return node ? node.getBoundingClientRect().width : 0;
  };

  /** The stored width for `side` in the current mode, if it ever got one. */
  function widthOf(side) {
    const value = visibility[widthKey(side, visibility.mode)];
    return Number.isFinite(value) ? value : undefined;
  }

  /** Clamps a desired width so the centre and the other panel keep their room. */
  function clamp(side, px) {
    const min = side === PANELS.left ? MIN_LEFT : MIN_RIGHT;
    const rounded = Math.round(Number.isFinite(px) ? px : min);
    const total = layout ? layout.clientWidth : 0;
    // No measurable layout (the boot shim): keep the plain value so the drag
    // logic is still exercised without pretending to have pixels.
    if (total === 0) return Math.max(min, rounded);
    const gutters = (visibility.left ? GUTTER : 0) + (visibility.right ? GUTTER : 0);
    const other = side === PANELS.left ? panelWidth('.panel-right') : panelWidth('.panel-left');
    const max = Math.max(min, total - gutters - MIN_CENTER - other);
    return Math.min(Math.max(min, rounded), max);
  }

  function storeWidth(side, px, persist) {
    const value = clamp(side, px);
    visibility[widthKey(side, visibility.mode)] = value;
    if (persist) saveState(visibility);
    return value;
  }

  /** Writes the current widths onto the grid. Cheap: no events, no classes. */
  function paint() {
    if (!layout) return;
    const left = visibility.left && Number.isFinite(visibility.leftWidth) ? `${visibility.leftWidth}px` : '';
    const rightValue = visibility[widthKey(PANELS.right, visibility.mode)];
    const right = visibility.right && Number.isFinite(rightValue) ? `${rightValue}px` : '';
    setVar(layout, '--track-left', left);
    setVar(layout, '--track-right', right);
  }

  function apply() {
    if (layout) {
      layout.classList.toggle('hide-left', !visibility.left);
      layout.classList.toggle('hide-right', !visibility.right);
      // `:not(.hide-right)` in the stylesheet keeps collapsing the winner: a hidden
      // panel must not be widened by the mode.
      layout.classList.toggle('trace-mode', visibility.mode === RIGHT_MODES.trace);
      paint();
    }
    panel?.classList.toggle('mode-trace', visibility.mode === RIGHT_MODES.trace);
    for (const side of Object.keys(buttons)) {
      const button = buttons[side];
      if (!button) continue;
      button.setAttribute('aria-pressed', visibility[side] ? 'true' : 'false');
    }
    if (traceButton) {
      const on = visibility.mode === RIGHT_MODES.trace;
      traceButton.setAttribute('aria-pressed', on ? 'true' : 'false');
      traceButton.title = on ? t('keys.traceBack') : t('keys.traceSwitch');
    }
    options.onChange?.({ ...visibility });
  }

  /** Re-clamps the stored widths after the window changed size. */
  function fitToWindow() {
    if (!layout || layout.clientWidth === 0) return;
    if (visibility.left && Number.isFinite(visibility.leftWidth)) {
      visibility.leftWidth = clamp(PANELS.left, visibility.leftWidth);
    }
    const value = widthOf(PANELS.right);
    if (visibility.right && value !== undefined) {
      visibility[widthKey(PANELS.right, visibility.mode)] = clamp(PANELS.right, value);
    }
    paint();
  }

  /** Pointer drag on a divider; the centre takes the difference either way. */
  function attachResizer(node, side) {
    if (!node) return;

    node.addEventListener('pointerdown', (event) => {
      if (typeof event.button === 'number' && event.button !== 0) return;
      const startX = event.clientX;
      const startWidth = widthOf(side) ?? panelWidth(side === PANELS.left ? '.panel-left' : '.panel-right');
      node.classList.add('dragging');
      // Pointer capture where the DOM has it; without it (the boot shim) the
      // listeners below still see the moves.
      node.setPointerCapture?.(event.pointerId);
      event.preventDefault?.();

      const move = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        // Dragging the left divider right widens the left column; the right
        // divider is mirrored.
        const wanted = side === PANELS.left ? startWidth + delta : startWidth - delta;
        storeWidth(side, wanted, false);
        paint();
      };
      const up = () => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        node.removeEventListener('pointercancel', up);
        node.classList.remove('dragging');
        node.releasePointerCapture?.(event.pointerId);
        saveState(visibility);
        apply();
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
    });

    node.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? KEY_STEP * 3 : KEY_STEP;
      let delta = 0;
      if (event.key === 'ArrowLeft') delta = side === PANELS.left ? -step : step;
      else if (event.key === 'ArrowRight') delta = side === PANELS.left ? step : -step;
      else return;
      event.preventDefault?.();
      const current = widthOf(side) ?? panelWidth(side === PANELS.left ? '.panel-left' : '.panel-right');
      storeWidth(side, current + delta, true);
      apply();
    });
  }

  function set(side, visible) {
    visibility[side] = visible;
    saveState(visibility);
    apply();
  }

  function setMode(mode) {
    visibility.mode = mode === RIGHT_MODES.trace ? RIGHT_MODES.trace : RIGHT_MODES.prompt;
    saveState(visibility);
    apply();
  }

  const toggle = (side) => set(side, !visibility[side]);

  buttons.left?.addEventListener('click', () => toggle(PANELS.left));
  buttons.right?.addEventListener('click', () => toggle(PANELS.right));
  // Switching to the trajectory should also show the column it lives in.
  traceButton?.addEventListener('click', () => {
    setMode(visibility.mode === RIGHT_MODES.trace ? RIGHT_MODES.prompt : RIGHT_MODES.trace);
    if (visibility.mode === RIGHT_MODES.trace) set(PANELS.right, true);
  });

  registerKey({
    key: 'b',
    ctrl: true,
    description: t('keys.toggleLeft'),
    handler: () => toggle(PANELS.left),
  });
  registerKey({
    key: 'b',
    ctrl: true,
    alt: true,
    description: t('keys.toggleRight'),
    handler: () => toggle(PANELS.right),
  });
  registerKey({
    key: 't',
    ctrl: true,
    description: t('keys.toggleMode'),
    handler: () => {
      setMode(visibility.mode === RIGHT_MODES.trace ? RIGHT_MODES.prompt : RIGHT_MODES.trace);
      if (visibility.mode === RIGHT_MODES.trace) set(PANELS.right, true);
    },
  });

  attachResizer(resizers.left, PANELS.left);
  attachResizer(resizers.right, PANELS.right);
  // A window that shrank must not leave the centre crushed: re-clamp on resize.
  window.addEventListener('resize', fitToWindow);

  apply();
  fitToWindow();
  return {
    /** Named `panels` rather than `state`, which means the app store everywhere else. */
    get panels() {
      return { ...visibility };
    },
    get rightMode() {
      return visibility.mode;
    },
    isVisible: (side) => visibility[side],
    /** Widths in use, per side / mode; `undefined` means "the CSS default". */
    getWidths: () => ({
      left: visibility.leftWidth,
      prompt: visibility.promptWidth,
      trace: visibility.traceWidth,
    }),
    setWidth(side, px) {
      const value = storeWidth(side, px, true);
      apply();
      return value;
    },
    setMode,
    toggle,
    set,
    show: (side) => set(side, true),
    hide: (side) => set(side, false),
  };
}
