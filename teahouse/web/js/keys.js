/**
 * Keyboard handling.
 *
 * Two mechanisms, both so shortcuts are declared rather than scattered:
 *
 *   registerKey(...)    global shortcuts with a `when` predicate
 *   pushEscapeLayer(fn) a stack of "close me" callbacks
 *
 * The escape stack is what makes Esc close the *topmost* layer — a context menu
 * sitting on a modal closes the menu and leaves the modal open, which is what
 * users expect and what a single global Esc handler cannot express.
 */

const shortcuts = [];
const escapeLayers = [];
let installed = false;

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * @param {object} spec
 * @param {string} spec.key        key value, lower-case (e.g. 'enter', 'escape', 'e')
 * @param {boolean} [spec.ctrl]    require ctrl (or meta)
 * @param {boolean} [spec.shift]   require shift
 * @param {boolean} [spec.alt]     require alt
 * @param {boolean} [spec.inInput] allow firing while typing in a field
 * @param {() => boolean} [spec.when] extra predicate
 * @param {(event: KeyboardEvent) => void} spec.handler
 * @param {string} [spec.description]
 */
export function registerKey(spec) {
  shortcuts.push({
    ctrl: false,
    shift: false,
    alt: false,
    inInput: false,
    ...spec,
  });
}

/** Returns a function that removes the layer again. */
export function pushEscapeLayer(onEscape) {
  escapeLayers.push(onEscape);
  return () => {
    const index = escapeLayers.lastIndexOf(onEscape);
    if (index !== -1) escapeLayers.splice(index, 1);
  };
}

export function escapeStackDepth() {
  return escapeLayers.length;
}

function matches(spec, event) {
  const key = String(event.key).toLowerCase();
  if (key !== spec.key) return false;
  const ctrl = event.ctrlKey || event.metaKey;
  if (Boolean(spec.ctrl) !== ctrl) return false;
  if (Boolean(spec.shift) !== event.shiftKey) return false;
  if (Boolean(spec.alt) !== event.altKey) return false;
  if (spec.when && !spec.when(event)) return false;
  if (!spec.inInput && !spec.ctrl && isTypingTarget(event.target)) return false;
  return true;
}

function onKeydown(event) {
  // Escape is handled by the layer stack first, so a single press closes exactly
  // one thing.
  if (event.key === 'Escape' && escapeLayers.length > 0) {
    const handler = escapeLayers[escapeLayers.length - 1];
    handler(event);
    event.preventDefault();
    return;
  }

  for (const spec of shortcuts) {
    if (!matches(spec, event)) continue;
    spec.handler(event);
    event.preventDefault();
    return;
  }
}

export function installKeys(target = document) {
  if (installed) return;
  target.addEventListener('keydown', onKeydown);
  installed = true;
}

export function keyHelp() {
  return shortcuts
    .filter((spec) => spec.description)
    .map((spec) => ({ key: spec.key, ctrl: Boolean(spec.ctrl), shift: Boolean(spec.shift), description: spec.description }));
}
