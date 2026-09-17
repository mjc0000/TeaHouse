/**
 * A tiny DOM test double.
 *
 * The interaction layer — views, components, focus handling, the Escape stack —
 * cannot be checked in a browser here, and pulling in jsdom would add the only
 * dependency this project has. So this implements the small slice of the DOM
 * that `web/js` actually touches: elements, classes, attributes, a bubbling
 * `fire`, `querySelector` for the handful of selectors the client uses, focus,
 * and `localStorage`.
 *
 * It is deliberately not a general DOM: anything unimplemented is simply absent,
 * so a component that reaches for a new API fails loudly instead of quietly
 * behaving differently from a browser. The one place that bites is
 * `offsetParent`, which mirrors the browser rule that a node inside `[hidden]`
 * is not focusable — `focus.js` depends on it for its Tab trap.
 *
 * Not part of the shipped app: this file is only imported by `scripts/test-ui.ts`.
 */

class ShimNode {
  childNodes: ShimNode[] = [];
  parentNode: ShimNode | null = null;
  nodeType = 0;

  /**
   * Accessors, never a class field: a field would be an own property and would
   * shadow these, so a container would read as '' instead of the text of its
   * children.
   */
  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.childNodes = [new ShimText(value)];
  }
}

class ShimText extends ShimNode {
  private ownText: string;

  constructor(text: unknown) {
    super();
    this.nodeType = 3;
    this.ownText = String(text);
  }
  override get textContent(): string {
    return this.ownText;
  }
  override set textContent(value: string) {
    this.ownText = String(value);
  }
  /** `CharacterData.appendData`: the stream's per-token text append. */
  appendData(text: unknown): void {
    this.ownText += String(text);
  }
}

/** One simple selector: `tag`, `.class`, `#id`, `[attr]`, `[attr="v"]`, `:not(...)`. */
function parseSimple(selector: string): RegExpExecArray[] | null {
  const parts: RegExpExecArray[] = [];
  let rest = selector.trim();
  const pattern =
    /^([a-zA-Z][\w-]*)|^([.#][\w-]+)|^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]|^:not\(([^)]*)\)/;
  while (rest.length > 0) {
    const match = pattern.exec(rest);
    if (!match) return null;
    parts.push(match);
    rest = rest.slice(match[0].length);
  }
  return parts;
}

function matchesSimple(node: ShimElement, selector: string): boolean {
  const parts = parseSimple(selector);
  if (!parts || parts.length === 0) return false;
  for (const part of parts) {
    if (part[1] && node.tagName !== part[1].toUpperCase()) return false;
    if (part[2]) {
      const token = part[2];
      if (token[0] === '.' && !node.classList.contains(token.slice(1))) return false;
      if (token[0] === '#' && node.getAttribute('id') !== token.slice(1)) return false;
    }
    if (part[3]) {
      if (!node.hasAttribute(part[3])) return false;
      if (part[4] !== undefined && node.getAttribute(part[3]) !== part[4]) return false;
    }
    if (part[5] !== undefined && matchesSelector(node, part[5])) return false;
  }
  return true;
}

/**
 * Splits on a separator that sits outside brackets and parentheses, so
 * `[data-x="a b"]` and `:not([tabindex="-1"])` survive.
 */
function splitTopLevel(selector: string, separators: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (const character of selector) {
    if (character === '[' || character === '(') depth++;
    if (character === ']' || character === ')') depth--;
    if (depth === 0 && separators.includes(character)) {
      if (current.trim() !== '') parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/**
 * Matches a selector list. Supports compound selectors (`div.a[href]`),
 * descendant combinators (`.pane code`) and `:not(...)`; that is everything the
 * client and these tests use.
 */
export function matchesSelector(node: ShimElement, selector: string): boolean {
  return splitTopLevel(selector, ',').some((piece) => {
    const steps = splitTopLevel(piece, ' \t\n');
    const last = steps[steps.length - 1];
    if (!last || !matchesSimple(node, last)) return false;

    // Walk up, matching the remaining steps from right to left.
    let current: ShimNode | null = node.parentNode;
    for (let index = steps.length - 2; index >= 0; index--) {
      const step = steps[index]!;
      let found = false;
      while (current) {
        if (current instanceof ShimElement && matchesSimple(current, step)) {
          found = true;
          current = current.parentNode;
          break;
        }
        current = current.parentNode;
      }
      if (!found) return false;
    }
    return true;
  });
}

/** Set by `installDom`, so `element.click()` can bubble like a real click. */
let dispatcher: ((target: ShimElement, type: string, props: Partial<ShimEvent>) => void) | null =
  null;

export class ShimElement extends ShimNode {  tagName: string;
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event: ShimEvent) => void)[]>();
  /** Inline styles are assigned, never read back by the client. */
  style: Record<string, string> = {};
  value = '';
  checked = false;
  disabled = false;
  tabIndex = 0;
  private classes = new Set<string>();
  private ownText = '';

  constructor(tag: string) {
    super();
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
  }

  get id(): string {
    return this.getAttribute('id') ?? '';
  }

  /**
   * `dataset` reflects onto `data-*` attributes, the way a browser does it. It was a
   * plain object once, which meant `el('button', { dataset: { accent: 'teal' } })`
   * was invisible to a `[data-accent="teal"]` selector — the client looked correct
   * and the shim quietly said no.
   */
  get dataset(): Record<string, string> {
    const attributes = this.attributes;
    const fromKey = (key: string) => `data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    const toKey = (name: string) =>
      name.slice(5).replace(/-([a-z])/g, (_all, letter: string) => letter.toUpperCase());
    return new Proxy({} as Record<string, string>, {
      get: (_target, key: string) => attributes.get(fromKey(key)),
      set: (_target, key: string, value: unknown) => {
        attributes.set(fromKey(key), String(value));
        return true;
      },
      has: (_target, key: string) => attributes.has(fromKey(key)),
      deleteProperty: (_target, key: string) => {
        attributes.delete(fromKey(key));
        return true;
      },
      ownKeys: () =>
        [...attributes.keys()].filter((name) => name.startsWith('data-')).map(toKey),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
  }

  get className(): string {
    return [...this.classes].join(' ');
  }
  set className(value: string) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get classList() {
    const classes = this.classes;
    return {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      contains: (name: string) => classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
    };
  }

  get hidden(): boolean {
    return this.attributes.has('hidden');
  }
  set hidden(value: boolean) {
    if (value) this.attributes.set('hidden', '');
    else this.attributes.delete('hidden');
  }

  override get textContent(): string {
    if (this.childNodes.length === 0) return this.ownText;
    return this.childNodes.map((child) => child.textContent).join('');
  }
  override set textContent(value: string) {
    this.childNodes = [];
    this.ownText = String(value ?? '');
  }

  get children(): ShimElement[] {
    return this.childNodes.filter((node): node is ShimElement => node.nodeType === 1);
  }

  /** `dom.js`'s `clear()` empties a node through these two. */
  get firstChild(): ShimNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): ShimNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get firstElementChild(): ShimElement | null {
    return this.children[0] ?? null;
  }
  get lastElementChild(): ShimElement | null {
    return this.children[this.children.length - 1] ?? null;
  }
  get parentElement(): ShimElement | null {
    return this.parentNode instanceof ShimElement ? this.parentNode : null;
  }
  /** Walk the sibling list in either direction, skipping text nodes. */
  private siblingElement(step: number): ShimElement | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    for (let index = siblings.indexOf(this) + step; index >= 0 && index < siblings.length; index += step) {
      if (siblings[index]!.nodeType === 1) return siblings[index] as ShimElement;
    }
    return null;
  }
  get nextElementSibling(): ShimElement | null {
    return this.siblingElement(1);
  }
  get previousElementSibling(): ShimElement | null {
    return this.siblingElement(-1);
  }

  removeChild(child: ShimNode): ShimNode {
    const index = this.childNodes.indexOf(child);
    if (index !== -1) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  insertBefore(child: ShimNode, reference: ShimNode | null): ShimNode {
    child.parentNode = this;
    const index = reference ? this.childNodes.indexOf(reference) : -1;
    if (index === -1) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    return child;
  }

  prepend(...nodes: unknown[]): void {
    const added = nodes
      .filter((node): node is ShimNode => node instanceof ShimNode)
      .map((node) => {
        node.parentNode = this;
        return node;
      });
    this.childNodes.unshift(...added);
  }

  before(node: ShimNode): void {
    if (!this.parentNode) return;
    node.parentNode = this.parentNode;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 0, node);
  }

  replaceChild(next: ShimNode, previous: ShimNode): ShimNode {
    const index = this.childNodes.indexOf(previous);
    if (index !== -1) {
      next.parentNode = this;
      previous.parentNode = null;
      this.childNodes.splice(index, 1, next);
    }
    return previous;
  }

  cloneNode(): ShimElement {
    const copy = new ShimElement(this.tagName);
    copy.className = this.className;
    for (const [key, value] of this.attributes) copy.setAttribute(key, value);
    copy.value = this.value;
    copy.checked = this.checked;
    copy.disabled = this.disabled;
    return copy;
  }

  /** Scroll metrics exist as plain numbers: the client assigns them, and
   *  `container.scrollTop = container.scrollHeight` must not throw. */
  scrollTop = 0;
  scrollLeft = 0;
  get scrollHeight(): number {
    return this.childNodes.length;
  }
  get clientHeight(): number {
    return this.childNodes.length;
  }
  get clientWidth(): number {
    return 0;
  }
  get offsetHeight(): number {
    return 0;
  }

  /** Hidden ancestors make a node unfocusable, as in a browser. */
  get offsetParent(): ShimNode | null {
    for (let node: ShimNode | null = this; node; node = node.parentNode) {
      if (node instanceof ShimElement && node.hidden) return null;
    }
    return this.parentNode ?? this;
  }

  /** `createModal` appends at construction, then checks this before showing. */
  get isConnected(): boolean {
    for (let node: ShimNode | null = this; node; node = node.parentNode) {
      if (node === document.body) return true;
    }
    return false;
  }

  setAttribute(key: string, value: unknown): void {
    // `class` goes through the same path as the `className` property in a
    // browser, so `classList` and class selectors stay in sync.
    if (key === 'class') {
      this.className = String(value);
      return;
    }
    this.attributes.set(key, String(value));
  }
  removeAttribute(key: string): void {
    if (key === 'class') this.classes = new Set();
    this.attributes.delete(key);
  }
  getAttribute(key: string): string | null {
    return this.attributes.has(key) ? this.attributes.get(key)! : null;
  }
  hasAttribute(key: string): boolean {
    return this.attributes.has(key);
  }

  /**
   * Faithful to `Element.append()`: a Node is inserted as a node, anything else
   * is converted to a string — including `null`, which becomes the *text*
   * `"null"` rather than being skipped. Getting this wrong once hid a real bug:
   * `body.append(maybeNullBlock, textNode)` leaked the word "null" into every
   * message in the browser while these suites stayed green.
   */
  append(...nodes: unknown[]): this {
    for (const node of nodes) {
      const child = node instanceof ShimNode ? node : new ShimText(String(node));
      child.parentNode = this;
      this.childNodes.push(child);
    }
    return this;
  }

  after(node: ShimNode): void {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    node.parentNode = this.parentNode;
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
  }

  remove(): void {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    const index = siblings.indexOf(this);
    if (index !== -1) siblings.splice(index, 1);
    this.parentNode = null;
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }

  closest(selector: string): ShimElement | null {
    for (let node: ShimNode | null = this; node; node = node.parentNode) {
      if (node instanceof ShimElement && matchesSelector(node, selector)) return node;
    }
    return null;
  }

  descendants(out: ShimElement[] = []): ShimElement[] {
    for (const child of this.childNodes) {
      if (child instanceof ShimElement) {
        out.push(child);
        child.descendants(out);
      }
    }
    return out;
  }

  querySelectorAll(selector: string): ShimElement[] {
    return this.descendants().filter((node) => matchesSelector(node, selector));
  }
  querySelector(selector: string): ShimElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  contains(node: ShimNode | null): boolean {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  addEventListener(type: string, handler: (event: ShimEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  removeEventListener(type: string, handler: (event: ShimEvent) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== handler));
  }

  focus(): void {
    document.activeElement = this;
  }
  blur(): void {
    if (document.activeElement === this) document.activeElement = null;
  }
  /** Set by `installDom`, so a programmatic click bubbles like a real one. */
  click(): void {
    dispatcher?.(this, 'click', {});
  }
  select(): void {}
  setSelectionRange(): void {}
  scrollIntoView(): void {}
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}

export interface ShimEvent {
  type: string;
  target: ShimElement;
  currentTarget?: ShimNode;
  key?: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
  [key: string]: unknown;
}

interface DocumentLike extends ShimElement {
  activeElement: ShimElement | null;
  body: ShimElement;
  documentElement: ShimElement;
  createElement(tag: string): ShimElement;
  createElementNS(namespace: string, tag: string): ShimElement;
  createTextNode(text: unknown): ShimText;
  getElementById(id: string): ShimElement | null;
}

export interface ShimDom {
  document: DocumentLike;
  /** Dispatches an event through the tree, bubbling like a browser. */
  fire(target: ShimElement | DocumentLike, type: string, props?: Partial<ShimEvent>): ShimEvent;
  click(target: ShimElement): void;
  /** Sets a control's value and fires the event the client listens for. */
  type(target: ShimElement, value: string): void;
  text(node: ShimNode | null | undefined): string;
  all(selector: string): ShimElement[];
  one(selector: string): ShimElement | null;
  /** Finds the first element with this tag whose text is exactly `label`. */
  button(label: string): ShimElement | null;
  /** The `.field-row` whose label reads `label`. */
  row(label: string): ShimElement | null;
  /** The control inside that row. */
  control(label: string): ShimElement;
  /** Messages the client's own error surface put on screen. */
  errors(): string[];
}

export function installDom(): ShimDom {
  class DocumentShim extends ShimElement implements DocumentLike {
    activeElement: ShimElement | null = null;
    body = new ShimElement('body');
    documentElement = new ShimElement('html');

    constructor() {
      super('#document');
      this.nodeType = 9;
      // The real tree: document → <html> → <body>. `document.querySelector`
      // searches it, which is how `layout.js` finds the panel grid.
      this.documentElement.append(this.body);
      this.append(this.documentElement);
    }

    createElement(tag: string): ShimElement {
      return new ShimElement(tag);
    }
    /** Namespaces do not exist here; the tag name is all that matters. */
    createElementNS(_namespace: string, tag: string): ShimElement {
      return new ShimElement(tag);
    }
    createTextNode(text: unknown): ShimText {
      return new ShimText(text);
    }
    getElementById(id: string): ShimElement | null {
      return this.descendants().find((node) => node.getAttribute('id') === id) ?? null;
    }
  }

  const document = new DocumentShim();

  // The globals are installed through an untyped view on purpose: this project
  // compiles with `lib: esnext` only, so the DOM type names do not exist here.
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = document;
  // A browser always has `matchMedia`; a theme that follows the system asks it.
  // This answers "the system prefers dark", which is what the shim's fixed
  // light-free palette assumed before themes existed.
  const mediaListeners = new Map<string, ((event: { matches: boolean }) => void)[]>();
  globals.matchMedia = (query: string) => ({
    media: query,
    matches: !query.includes('light'),
    addEventListener: (type: string, handler: (event: { matches: boolean }) => void) => {
      mediaListeners.set(type, [...(mediaListeners.get(type) ?? []), handler]);
    },
    removeEventListener: () => {},
  });
  globals.window = {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1400,
    innerHeight: 900,
    isSecureContext: true,
    matchMedia: (query: string) => (globals.matchMedia as (value: string) => unknown)(query),
  };
  globals.Node = ShimNode;
  globals.HTMLElement = ShimElement;
  // `navigator` is not installed: Node already defines it as a getter-only
  // global without `clipboard`, which is exactly the situation where
  // `clipboard.js` takes its legacy path — so `execCommand` below is what makes
  // copying succeed here.

  // `clipboard.js` and the export menu reach for these; without them a copy or
  // a download would fail here for a reason that cannot happen in a browser.
  const blobUrls = new Map<string, unknown>();
  let blobCounter = 0;
  const urlWithBlobs = URL as unknown as {
    createObjectURL(value: unknown): string;
    revokeObjectURL(url: string): void;
  };
  urlWithBlobs.createObjectURL = (value: unknown) => {
    const url = `blob:shim/${++blobCounter}`;
    blobUrls.set(url, value);
    return url;
  };
  urlWithBlobs.revokeObjectURL = (url: string) => void blobUrls.delete(url);

  (document as unknown as { execCommand: (command: string) => boolean }).execCommand = () => true;

  const store = new Map<string, string>();
  globals.localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };

  function fire(
    target: ShimElement | DocumentLike,
    type: string,
    props: Partial<ShimEvent> = {},
  ): ShimEvent {
    const event: ShimEvent = {
      type,
      target: target as ShimElement,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      stopImmediatePropagation() {
        this.propagationStopped = true;
      },
      ...props,
    };

    let reachedDocument = false;
    for (let node: ShimNode | null = target; node; node = node.parentNode) {
      if (!(node instanceof ShimElement)) break;
      if (node === document) reachedDocument = true;
      event.currentTarget = node;
      for (const handler of node.listeners.get(type) ?? []) {
        handler(event);
        if (event.propagationStopped) break;
      }
      if (event.propagationStopped) return event;
    }
    // Document-level listeners (the global keyboard layer) come last, which is
    // where a browser would run them after the event bubbles out of the body.
    // A target already inside the document tree reaches them on the way up, so
    // running them again here would fire every shortcut twice — and, because
    // Escape unwinds a layer stack, close two things at once.
    if (reachedDocument) return event;
    event.currentTarget = document;
    for (const handler of document.listeners.get(type) ?? []) handler(event);
    return event;
  }

  dispatcher = fire;

  const dom: ShimDom = {
    document,
    fire,
    click: (target) => void fire(target, 'click'),
    type: (target, value) => {
      target.value = value;
      fire(target, 'input');
    },
    text: (node) => (node ? node.textContent : ''),
    all: (selector) => document.body.querySelectorAll(selector),
    one: (selector) => document.body.querySelector(selector),
    button: (label) =>
      document.body.descendants().find(
        (node) => node.tagName === 'BUTTON' && node.textContent === label,
      ) ?? null,
    row: (label) =>
      document.body
        .descendants()
        .find(
          (node) =>
            node.classList.contains('field-row') &&
            (node.querySelector('.field-label')?.textContent ?? '') === label,
        ) ?? null,
    control(label) {
      const row = this.row(label);
      if (!row) throw new Error(`no field row labelled ${label}`);
      return row.children[row.children.length - 1]!;
    },
    errors: () =>
      document.body
        .descendants()
        .filter((node) => node.classList.contains('toast') && node.classList.contains('error'))
        .map((node) => node.querySelector('.toast-message')?.textContent ?? node.textContent),
  };

  return dom;
}
