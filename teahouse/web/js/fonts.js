/**
 * Chat fonts: which typeface the transcript reads in.
 *
 * Nothing is vendored — font binaries are big and the repo ships no
 * third-party content. Instead there are two layers:
 *
 *   1. named stacks for well-known open-source families (they apply when the
 *      machine has them; otherwise the list falls through to system fonts);
 *   2. files the user drops into `data/fonts/` (served as `/fonts/<name>`),
 *      picked up automatically and offered in the same picker.
 *
 * The choice lives in this browser's localStorage (like the theme, not the
 * server config): a reading preference, not conversation data.
 */

export const FONT_STACKS = [
  {
    id: 'system',
    labelKey: 'appearance.fontSystem',
    family: 'system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    noteKey: 'appearance.fontSystemNote',
  },
  // Script faces bundled with Windows / Office. They are named here, not
  // vendored: the app only asks the system for a family, exactly like the
  // existing `PingFang SC` / `SimSun` references. Where the family is absent the
  // stack falls through, so the picker never shows a broken card.
  {
    id: 'kaiti',
    labelKey: 'appearance.fontKaiti',
    family: '"KaiTi", "楷体", "STKaiti", "Noto Serif SC", serif',
    noteKey: 'appearance.fontKaitiNote',
  },
  {
    id: 'stkaiti',
    labelKey: 'appearance.fontStkaiti',
    family: '"STKaiti", "华文楷体", "KaiTi", "楷体", serif',
    noteKey: 'appearance.fontStkaitiNote',
  },
  {
    id: 'lisu',
    labelKey: 'appearance.fontLisu',
    family: '"LiSu", "隶书", "STLiti", "SimSun", serif',
    noteKey: 'appearance.fontLisuNote',
  },
  {
    id: 'stliti',
    labelKey: 'appearance.fontStliti',
    family: '"STLiti", "华文隶书", "LiSu", "隶书", serif',
    noteKey: 'appearance.fontStlitiNote',
  },
  {
    id: 'stxingkai',
    labelKey: 'appearance.fontStxingkai',
    family: '"STXingkai", "华文行楷", "KaiTi", "楷体", serif',
    noteKey: 'appearance.fontStxingkaiNote',
  },
  {
    id: 'stxinwei',
    labelKey: 'appearance.fontStxinwei',
    family: '"STXinwei", "华文新魏", "KaiTi", "楷体", serif',
    noteKey: 'appearance.fontStxinweiNote',
  },
  {
    id: 'fangsong',
    labelKey: 'appearance.fontFangsong',
    family: '"FangSong", "仿宋", "STFangsong", "华文仿宋", "SimSun", serif',
    noteKey: 'appearance.fontFangsongNote',
  },
  {
    id: 'youyuan',
    labelKey: 'appearance.fontYouyuan',
    family: '"YouYuan", "幼圆", "Microsoft YaHei", sans-serif',
    noteKey: 'appearance.fontYouyuanNote',
  },
  {
    id: 'fzshuti',
    labelKey: 'appearance.fontFzshuti',
    family: '"FZShuTi", "方正舒体", "STXingkai", "华文行楷", serif',
    noteKey: 'appearance.fontFzshutiNote',
  },
  {
    id: 'noto-sans',
    labelKey: 'appearance.fontNotoSans',
    family: '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    noteKey: 'appearance.fontNotoSansNote',
    webFont: 'Noto Sans SC',
  },
  {
    id: 'lxgw',
    labelKey: 'appearance.fontLxgw',
    family: '"LXGW WenKai", "LXGW WenKai Screen", "LXGW WenKai Lite", "Noto Sans SC", sans-serif',
    noteKey: 'appearance.fontLxgwNote',
  },
  {
    id: 'iansui',
    labelKey: 'appearance.fontIansui',
    family: '"Iansui", "LXGW WenKai", "Noto Sans SC", sans-serif',
    noteKey: 'appearance.fontIansuiNote',
    webFont: 'Iansui',
  },
  {
    id: 'klee',
    labelKey: 'appearance.fontKlee',
    family: '"Klee One", "LXGW WenKai", "Noto Sans SC", sans-serif',
    noteKey: 'appearance.fontKleeNote',
    webFont: 'Klee One',
  },
  {
    id: 'mashanzheng',
    labelKey: 'appearance.fontMashanzheng',
    family: '"Ma Shan Zheng", "LXGW WenKai", "Noto Sans SC", sans-serif',
    noteKey: 'appearance.fontMashanzhengNote',
    webFont: 'Ma Shan Zheng',
  },
  {
    id: 'zhimangxing',
    labelKey: 'appearance.fontZhimangxing',
    family: '"Zhi Mang Xing", "LXGW WenKai", "Noto Sans SC", sans-serif',
    noteKey: 'appearance.fontZhimangxingNote',
    webFont: 'Zhi Mang Xing',
  },
  {
    id: 'liujianmaocao',
    labelKey: 'appearance.fontLiujianmaocao',
    family: '"Liu Jian Mao Cao", "LXGW WenKai", "Noto Sans SC", sans-serif',
    noteKey: 'appearance.fontLiujianmaocaoNote',
    webFont: 'Liu Jian Mao Cao',
  },
  {
    id: 'longcang',
    labelKey: 'appearance.fontLongcang',
    family: '"Long Cang", "LXGW WenKai", "Noto Sans SC", sans-serif',
    noteKey: 'appearance.fontLongcangNote',
    webFont: 'Long Cang',
  },
  {
    id: 'zhuque',
    labelKey: 'appearance.fontZhuque',
    family: '"Zhuque Fangsong", "Noto Serif SC", "Songti SC", serif',
    noteKey: 'appearance.fontZhuqueNote',
  },
  {
    id: 'noto-serif',
    labelKey: 'appearance.fontNotoSerif',
    family: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
    noteKey: 'appearance.fontNotoSerifNote',
    webFont: 'Noto Serif SC',
  },
  {
    id: 'plex',
    labelKey: 'appearance.fontPlex',
    family: '"IBM Plex Sans SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    noteKey: 'appearance.fontPlexNote',
  },
  {
    id: 'mono',
    labelKey: 'appearance.fontMono',
    family: '"JetBrains Mono", "Noto Sans Mono", Consolas, "Courier New", monospace',
    noteKey: 'appearance.fontMonoNote',
  },
];

const STORAGE_KEY = 'teahouse.font.v1';

function quoteFamily(name) {
  return `"${String(name).replace(/["\\]/g, '')}"`;
}

export function readStoredFont() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      stack: typeof parsed?.stack === 'string' ? parsed.stack : 'system',
      size: Number.isFinite(Number(parsed?.size)) ? Number(parsed.size) : 0,
    };
  } catch {
    return { stack: 'system', size: 0 };
  }
}

export function writeStoredFont(value) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ stack: value.stack ?? 'system', size: value.size ?? 0 }));
  } catch {
    /* storage may be unavailable; the page still reads fine this session */
  }
}

/** `file:name` addresses an uploaded file; anything else is a stack id. */
export function resolveFamily(choice, files) {
  if (typeof choice === 'string' && choice.startsWith('file:')) {
    const name = choice.slice(5);
    const found = (files ?? []).find((file) => file.name === name);
    if (found) return `${quoteFamily(found.family ?? name)}, sans-serif`;
    return null;
  }
  return FONT_STACKS.find((stack) => stack.id === choice)?.family ?? null;
}

let faceStyle = null;

/** Injects one @font-face per uploaded file. CSS text, never innerHTML. */
export function ensureFileFaces(files) {
  if (!Array.isArray(files) || files.length === 0) {
    faceStyle?.remove();
    faceStyle = null;
    return;
  }
  if (!faceStyle) {
    faceStyle = document.createElement('style');
    faceStyle.id = 'teahouse-font-faces';
    document.head.append(faceStyle);
  }
  faceStyle.textContent = files
    .map((file) => `@font-face{font-family:${quoteFamily(file.family ?? file.name)};src:url("${file.url}") format("${file.format ?? 'woff2'}");}`)
    .join('\n');
}

/**
 * Web fonts: an open-source family is fetched on demand rather than installed.
 *
 * A stack opts in with `webFont` (its Google Fonts family name). When that stack
 * is chosen, one `<link>` to the Google Fonts CSS is injected; the CSS carries
 * per-`unicode-range` `@font-face` rules, so the browser downloads only the
 * glyph subsets a page actually uses. `fonts.loli.net` is the fallback because
 * `fonts.googleapis.com` is often unreachable from mainland China. Nothing is
 * fetched until a web font is selected, and if both sources fail the stack falls
 * through to the next family, so this stays harmless offline.
 */
const WEB_FONT_SOURCES = [
  (query) => `https://fonts.googleapis.com/css2?${query}`,
  (query) => `https://fonts.loli.net/css2?${query}`,
];

const loadedWebFonts = new Set();

/** Injects the web-font stylesheet for a stack, once, with mirror fallback. */
export function ensureWebFont(stack) {
  const family = stack?.webFont;
  if (!family || loadedWebFonts.has(family)) return;
  if (typeof document === 'undefined' || !document.head) return;
  loadedWebFonts.add(family);
  const query = `family=${encodeURIComponent(family).replace(/%20/g, '+')}&display=swap`;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  let index = 0;
  link.addEventListener('error', () => {
    index += 1;
    if (index < WEB_FONT_SOURCES.length) link.href = WEB_FONT_SOURCES[index](query);
  });
  link.href = WEB_FONT_SOURCES[0](query);
  document.head.append(link);
}

/** Applies the stored choice to the transcript column. */
export function applyFonts(files) {
  const holder = document.getElementById('messages');
  if (!holder) return;
  const stored = readStoredFont();
  ensureFileFaces(files);
  const family = resolveFamily(stored.stack, files) ?? FONT_STACKS[0].family;
  holder.style.fontFamily = family;
  holder.style.fontSize = stored.size > 0 ? `${stored.size}px` : '';
  ensureWebFont(FONT_STACKS.find((stack) => stack.id === stored.stack));
}
