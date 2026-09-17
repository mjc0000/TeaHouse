/**
 * Focus management shared by the modal and the floating menu.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusableWithin(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(
    (node) => node.offsetParent !== null || node === document.activeElement,
  );
}

export function focusFirst(root) {
  const [first] = focusableWithin(root);
  if (first) first.focus();
  else root.focus();
}

/** Keeps Tab inside `root` while it is open. */
export function trapFocus(root, event) {
  if (event.key !== 'Tab') return;
  const items = focusableWithin(root);
  if (items.length === 0) {
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Remembers where focus was, and puts it back afterwards. */
export function captureFocus() {
  const previous = document.activeElement;
  return () => {
    if (previous instanceof HTMLElement && document.contains(previous)) previous.focus();
  };
}

let lockCount = 0;

export function lockScroll() {
  lockCount++;
  if (lockCount === 1) document.body.classList.add('scroll-locked');
  return () => {
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) document.body.classList.remove('scroll-locked');
  };
}
