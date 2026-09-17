/**
 * Client-side decorations, injected into the teahouse page by the desktop shell.
 *
 * The window is frameless (`decorations: false`), so the OS draws nothing: this
 * adds a menu button on the left, the three window controls on the right, and
 * the drag / double-click behaviour a title bar would have. It never touches the
 * app's own modules — it only appends to `.topbar` and reads the page's CSS
 * variables, so it follows the current theme.
 *
 * The innerHTML below is three fixed SVG strings defined in this file, never
 * page content; nothing from the app is ever interpreted as markup.
 */
(() => {
  if (window.__teahouseChrome) return;
  window.__teahouseChrome = true;

  const invoke = (command, args) => {
    const api = window.__TAURI__;
    if (api?.core?.invoke) return api.core.invoke(command, args);
    if (window.__TAURI_INTERNALS__?.invoke) return window.__TAURI_INTERNALS__.invoke(command, args);
    return Promise.reject(new Error('tauri ipc unavailable'));
  };

  const ICON = {
    minimize:
      '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>',
    maximize:
      '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    restore:
      '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="4" width="5.5" height="5.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 4V2.5h5v5H8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    close:
      '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>',
    menu:
      '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
  };

  const CSS = `
  .teahouse-chrome-btn { flex: none; }
  .teahouse-winbtns { display: flex; align-items: stretch; align-self: stretch; margin-left: 8px; }
  .teahouse-winbtn {
    width: 46px; display: grid; place-items: center; padding: 0;
    border: 0; background: transparent; color: var(--muted); cursor: default;
  }
  .teahouse-winbtn:hover { background: var(--accent-soft); color: var(--text); }
  .teahouse-winbtn.teahouse-close:hover { background: #e81123; color: #ffffff; }
  .teahouse-menu {
    position: fixed; z-index: 10000; min-width: 210px; padding: 4px;
    background: var(--menu-bg); border: 1px solid var(--line); border-radius: 8px;
    box-shadow: var(--shadow);
  }
  .teahouse-menu[hidden] { display: none; }
  .teahouse-menu button {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    width: 100%; padding: 6px 10px; border: 0; border-radius: 6px;
    background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer;
  }
  .teahouse-menu button:hover { background: var(--accent-soft); }
  .teahouse-menu .check { color: var(--accent); }
  .teahouse-menu hr { border: 0; border-top: 1px solid var(--line); margin: 4px 2px; }
  `;

  const isInteractive = (target) =>
    Boolean(target.closest?.('button, input, select, textarea, a, [role="button"], .menu, .teahouse-menu'));

  function makeButton(className, title, html, onClick) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = className;
    node.title = title;
    node.innerHTML = html;
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return node;
  }

  function refreshMaximize(node) {
    invoke('shell_state', {})
      .then((info) => {
        node.innerHTML = info?.maximized ? ICON.restore : ICON.maximize;
        node.title = info?.maximized ? '向下还原' : '最大化';
      })
      .catch(() => {});
  }

  let menu = null;
  function closeMenu() {
    if (!menu) return;
    document.removeEventListener('mousedown', onOutside, true);
    menu.remove();
    menu = null;
  }
  function onOutside(event) {
    if (menu && !menu.contains(event.target)) closeMenu();
  }
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  async function toggleMenu(anchor) {
    if (menu) {
      closeMenu();
      return;
    }
    const info = await invoke('shell_state', {}).catch(() => ({}));
    menu = document.createElement('div');
    menu.className = 'teahouse-menu';
    const item = (label, action, extra) => {
      const node = document.createElement('button');
      node.type = 'button';
      const text = document.createElement('span');
      text.textContent = label;
      node.append(text);
      if (extra) {
        const mark = document.createElement('span');
        mark.className = 'check';
        mark.textContent = extra;
        node.append(mark);
      }
      node.addEventListener('click', () => {
        closeMenu();
        invoke('shell_action', { action }).catch(() => {});
      });
      return node;
    };
    const separator = () => document.createElement('hr');
    menu.append(
      item('打开数据目录', 'open-data'),
      item('打开程序目录', 'open-app'),
      item('打开日志', 'open-log'),
      separator(),
      item('重启服务端', 'restart-server'),
      item('检查更新…', 'check-update'),
      separator(),
      item('退出前确认', 'toggle-confirm', info?.confirmQuit ? '✓' : ''),
      item('退出', 'quit'),
    );
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.round(rect.left)}px`;
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
  }

  // Ctrl+wheel and Ctrl+= / Ctrl+- / Ctrl+0 page zoom. A browser does this
  // natively; a WebView2 window has the hotkeys off, so the shell does it and
  // remembers the level.
  function installZoom() {
    let lastWheel = 0;
    window.addEventListener(
      'wheel',
      (event) => {
        if (!(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        const now = Date.now();
        if (now - lastWheel < 40) return; // one step per wheel tick
        lastWheel = now;
        invoke('shell_zoom', { action: event.deltaY < 0 ? 'in' : 'out' }).catch(() => {});
      },
      { passive: false, capture: true },
    );
    window.addEventListener(
      'keydown',
      (event) => {
        if (!(event.ctrlKey || event.metaKey)) return;
        let action = null;
        if (event.key === '=' || event.key === '+' || event.key === 'Add') action = 'in';
        else if (event.key === '-' || event.key === '_' || event.key === 'Subtract') action = 'out';
        else if (event.key === '0') action = 'reset';
        if (!action) return;
        event.preventDefault();
        invoke('shell_zoom', { action }).catch(() => {});
      },
      true,
    );
  }

  function install() {
    const topbar = document.querySelector('.topbar');
    if (!topbar || topbar.querySelector('.teahouse-winbtns')) return Boolean(topbar);

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);

    const maximize = makeButton('teahouse-winbtn', '最大化', ICON.maximize, () => {
      invoke('shell_control', { action: 'toggle-maximize' })
        .then(() => refreshMaximize(maximize))
        .catch(() => {});
    });
    const minimize = makeButton('teahouse-winbtn', '最小化', ICON.minimize, () =>
      invoke('shell_control', { action: 'minimize' }).catch(() => {}),
    );
    const close = makeButton('teahouse-winbtn teahouse-close', '关闭', ICON.close, () =>
      invoke('shell_control', { action: 'close' }).catch(() => {}),
    );
    const controls = document.createElement('div');
    controls.className = 'teahouse-winbtns';
    controls.append(minimize, maximize, close);
    topbar.append(controls);

    const menuButton = makeButton('ghost icon-button teahouse-chrome-btn', '菜单', ICON.menu, () =>
      toggleMenu(menuButton),
    );
    topbar.insertBefore(menuButton, topbar.firstChild);

    // The title bar a frameless window no longer has. Clicks that land on a
    // control keep their own meaning; anything else moves the window.
    topbar.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || isInteractive(event.target)) return;
      invoke('shell_control', { action: 'drag' }).catch(() => {});
    });
    topbar.addEventListener('dblclick', (event) => {
      if (isInteractive(event.target)) return;
      invoke('shell_control', { action: 'toggle-maximize' })
        .then(() => refreshMaximize(maximize))
        .catch(() => {});
    });

    refreshMaximize(maximize);
    installZoom();
    return true;
  }

  const start = () => {
    if (install()) return;
    requestAnimationFrame(() => {
      if (!install()) setTimeout(start, 50);
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
