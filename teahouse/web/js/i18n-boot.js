/**
 * Applies the interface language to the static shell before the first paint.
 *
 * A classic script at the end of `<body>`, not a module: modules are deferred,
 * so the topbar would paint in the source language first and then switch. It runs
 * while the document is still parsing, when every static element already exists.
 *
 * It deliberately carries only the strings index.html declares with
 * `data-i18n*` — the "shell". The full dictionary in `js/locales/` takes over as
 * soon as `app.js` runs, and `test:web` asserts this shell map is exactly the
 * index.html subset of both locales, byte for byte, so the two cannot drift.
 *
 * The marker comments split the map into one JSON blob per locale; that is what
 * the test reads, and it keeps the values plain JSON (no logic to re-implement).
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'teahouse.uiLanguage.v1';
  var FALLBACK = 'zh-CN';
  var SHELL = {};

  /* SHELL:zh-CN */
  SHELL['zh-CN'] = {
    "app.brandTitle": "菜单：新会话 / 新建群聊 / 设置",
    "app.toggleLeftTitle": "折叠/展开左侧面板 (Ctrl+B)",
    "app.toggleRightTitle": "折叠/展开右侧面板 (Ctrl+Alt+B)",
    "app.trace": "轨迹",
    "app.traceTitle": "把右侧面板切换为轨迹 (Ctrl+T)",
    "app.preview": "装配预览",
    "settings.title": "设置",
    "app.importCharacter": "导入角色卡",
    "app.importWorld": "导入世界书",
    "app.importChat": "导入记录",
    "app.newChat": "新会话",
    "common.delete": "删除",
    "app.resizeLeft": "拖动调整左栏宽度",
    "app.resizeRight": "拖动调整右栏宽度",
    "app.send": "发送",
    "app.regen": "重新生成",
    "app.continue": "继续",
    "app.continueTitle": "把最后一条 AI 回复接着写下去",
    "app.impersonate": "替我说",
    "app.impersonateTitle": "替你说一句，以你的身份生成一条消息",
    "app.stop": "停止",
    "app.attachTitle": "挂一张图一起发（JPEG/PNG/GIF/WebP，单张 32MB 内）",
    "panels.characters": "角色",
    "panels.worlds": "世界书",
    "panels.worldsHint": "勾选的世界书会附加到当前会话；角色卡内嵌的世界书自动生效。",
    "panels.chats": "会话",
    "panels.chatsHint": "会话可以按酒馆的 jsonl 导出（列表项的 ⋯ 菜单）与导入。",
    "panels.sprites": "立绘",
    "panels.params": "请求参数",
    "panels.paramsHint": "本会话的采样参数；新建会话时按设置里的默认值快照。",
    "panels.stack": "提示词栈",
    "panels.stackHint": "按分组折叠；行内的开关可启停，改动真实生效并记住。",
    "panels.hits": "世界书命中",
    "panels.preview": "请求预览",
    "chat.none": "未选择会话",
    "chat.inputPlaceholder": "说点什么…（Ctrl+Enter 发送）"
  };

  /* SHELL:en */
  SHELL['en'] = {
    "app.brandTitle": "Menu: new chat / new group / settings",
    "app.toggleLeftTitle": "Collapse/expand the left panel (Ctrl+B)",
    "app.toggleRightTitle": "Collapse/expand the right panel (Ctrl+Alt+B)",
    "app.trace": "Trace",
    "app.traceTitle": "Switch the right panel to the trace (Ctrl+T)",
    "app.preview": "Assembly preview",
    "settings.title": "Settings",
    "app.importCharacter": "Import character card",
    "app.importWorld": "Import world book",
    "app.importChat": "Import log",
    "app.newChat": "New chat",
    "common.delete": "Delete",
    "app.resizeLeft": "Drag to resize the left panel",
    "app.resizeRight": "Drag to resize the right panel",
    "app.send": "Send",
    "app.regen": "Regenerate",
    "app.continue": "Continue",
    "app.continueTitle": "Keep writing the last AI reply",
    "app.impersonate": "Speak for me",
    "app.impersonateTitle": "Write a line as you, in your voice",
    "app.stop": "Stop",
    "app.attachTitle": "Attach an image to send along (JPEG/PNG/GIF/WebP, up to 32MB each)",
    "panels.characters": "Characters",
    "panels.worlds": "World books",
    "panels.worldsHint": "Checked world books are attached to the current conversation; a card’s embedded world book applies automatically.",
    "panels.chats": "Chats",
    "panels.chatsHint": "Conversations export as SillyTavern jsonl (the ⋯ menu on a row) and import the same way.",
    "panels.sprites": "Sprites",
    "panels.params": "Request parameters",
    "panels.paramsHint": "This conversation’s sampling parameters; a new conversation snapshots the defaults from settings.",
    "panels.stack": "Prompt stack",
    "panels.stackHint": "Collapsed by group; the switches on each row take effect immediately and are remembered.",
    "panels.hits": "World book hits",
    "panels.preview": "Request preview",
    "chat.none": "No conversation selected",
    "chat.inputPlaceholder": "Say something… (Ctrl+Enter to send)"
  };

  var lang = FALLBACK;
  try {
    var stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && SHELL[stored]) lang = stored;
  } catch (error) {
    /* private mode, or storage disabled: the source language applies */
  }
  var messages = SHELL[lang] || SHELL[FALLBACK];

  var root = document.documentElement;
  root.setAttribute('lang', lang);
  // Every shipped locale is left-to-right; an RTL locale extends this map.
  root.setAttribute('dir', 'ltr');

  function apply(attribute, target) {
    var nodes = document.querySelectorAll('[' + attribute + ']');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var key = node.getAttribute(attribute);
      if (!key || !(key in messages)) continue;
      if (target === '') node.textContent = messages[key];
      else node.setAttribute(target, messages[key]);
    }
  }

  apply('data-i18n', '');
  apply('data-i18n-title', 'title');
  apply('data-i18n-placeholder', 'placeholder');
  apply('data-i18n-aria-label', 'aria-label');
})();
