# teahouse 设计文档

teahouse（茶馆）是一个本地单用户的 AI 角色扮演前端。产品定义只有三件事：**角色卡**、
**世界书**、**提示词栈**——开箱能聊、能重 roll、能看见世界书为什么命中。SillyTavern
是这个领域事实上的文件格式制定者，所以**世界书文件的完全兼容**是第一约束：
网上能用的 JSON 世界书，这里都能用，且原文存盘、无损回写。除此之外，它是独立的产品，
有自己的提示词栈、交互与测试体系。

语义参照（开发期只读对照，核对字段与算法用）：`_ref/SillyTavern`（SillyTavern 官方仓库检出）。

---

## 0. 产品目标与设计原则

teahouse 回答一个问题：**这一轮模型到底看到了什么、为什么**。所有设计都从这句话长出来：

1. **三件事是产品，不是 demo**：角色卡、世界书、提示词栈各自完整（编辑、导入导出、
   消息级操作一个不少），提示词栈的每个区块都可开关、有 token 计数、改动真实生效。
2. **世界书文件完全兼容是硬约束**：解析、扫描语义、导出三方面与 SillyTavern 一致，
   原文字节存盘、无损回写。`corpus/` 放真实样本跑 conformance：解析成功 + 语义等价 +
   导出深比较无损（含全部未知字段）。
3. **零依赖、零构建**：Node 原生跑 TypeScript；PNG、二进制 zip、BPE 分词器、DOM 测试替身
   全部手写。拷目录、`node src/server.ts` 就能跑。
4. **数据是纯文本文件**：`data/` 下的 JSON / JSONL 可读、可 diff、可手改、可备份；
   浏览器偏好（主题、布局）才放 localStorage，不进数据文件。
5. **行为由测试钉住**：八套件 3958 项（conformance 468 / scan 100 / prompt 289 /
   tokenizer 39 / api 795 / web 1456 / ui 230 / boot 581），`npm test` 一次跑完。
   修 bug 的方式是先写一条会红的用例，再修。

**明确不做**：扩展脚本系统、多用户与鉴权、SD 文生图（独立子系统）。语音输入与绘图在路线图里（§8）。

> 前端结构：`dom.js` + `api.js` + `keys.js` + `focus.js` + `token-budget.js` + `hits.js` +
> `language.js` + `clipboard.js` + `chat-actions.js` + `settings-schema.js` + `commands.js` +
> `preview-tokens.js` + `character-fields.js` + `errors.js` + `app.js`（接线）+ 16 个 `components/*`
> + 15 个 `views/*`。
>
> 测试数据分两层：`corpus/owned/`（`npm run fixtures` 生成，全部原创，进版本库，**断言**格式/条目数/未知字段集）
> 与 `corpus/local/`（真实的网络世界书，不进版本库，只**报告**未知字段而不判失败）。
> 仓库因此不含任何第三方内容，同时保留了对真实样本的验证能力。详见 `corpus/README.md`。

---

## 1. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node v26（当前机器已有 v26.8.2） | 原生剥类型跑 TypeScript，**不需要构建步骤** |
| 后端 | `node:http` + 手写路由 | 依赖 express 得不到什么 |
| 前端 | 原生 HTML + ES Module + 手写 CSS，无框架无打包 | 省掉整条构建链，改完刷新即生效 |
| 模型层 | OpenAI 兼容 `/v1/chat/completions`（SSE 流式） | 一个适配器覆盖 DeepSeek、OpenAI、Ollama、LM Studio、vLLM、OpenRouter、硅基流动… |
| 存储 | 纯文件（JSON / JSONL / PNG） | 可读、可 diff、可直接改、可备份 |
| 依赖 | **0 个运行时依赖** | PNG tEXt 读写用 `node:zlib` 之外的纯字节操作 + 自带 CRC32，约 120 行 |

启动方式：`node src/server.ts`（或 `npm start`）。

---

## 2. 目录结构

```
teahouse/
├─ DESIGN.md                    ← 本文档
├─ README.md
├─ package.json                 ← 只有 scripts，无 dependencies
├─ tsconfig.json
├─ data/                        ← 运行时数据（不进 git）
│  ├─ config.json               ← 接口 / 模型 / 采样 / 扫描 / 人设库默认 / 界面语言
│  ├─ characters/<id>/          ← card.png（原始载体）+ skill.zip/skill.md（技能导入留档）
│  ├─ worlds/<id>.json          ← 世界书原文（原样字节）+ <id>.vectors.json（旁挂向量索引）
│  ├─ chats/<id>.jsonl          ← 消息流（一行一条）+ <id>.meta.json（挂载/状态/覆盖）+ <id>.trace.jsonl（轨迹）
│  ├─ personas.json / quick-replies.json / regex.json / connections.json
│  ├─ images/ / sprites/<角色>/ / fonts/   ← 二进制素材，各有专属路由供字节
│  └─ model-limits.json         ← 从服务商错误里学到的窗口/输出上限（机器写，可删）
├─ src/
│  ├─ server.ts                 ← 组合根：静态资源 + 分发 + 错误映射（没有端点逻辑）
│  ├─ pipeline.ts               ← 会话 → 扫描 → 提示词栈 的共享装配路径
│  ├─ vectors.ts / i18n.ts      ← 向量检索装配入口 / 服务端 Notice 命名
│  ├─ http/                     ← 与业务无关的 HTTP 基础设施
│  │  ├─ router.ts              ← 模式路由（`/api/x/:id`），静态段优先于参数段
│  │  ├─ respond.ts             ← HttpError、JSON/字节响应、SSE 帧、请求体读取
│  │  └─ static.ts              ← web 目录投递（含路径逃逸防护）
│  ├─ routes/                   ← 一个资源一个模块，各自声明自己的端点
│  │  ├─ index.ts               ← 注册表
│  │  ├─ meta.ts                ← health / config / models / 字段元数据 / 服务商预设
│  │  ├─ characters.ts          ← 导入（含技能包探测）、查看、导出、改名、改 id、删除
│  │  ├─ worlds.ts              ← 导入、查看、删除、本书设置、条目增删改
│  │  ├─ chats.ts               ← 会话、挂载世界书、swipe、截断、消息级操作、翻译批量
│  │  ├─ prompt.ts              ← 提示词栈 / 装配预览 / 扫描调试
│  │  ├─ generate.ts            ← SSE 生成（重试/继续/替身/群聊连播同一入口）
│  │  ├─ connections.ts         ← 额外连接 CRUD（Key 掩码存回）
│  │  ├─ memory.ts              ← 长期记忆读写与立即总结
│  │  ├─ trace.ts               ← 轨迹读写与清空（只动轨迹文件）
│  │  ├─ regex.ts / quick-replies.ts / personas.ts  ← 整份存取 + 试用/互导
│  │  ├─ images.ts / sprites.ts / fonts.ts          ← 上传、供字节、删除
│  │  ├─ vectors.ts             ← 索引构建、检索查询、逐本状态
│  │  └─ tts.ts                 ← 在线语音代理（Key 不出服务端）
│  ├─ formats/                  ← ★ 兼容层
│  │  ├─ types.ts               ← 内部归一化模型
│  │  ├─ png-text.ts            ← PNG tEXt 分块读写（零依赖，含 CRC32）
│  │  ├─ character-card.ts      ← v1 / v2 / v3 + PNG 载体 + 卡片编辑字段表
│  │  ├─ key-list.ts            ← 键语法：正则键识别、逗号切分（正则内的逗号不切）
│  │  ├─ entry-fields.ts        ← ★ 声明式字段元数据 + 补丁校验（同时驱动前端表单）
│  │  ├─ chat-log.ts            ← ★ 聊天记录与酒馆 JSONL 双向互导（自家往返无损）
│  │  ├─ quick-replies.ts       ← 快捷回复形状与酒馆 `{ quickReplySlots }` 互导
│  │  ├─ skill.ts               ← SKILL.md / zip 映射成角色卡（references 进内嵌书）
│  │  ├─ zip.ts                 ← 最小 zip 读取（STORE/DEFLATE，内置 zlib）
│  │  └─ world-info.ts          ← 6 种来源识别 + 归一化 + 无损回写
│  ├─ engine/                   ← ★ 核心：装配、扫描与各注入通道
│  │  ├─ prompt-stack.ts        ← 区块装配、marker 填充、绝对注入、栈覆盖校验
│  │  ├─ world-scan.ts          ← 关键词/正则匹配、预算、递归、分组、概率、sticky
│  │  ├─ hf-tokenizer.ts        ← 零依赖读 tokenizer.json（BPE，精确计数）
│  │  ├─ tokens.ts              ← 计数门面：exact/estimate + 服务端真值自校准
│  │  ├─ macros.ts              ← {{char}} {{user}} {{getvar}} 等
│  │  ├─ retrieval.ts           ← 检索模式分派：全文注入 / 向量 / 模型点名 / agent
│  │  ├─ select.ts              ← 模型点名：候选目录 + 宽松解析（一次调用）
│  │  ├─ agent.ts               ← agent 读文件：read_file 工具 + 有界循环 + 白名单
│  │  ├─ group.ts               ← 群聊发言名单（五种模式，纯函数）
│  │  ├─ connections.ts         ← 发言人连接解析（成员连接 → 会话 → 默认）
│  │  ├─ limits.ts              ← 溢出识别、窗口抽取、重试与回写
│  │  ├─ story-template.ts      ← 上下文模板渲染与校验
│  │  ├─ memory.ts              ← 记忆触发判定与总结装配
│  │  ├─ regex-rules.ts         ← 正则编译、试用与双作用域改写
│  │  ├─ translate.ts           ← 翻译判定（启发式）与缓存新鲜度
│  │  ├─ images.ts              ← 图片引用校验与 token 估算
│  │  ├─ personas.ts            ← 有效人设解析（含掉级顺序）
│  │  ├─ trace.ts               ← 轨迹事件落盘与正文保留窗口
│  │  └─ completion.ts          ← 纯文本补全：messages 拍平与停止串
│  ├─ llm/
│  │  ├─ openai-compat.ts       ← 流式 chat completions（SSE）+ 工具调用 + 纯文本补全
│  │  ├─ providers.ts           ← 服务商预设表：地址 + 模型 + 文档写明的窗口/输出
│  │  └─ embeddings.ts          ← embedding 查询客户端（向量检索用）
│  └─ store/
│     └─ db.ts                  ← 文件存储 + 原子写（与 HTTP 无关）
├─ web/
│  ├─ index.html                ← 只放静态锚点（不含任何弹窗表单）
│  ├─ style.css / logo.svg
│  └─ js/
│     ├─ dom.js                 ← DOM 助手，零依赖（全站唯一的 innerHTML 出口）
│     ├─ api.js                 ← 状态、fetch 封装、发布订阅、加载器、Notice 本地化
│     ├─ app.js                 ← 唯一知道所有视图的模块：初始化 + 事件接线
│     ├─ keys.js / focus.js / errors.js     ← Esc 层栈 / 焦点管理 / 全局错误浮层
│     ├─ settings-schema.js     ← ★ 设置页/字段/校验/保存载荷的唯一声明（无 DOM）
│     ├─ token-budget.js / preview-tokens.js← ★ 预算算术 / 预览 token 归因（无 DOM，可单测）
│     ├─ token-breakdown.js     ← 上下文构成明细（纯函数分桶）
│     ├─ language.js / translate.js / tts.js← 回复语言渲染 / 翻译判定 / 朗读与剥 Markdown
│     ├─ connections.js / persona.js        ← 额外连接纯函数 / 有效人设（含掉级）
│     ├─ display-macros.js      ← 阅读时宏展开（存盘不动）
│     ├─ context-template.js    ← 上下文模板解析与酒馆预设互导
│     ├─ regex.js / markdown.js / math.js   ← 显示侧改写 / 安全 Markdown / LaTeX 子集
│     ├─ fonts.js / sprite-focus.js         ← web 字体按需加载 / 立绘智能取景（纯函数）
│     ├─ themes.js / theme-boot.js          ← 主题与配色注册表 / 首帧防闪
│     ├─ i18n.js / i18n-boot.js / locales/  ← 界面语言字典（zh-CN 源语言 + en）
│     ├─ hits.js / chat-actions.js / clipboard.js
│     ├─ components/            ← 自持 DOM 的小组件（16 个）
│     │  ├─ modal.js            ← ★ 唯一的弹窗外壳（Esc/焦点/滚动锁）
│     │  ├─ form-field.js       ← ★ 由字段规格生成控件（设置页与条目编辑器共用）
│     │  ├─ icon.js             ← ★ 手写内联 SVG 图标（分类导航用）
│     │  ├─ layout.js           ← 三栏/分隔条/折叠/轨迹模式宽度
│     │  ├─ model-picker.js / connection-status.js  ← 顶栏模型下拉 / 连接徽标
│     │  ├─ menu.js / confirm.js / toast.js / tooltip.js / empty-state.js
│     │  └─ message.js / preview-item.js / hit-card.js / stack-group.js / token-bar.js
│     └─ views/                 ← 视图之间不互相 import（15 个）
│        ├─ characters.js / character-editor.js
│        ├─ worlds.js / world-editor.js     ← ★ 条目编辑器（表单由字段元数据生成）
│        ├─ chats.js / chat.js             ← 会话列表 / 对话流与 SSE 消费
│        ├─ settings.js         ← ★ 设置弹窗：左栏分类 + 分页表单
│        ├─ prompt.js / trace.js           ← 提示词栈与预览 / 轨迹时间线
│        ├─ group.js / memory.js           ← 群聊选人 / 记忆编辑器
│        ├─ quick-replies.js / regex.js    ← 快捷横条与编辑器 / 正则编辑器
│        └─ sprite.js / theme-fab.js       ← 立绘面板 / 右下角主题按钮
├─ corpus/                      ← owned/ 生成的原创样本（进版本库）；local/ 真实世界书（不进）
└─ scripts/
   ├─ conformance.ts            ← 往返无损 + 字段覆盖报告
   ├─ test-tokenizer.ts         ← BPE 性质验证
   ├─ test-scan.ts              ← 扫描语义用例
   ├─ test-prompt.ts            ← 装配语义用例
   ├─ test-api.ts               ← 端到端 API（含假 provider 流式）
   ├─ test-web.ts               ← 前端资源/DOM/state 交叉校验（静态）
   ├─ test-ui.ts                ← ★ 交互用例：真的打开设置弹窗并操作它
   ├─ test-boot.ts              ← ★ 启动用例：真页面 + 真 app.js + 真服务端跑一遍
   ├─ shim-dom.ts               ← ★ 上面两套用的极小 DOM 替身（零依赖，非产品代码）
   ├─ make-fixtures.ts          ← 生成 corpus/owned（仓库不含第三方内容）
   └─ seed.ts                   ← 往运行中的服务端灌样本数据（开发用）
```

---

## 3. 兼容层设计

兼容 6 种世界书来源，外加两种只有这里能正常用的形态（§3.2）。

### 3.1 核心原则：Raw 存盘，Normalized 视图，导出无损

```
上传文件 ──► 识别来源 ──► 归一化 ──► 引擎只认归一化结构
                │
                └──► 原始字节原样落盘 ──► 导出时按原格式回写
```

三条铁律：

1. **引擎只读归一化模型**，绝不接触 `key` / `keys` / `keywords` 这类来源差异。
2. **原文永不被改写**。`data/worlds/<name>.json` 是导入时那份字节，编辑只发生在归一化层，导出走序列化器。
3. **能识别就必须能回写**。往返测试要求 `parse → serialize` 与原文件**深比较相等**（结构、值、未知字段全一致；空白缩进归一化为 4 空格后比较）。注意：不是字节级比较，缩进风格差异不算丢失。

### 3.2 来源识别（6 种文件形态 + 2 种额外支持）

| 来源 | 识别特征 | 条目容器 |
|---|---|---|
| SillyTavern 原生 | `entries` 是**以 uid 为键的对象** | `entries{}` |
| `chara_card_v2` 内嵌 | `spec === "chara_card_v2"`，取 `data.character_book` | `entries[]` 数组 |
| **独立 CharacterBook** | `entries` 是数组，条目用 `keys`/`secondary_keys`/`insertion_order` | `entries[]` |
| Agnai Memory Book | `kind === "memory"` | `entries[]` |
| Risu Lorebook | `type === "risu"` | `data[]` |
| NovelAI Lorebook | `lorebookVersion !== undefined` | `entries[]` |
| **裸数组 / `{entries: []}`** | 只有这里支持的两种兜底形态 | 数组 |

**实测结论（重要）**：网上大量流行的世界书是**独立 CharacterBook 数组形态**（例如 Elden Ring 那套 1221 条的合集）。SillyTavern 对它的处理是——`POST /api/worldinfo/import` 只校验 `'entries' in worldContent`，所以**导入会成功**；但前端按 `entries[uid]` 对象消费且读 `entry.key`/`entry.content`，而这个形态的字段叫 `keys`/`insertion_order`，于是**这本书在那边永远不会触发**，除非作为角色卡内嵌的 `character_book`。

也就是说：这类文件是兼容层的首要目标——能导入必须能用。在这里它们正常触发，也能一键导出成 SillyTavern 原生格式。

### 3.3 归一化模型

```ts
interface World {
  id: string;              // 文件名
  name: string;
  sourceFormat: 'st' | 'character_book' | 'agnai' | 'risu' | 'novelai' | 'array';
  scanDepth: number | null;      // book 级，null = 用全局
  tokenBudget: number | null;
  recursiveScanning: boolean | null;
  extensions: Record<string, unknown>;
  entries: WorldEntry[];
  raw: unknown;            // 原文，导出用
}

interface WorldEntry {
  uid: number;
  key: string[];                 // 主键
  keysecondary: string[];        // 次键
  comment: string;               // 备注（列表标题）
  content: string;               // 注入内容
  constant: boolean;             // 常驻
  selective: boolean;
  selectiveLogic: 0|1|2|3;       // AND_ANY|NOT_ALL|NOT_ANY|AND_ALL
  order: number;                 // 默认 100
  position: 0|1|2|3|4|5|6|7;     // before|after|ANTop|ANBottom|atDepth|EMTop|EMBottom|outlet
  depth: number;                 // atDepth 用，默认 4
  role: 0|1|2;                   // SYSTEM|USER|ASSISTANT
  disable: boolean;
  ignoreBudget: boolean;
  probability: number;           // 默认 100
  useProbability: boolean;
  group: string;
  groupOverride: boolean;
  groupWeight: number;           // 默认 100
  useGroupScoring: boolean | null;
  scanDepth: number | null;      // 条目级覆盖
  caseSensitive: boolean | null;
  matchWholeWords: boolean | null;
  // 递归
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: number;   // 默认 0
  // 时间窗（需要 per-chat 状态）
  sticky: number | null;
  cooldown: number | null;
  delay: number | null;
  // 扫描范围扩展
  matchPersonaDescription: boolean;
  matchCharacterDescription: boolean;
  matchCharacterPersonality: boolean;
  matchCharacterDepthPrompt: boolean;
  matchScenario: boolean;
  matchCreatorNotes: boolean;
  // 其它
  vectorized: boolean;
  automationId: string;
  outletName: string;
  triggers: string[];            // normal|continue|impersonate|swipe|regenerate|quiet
  addMemo: boolean;
  displayIndex: number;
  extensions: Record<string, unknown>;
}
```

字段清单取自 SillyTavern 的 `newWorldInfoEntryDefinition`（40 个 + `uid`），一个不少——
网上流传的书里出现的字段，这里不会漏读。

### 3.4 来源映射表

| 归一化字段 | ST 原生 | character_book | Agnai | Risu | NovelAI |
|---|---|---|---|---|---|
| `key` | `key` | `keys` | `keywords` | `key.split(',')` | `keys` |
| `keysecondary` | `keysecondary` | `secondary_keys` | — | `secondkey.split(',')` | — |
| `comment` | `comment` | `comment` / `name` | `name` | `comment` | `displayName` |
| `content` | `content` | `content` | `entry` | `content` | `text` |
| `order` | `order` | `insertion_order` | `weight` | `insertorder` | `contextConfig.budgetPriority` |
| `disable` | `disable` | `!enabled` | `!enabled` | `false` | `!enabled` |
| `constant` | `constant` | `constant` | `false` | `alwaysActive` | `false` |
| `selective` | `selective` | `selective` | `false` | `selective` | `false` |
| `position` | `position` | `extensions.position` ?? `before_char?0:1` | `0` | `0` | `0` |
| `probability` | `probability` | `extensions.probability` ?? 100 | 100 | `activationPercent` | 100 |
| `depth` | `depth` | `extensions.depth` ?? 4 | 4 | 4 | 4 |
| `role` | `role` | `extensions.role` ?? 0 | 0 | 0 | 0 |
| `scanDepth` | `scanDepth` | `extensions.scan_depth` | null | null | null |

`character_book` 的 `extensions.*` 用 snake_case（`exclude_recursion`、`match_whole_words`、`group_weight`、`sticky`…），映射表与 SillyTavern 的 `convertCharacterBook` 逐项一致，保证同一份文件两边行为相同。

### 3.5 已知偏差与降级（必须写在 README 里）

| 项 | 处理 | 说明 |
|---|---|---|
| `automationId` | 解析并原样保存，**不执行** | 依赖脚本自动化，不在范围内 |
| `position: 7`（outlet） | 解析并保存，渲染为占位符，**不注入** | outlet 是给扩展用的插槽 |
| book 级 `scan_depth` / `token_budget` / `recursive_scanning` | **生效**（book 级 > 全局），比酒馆更严格 | 酒馆里这几个字段基本不生效；这是有意的改进，文档中标明 |
| CharacterBook 的顶层 `case_sensitive` | **读**（`extensions.case_sensitive` 优先） | 规范里这个字段在顶层，酒馆只读 extensions 里的那份，属于酒馆漏读 |
| CharacterBook 的 `use_regex` | **保存并原样回写**，但引擎不据此改变匹配 | 这是酒馆自己导出角色书时写的字段（注释「ST keys are always regex」），而酒馆扫描器从不读它。正则键按酒馆的规则识别：`/pattern/flags` |
| PNG 导出 | 只写 `chara`（v2），与酒馆一致 | 酒馆自己写回时也是删掉 `ccv3` 只写 `chara` |

### 3.6 一致性测试

`scripts/conformance.ts` 对本目录跑三件事：

1. **解析**：每份样本都能导入，条目数一致。
2. **语义**：归一化后逐字段比对期望快照（`corpus/*.expected.json`）。
3. **往返**：`serialize(parse(bytes))` 与原文件 JSON 深比较，必须相等。

外加一份**字段覆盖报告**：扫描 corpus 里出现过的所有字段名，列出「已映射 / 已保存未使用 / 未识别」三类。
自有样本必须把「未识别」压到只剩**故意声明为不透明**的那几个（曼哈顿断言：`unknownFields` 精确相等）；
真实样本（`corpus/local/`）的未识别字段只报告、不判失败——那份报告就是待映射字段的入口。
这是「完全适配」从口号变成可验证目标的办法。

---

## 4. 引擎设计

### 4.1 提示词栈

提示词栈采用与 SillyTavern Prompt Manager 相同的区块 / marker 模型（`identifier` / `role` /
`marker` / `injection_position` / `injection_depth`），概念与术语互通，便于理解与迁移：

```ts
interface PromptBlock {
  identifier: string;      // 唯一 id
  name: string;            // 显示名
  role: 'system'|'user'|'assistant';
  content: string;         // 静态文本
  marker?: MarkerKind;     // 非静态：运行时填充
  system_prompt: boolean;  // 是否算系统提示
  enabled: boolean;
  injection_position: 0 | 1;   // 0=按顺序, 1=绝对位置
  injection_depth: number;     // 绝对定位时插到倒数第 N 条
  injection_order: number;     // 同层排序
  forbid_overrides: boolean;
}
type MarkerKind = 'worldInfoBefore' | 'worldInfoAfter' | 'chatHistory'
                | 'charDescription' | 'charPersonality' | 'scenario'
                | 'personaDescription' | 'dialogueExamples';
```

默认顺序（与酒馆一致）：

```
main → worldInfoBefore → personaDescription → charDescription →
charPersonality → scenario → story → enhanceDefinitions → nsfw →
worldInfoAfter → dialogueExamples → impersonate → chatHistory → jailbreak

（`story` 是我们自己的上下文模板区块，空着时禁用，顺序与数量与酒馆无关——酒馆的
story string 只走 text-completion 那条路，我们把它做成 chat 里的一个真实区块。）
```

装配流程：

```
1. 按顺序遍历启用区块，静态块直接出栈
2. 碰到 marker 时按类型填充：
   - charDescription/Personality/scenario → 从当前角色卡取
   - worldInfoBefore/After → 调 world-scan 取命中条目，拼接
   - dialogueExamples → 卡片 mes_example
   - chatHistory → 按 token 预算裁剪后的消息历史
3. 处理 injection_position=1 的块：插到 chatHistory 倒数第 depth 条，
   同 depth+role 的合并成一个块
4. 展开宏、算 token、返回 { messages, itemization }
```

`itemization` 是**可玩性的关键**：每一块的 token 数、世界书命中了哪几条、为什么命中，全部回给前端——「这一轮模型看到了什么」必须有地方看。

### 4.2 世界书扫描

**键匹配语义（与 SillyTavern 的 `matchKeys` 一致，这几点极易漏）**：

```
matchKey(haystack, needle, entry):
  # 1. 斜杠定界即正则，且【覆盖所有其它选项】
  regex = parseRegexFromString(needle)     # /^\/([\w\W]+?)\/([gimsuy]*)$/
  if regex: return regex.test(haystack)    # 忽略大小写/整词/大小写敏感设置

  haystack = caseSensitive ? haystack : lower(haystack)     # transformString
  needle   = caseSensitive ? needle   : lower(needle)

  # 2. 整词匹配：多词短语退化为子串匹配，单词才加词边界
  if matchWholeWords:
      if needle.split(/\s+/).length > 1: return haystack.includes(needle)
      return new RegExp(`(?:^|\\W)(${escapeRegex(needle)})(?:$|\\W)`).test(haystack)
  else:
      return haystack.includes(needle)
```

关键点：

- **键可以是 `/pattern/flags` 形式的正则**，此时大小写敏感和整词设置**全部失效**。`parseRegexFromString` 还要求正则内部的 `/` 必须转义（`\/`），否则不认为是正则。
- 逗号可以出现在正则内部，所以酒馆有一个专门的分词器（`splitKeywordsAndRegexes`）而不是简单 `split(',')`。**数组形态的键不需要切分**，只有 Risu 那种逗号字符串才切。
- 整词匹配的边界是 `(?:^|\W)` / `(?:$|\W)`，标点和非字母数字都算边界。
- 扫描 haystack 由「最近 N 条消息 + 命中的 `match*` 全局字段 + 递归缓冲 + 注入缓冲」用 `JOINER` 拼接而成；`MIN_ACTIVATIONS` 状态下**不含**递归缓冲。

**扫描流程**：

```
scan(chat, character, worlds, globalSettings, trigger):
  book = merge(worlds)                      # 多本世界书，按 character_first 等策略排序
  # 第一遍：关键词
  for entry in book.entries where !entry.disable:
      depth  = entry.scanDepth  ?? book.scanDepth ?? global.depth(默认2)
      hay    = 最近 depth 条消息（include_names 时带角色名前缀）
      if entry.matchPersonaDescription      : hay += persona.description
      if entry.matchCharacterDescription    : hay += char.description
      if entry.matchCharacterPersonality    : hay += char.personality
      if entry.matchCharacterDepthPrompt    : hay += char.depth_prompt
      if entry.matchScenario                : hay += char.scenario
      if entry.matchCreatorNotes            : hay += char.creator_notes
      primary = matchAny(hay, entry.key, caseSensitive, wholeWords)
      active  = entry.constant ? true
              : primary && (!entry.selective || !entry.keysecondary.length
                            || applyLogic(entry.selectiveLogic, matchAny(hay, entry.keysecondary)))
      # 概率
      if active && entry.useProbability && entry.probability < 100:
          active = rand() * 100 < entry.probability
      # 时间窗（需要 per-chat 状态）
      if active && entry.delay   && chat.turn < entry.delay            : active = false
      if active && entry.sticky  && state.stickyUntil  > chat.turn     : active = true
      if active && entry.cooldown && state.cooldownUntil > chat.turn   : active = false
      if active: 记录命中原因 {entry, matchedKeys}
  # 第二遍：递归（recursiveScanning）
  for step in 1..maxRecursionSteps:
      把上一轮命中条目的 content 追加进 haystack，重新扫
      跳过 excludeRecursion 的条目；preventRecursion 条目的内容不参与触发
      delayUntilRecursion == step 的条目只在这一步才允许激活
  # 分组：同 group 只留一条，决策顺序是
  #   组内 sticky 独占 > 已激活过该组的条目占位 > groupOverride 按 order 最高 > 评分最高 > 按 groupWeight 加权随机
  # 预算：budget = round(world_info_budget% × maxContext) || 1，再被 budgetCap 截断
  #       —— 预算单位是【token】，不是条目数；默认 25 表示占上下文窗口的 25%
  #       按 order 降序消耗；【第一个把预算撑爆的条目本身也被拒绝】
  #       ignoreBudget 的条目无条件保留，且溢出后仍会被处理
  # 输出分桶：beforeChar / afterChar / ANTop / ANBottom / EMTop / EMBottom
  #           / atDepth[depth][role] / outlet
```

**预算语义（注意）**：`world_info_budget` 的默认值 25 是**百分比**，
`budget = Math.round(world_info_budget * maxContext / 100) || 1`，`world_info_budget_cap > 0` 时再取小值。
它从来不是「最多激活 25 条」——把单位理解错，长上下文下的行为会完全跑偏。

**sticky 的武装时机（注意）**：SillyTavern 的 `#setTimedEffectOfType` 只在效果**尚不存在**时设置
（`if (!chat_metadata.timedWorldInfo[type][key])`）。如果每轮生成后都重新计时，每个
sticky 条目在第一次命中后会**永久驻留**——因为每次扫描都把它的结束点往后推。正确做法是只在不存在时武装，
并在扫描前按 `checkTimedEffects` 让过期效果退场；sticky 结束时若该条目声明了 cooldown，
cooldown 立即开始计时。

**delay 的语义（注意）**：它不是时间窗，而是
`if (this.#chat.length < entry.delay) buffer.push(entry)` —— 一个直接的消息数比较，
与键是否命中无关。

**`include_names` 的连带效果（注意）**：默认开启时每条消息都会带上说话人名字
前缀，所以**键等于说话人名字的条目会在每一轮都命中**。SillyTavern 就是这样（也正因如此，很多世界书
故意拿角色名做键）。测试样本里不要把键设成卡片名，否则计时效果的用例会全部失真——
这个行为有专门的用例钉住。

`scanState`（sticky/cooldown）存在 `chats/<id>.meta.json` 里，键为 `<world>::<uid>`，这样不会污染世界书文件。

**插桩**：`scan()` 返回 `hits[]`，每项带 `{uid, comment, matchedKeys, reason, tokens}`。前端世界书面板高亮这些条目 —— 这是用户判断「我的世界书为什么不生效」的唯一手段，必须有。

### 4.3 角色卡

归一化后再喂给 prompt 栈：

```
v3 (ccv3) > v2 (chara) > v1 (平铺字段)     # 优先级与酒馆一致
v1 → v2 补全：name/description/personality/scenario/first_mes/mes_example
             creatorcomment→creator_notes, talkativeness→extensions.talkativeness
             depth_prompt_*→extensions.depth_prompt.{prompt,depth,role}
内嵌 character_book → 自动注册为一本世界书，并挂到该角色
```

PNG 读取：解析分块 → 取 `tEXt` → 匹配 `ccv3`/`chara`（不区分大小写）→ base64 解码 → JSON。v1 卡片常在 `chara` 里塞平铺 JSON，需要探测 `spec` 字段决定走哪条分支。

### 4.4 宏与 token

宏：`{{char}}` `{{user}}` `{{persona}}` `{{description}}` `{{personality}}` `{{scenario}}` `{{mesExamples}}` `{{time}}` `{{date}}`，以及变量 `{{getvar::x}}` / `{{setvar::x::v}}`（存 chat meta）。宏在**注入之后**展开，保证世界书内容里的 `{{user}}` 也能替换。

**Token 计数：精确优先，且用服务端真值自校准。**（已实现，`src/engine/tokens.ts` + `src/engine/hf-tokenizer.ts`）

零依赖做到精确的办法是自己读模型的 `tokenizer.json`。已实现的 BPE 覆盖：

- `model.type = "BPE"`，`vocab` + `merges`，支持 `ignore_merges`
- `added_tokens`（`<|begin_of_text|>` 这类特殊 token）在最前面按最长匹配切分并原子化
- normalizer：`NFC/NFD/NFKC/NFKD/Lowercase/Strip/Replace/Prepend/Sequence`
- pre_tokenizer：`Sequence/Split(Regex)/ByteLevel/Whitespace/Punctuation/Digits/Metaspace`
- ByteLevel 的 256 字符字节表 + GPT-2 分块正则
- decoder 可逆，用于验证

关键实现细节：酒馆随包的 llama3 `tokenizer.json` 里，预分词正则含 `(?i:'s|'t|'re|'ve|'m|'ll|'d)` 这种**内联修饰组**。Node 26 的 V8 支持 `(?i:...)`，所以正则**原样使用**，不需要任何改写——这是「精确」成立的前提。

验证方式（没有联网参考实现，所以用性质验证）：对 1416 条**真实世界书文本**做 encode→decode 字节级往返，全部一致；特殊 token 原子性；计数单调性；常见词/句子/中文的量级校验。已知的边界：estimate 模式在英文上偏高约 24%，学习比例后收敛到 6% 以内。

**自校准**：无论哪种模式，每次生成后拿服务端返回的 `usage.prompt_tokens` 回灌 `calibrate()`——它学的是「每条消息的对话框架开销」和「文本/token 比例」。精确模式下如果 divergence 明显偏离 1，说明加载的 tokenizer 与模型不匹配，UI 会直接提示，而不是默默给个错数字。

需要精确计数时，把对应模型的 `tokenizer.json` 放进 `data/tokenizers/`，在设置里选用即可；没有就退回估算模式并在 UI 上标注。

**窗口构成明细（`web/js/token-breakdown.js` + `components/token-bar.js`，2026-09）。** 进度条下面原本是一行
「总量锚定 X 实测（N prompt tokens）；构成「~」为 4 字符/token 估算」的长句。用户要求删掉它、换成**可折叠的
占比分析**。做法：

- **纯函数 `tokenBreakdown(preview, config)`**：按通道分桶（提示词栈 / 世界书 / 长期记忆 / agent 读到的文件 /
  对话历史 / 图片），每桶带 token 数与**占窗口的百分比**（与进度条同一分母）；世界里只算 `worldHits` 那些条目，
  深度注入里属于提示词栈的残余单独记；桶内再列出条目（世界书条目 / 历史消息），各取**最大的 12 条**，其余折叠成
  一行「其余 N 条」并带上 token 数。
- **诚实**：桶之和与 provider 锚定的 `used` 对不上时，差额单独列成「其它／未归类」，不吞掉、不假装加得起来。
  `test:web` 直接断言「各行之和 == used」。
- **折叠用原生 `<details>`**（和提示词栈分组同一套），**展开状态存模块级变量**——进度条每次预览刷新都会重建，
  否则用户一展开就被下一次编辑拍回去。默认收起。
- 原来那三行说明里的两个状态（精确/估算、是否锚定）没丢，收成标题行上的一个小标记「估算 · 锚定」。

---

## 5. 一次生成的完整数据流

```
前端 POST /api/generate {chatId, userMessage?, trigger}
  │
  ├─ 1. 追加用户消息到 chats/<id>.jsonl
  ├─ 2. world-scan.scan(...)                       ← 世界书命中集 + 命中原因
  ├─ 3. prompt-stack.build(...)                    ← 区块 → messages[]，填充 marker
  ├─ 4. macros.expand(messages)                    ← 宏替换
  ├─ 5. tokens.count → 超预算则按 chatHistory 从旧到新裁剪
  ├─ 6. （可选）GET /api/prompt/preview 同一条路径，前端可先看装配结果
  ├─ 7. llm.stream(messages) → SSE 逐 token 推给前端
  ├─ 8. 落盘助手消息 + scanState 更新（sticky/cooldown）
  └─ 9. 返回 itemization（token 明细 + 命中世界书清单）
```

**swipes**：同一份 messages 保留为 `parentId` 下的多个候选，前端左右翻。JSONL 每行一条，用 `{id, parentId, role, content, variants[], activeVariant}` 表达。

---

## 6. HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 存活检查 |
| GET/PUT | `/api/config` | 模型与采样参数、扫描默认值、persona（读时掩码 API Key） |
| POST | `/api/models` | 透传 provider 的模型列表 |
| GET | **`/api/providers`** | **服务商预设表 + 当前 baseUrl/model 匹配到的预设与文档上限（`?baseUrl=&model=` 可判断未保存的值）** |
| GET/PUT | **`/api/connections`** | **额外连接列表（群聊成员可单独选用；Key 读出为 `***`，存回 `***` 表示保持不变）** |
| GET | **`/api/worlds/fields`** | **字段元数据：编辑器表单与服务端校验的同一份来源** |
| GET | `/api/characters` | 角色列表 |
| POST | `/api/characters/import?name=` | 导入 PNG/JSON 卡片，自动识别 v1/v2/v3 |
| GET | `/api/characters/:id` | 卡片详情 + 它的会话列表 |
| PATCH | `/api/characters/:id` | `{name}` 改显示名；`{id}` 改 id 并迁移会话 |
| DELETE | `/api/characters/:id?cascade=` | 删除角色；有会话时默认 409，`cascade=true` 连会话一起删 |
| GET | `/api/characters/:id/avatar` | 头像（原 PNG 字节） |
| GET | `/api/characters/:id/export` | 导出成酒馆 v2 卡片 JSON |
| GET | `/api/worlds` | 世界书列表 + 来源格式 + 条目数 + 解析错误 |
| POST | `/api/worlds/import?name=` | 导入并识别来源；角色卡会被明确拒绝 |
| GET | `/api/worlds/:id` | 归一化视图（条目 + 本书设置） |
| PATCH | `/api/worlds/:id` | 本书设置：`scanDepth` / `tokenBudget` / `recursiveScanning` |
| DELETE | `/api/worlds/:id` | 删除世界书（缺失时 404，不会假成功） |
| GET/PUT | `/api/worlds/:id/raw` | 原文读写（写入前先解析校验，坏文档不覆盖好文档） |
| GET | `/api/worlds/:id/st-native` | 导出为酒馆原生格式 |
| POST | `/api/worlds/:id/entries` | **新增条目**（补丁经字段元数据校验） |
| PATCH | `/api/worlds/:id/entries/:uid` | **修改条目**，按原格式写回 |
| POST | `/api/worlds/:id/entries/:uid/duplicate` | 复制条目（含未知字段） |
| DELETE | `/api/worlds/:id/entries/:uid` | 删除条目 |
| GET | `/api/chats` / POST | 会话列表 / 新建 |
| GET/PUT/DELETE | `/api/chats/:id` | 会话读写与删除 |
| POST | `/api/chats/:id/worlds` | 挂载/卸载世界书（服务端原子操作） |
| POST | `/api/chats/:id/message` | 追加消息 |
| POST | `/api/chats/:id/variant` | 切换/追加 swipe 变体 |
| POST | `/api/chats/:id/truncate` | 从某条重开 |
| PATCH | `/api/chats/:id/entries/:entryId` | **编辑单条消息**（有 swipe 时改当前变体，变体 0 与 content 同步） |
| DELETE | `/api/chats/:id/entries/:entryId` | **删除单条消息**并把后续重新挂接到它的父节点（其余对话保留） |
| POST | `/api/generate` | SSE 流式生成；带 `retryEntryId` 时先回退到该条再生成 |
| POST | `/api/config/test` | 连接测试（无论成败都 200，失败原因原样透传） |
| POST | `/api/prompt/preview` | 装配预览：messages + 每块 token + 命中原因 |
| POST | `/api/scan/debug` | 只跑世界书扫描，返回命中与跳过原因 |

**约定**：路由只声明模式，不认识 `if (id === ...)` 链；出错就抛 `HttpError`，由组合根映射状态码
（`EntryPatchError` → 400 并带 `problems`）。分页参数一律 `decodeURIComponent`，
因为 `URL.pathname` 保留百分号编码——漏掉这一步曾让带空格的 id 删除静默失效。

---

## 7. 前端三面板

单页，左中右：

- **左：角色 + 世界书 + 会话**。角色可改名 / 改 id / 删除；世界书可勾选挂载、导出为酒馆格式、
  删除、**点名字打开条目编辑器**；会话可新建/删除。
- **中：对话**。消息流、swipes、从任意一条重开。
- **右：提示词栈 + 命中 + 预览**。空区块可开关、可改内容（改动真实生效并存进 localStorage）、
  绝对注入位置/深度/顺序；「装配预览」展开完整 messages 与每块 token；命中面板列出本轮命中的
  世界书条目、命中键、以及为什么（来源 / 递归轮次）。

**模块边界**（这是这一轮特意立起来的规矩）：

- `dom.js` 不依赖任何东西；`api.js` 只管状态、请求和事件总线，不碰 DOM；`views/*` 只渲染和发请求。
- **视图之间不互相 import**。跨视图动作走事件（`emit('select-character')`），由 `app.js` 接线——
  它是唯一知道所有视图存在的模块。
- **动态组件自持 DOM**。编辑器不往 index.html 里塞 id，也不用 `getElementById`；
  只有 index.html 里的静态锚点才用 id 查找。`test:web` 里有一条用例专门强制这条约定。
- **表单控件只有一份实现**：`components/form-field.js` 按字段规格生成控件（单行/多行/数字/开关/
  三态/枚举/键列表/触发条件），设置弹窗与条目编辑器共用它，所以新增一种控件不会只在一边生效。
- 编辑器表单由 `/api/worlds/fields` 生成，与后端校验共用一份元数据，加字段不需要改两处。
  设置页同理，由 `settings-schema.js` 生成（见 7.4）。

### 7.1 交互层约定

- **弹窗只有一个实现**：`components/modal.js` 负责 Esc、焦点陷阱、焦点归还、滚动锁定。
  设置与条目编辑器都用它，并且**自己构建内容**——index.html 里不再有任何表单。
  设置弹窗的尺寸是**固定的**（`height: min(760px, 88vh)`），滚动交给右侧的分页列：
  切分类时窗口不长不缩，行也不会因为滚动条出现而横向跳动（`scrollbar-gutter: stable`）。
  `test:web` 有一条用例禁止视图手搓 modal，另有几条把上面这几条尺寸规则钉住。
- **Esc 是一个栈**：`keys.js` 的 `pushEscapeLayer` 让 Esc 只关掉最上面那层——菜单盖在弹窗上时，
  Esc 先关菜单；消息内联编辑自己吃掉 Esc，不会关掉更外层的东西。
- **组件不认识 API**：`components/message.js` 只发 `onAction(action, entry, payload)`；
  `chat-actions.js` 才是发请求的地方。这样消息组件不依赖状态，也不需要 mock 网络就能读。
- **不做乐观更新**：编辑/删除/重试都等服务端返回后重新拉取。因为每次改动都会改变扫描与 token，
  本地先改再对齐只会让右侧面板短暂显示错误的数字。
- **滚动条自己画**：平台默认滚动条在深色面板里是一根 17px 的灰色柱子，三个面板各来一根很难看。
  改成 9px、轨道透明、滑块是内缩 2px 的胶囊（悬停变亮、拖动时变 accent 色）。用 `::-webkit-scrollbar`
  而不是标准属性，是因为 Chromium 一旦看到 `scrollbar-width`/`scrollbar-color` 就**丢弃**这些伪元素，
  而标准属性给不了精确宽度——代价是 Firefox 用它自己的细滚动条。另外整页**自己不许滚动**：
  `body` 是 `flex-direction: column`，`.layout` 吃 `flex: 1`，取代从前 `calc(100% - 41px)` 那种猜顶栏高度的写法
  ——猜错几像素，页面就会在窗口右缘多出一根滚动条，紧挨着右侧面板自己那根。
- **预算算术只有一处**：`token-budget.js` 是纯函数（无 DOM），中栏统计、右侧进度条、
  预览头部都调它，并由 `test:web` 直接单测——包括「剩余不为负」「超额时进度条夹住但百分比仍显示 120%」。

### 7.2 回复语言为什么是一个区块

「让模型用中文回答」有两种做法：把指令拼进系统提示词，或者让它在提示词栈里占一个位置。
这里选了后者，代价是多个区块、好处是它**可解释**：

- 出现在右侧提示词栈的「系统提示词」分组里，有自己的 token 计数，能单独开关、能被记住；
- `applyLanguage()` 在**装配时**和 `GET /api/prompt/stack` 里各渲染一次，所以生成前就能看到真实那一行；
- 语言是自由文本（`中文` / `English` / `文言文` / 火星文都行），指令模板也可改，
  模板里的 `{{language}}` 被替换；
- 客户端为了做实时预览复制了一份渲染函数（`web/js/language.js`）。这份重复是刻意的——
  **`test:web` 会拿同一组输入同时调客户端与服务端实现并断言结果相等**，还会断言客户端的兜底文案与服务端默认文案逐字节相同，所以两者无法悄悄漂移。

装配时若客户端传来的栈里没有这个块（老版本存下的 localStorage 覆盖），`applyLanguage` 会把它插回
`main` 之后——否则这个设置会被一个陈旧的覆盖静默吞掉。

### 7.3 面板折叠

布局是 CSS grid（`300px / 1fr / 360px`），折叠靠切类名把对应列压成 `0` 并 `display:none`：
中间的对话区因此**真的接管**释放出来的空间，而不是只把面板藏起来留一片空白。
状态在 `localStorage`，按钮用 `aria-pressed` 表示可见性，快捷键 `Ctrl+B` / `Ctrl+Alt+B`
由 `components/layout.js` 自己注册。

### 7.4 设置弹窗：分类导航 + 一行一个设置

配置项越来越多以后，一个长表单就不可读了。现在照 IDE 式设置的排布重做：左栏是**分类**
（各带一枚内联 SVG 图标），右边一次只显示一页；**每一行是「名字 + 说明」在左、控件靠右**，行间一条
细分隔线；多行文本整行展开；世界书那页再用 `group` 把 12 行分成「扫描范围 / 预算 / 递归 / 兼容开关」。
**配色没有换**——仍是这套深蓝灰，借的只是布局与层次。

六个分类：

| 分类 | 管什么 |
|---|---|
| 通用设置 | `outputLanguage` / `languageInstruction` + 预设 + **实时预览要注入的那一行**、界面语言、外语自动翻译、「替我说」后自动接话 |
| 外观 | 主题、配色、对话字体与字号、自投字体、消息 Markdown 开关（与右下角小按钮同一份实现） |
| 模型 | **服务商预设**（§7.34）、接口（`baseUrl` / `apiKey` / `model`）、**额外连接**、采样与预算（温度 / `top_p` / 频率惩罚 / 存在惩罚 / 上下文窗口 / 回复预留 / 单次回复上限 / 停止字符串）、
  token 计数（`tokenizerPath` + 当前模式 + 连接测试）、思考（显示思考过程 / 关闭思考）、纯文本补全后端 |
| 角色扮演 | 老两栏（`personaName` / `personaDescription`，兜底）、人设库、上下文模板（含酒馆预设导入导出） |
| 世界书 | 扫描深度与最小激活、预算百分比与上限、递归、向量检索（含两套 embedding 端点与索引状态）、以及 5 个兼容开关 |
| 语音 | 引擎（本机 / 在线）、音色、语速、在线 Key 与模型（§7.25） |

几条刻意的选择：

- **左栏是真的 tablist**：`role="tab"/"tabpanel"`、`aria-selected`、隐藏用 `hidden`，方向键 / `Home` /
  `End` 切换。不是几个按钮加 `display:none`。
- **所有页的控件一起建**。切页不重建 DOM，所以改了一半切走再切回来，改动还在；保存时**一次 PUT**
  提交整份配置，不存在「这页存了那页没存」。
- **`settings-schema.js` 是设置的唯一描述**：页、图标、分组、字段、校验规则、保存载荷都在这里，视图只
  负责建 DOM。从前这些字段被写了四遍（`CONFIG_FIELDS`、`SCAN_FIELDS`、两个数字常量表、index.html 里的
  手写 markup），改一处忘一处是迟早的事。现在 `test:web` 会交叉校验：**每个字段 key 必须真实存在于
  服务端 `DEFAULT_CONFIG`**（写错一个字母就红），同名字段不能出现两次，控件类型必须在支持列表里，
  每个分类的 `icon` 必须在 `components/icon.js` 里真有那枚图标，枚举选项必须与 `INSERTION_STRATEGY` 一致。
- **载荷规则用测试钉住**（都是以前手写保存踩过的坑）：文本字段**总是发送**（包括空串，否则「清空回复语言」
  会被静默忽略）；数字框被清空时**不发**（否则变成 0）；`apiKey` 显示 `***` 时**不发**（服务端也是看到
  `***` 就丢弃）；枚举按数字发。
- **校验在保存之前**：`FIELD_RULES` 检查取值范围，出错时自动跳到有问题的页、把消息贴在那一行下面并聚焦，
  「有未保存改动」的小圆点则来自 `changedFields`（它按**载荷**判断，所以「清空数字框」不算改动）。
- **行由 `components/form-field.js` 生成**，设置页传 `{ hint: 'inline' }` 把说明显示在行里，条目编辑器
  的 41 个字段则不显示（太密），只留 tooltip——同一份代码，两种密度。
- **每页可以带一块不是字段的区域**：`extra: 'counting' | 'language'`，由视图注册的构造函数渲染并提供一个
  `refresh()`，而且也用同一个行结构（`settingsRow()`），所以额外区域和字段看起来是一套东西。

### 7.5 交互层怎么测（`test:ui` + `shim-dom`）

「设置按钮点了没反应」已经出现过两次，而两次的语法检查、导入解析、id 对照**全是绿的**——坏的是点击处理函数
内部的一个运行时细节。这类错误只有真的点一下才会暴露，可这里没有浏览器。

于是有了 `scripts/shim-dom.ts`：一个手写的极小 DOM（元素/类名/属性/冒泡派发/`querySelector`/焦点/`localStorage`），
`test:ui` 用它把设置弹窗**真的跑起来**：

- 打开 → 断言六个分类、`aria-selected` 唯一、只有选中页可见、每个 tab 与 pane 互指；
- 键盘：方向键/Home/End 走分类，**只有选中的分类在 Tab 顺序里**，隐藏页里的控件**不可达**（`focus.js` 依赖
  `offsetParent`），Tab 在弹窗内环绕且被 `preventDefault`，**Esc 关闭并归还 Esc 层**；
- 值：控件初始值来自配置、`***` 掩码、存一个非法数字会被拒并跳到它的页、空数字框不发；
- 保存：一次 PUT，载荷形状（`scan` 嵌套、枚举是数字、掩码字段缺席）逐条断言；
- 41 个真实条目字段规格全部过一遍控件工厂，读写往返一致；
- 最后断言客户端**自己的错误浮层**没有报过任何错——没被 guard 抓住的异常会让这一步变红。

不引 jsdom 是为了保住「零依赖」，代价是这个替身不通用：没实现的方法就是不存在，一用就抛错，而不是悄悄
表现得和浏览器不同。它也踩过一次自己的坑——类字段会**遮蔽**原型上的 `textContent` 访问器，导致容器读成空字符串，
所以那里特意写成访问器（shim 自己的 bug 由 `test:ui` 的断言兜住）。

更危险的是替身**比浏览器宽松**，因为那种差异会让测试替真代码撒谎。真实案例：`Element.append(null)` 在浏览器里
按 DOMString 转换插入文本 `"null"`，而替身一开始「聪明地」跳过了 `null` —— 于是
`body.append(maybeNullBlock, textNode)` 这个写法在**八套件里全绿**，而在浏览器里每条消息下面都多出一行
`null`。最后是靠用户贴的 DevTools 截图才发现的，而我当时拿替身跑出的「渲染 43 条消息、0 处 null」那份证据
恰恰是假的。现在替身忠实复刻这个转换（`null` → `"null"`、`undefined` → `"undefined"`），`test:boot` 另有一条
「消息体里只允许元素节点、不许有裸文本节点」的断言，并且**验证过把那个 bug 重新塞回去时它确实会红**。
教训：替身的每一条「宽容」都要么去掉、要么写进注释当已知偏差——否则它保护的不是代码，是幻觉。

`test:boot` 再往前一步：它把真实的 `index.html` 解析进这个 DOM，把 `fetch` 指向一个**真的**起了临时数据目录的
服务端（外加一个假 provider 用来真的流式回话），然后 `import('web/js/app.js')` 跑完整条启动路径，并继续驱动
导入、预览、发送、重生成、条目编辑、列表菜单与二次确认。它抓到过第一个真实 bug：

> 一轮生成结束后，`generate()` 是**先**重新渲染对话、**后**把 `streaming` 置回 false 的。而消息操作菜单
> 是在渲染时按 `state.streaming` 决定「删除这一条 / 从这里重开」是否禁用的——于是每次生成完，这两项都会
> 一直是灰的，直到别的事情重新渲染了对话。现在在重新渲染之前就先把 streaming 关掉。

它顺带解释了为什么这类 bug 以前只能靠人发现：静态检查全绿，接口测试与它无关，而单元级的组件测试根本走不到
「生成结束之后的那一次渲染」。

同一套用例还复现并修掉了第二个真实 bug —— 用户报的那条 `Cannot read properties of undefined (reading 'length')`：

> 流式生成在第一个 delta 之前会先发一个 `prompt` 帧，里面只有 itemization 与 token 数、**没有 `messages`**；
> 而 `state.preview` 在那之前可能是 `null`（刚打开页面就直接发消息）。预览面板读 `preview.messages.length`
> 就抛异常，异常被 `generate()` 的 catch 接住、用 `showError` 顶掉整个对话区 —— 于是「消息其实已经存好了，
> 但界面报错、刷新一下才出现」。生成之后再**切换对话**会重新渲染预览面板，拿到的是同一个残缺对象，所以也炸。
> 现在面板统一走 `preview.messages ?? []`，没有正文时改说「正文还在生成」，`test:web` 另有一条静态断言
> 禁止再出现 `preview.messages.length` 这种读法。

### 7.6 思考过程：看不见的等待与「关闭思考」

用户的反馈是「加了模型切换之后慢了很多」。实测下来**程序侧无辜**：装配 + 扫描 + 计数只有 38ms；
慢的是两个模型**都在思考**——它们先流一段 `reasoning_content`，而客户端当时没有 handler，把这些帧直接丢掉，
于是思考那段时间界面完全静止，体感就是卡住。同一句短问实测：

| 模型 | 总耗时 | 首个思考帧 | 首个可见正文 |
|---|---|---|---|
| `deepseek-flash` | 832 / 881 ms | 827 / 795 ms | 975 ms |
| `deepseek-v4-pro` | 1404 / 1516 ms | 635 / 967 ms | 1180 / 1667 ms |

顺带发现一个坑：**把 `max_tokens` 设小（16）时，思考会把预算吃光，正文返回空字符串**（实测 `v4-pro` 就是这样）。
所以设置里的两个开关（都在「模型 → 思考」）：

- **显示思考过程**（默认开）：实时显示 + 存在消息里（`ChatEntry.reasonings`，与候选回复**按下标对齐**，
  所以 swipe 时看到的是当前那条的思考）+ 默认折叠。关掉时服务端**既不转发也不存储**（思考可能很长，
  没必要留着）。它**永远不会**回到提示词里：装配只读 `content`。
- **关闭思考（实验）**（默认关）：请求里同时发 `reasoning_effort: "none"` 与 `thinking: {"type":"disabled"}`。
  两个拼法都发是因为各家不一致——在 api.deepseek.com 上实测**两者都有效**，而
  `enable_thinking` / `chat_template_kwargs` / `reasoning:{enabled:false}` 被无视（**不报错**，说明未知参数它只是忽略）。
  默认关是因为严格校验参数的端点可能直接 400。

### 7.7 角色卡编辑与开场白

「核心三件事」里最后补上的一角。两个决定值得记下来：

**开场白是一条普通消息。** 新建会话时把卡片的 `first_mes` 作为一条 `role: 'assistant'` 的条目写进 JSONL，
而不是某种"虚拟问候"。下游因此不需要任何特例：提示词栈把它当普通历史、可以编辑、可以删除、
swipe/重试都照常工作——它只是"不是模型产出的"而已。`greeting` 参数是**索引**而不是文本
（`0` = 首条消息、`N` = 第 N 个备用问候、`-1` = 不要问候），服务端从卡片里取文本，
所以调用方无法用这个接口往transcript 里塞任意内容。

**卡片的可编辑字段只有一份声明。** `EDITABLE_CARD_FIELDS`（`src/formats/character-card.ts`）同时被
补丁校验、编辑器表单（`web/js/character-fields.js`，逐字段对应）和 `test:web` 的交叉校验读取。
这条规矩是从设置弹窗那边学来的：字段表写两遍，早晚会出现"界面能填、保存被悄悄丢掉"。
写入复用导入器那条无损路径（`writeCharacter` → PNG 或 JSON 载体），所以编辑 PNG 卡不会把它变成 JSON，
未知字段也不会丢。

编辑器为了「备用问候」给共享控件工厂加了第四种控件：`text-list`（一列多行框，可增删，读取时丢弃空项，
与服务端保持一致）。设置页、世界书条目编辑器、角色卡编辑器现在共用同一套控件。

### 7.8 聊天记录互导，与「分叉 = 另存一份」

**记录互导**（`src/formats/chat-log.ts`）。酒馆的聊天记录是 JSONL：第一行是头部
（`chat_metadata` / `user_name` / `character_name`），之后每行一条消息
（`mes` / `is_user` / `is_system` / `send_date` / `swipes` / `swipe_id` / `extra`）。导出按这套写，
`send_date` 也照它的样子格式化成 `June 1, 2024 3:04pm`；导入同时认**自己的 jsonl**
（`role`/`content`/`variants`/`activeVariant`），所以「导出→导入」对自家无损往返，
`swipes` ↔ `variants`、`swipe_id` ↔ `activeVariant` 一一对应。读不懂的行**跳过并计数**而不是整份失败
——一份记录里有一行坏数据，不该让人丢掉整段对话。导入时`greeting: ''` 建空会话再 `writeChat` 覆盖，
所以内容一律以文件为准。

**分叉 = 复制成一条新会话**，而不是在同一份记录里建树。与 SillyTavern 的 branch 语义一致：
它的 branch/checkpoint 也是另存一个聊天文件。好处是分叉出来的是普通会话，可以改名、导出、删除、再分叉；
代价只是磁盘上多一份副本。若改成"文件内建树"，提示词装配、swipe、截断、追加都得先回答"当前路径是哪条"，
那才是真正容易出错的地方。`ChatEntry.parentId` 留着（数据本来就是树），将来真要做文件内分支切换时它已经在那儿。

### 7.9 请求参数：从「类型里有」到「端到端生效」

第一批补的是"后端早就支持、界面没有入口"的四个请求参数（`top_p` / `maxTokens` / 停止字符串 / `requestUsage`）
和已经有了但只给 JSON 的 PNG 导出。接线本身很浅，却抓到一个真问题：

> `LlmConfig.stop` 与请求组装（`payload.stop`）一直都在，客户端也能编辑列表——可是**生成路由从来没有把
> `config.stop` 传进 `streamChat`**。"后端支持"当时只对了一半：类型和序列化支持，调用链断了。
> 我在设置里把它暴露出来、加了一条"stop 必须出现在 provider 请求体里"的断言，它立刻红了，才发现要补的是路由。

教训写进测试而不是注释：**"这个能力已支持"要以端到端能验证的行为为准**，不能以"类型里存在"为准。
所以这一批断言都落在最终效果上——假 provider 收到的请求体里有没有 `top_p`/`max_tokens`/`stop`、
关掉用量后 `stream_options` 是否真的消失、导出的 PNG 用 `parseCardFile` 读回来是不是当前数据。

另外两个细节：**列表字段必须按数组发**（`stop` 若被 `String()` 掉就变成逗号连接的一整条，永远匹配不上）；
`displayValue` 若把数组字符串化，未改动的字段每次保存都会被判成"有改动"。导出的 PNG **不重新编码图片**，
直接把 `data/characters/<id>/card.png` 交出去——它本身就是最新卡片，因为每次编辑都经 `writeCardPNG` 写回。

### 7.10 快捷回复：一条横条、一个事件

几个小决定：

- **存服务端文件**（`data/quick-replies.json`），不是浏览器 localStorage：本项目的数据都是可读、可手改、
  可备份的文件，快捷回复没有理由例外。
- **字段名对齐酒馆**（`label` / `mes` / `enabled`，导入还认它的 `{ quickReplySlots }` 外壳），
  这样别人现成的快捷回复可以直接搬过来；导出同样给它的形状。我们自己的文件多一个 `enabled`（整条横条）
  与 `id`（编辑器定位行用；导出时不带，免得污染对方的形状）。
- **整份替换而不是逐条 PATCH**：这是一个短列表、用户当成一个整体在编辑，逐条接口只会多出两份副本走样的机会。
- **空条目在导入/保存时就被丢掉**（没有正文、也没有按钮文字 = 没有意义），并**计数上报**——静默丢弃比报错更糟。
- **横条不碰输入框**：它只 `emit('insert-composer' | 'send-message', { text })`，由拥有 composer 的
  `views/chat.js` 插入到光标处或直接发送。跨视图动作走事件、由 `app.js` 接线，这条规矩没有因为
  "只差一个 DOM 引用"而破例。
- 一个空横条会留一个「＋ 快捷回复」的入口，否则用户根本发现不了这个功能。

### 7.11 斜杠命令：输入框里的一条命令行

目标是"像 agent 一样"：输入 `/` 就跳出可用命令，边打边筛，选一条执行。决定如下：

- **纯客户端，不新增任何后端接口**。每条命令要么调用界面本来就能调的 API，要么用事件请对话面板
  代劳（`/model` → `set-chat-model`、`/regen` → `regenerate-reply`、`/send` → `send-message`）。
  所以这一块不需要重启服务端，也不可能绕过已经存在的权限与校验。
- **只登记今天真能跑的命令**。`/continue`、`/impersonate` 属于下一块（继续/替用户发言），现在登记
  只会多两个点了没反应的入口——这正是 §7.9 那个教训的应用。
- **补全而不是发送**：调色板打开时 Enter/Tab 是补全成 `/名字 `，不是把半条命令当消息发出去；
  Esc 只关调色板（`stopPropagation`，不动底下的弹层）。单独一个 `/` 加发送键也只是唤出列表。
- **同步判定、异步执行**：`isCommandLine()` 是同步的，`views/chat.js` 靠它决定"发送"还是"执行"。
  第一版写成 `await runCommand(...)`，普通文本因此晚一个微任务才进 `generate()`，composer 的
  锁按钮不再和点击同拍——boot 用例立刻抓到了这个回退。现在普通文本与点击同拍，命令才走异步。
- **只在真的是一条命令行时出现**（用户复核后收紧）：输入框内容必须是**裸命令记号**（`/`、`/mod`）**且至少匹配
  一条命令**。普通句子里的斜杠（`价格是 10/20`）、匹配不到任何命令的前缀（`/zzz`）、空输入框，一律不显示——
  一个什么都提供不了却挡着对话区的列表，比没有列表更糟。列表也刻意压到 200px，超出部分自己滚。
- **程序化写输入框要主动通知**：给 `.value` 赋值不会触发 `input` 事件，所以「打了 `/` 又点快捷回复」会让列表
  僵在那儿遮着一个已经不是命令的行。现在由 composer 的主人（`views/chat.js`）在插入与发送清空之后调
  `syncComposerPalette()`，判定逻辑仍然只写在一处。
- **`//开头` 仍是普通消息**，留一条逃生通道：真想发一条以斜杠开头的话，打两个斜杠。
- **`/help` 用共享弹窗外壳**（`components/modal.js`），命令清单只在一处声明（`web/js/commands.js`
  的 `COMMANDS`），`test-web` 直接读这张表检查命名、唯一性、必填说明，以及"/continue 还没登记"。
- 顺手补上 **Ctrl+Enter 发送**：占位符和 `components/message.js` 的注释都一直宣称它存在，实际上从来
  没有注册过。现在它真的发送，而消息内联编辑器靠 `stopPropagation` 继续独占自己的 Ctrl+Enter。

### 7.12 长期记忆：一个区块，不是一次改写

长期记忆把滚动摘要做成独立区块。语义与 SillyTavern 的 Memory 扩展
（`public/scripts/extensions/memory/index.js`）一致：**每 N 条**（默认 10）把"上次摘要之后的新消息"
接着**上一版摘要**扩写一次，注入成 `[Summary: {{summary}}]`，system 消息、从末尾往前第 2 条的位置，
可手动编辑，也可冻结（`memoryFrozen`）。

两处是刻意的不同，都记在这里免得以后被"对齐"回去：

1. **摘要存 `chats/<id>.meta.json`，不挂在某条消息的 `extra.memory` 上。** 一条事实一个出处，而且删掉
   任何一条消息都不可能顺手把记忆带走。酒馆互导仍然成立：`formats/chat-log.ts` 双向转换——导入时把
   `extra.memory` 收进我们的字段（并锚定到它所在的那条消息），导出时写回同一位置，那边照旧能用。
2. **不改写聊天记录。** 摘要只增加一个区块，裁剪仍是唯一会把消息移出提示词的东西。用户选的正是
   "只增不删"：事实会重复出现，但没有任何一条历史会被悄悄删掉。

其余决定：

- **注入方式与「回复语言」同构**：一个真实区块 `memory`，`injection_position = ABSOLUTE` +
  `injection_depth = 2` + `role = system`，所以它有独立 token 计数、能在右栏看到、能单独关掉；绝对注入
  与"世界书条目按深度注入"走的是 `buildPrompt` 里同一条 `addInjection` 路径，多个来源会合并进同一条
  system 消息——预览里看得见。
- **触发在回复落库之后**：`/api/generate` 的 `done` 帧带 `memory: {due, since, interval}`，客户端在
  `generate()` 完全收尾（streaming 已清、会话已重载）之后才 `emit('memory-due')`，由 `views/memory.js`
  跑第二次模型调用。第一版在 `done` 里直接触发，结果被自己的 `state.streaming` 闸门挡掉，boot 用例
  立刻抓到——**"什么时候跑"和"跑什么"一样是设计的一部分**。
- **摘要调用是一次独立的 `chatOnce`**：非流式；温度 0.3（总结要的是无聊的答案）；不带 `stop`（用户的
  停止串是给角色扮演的，会把摘要截断）；不带 `maxTokens`（长度由提示词约束）；`requestUsage: false`，
  而且**绝不写 `usageAnchor`**——那个锚描述的是会话自己的提示词，混进来预算就废了。有专门的用例钉住。
- **失败只影响记忆**：provider 报错时该轮回复照常，旧摘要保留，编辑器里能看到错误；下一轮由于
  `since` 仍然够数会自然重试一次。
- **顺手修掉一个既有毛病**：`applyLanguage` / `applyMemory` 过去每次装配都重算 `enabled`，于是"在提示词
  面板里关掉那一行"看着生效、实际无效（行显示 off，内容照旧注入）。现在分工明确：**设置决定有没有内容，
  面板那一行决定注不注入**。语言与记忆两个区块都按这条走。
- **默认关闭**，而且"打开但还没有摘要"也不改变请求：`test:api` 直接对比开关前后的 `messages` 与
  `totalTokens`，逐字节相等；`test:prompt` 则钉住区块禁用时不进请求。

### 7.13 轨迹：程序做了什么，与它说了什么分开记

右栏「请求预览」升级成轨迹视图：把"这一轮发了什么、花了多久、命中了什么"做成可回看的时间线。三个决定：

1. **轨迹不是会话的一部分，是旁挂的仪器。** `data/chats/<id>.trace.jsonl`，一行一个事件，与
   `<id>.jsonl`（说了什么）并列。**事件日志而不是挂在消息上的字段**，因为有意思的事件不全是消息：
   被删掉的消息在会话里已经不存在、记忆更新根本不是消息、失败的请求压根没产生消息——这三件事都值得
   留痕，也只有独立日志放得下。轨迹**只读业务数据**，唯一的写入就是它自己。
2. **数字在发生的地方记，不在需要的地方算。** `startedAt` / 首 token 延迟 / 结束时间只有生成路由知道，
   所以 `routes/generate.ts` 直接落一行 `turn`（含 provider 的 usage、命中的世界书、是否裁剪、模型、
   触发方式、失败的原文）；记忆更新由 `routes/memory.ts` 落 `memory`，编辑/删除/重开/分叉/导入/换候选
   由 `routes/chats.ts` 落各自的行。**没有"事后补记"的路径**——需要被通知的接口就有被遗忘的可能。
3. **请求正文只留最近 20 轮**（`TRACE_BODY_TURNS`）。一轮的 messages 有几十 KB，全留会让"仪器"变成仓
   库里最大的文件；旧轮次保留数字、丢掉正文，详情里明说"这一轮的请求正文已经不在保留窗口里了"。
   顺带把「装配预览」从一个只能看当前的界面，变成能回看历史某一轮究竟发了什么。

界面上：

- **右栏两种模式**（提示词 ⇄ 轨迹）。模式归 `components/layout.js` 管，因为它是布局事实：决定这一列
  装什么、多宽。轨迹模式下这一列放宽到 `min(620px, 46vw)`（`list + detail` 在 360px 里放不下），
  并且写 `.layout.trace-mode:not(.hide-right)`，让"收起面板"仍然赢——隐藏的面板不该被模式撑开。
- **列表与详情用可换行的 flex 行**而不是网格：宽度够就左右并排，不够就自动上下堆叠，不需要媒体查询。
- **时间线 = 消息 + 事件**。消息是骨架（导入的会话也有），`turn` 事件按 `entryId` 贴到它产生的那条消息上，
  于是回复那一行自己带着数字；没有消息的事件（失败、记忆、删除）自成一行。会话里那条开场白没有请求记录，
  详情就**明说没有**，而不是编一组数字出来。
- 顶部每轮一根双色柱（输入 / 输出，按最大值缩放），点柱子即选中那一轮；失败的那一轮柱子标红。
- **不做没有数据源的一栏**：例如缓存命中率，兼容的 SSE 不回这个统计，所以没有这一栏；模型没报
  usage 的轮次在图上按 0 计，并在汇总里说明有几轮没有数字。
- 模式变化由布局控制器 `onChange` 广播（`emit('layout')`），轨迹视图据此决定何时拉数据——**不去重复监听
  同一批按钮**，否则两个监听器谁先谁后会变成隐式契约。

### 7.14 向量存储：两种接口，一条管线

向量检索补的是兼容洞口：SillyTavern 里靠向量激活的条目，在这里原本完全不动。
对方的实现已经核对过（`_ref/SillyTavern`）：`vectra` 库的本地索引（`package.json:91`、`src/endpoints/vectors.js:300-310`）、
集合 id `world_<hash(书名)>`、**整条条目内容不切块**（`extensions/vectors/index.js:1680-1687`）、按内容 hash 增量
（:1682-1693）、命中后 `WORLDINFO_FORCE_ACTIVATE`（:1725）。几个决定：

- **一个客户端，两套配置**：远程（OpenAI 兼容）与本地（Ollama / LM Studio / llama.cpp / vLLM）
  都是 `POST {base}/embeddings`、`{model, input}`，所以差别只在地址、Key、模型。两套都存着，一个「当前使用」
  开关选用哪套——换端点不用重填。**聊天接口常常没有 embedding**（实测 `api.deepseek.com` 的 `/embeddings`
  是 404），这正是它必须独立配置的原因；设置里的「测试向量服务」会把这件事直接说出来，而不是让你猜。
- **零依赖的边界**：「本地」指的是**本机已经在跑的 HTTP 服务**，不是把模型打进 Node。想完全离线，装一个 Ollama。
- **命中进现有世界书管线**：`world-scan.ts` 里那个从没被产生过的 `activatedBy: 'external'`
  就是为此留的。向量命中的条目在扫描**之前**就被塞进 `allActivated`（SillyTavern 也是先激活再扫描），于是位置、
  深度、插入策略、预算、递归、命中面板的解释全都照旧。三处刻意与关键词命中不同：**不掷概率**（向量已经做过判断）、
  **不武装也不受 sticky/cooldown 影响**（那不是关键词事件，武装 cooldown 反而会挡住它自己以后的关键词命中）、
  **它的文本计入世界书预算**（提示词超了就是超了，不管条目是怎么进来的）。
- **索引是显式动作**，绝不是保存世界书的副作用：要花钱或花 CPU，还可能很慢。`data/worlds/<id>.vectors.json`
  是旁挂文件（**不碰书本原文**），只存 `{uid, hash, vector(base64 Float32)}`——文本永远从书里现读，
  不存在两份内容漂移；维度或模型不符则整本作废并要求重建，而不是拿两个向量空间的数字硬比。
- **只索引勾选过的条目**：条目编辑器里的 `vectorized` 从「只读、当前仅保存不生效」变成了真字段；
  再加一个「索引所有条目」总开关（酒馆的 `enabled_for_all`）。空条目与禁用的条目不参与——没有内容可嵌。
- **检索**：最近 N 条消息（默认 2）拼成查询，阈值 0.25、最多 5 条（都是酒馆默认）；查询向量按
  `模式+地址+模型+hash(文本)` 缓存，装配预览刷新不会重复打接口。
- **失败只影响这一轮的语义搜索**：端点是 404、超时、维度不一致、模型换了，都会变成预览里的一条 warning，
  而回复照常发生。这条在 `test:api` / `test:boot` 里都有用例（假 provider 会按开关返回 404）。
- 客户端：设置「模型」页放连接（两套地址/模型/Key），「世界书」页放行为（**注入模式**/阈值/条数/查询条数/批量）
  与那块状态面板（测试连接、逐本已索引/待更新、重建全部、「试一条」看真实分数）；世界书列表上的
  「向量 N/M」徽标点一下就增量重建；命中面板显示「向量激活 0.423」——**分数是调阈值的唯一依据**，比酒馆的静默激活好解释。
- 顺手修掉一个既有毛病：`vectorized` 是只读字段，所以「勾上它」这件事以前根本写不进去。现在它是可写的，
  `test:api` 用另一个真正只读的字段（`displayIndex`）继续钉住"只读字段被拒绝"这条规则。
- 测试里还抓到一个**假阳性风险**：boot 套件里两处断言读的是 toast 文本，而 toast 是在它们等待的状态之后
  才创建的——跑得慢一点就会偶发失败。现在它们也 `until` 等待，不再靠"刚好赶上"。

### 7.15 主题：调色板是数据，不是散落的颜色

用户要求：现在只有深色，要能切浅色，**并且预留别的主题，而不是锁死黑白**。做法：

- **主题 = 一组 CSS 变量的取值**，一份完整契约（29 个 token：底色/面板/线/文字/强调/危险/成功/警示/
  角色色/气泡/菜单/遮罩/阴影/滚动条）。`:root` 本身就是深色主题，浅色是 `:root[data-theme='light']`。
  加一套主题因此只有两步：**在 `style.css` 加一个调色板块 + 在 `js/themes.js` 加一条记录**，任何组件
  都不用动——因为没有组件知道颜色的字面值（改造前只有 19 处 hex、8 处 rgba 是散落的，其余 280 处早就走 token）。
- **切换只改 `<html>` 上的一个属性**。选「跟随系统」时**不设属性**，交给样式表里的
  `@media (prefers-color-scheme: light)`——所以跟随系统**一行脚本都不需要**，而且窗口开着时系统切换会立刻跟上。
- **浅色调色板出现两次**（显式选择那块 + 媒体查询里那块），因为 CSS 无法用一条规则同时覆盖"明确选了浅色"
  和"跟随系统且系统是浅色"。既然必须写两遍，就让 `test:web` **断言两块逐字节相同**，而不是指望以后的人记得同步。
- **`test:web` 的主题契约**（这次改造的主要价值）：先剥掉注释，收集样式表里所有 `var(--x)`，然后要求
  ① 每个被用到的 token 都有定义（抓拼写错误）；② 每个调色板块**定义完全相同的 token 集合**（少一个就是
  浅色主题里的一块黑斑）；③ 两块浅色完全一致；④ 调色板里没有用不到的 token（`--warn-dim` 就是这么揪出来的：
  它从旧代码带来、从来没人用）；⑤ **布局状态不是主题**——`--track-left/--track-right` 属于 `.layout`，
  塞进调色板会让"折叠面板"随主题变化而坏掉；⑥ 每个主题 id 都有调色板块、每个调色板块都有可选中的 id、
  图标名字真实存在。
- **深色一像素不改**：`test:web` 里钉着"改造前的 11 个颜色值"，谁动了深色主题都会红——这是把用户那句
  「保持颜色」变成机器可执行的断言。
- **不闪**：`js/theme-boot.js` 是 `<head>` 里的**普通脚本**（不是模块——模块是 defer 的，浅色主题在深色
  系统上会先闪一下深色），它只做一件事：把存着的选择抄到属性上。规则（校验、系统解析、持久化）仍然只在
  `themes.js` 一处，所以它不会长成第二份实现。
- **存 localStorage，不进 `data/config.json`**：主题是"这台机器这个浏览器"的偏好（和面板折叠一样），
  不是服务端数据，所以切主题不写用户的数据文件。存了个已不存在的主题 id 时回落到跟随系统，而不是变成没样式。
- 设置里放在**通用设置**页（`extras` 现在是列表，一页可以带多个非字段区块），做成三张卡片：主题靠眼睛
  识别比靠读字快。卡片颜色全部来自 token，所以新加的主题自动就有正确的卡片。

### 7.16 配色：第二条正交的轴

用户要"右下角一个小按钮，能选多种颜色、实现多种好看的配色"。与其做 N 套整主题（每套 29 个 token ×3 份），
不如把它拆成**两条正交的轴**：明暗（主题）× 强调色（配色）。

- **配色只覆盖强调色那一族**：`--accent` / `--accent-dim` / `--accent-soft|mid|strong` / `--user-bubble`，
  6 个 token。于是"6 配色 × 2 明暗 = 12 种观感"，代价是每套配色 3 个小块（深色、显式浅色、
  跟随系统且系统为浅色——同样因为 CSS 没法让一块同时覆盖两种浅色情形），而不是每套 29 个 token。
- **默认配色（靛蓝）没有块**：它正是基础调色板已经定义的东西，所以 `data-accent` 的缺省就是它——
  和"跟随系统 = 不设 `data-theme`"是同一种思路：**缺省值不进 CSS**，少一份要同步的东西。
- **配色必须两套明暗都好看**：每块里浅色的强调色都另给（深色底用亮蓝 #7aa2f7，浅色底用 #3b6fd4）。
  `test:web` 因此要求：每套配色恰好覆盖那 6 个 token、三种变体齐全、两块浅色逐字节相同、
  深浅两版的 `--accent` 必须不同（否则就是直接把深色值搬到浅色底上）。
- **色块必须说真话**：按钮上那个圆点的颜色写在 `themes.js` 里（UI 需要它，CSS 给不了），
  `test:web` 断言它与该配色在 CSS 里的 `--accent` 一致——一个显示错颜色的色块比没有色块更糟。
- **右下角小按钮**（`views/theme-fab.js`）：常驻、半透明、悬停变清晰，点开是一个小浮层，
  里面是配色圆点 + 三个明暗 chip + 一行"存这台浏览器"。**两条轴都走同一个 `themes.js`**，所以它和设置
  对话框永远不可能给出不同的结果。Esc 与点击外部只关浮层（用的是 `pushEscapeLayer` 那套"一次只关一层"）。
- 设置里也有同一排色块（同一个 `components/accent-swatches.js`），两处入口、一份实现。

### 7.17 继续生成与替用户发言：同一条路的两种走法

继续生成与替用户发言各走各的存法（`commands.js` 里 `/continue`、`/impersonate` 一直空着等它）。
语义上：

- **`continue` 把最后一条回复接着写下去**，而不是新起一条。落盘是原地追加到当前候选
  （有 swipe 时是激活的那个，`content` 只在改的是变体 0 时同步），transcript 长度不变、
  不新增变体。世界书按 `trigger: 'continue'` 重扫一次，所以限触发的条目在这轮可用。
- **`impersonate` 替用户说一句**，存成一条新的 `role: 'user'` 消息（不带变体、不带思考）。
  印象提示词是一个真实区块 `impersonate`（默认文案见下），平时强制关闭、
  这一轮才按面板开关注入——与回复语言、长期记忆是同一套"设置决定有没有、面板决定注不注入"的分工。
  它会出现在提示词栈"对话与示例"分组里，有独立 token 计数。

**替我说「像续写」的修法（用户报的）。** 三件事一起改，缺一不可：

1. **位置**：它从前是个普通静态区块，于是被塞进 `systemMessages`——**排在整段对话之前**。模型最后
   读到的是角色那条旁白，自然接着往下写。现在它是**绝对注入、深度 0**，也就是请求里的**最后一条消息**。
2. **role 必须是 `user`，不是 `system`**（A/B 实测，同一会话同一文案）：

   | 结尾消息 | 结果 |
   |---|---|
   | `system` + 现文案 | ❌ 写成 {{char}}（角色）——复现用户报的 bug |
   | `user` + 现文案 | ✅ 写成玩家视角 |
   | `system` + 改写文案 | ❌ 还是 {{char}} |
   | `user` + 改写文案 | ✅ 玩家视角 |

   chat 模型把"最后一条 system"当背景提示，继续以 assistant（=角色）身份续写；**最后一条 user 才是它必须
   回应、且必须以对面那个人身份回答的东西**。所以 role 从 system 改成 `user`。
3. **深度 0 的插入索引有个真 bug**：原式 `index = baseLength - depth` 里的 `baseLength` 是**原始**历史长度，
   只要已有别的注入（长期记忆在深度 2、世界书 atDepth、卡片的 depth prompt）先插进来，深度 0 就会落到
   **倒数第二**。已改成：深度 ≤ 0 一律插到当前末尾。`test:prompt` 造了「记忆 + 深度 0」的组合来钉它。
4. **文案**：不再要求"第一人称"（玩家的习惯可能是「你看着她…」这种第二人称自述），改成"看玩家最近几条
   的**人称与语气**去写"；也不再依赖人设名——人设正好叫「我」时，`{{user}}` 会被读成人称代词（这正是第一版
   踩的坑），所以一律说 "the player"，只用 `{{char}}` 指对手。
5. 已知行为（不是 bug）：替我说只生成**你那一条**，对方的回复仍要你按发送/继续——与酒馆的 Impersonate 一致。
   `config.impersonateAutoReply`（设置 → 通用设置，默认关）是给想要"说完就接戏"的人的可选项：客户端在
   `impersonated` 落定、transcript 重载之后，用 `setTimeout(0)` 再发起一次**普通**回合（没有 mode，所以
   不可能自连环），代价是多一次模型调用。
6. 顺带补的**空回合警告**：推理模型把预算全花在思考上时，这一轮没有正文、什么都不存，界面上气泡直接消失。
   现在 `generate` 在 `text === '' && failed === null` 时发一条 `warning`（复用溢出学习那条帧），提示把
   「单次回复上限」调大或打开「关闭思考」；`test:api` 用一个"只回思考不回正文"的假 provider 钉住。

三处刻意的选择：

- **与发送/重生成/重试互斥**：`mode` 传了就不能再传 `message`、`regenerate`、`retryEntryId`，
  否则 400。一种请求只做一件事，服务端不用猜。
- **推理前缀不重发**：续写只把新思考追加到同一条的思考槽（旧的不丢），已知与酒馆的差异点。
- **轨迹照实记**：`trigger` 新增 `continue` / `impersonate` 两种，旧轨迹文件读到未知值仍回落 `normal`。

入口有三处，同一份后端：输入框旁"继续 / 替我说"按钮、消息菜单里的"继续生成"
（只有最后一条 AI 回复可点）、斜杠 `/continue` `/impersonate`。

### 7.18 渲染三件套：上下文模板、正则、Markdown

上下文模板、正则、Markdown 一次做完，因为它们互相咬合：模板决定发什么、正则两边改写、
Markdown 决定怎么看。

**上下文模板（story string）。** SillyTavern context 预设的格式：`{{description}}` /
`{{personality}}` / `{{scenario}}` / `{{persona}}` / `{{wiBefore}}` /
`{{wiAfter}}` / `{{char}}` / `{{user}}` / `{{system}}`，条件用 `{{#if 字段}}…{{/if}}`
（可嵌套），`loreBefore`/`loreAfter` 当别名认。空字段在条件里按假处理；未知字段
按空处理并告警；模板漏掉了有内容的字段也告警（校验思路与 SillyTavern 的 `validateStoryString`
相同，告警进 `warnings`，右侧预览看得见）。

- 一根配置 `contextTemplate`（设置 → 角色扮演），空 = 不用，走原来的栈。
  非空时渲染成 `story` 真实区块（scenario 之后，有独立 token 计数、能单独关）。
  启用后建议关掉对应的四个独立区块，不然同一段话发两遍——但关不关由面板决定，
  设置只决定有没有内容（又是语言/记忆那套分工）。
- 酒馆预设双向走：设置页"导入预设"读 JSON 里的 `story_string`，"导出预设"给回
  `{name, story_string}`，"恢复酒馆默认"填酒馆自带的默认模板。
  客户端那份默认与服务端逐字节对齐（`test:web` 钉着）。
- 已知差异：酒馆的 story string 只走 text-completion，我们把它做成了 chat 的
  一个区块；`wiBefore`/`wiAfter` 只含 before/after 两桶（AN/EM 桶不进模板）。

**正则替换。** 每条 `{名字, 表达式, 标志, 替换, 作用域, 开关}`，
替换走原生 `String.replace` 语义（`$1`/`$&`/`$$`）。作用域三选一：
只改显示 / 只改提示词 / 两边都改。

- 存盘永远是原文：显示侧只改看到的副本，提示词侧只改装配出的 messages，
  两边都不碰 transcript。编辑与复制用的也永远是原文。
- 编译不过的规则拒绝保存（400 + 理由），而不是存下来等装配时爆炸；
  编辑器里每条都能"试一条"，先看改写几处。
- 提示词侧跑在计数与裁剪之前，所以预算与裁剪看到的是改写后的文本；
  预览里告警写明哪条规则改写了几处。流式进行中的气泡是原文（delta 没法
  预判正则），落定后重渲染才改写——已知行为，写在这里免得被当 bug。
- 整份 `data/regex.json` 一次 PUT（快捷回复同款），另有 `POST /api/regex/test`
  专供试用。

**消息 Markdown（`web/js/markdown.js`）。** 没有依赖、不用 `innerHTML`：每个字符先变成文本节点，
只有列出的结构会变成元素，属性一律由代码给定（唯一的例外是过了 `https?://` 白名单的 `href`），
所以卡片里夹带的 `<img onerror>` 只会显示成文本。支持：围栏代码、行内代码、粗体/斜体/粗斜体、
删除线、引用、`#`…`######` 标题（钳到 h4–h6，因为页面自己占了 h1–h3）、有序/无序列表
（含**一层缩进嵌套**，`<ol>` 保留非 1 起始）、`---`/`***`/`___` 分割线、`[文字](https?://…)`、
**裸 URL**（句末标点留在正文，不进 `href`）、数学公式、换行。

- 两条刻意的偏离：**`---` 一律当分割线**，不按 CommonMark 的 setext 标题——聊天里人们就是拿它画线；
  **`![图片](…)` 不渲染成 `<img>`**，那会把读者的 IP 泄露给模型随便写的地址。
- 纯文本模式（设置 → 外观关掉）只留一个文本节点；编辑与复制永远用原文，重渲染复用已解析的节点。
- 补记：分割线、有序列表、嵌套列表、`***粗斜体***`、裸 URL 起初都缺（`---` 直接显示成字面量，
  是用户报上来的）。`test:boot` 现在直接从模块渲染这些结构逐个断言，不再只靠一条消息的粗体/代码。

### 7.19 人设库、外观页与字体

**多套人设。** `data/personas.json` 存 `{activeId, items[]}`，整份 PUT，
名字可重、id 不可重、默认必须指向存在的条目，否则 400。

- 生效顺序：会话 pin（`meta.personaId`）> 库默认（`activeId`）>
  老两栏（`config.personaName/Description`，以前唯一的人设，老会话全走这里）。
  删掉的人设不会弄坏会话：解析不到就往下一级掉。
- 新建会话快照当时的库默认（与模型快照同理），分叉带走原会话的 pin，
  导入同样快照。清掉 pin 就是"跟随默认"。
- 入口三处：设置 → 角色扮演的人设库（新增/编辑/删除/应用为默认）、
  对话头部的「人设：X」按钮（只改本会话的 pin，别处不动）、
  斜杠 `/persona [名字|默认]`。导出酒馆 jsonl 的 `user_name` 与记忆总结里的
  人名都跟有效人设走，而不是只读老两栏。

**外观独立页。** 设置共六页：通用设置 / **外观** / 模型 / 角色扮演 /
世界书 / 语音。主题卡片与配色圆点从通用设置搬到外观页（右下角小按钮不动，同一份
实现）；Markdown 开关也搬过去（它是阅读项）；字体的选择器同样在这一页。
新页能成立是因为它有真实字段（test 里断言每页至少一个字段）。

**字体。** 只改对话区的字，分两层：

- 内置六栈（都是开源协议的知名家族，本机有就用、没有就顺延系统字体）：
  系统默认 / 思源黑体 / 霞鹜文楷 / 思源宋体 / IBM Plex Sans SC / 等宽。
- 自投文件：把 `.woff2/.woff/.ttf/.otf` 丢进 `data/fonts/`
  （或在外观页上传，最大 20MB），列表自动出现并可选用、删除；
  字节走 `/api/fonts/:name/file`，`@font-face` 用 CSS 文本注入（不走
  `innerHTML`）。仓库不带任何字体二进制；要下字体就去 Google Fonts 或
  GitHub 搜上面的名字（都是 SIL OFL 协议）。
- 选择与字号存在这台浏览器（localStorage，和主题同理），不进
  `data/config.json`。文件名做过消毒（`..`、斜杠、非法后缀一律拒绝，
  组合根只把 `/api/*` 交给路由的规矩也顺手挡了一层）。
- 字号框曾经"改不动"：设置页每次按键都重刷 extra，旧代码每次把框洗回
  存盘值，敲的数字到不了 `change`。现在聚焦时不洗（`test:boot` 用真实
  按键路径钉着，撤掉修复会红两条）。

顺手修了一个截图里的真问题：角色名超长时说话人把操作按钮挤没了，
`assistant` 角标还被折成两行。现在说话人缩成省略号、按钮与角标都不让位。

### 7.20 翻译：外语消息自动译成预设语言

开场词是英文、预设是中文时，
英文消息自动显示成中文，原文一切可回。

- 判定是启发式的（`engine/translate.ts`）：目标含 CJK（或点名中日韩文）
  时，有拉丁词无 CJK 就译；目标是拉丁文时反过来。中英混排不动，
  空目标（没设回复语言）永远不动。客户端有一份同逻辑副本做本地判定，
  `test:web` 拿同一组输入对两份断言一致，漂移不了。
- 翻译用本会话的模型再问一次（`chatOnce`，温度 0.3、不要停止串、
  不记用量、不碰预算锚点——与记忆总结同一套"别污染正事"的规矩）。
  不需要配第二个服务，代价是每条外语消息多一次调用。
- 存的是派生：原文永远是 transcript，译文以
  `entry.translation = {lang, text, ofVariant, ofHead, ofLength}` 挂在旁边；
  编辑、切候选、换预设语言都会让缓存过期重译。导入导出不带译文
  （到那边重译一次即可）。
- 显示：译文默认展示，消息上多一个「原文/译文」小开关（只翻阅读视图，
  编辑与复制永远原文）；菜单里有「翻译」可手动重译。开关在设置 →
  通用「外语自动翻译」（默认开，但没设回复语言时不生效）。
- 节流：渲染时收集缺译文的消息，绘制完再串行补、只重载一次；
  流式中不触发（否则重载会踩掉 pending 气泡）；失败静默留原文，
  菜单可重试。轨迹不记这种行（它是阅读辅助，不是请求）。

**Markdown。** `**粗体**` / `*斜体*` / `` `代码` `` / ```围栏``` / `>` 引用 /
`#` 标题 / 列表 / `[文](http(s)://…)` 链接 / `\(…\)` 行内公式 /
`\[…\]` 与 `$$…$$` 独立公式块，默认开（酒馆默认也渲染），
设置 → 外观可关（关了公式也回原文）。

- 公式是 LaTeX 子集、无依赖手写（`web/js/math.js`）：上下标、`frac/binom/sqrt`、
  `sum/prod/int/lim` 等（展示模式下限标上下）、`left/right`、`boxed`、`text` 系、
  上下划线与单字符重音、aligned/cases/矩阵环境、常用希腊字母与符号。
  解析是全函数（未知命令、散括号、未闭合都退化成原文，不抛），构建只走
  `createElement`（文本只进 textContent）。`\$` 可转义，围栏里的 `$` 不动。
- 朗读时公式变词：`texWords` 把命令变名字、括号变停顿
  （`\frac{a}{b}` 念 "frac a b"），总比念反斜杠强。

- 消毒是结构性的，不是字符串黑名单：消息的每个字符先变成文本节点，
  只有上面这几个结构会变成元素（`createElement`，不走 `innerHTML`——
  全客户端唯一的 `innerHTML` 出口仍是 `dom.js` 那一个，`test:web` 钉着）。
  卡片里塞 `<img onerror>` 或 `[x](javascript:…)` 只会原样显示成标点。
  链接只认 http/https 且带 `rel=noopener`。
- 消息体里不许有裸文本节点（纯文本包进 `span`），沿用"继续"那轮定下的规矩，
  `test:boot` 照旧断言。

### 7.21 图片：发给模型看

多模态输入目前只做了 base64 内联一种。照官方 Vision 指南（`deepseek-flash` 收图，
JPEG/PNG/GIF/WebP，base64 内联 / 外链 / Files API 三种给法）只做了第一种，
因为后两种在本项目的约束下不划算：外链要求公网可访问（本地图床没有），
Files API 要先调上传接口（多一次往返，不常用）。

- 上传即存：`POST /api/images?name=` 收原字节，按**内容**嗅探格式
  （文档原话：看文件内容，不看名字与 MIME），非四种或超 32MB（官方单图上限）
  直接 400。文件以 `data/images/<生成id>.<ext>` 存原字节，消息里只记引用
  `{id, name, mime, bytes}`——transcript 不膨胀，删图就是删一个文件。
- 发送：`POST /api/generate {message, imageIds[]}`（未知 id 400，最多 10 张），
  引用落在新 user 消息的 `images` 上；装配时**最新一条** user 消息拼成
  `[{text}, {image_url:{url: data:…}}]` 发出，历史一律纯文本（图按尺寸烧
  token，官方称最多 1024/张，旧图重发纯属浪费）。
- 组装之外全是文本：扫描、宏、校准、token 计数都不碰图；预览与 `prompt` 帧
  报 `images[]`（名字与字节，从无 base64）+ `imageTokens`（1024×张数，
  与文本计数分开列）；轨迹里图块记成名字，不让几 MB 的 data URL 进仪器文件。
- 前端：输入框回形针（沿用 `file-button` 惯例）→ 待发缩略图条（可逐张拿掉，
  输入框里 `Ctrl+V` 截图走同一条路，纯文本粘贴不受影响）→
  气泡里缩略图（点开放大，共享 modal 外壳）→ 文件没了显示名字不断页。
  流式气泡仍是纯文本（图在发送前、回复是后到的）。
- 已知不做：外链 URL 与 Files API `file_id`（等有人真需要再接）；
  删消息不连带删图文件（`data/images/` 手动清，未来可做 maid 任务）；
  非 user 消息带图官方直接 400，所以装配永远只给 user 消息拼图。
- 实测行为（deepseek-flash，2026-09-14）：图确实发出去了
  （无 400，`promptTokens` 含图片份量，轨迹可查），但模型在 RP 上下文里
  有时会回一句系统口吻的 ``【系统提示：检测到外部图像输入】`` 而不是描述图片——
  这是模型侧的输出（`failed: null`、`completionTokens: 12`，原样落盘），
  不是本项目拼的（代码库里无此字符串）。对照试验证明是内容拒答
  （V 面具图拒、中性头像正常接），不是管线问题。想看它正经看图就换弱设定的卡或明示。
- 回复里的宏会显示展开：模型常把提示词里的 `{{user}}` 学进回复，
  阅读视图按纯子集展开（身份与时间类；`setvar`/`random` 等不动），
  存盘、编辑、复制永远原文。酒馆只在第 0 条做这件事，我们对所有消息做、
  但不写回。

### 7.22 纯文本补全：同一套装配，另一条后路

给只会续写纯文本的后端（KoboldAI、llama.cpp 一类，OpenAI 式 `/v1/completions`）。
开关在设置 → 模型「纯文本补全后端」（默认关，走 chat）。

- 装配完全不动：世界书扫描、模板、正则、宏、裁剪照旧产出 `messages[]`；
  只在最后把它们拍平成一段文本（system 原样、`User:`/`Char:` 前缀、
  末尾空着的 `Char:` 等模型接），停止串 = 配置的 stop + `\nUser:`/`\nChar:`
  （名字含换行就不加，宁缺勿错）。
- 流式照旧：`/completions` 的 SSE 帧是 `choices[0].text`（没有 thinking 通道），
  事件形状与 chat 流一致，所以气泡、swipe、重 roll、轨迹全都不用改；
  轨迹与预览存的都是拍平后的 prompt（"实际发出的是什么"优先）。
- 计数：`totalTokens` 切到整段 prompt 的计数，校准与 usage 锚点同口径；
  无图时与原来逐字节一致，有图时图块记成 `[图片]` 再数（`imageTokens` 另列）。
- 教训：第一版抄帧解析时漏了 `extractDelta` 的空数组守卫，
  usage 帧（`choices: []`）直接把整轮炸成 error——而 api 用例只断言了
  saved 不断言无 error，所以漏网。现在两边都有守卫，api 另有一条
  "全程无 error 帧"钉着。

### 7.23 群聊：模式决定谁说话

成员即模式：`meta.members` 空或独苗就是单人（老文件一个字不用改），
两人以上才是群聊。每条 AI 回复记 `speaker`（成员 id），删成员不炸旧会话
（解析不到就按单人名字显示）。

**一轮 = 一份名单**：每次发言服务端先算出这一轮该谁、按什么顺序说（`prompt` 帧的
`groupPlan`），只由第一名现在回答，其余由客户端逐个钉住连播。名单由 `meta.groupMode` 决定：

| 标签 | id | 名单怎么来 |
| --- | --- | --- |
| **A · 依次回复**（默认） | `round` | 导演 `chatOnce` 点一名（失败按轮次顺延），再按阵容顺序补到上限 |
| **B · 自然** | `natural` | `@名字` 优先 → 其余按**话痨度**掷骰 → 都没中挑一个话痨的 |
| **C · 列表** | `list` | 阵容顺序全员 |
| **D · 池化** | `pooled` | 优先"自你上次发言后还没说过话"的人，避开刚说过的 |
| **E · 手动** | `manual` | 只让被 `@` 到的人说；没点到人 → 这一轮**不请求模型**（发条提示就收工） |

- 共同规则：**每轮最多回复**（`meta.groupReplyLimit`，1 默认 / 2 / 3 / 0 = 不限）是**所有模式**的硬上限；
  默认**同一人不能连说两句**，但你自己发言之后上一位重新可以被点到（与酒馆一致，`allowSelfResponses` 预留）；
  重试/重生成沿用原 `speaker`，`@名字`、`continue`、`impersonate` 一律绕过名单。
- **话痨度**（角色 `meta.json` 的 `talkativeness`，0–100）不是卡片字段——SillyTavern 也没有：
  它是对方自己的滑杆（默认 0.5，v2 卡的 `extensions.talkativeness` 可选读）。这里取值顺序是
  **我们存的值 → 卡的 `extensions.talkativeness`（0–1 折算成百分比）→ 50**；
  在群聊选人弹窗里拖，存在**角色自己**身上（所有群聊共用，重导入卡也不丢）。
- 策略是纯函数 `engine/group.ts activateGroupSpeakers()`（`random` 可注入，单测不用碰网络），
  `round` 的那次导演调用在装配前发生（此时发言人还没定，所以走会话自己的端点）；其余四种零额外调用。
- 旧会话没有 `groupMode`，按 `round` 走，行为与之前一致。

- 历史自带人名：`ChatMessage.name`（之前就有字段，一直空着），
  组装、扫描、拍平、轨迹、记忆总结、酒馆导出全都读它；
  单人时就是原来那两个名字，逐字节一致。
- 成员书全带：每个成员的内嵌书都进扫描（去重），分组打分那套现成的直接复用。
- **入口：建群就是建会话，不是一个开关**。品牌菜单 →「**新建群聊…**」打开选人弹窗
  （可填群聊名，留空按成员名自动起；第一个勾选的是发起人 = 会话的 `characterId`，勾选顺序即默认发言顺序），
  确认后 `POST /api/chats { characterId, members, name }` 一次建好（服务端本来就接受 `members`）。
  原来的「群聊模式：开/关」开关删掉了：它把"群"当成当前会话的一个状态去切换，语义绕，
  而且要先有会话才能开——现在群是**会话本身的属性**。
  改阵容仍走会话行 `⋯` →「群聊成员…」（勾选即成群，全取消即回单人），`characterId` 不动。
- **群聊标识**：会话列表行上带 `群聊 N` 徽标（`.pill.group-badge`，鼠标悬停显示成员名），
  打开后对话头部显示完整 lineup，统计行里再带当前模式（`A · 依次回复`，`.pill.group-mode-badge`）。
- **模式入口在右栏**：命中面板顶部一行 `群聊模式`，只在 `members.length >= 2` 时出现；
  `round` 就是默认，所以没有"跟随默认"那一项——选 A 等于清掉钉子。切模式立即 `PUT /api/chats/:id { groupMode }`。
- **每个成员可以走自己的接口和模型**：
  - `data/connections.json` 存若干命名端点 `{id, label, baseUrl, apiKey, model}`，`GET/PUT /api/connections`
    读写；**Key 例外处理与主 Key 一致**——读出来是 `***`，存回 `***` 表示"保持不变"（服务端把 `***` 映射回已存的值），
    所以掩码永远不会覆盖真 Key。
  - `meta.memberConnections: { characterId: connectionId }`：哪个人走哪个端点。`POST /api/chats` 与
    `POST /api/chats/:id/members` 都收这个字段；指向不存在的连接 → 400（拼错就会静默走默认端点，必须拦），
    指向已不在阵容里的角色 → 保留（重新勾回来时不用重设）。
  - **解析**（`engine/connections.ts` `resolveConnection`）：发言人自己的连接 → 否则会话端点 + 会话模型
    （`meta.model` 覆盖 → 全局默认）。连接被删了就当没设过，不会让会话炸掉。导演调用（选谁发言）在发言人确定
    **之前**发生，所以它总是走会话自己的端点。
  - 装配时把解析出的模型作为 `AssembleOptions.model` 传给 `assemble()`，只影响显示与轨迹（`prompt` 帧、
    trace 的 `model`）；真正的请求由同一个解析结果构造 `llmConfig`。
  - UI：设置 → 模型 →「额外连接」列表（自带保存按钮，不跟设置弹窗的 config 一起提交）；选人弹窗里每个成员
    一个「跟随会话 / 某连接」下拉；对话头部把阵容写成 `Enola（GLM）· Haena`。
  - `test:api` 用假 provider 端到端证明：钉住该成员的那一轮真的带着 `ally-model` 与 `Bearer member-key` 发出，
    而主持人那轮仍是会话端点；掩码存回后 Key 仍在。
- **连播协议**：`prompt` 帧带 `groupPlan: string[]`（有序、已按上限截断、已排除刚说过的人）。
  第一条由本轮回答，客户端拿到名单后依次以 `speaker=<id>` 发起普通回合——每条都是**普通回合**：
  各自落盘、各自记 `speaker`、各自进轨迹、各自按自己的连接与模型发；`@点名`、重试、重生成、
  `continue`、`impersonate` 一律不连播（那些是"我只要这一条"的指令）。
  中途不发"该总结了"信号：`memory-due` 只在**本轮最后一条**之后 emit。
  （更早的版本是客户端按配额自己再问一次服务端"下一个是谁"，名单改成一次算完之后，
  同一轮不会因为中途重问而漂。）
- 好处是没有新的流形态、失败也只丢那一条；代价是 N 条就是 N 次调用（界面上说明了）。
- 选人弹窗里选上限，`POST /api/chats` 与 `/members` 都收 `groupReplyLimit`（非负整数，1 = 默认不落盘，
  负数/小数 400）；`groupMode` 同样在 `POST /api/chats`、`/members`、`PUT /api/chats/:id`（`null` 清除）上，
  非法模式名 400（拼错会静默改变谁说话，宁可拦下来）；分叉会话两者都带走。
- 轨迹记 `speaker`，只读旧文件时缺席即无——又是"只增字段"式兼容。

### 7.24 立绘：文件名就是关键词
`data/sprites/<角色id>/` 有文件就算有立绘，没有就不占地方
（整个区块 `hidden`，右栏不留空位）。`开心.png` 看到"开心"就上场，
最长命中优先；谁都不中就找 `默认`/`default`/`neutral`，再没有就第一张。

- 零配置是刻意的：立绘是用户自己的素材，配个映射表只是多一份要同步的东西。
  面板只管展示（当前哪张、手动下拉），匹配只读最近三条非系统消息。
- 手动选择钉住到换会话为止；文件删了显示名字不断页。
- 进件三种：面板「管理」→「上传立绘」（选文件、填关键词，同名替换，
  × 删除走二次确认），直接往目录丢文件，以及 **PNG 卡导入时自动种一张**：
  载体图就是现成的立绘，导入成功顺手拷一份 `默认.png`，已有常驻脸（上传的、
  手丢的、以前种的）一律不覆盖。JSON 卡没图可种，什么都不发生。
- 上传是裸字节 POST（和聊天图片一个形状），`?emotion=` 定关键词，
  服务端嗅探格式、只收图片；`DELETE` 只删列表里的文件，删两次第二次 404。
- 当前那张同时铺进聊天区当底图：中间栏自带的 `#chat-backdrop` 层，
  `blur(26px)` + 一层面纱渐变保证两套主题下字都清楚，不跟消息滚、不吃点击，
  字和气泡都在它上面一层。手动钉住哪张，底图就跟哪张。开关在面板里
  （「聊天底图」，默认开，存浏览器 localStorage，和主题字体一个待遇）。
- 底图可调两样，都在开关下面：「虚化」滑杆（0–40px，直接改底图层的 filter）；
  「上下」滑杆（±30，取景微调）。取景本身是智能的：图载入后在 48px 宽的
  画布上算一次显著性（饱和度 + 明暗对比 + 肤色，无中心偏好——人像的脸常在
  下半截），重心落哪底图就对准哪；算好之前先居中，算好只动位置不动选项，
  所以正在看图不会闪。每张图只算一次，同源字节画布不污染。
  算法是纯函数（`web/js/sprite-focus.js`，零导入），单测直接喂像素断言。
  和提示词、预算、轨迹一概无关——立绘是家具，不是上下文。

顶栏品牌字是个 Windows 式菜单按钮（`teahouse ▾`，悬停才显形）：
新会话 / 新建群聊 / 设置，全是本来就有的入口换个门进，
不新增任何逻辑。

### 7.25 语音：读出来，两种引擎

设置独立成页（第六页，永远放最后——前面的 tab 序号是写死的，
新页放最后才不用重排旧用例）。两套引擎：

- 本地（默认）：浏览器的 `speechSynthesis`，离线免费，零配置。
  音色下拉读系统现有的（中文优先兜底），选了填进配置；语速 0.5–2。
- 在线：OpenAI 兼容 `/audio/speech`，Key 只存本机，
  浏览器永远只见音频字节——服务端代理就是为了这个
  （顺带躲掉各家 CORS）。单次 4000 字、10MB、60 秒上限，
  超了直接 400 而不是静默截断。

客户端一次只读一条：在读再点就停，发新消息也停。读的是剥掉
Markdown 符号的版本（否则它会念星号），编辑与原文不受影响。
入口只有消息菜单里的「朗读/停止朗读」，不占操作条——那一排已经够挤了。

- **音色下拉为什么「点了没反应」**：`voiceschanged` 会在 Chrome 里反复触发（Microsoft 那上百个在线音色
  是分批到的），每次重建选项都会**把用户正打开的下拉里的选项换掉**——点下去时那个选项已经不存在了，
  于是选择丢失、控件弹回「浏览器默认」。现在规则是：列表没变只重新同步选中值；列表变了且**控件处于聚焦
  （下拉开着）就推迟重建**，`blur` 后再建。系统音色按 `voiceURI` 存，浏览器不给 URI 时退化成存名字；
  那一行下面还会写清「当前落在哪个音色」或「已存的值这个浏览器里没有」，省得再靠猜。
  `test:boot` 现在专门造了一次「下拉开着时来了新音色」的竞态。

顺手堵了个 Key 泄漏：`GET /api/config` 从前只掩顶层 key，
`tts.apiKey` 会全文回来。现在两边都掩，PUT 两边都认 `***`。

### 7.26 会话采样参数：右栏调本会话，设置管新会话的默认

采样参数沿用模型的规矩（新建快照、顶栏覆盖、删掉跟随）：
温度、Top P、频率惩罚、存在惩罚。配置里新增后两项（都默认 0），
以前 `llmConfig` 组装好了却没递出去的两个 penalty，这次真发给服务商。

- 新建会话快照当时四项 + 上限（`meta.params`），导入、分叉同样带走；
  分叉漏带参数是这轮测试抓出来的（跟 model 一行，顺手补齐）。
- 右栏「请求参数」一次一行：滑杆拖动只改数字框（不存），松手（change）
  才 PUT；数字框非法（非数字/越界）报范围、不存；「恢复默认」删快照，
  面板写「跟随设置默认值」。PUT 回包验 echo，防没重启的老后端静默 200。
- 生效走 `effectiveParams(config, meta)`（`pipeline.ts`，紧挨着
  `effectiveModel`），generate 的两条后路（chat/completions）共用。

### 7.27 卡死排查：测出来的都不慢，hang 住的全加上限

一次"按几个按钮就卡死"的报修，把能卡主线程的东西全量了一遍：
60 条长消息整页重渲染 32ms（JS 部分），真实 65k 上下文的装配预览
14–126ms，定时器/文档监听/事件图无环，菜单与 toast 自清理——都不够卡死。
修的是 hang 住类硬伤（现象都是"点了没反应"，和真卡死摸起来一样）：

- 服务商单次调用（翻译/导演/记忆总结、模型列表）默认 120 秒超时，
  以前 stall 就永远等。流式另有 90 秒无帧看门狗（任何帧都续命，
  话痨模型不受影响），超时 abort 并明说。
- 翻译失败本会话内记住（精确到条目+语言+原文），渲染不再对死端点
  无限重试；菜单手动重译清掉记忆，改字换文自然是新的 key。
  （之前失败了每次渲染都重打，打完 reload，reload 又重打。）
- 一次性弹窗（确认/输入/图片/记忆/群聊/正则/命令帮助/人设编辑）
  关掉就离文档；复用的编辑器（设置、世界书、卡片、快捷回复）保留 DOM，
  `test:boot` 两边都钉着。

### 7.28 流式与重渲染的热点：按「观感不变」的方式提速

一轮性能排查里量到三处热点，全部按「先保证逐字冒出的观感与存储不变」来改，
而不是把流式改成批量刷新：

- **逐字追加，不重建整串**（`web/js/views/chat.js`）。原来每个 delta 都写
  `textContent = prefix + text`，并在 `scrollHeight` 上强制同步布局一次——回复越长，
  这两件事都是平方级。现在正文与思考各持有**一个文本节点**，用 `appendData` 追加；
  滚动改成每帧最多一次（`followBottom`），且只在读者贴着底部时跟随，往上翻不会被拽回去。
  后台标签的 `requestAnimationFrame` 会暂停，所以滚动用 `nextFrame` 回退到 `setTimeout`。
- **重渲染尊重读者的位置**（`web/js/views/chat.js`）。`render()` 重建前先记下
  `scrollTop` 与「是否贴底」：同一会话刷新保留位置（贴底则继续跟随），只有切换会话才跳到底部。
  顺带把 `speakerName` 的每消息线性查找换成渲染前建一次的 `Map`。
- **解析结果复用，DOM 照重建**（`web/js/components/message.js`）。Markdown/math 解析出的节点
  是纯结构、没有闭包，所以按「entry id + 显示文本 + Markdown 开关」缓存，重渲染直接搬进新气泡，
  文本一变就替换（带上限，避免换会话后无限堆积）。**没有做按 key 复用整条消息 DOM**：
  那些节点的事件闭包捕获的是本次渲染的 entry 对象，而 `loadChat` 每次都造新对象，
  复用会让按钮拿着旧的 `variants`/`content`——要做对得先把所有动作改成按 id 现查，风险与收益不成比例。
- **显示正则只编译一次**（`web/js/regex.js`）。原来的 `match` 与 `replace` 各自 `new RegExp`
  一次，而且是「每条消息 × 每条规则 × 每次渲染」。现在按 `pattern+flags` 缓存，使用前把
  `lastIndex` 归零，等价于原来的「每次新建」（含 `$1` 与 sticky），输出仍与后端逐字节一致。
- **整段显示结果也缓存**（`web/js/views/chat.js` 的 `shownText`）。宏展开后的文本 + 规则对象
  （它每次保存都会换新对象，所以对象身份就是版本号）作为键，重渲染不再把每条规则重跑一遍；
  宏展开本身留在缓存外，人设一改键就变。切会话时连同消息体缓存一起清掉。
- **SSE 按游标切帧**（`consumeStream`）。原来每帧都 `buffer = buffer.slice(index + 2)`，
  provider 一次性把整段吐出来时是平方级；现在游标只前进、每次 read 只裁一次尾巴。
- **面板不再双重建**。一次 `loadChat` 会先 `chat`、后 `preview`（预览是 `await` 出来的），
  而世界书列表与提示词栈都订阅了两边，等于每次开会话整列表建两遍。现在世界书列表只跟
  `preview`、提示词栈的预览相关部分只跟 `preview`（`chat` 只更新采样参数），
  顶栏模型选择器与立绘也不再订阅 `preview`——它们的数据源根本不在预览里。
- **立绘预览去重**（`web/js/views/sprite.js`）。`preview` 触发得远比立绘变得勤；
  拉回后先比对载荷，没变就不重建面板。
- **重复 CSS 清掉**。`style.css` 里 `.message`/`.message.user/assistant/system`/`.message.pending`
  各定义了**两遍**，`.message .tools` 是旧标记的死规则；只留下流式气泡仍在用的 `.message .role`。
- **失败条目不再进 `needFetch`**（`web/js/views/chat.js`）。本会话已记住失败的翻译直接在
  `render()` 里跳过，不再交给 `translateMissing` 过滤，也少一次无谓调用。

翻译也从「每条一次请求」改成**批量端点** `POST /api/chats/:id/translate`
（`src/routes/chats.ts`）：客户端把「这一屏需要译的 id」一次交出去，服务端用**并发 3**
跑模型调用（`mapWithConcurrency`），最后**重新读一次 chat、合并写回一次**——避免并发下的
丢更新，也避免每条各写一遍文件。单条端点保留给菜单的手动重译。失败是逐条结果，
客户端照旧记进「本会话失败记忆」，不会因为死端点被反复重打。

### 7.29 三栏可拖宽度：两条 gutter 轨道，右栏按模式各记一份

拖动分隔条改变左右栏宽度，中央栏是 `1fr`，自动吃掉差额——所以拖任一条就能调三栏，
不用再抓中间。

- **结构**：`.layout` 从 3 列变 5 列，每条分隔条是**自己的 gutter 轨道**
  （`--gutter-left/right`），而不是压在面板上做绝对定位。这样分隔条是真正的网格项，
  全高、不随面板滚动，也不会被 `.panel-center` 的 `overflow: hidden` 裁掉。
  折叠时对应面板的轨道**和 gutter 一起归零**，`display: none` 只负责隐藏节点。
  `.resizer { cursor: col-resize }`，悬停/键盘聚焦/拖动时才显示 `--accent` 细线。
- **拖动**：Pointer 事件 + `setPointerCapture`（替身没有就退回普通监听，`?.` 守卫）。
  拖左条向右变宽，拖右条镜像；`pointermove` 只调 `paint()`（写两个 CSS 变量，不发事件），
  `pointerup` 才 `saveState + apply()`——避免每一像素都触发 `on('layout')`（轨迹面板订阅了它）。
- **约束**：左 ≥200、右 ≥280、中央 ≥360px，上限按窗口与另一侧实时算；窗口 resize 重新夹紧，
  中央永远不会被挤没。键盘：分隔条可聚焦，`←/→` 步进 16px（Shift ×3）。
- **右栏宽度按模式各记一份**（`promptWidth` / `traceWidth`）：拖哪一栏存哪一份，切模式用对应那份；
  没存过就交给 CSS 默认（提示词 360px，轨迹 `min(620px, 46vw)`）——**内联变量优先于类规则**，
  所以手动宽度会盖掉轨迹模式的自动加宽。
- 持久化复用 `teahouse.layout.v1`，与折叠状态同一条记录。
- 顺带清掉了 `style.css` 里 `.message` 系列的重复定义（见 §7.28）。

### 7.30 技能导入：Agent Skill 映射成一张普通角色卡

网上大量「人物 skill」是 Agent Skills 格式：一个目录里的 `SKILL.md`（可选 YAML frontmatter 的
`name`/`description` + 任意附加字段，下面是正文），常打包成 zip。这里把它**当成角色卡的第五种来源**，
而不是新建一种对象：

- **识别只在导入那一刻**：`src/routes/characters.ts` 的探测加一档——PNG 签名 → png；`{`/`[` → json；
  其余（zip 或文本）→ skill。空文件与非文本（含 NUL）直接 400，不静默收垃圾。
- **映射**（`src/formats/skill.ts`）：正文 → `description`（角色扮演里人设本来就该常驻）；
  frontmatter `description`（「何时用」）→ `creator_notes`；`author`/`version` → `creator`/`character_version`；
  `references/*.md` → **卡内嵌世界书**（`data.character_book`，走现成的 `parseWorldInfo`）。
- **原文不丢**：原始 zip/`SKILL.md` 原样写在角色目录旁（`skill.zip` / `skill.md`），卡只是它的一个镜头；
  未知 frontmatter 留在 `extensions.tavern.skill`。**不做整包解压**——多层目录、references、scripts
  全留在原包里，也就没有 zip-slip 与目录深浅的问题。
- **零依赖**：`src/formats/zip.ts` 手写最小 zip 读取（中央目录 + 本地头，STORE/DEFLATE 用内置 `zlib`；
  zip64/加密/其它压缩明确报错，条目与总量有上限），和手写 PNG tEXt、BPE 一个路子。
- **为什么不新建 skill 对象**：角色卡本来就是目录，能放下卡、原包、立绘；会话、编辑器、导出、
  内嵌书全部现成。等真出现「一个 zip 多个人物、能挂到任意会话」的需求，再谈 `skills/<id>/`。
- **没有开场白不算错**：技能卡没有 `first_mes`，所以建会话时「取第 0 条问候」在没问候时直接开一个
  空记录，而不是报越界（`src/routes/chats.ts`）；只有卡片**确有**问候而索引越过末尾才算调用方出错。

### 7.31 模型自选条目：没有工具循环，也能「按需读」

Agent Skills 的消费方式是渐进式披露：提示词里只有 name/description，正文和 references 由模型
按需 `read`。teahouse 没有工具循环，所以这一步改成一次**有界的便宜调用**：把「可点名的条目」做成
小目录，让模型回一个 JSON 数组，命中的走**已有的外部激活路径**注入——和向量检索是同一个入口，
位置/深度/预算/递归一律照旧。

- **候选** = 本会话扫描的那批条目（挂载世界书 + 卡内嵌书，含 §7.30 生成的 skill references），
  只列**启用且非常驻**的；`buildCatalog` 截断到 200 条 / 12k 字符并在 warning 里说明。
- **一次调用**（`src/engine/select.ts` `selectExternal`）：低温柔的非流式 `chatOnce`，`maxTokens: 128`，
  只回 `[1,2]`；解析**故意宽松**（围栏、前后杂字、字符串数字、越界与重复都处理），任何失败只丢这条通道。
- **配置**：由**检索模式**（§7.32）决定，模式为 `select` 时才走这里；`scan.modelSelectMax`（1–10）仍是条数上限。
  非 `select` 模式时**一次调用都不发**；候选为空也不发。**不在 `/api/prompt/preview` 里跑**——预览不该多花一次模型调用，
  真实那一轮才有（`collectRetrieval({ allowModel: false })` 直接把 `select` 退化成空）。
- **可解释**：`ExternalActivation.source` 区分 `'vector'` / `'model'` / `'full'`，命中面板据此写
  「向量激活 0.xx」「模型点名」「全文注入」，轨迹与预览看到的仍是同一批命中。
- **安全**：没有任何执行——模型只回编号，App 自己读已挂载的文件。不可信的角色卡最多影响角色扮演文本，
  与既有风险同级。真正的「按需读文件」在 §7.33：同样是**只读 + 白名单**，但用原生 tool calling 读技能包文件。

### 7.32 检索模式：一条通道选择器，管住「怎么额外注入」

关键词扫描是免费的、永远先跑；它之外还长出了三条**额外通道**：向量检索（§7.14）、模型自选（§7.31），
以及技能导入带来的诉求——references 就在卡里，干脆整本灌进去（全文注入）。与其让三组布尔开关互相打架，
不如收合成**一个枚举** `retrieval.mode`：

| 模式 | 行为 | 代价 |
|---|---|---|
| `keyword` | 只跑关键词扫描（默认） | 0 |
| `all` | 卡内嵌书整本进 | 0（吃 token） |
| `vector` | 语义 top-N | 1 次 embedding |
| `select` | 模型点名 | 1 次便宜调用 |

- **不取代关键词扫描，只叠加**：模式产出的命中走**同一条外部激活管线**（`ExternalActivation` → 扫描的
  `source: 'full' | 'vector' | 'model'`），位置/深度/预算/递归/去重照旧。三者互斥，是因为它们回答的是
  同一个问题（「额外注入什么」），叠着开只会让预算和解释都失控。
- **会话级钉住**：`ChatMeta.retrievalMode` 覆盖全局默认（和模型、人设同一套「跟随 / 钉住」规则，
  `null` 表示跟随）。存进 `chats/<id>.meta.json`，PUT `/api/chats/:id` 接受它；右栏命中面板上方的下拉就是它的 UI。
- **全文注入的冲突规则**：内嵌书某条与**挂载世界书**某条正文归一化后相同时算冲突，默认丢内嵌那条、让世界书走扫描；
  `retrieval.fullForceOnConflict` 打开才两份都留。只有**启用且非空**的世界书条目才算「活的」冲突源——
  一条被禁用的重复项从不激活，没资格压掉内嵌的那份（这是 `fullInjectionHits` 里唯一不显然的一行）。
  `retrieval.fullIncludeWorlds` 打开后，全文注入会把挂载世界书也一起灌（更贵，默认关）。
- **旧配置的迁移**：`scan.modelSelect` / `vector.enabled` 在**首次读取**且配置里还没有 `retrieval` 段时被映射成
  对应模式（`mergeRetrieval`），之后由模式接管；两个老开关**从设置 UI 里删掉**（不是禁用），字段仍在配置里可读。
  只要任一开关还开着而模式不匹配，世界书页就渲染一条橙色提示（`retrievalMigrationNotice()`，纯函数、`test:web` 单测），
  写明「行为以模式为准」以及「要恢复就把模式改成哪一项」——避免用户看到索引建好了却什么都没发生。
- **向量检索只由模式开关控制**：`retrieveExternal` 不再读 `vector.enabled`（它只留下来做展示与迁移输入），
  所以档位切到「向量检索」才真的发查询；开关撤掉后状态面板也按模式说话（「注入模式是 X：索引可以照建，但本轮不会做向量检索」）。
- **实现分层**：`src/engine/retrieval.ts` 一个 `collectRetrieval(input)` 入口，`generate.ts` 与 `prompt.ts`
  各调一次，区别只在 `allowModel`（预览为 `false`）。纯函数 `fullInjectionHits` / `effectiveRetrievalMode`
  在 `test:prompt` 里直接单测，不靠 HTTP 侧面验证。

### 7.33 agent 模式：给模型一个 `read_file`，它自己决定读什么

§7.31 的「模型点名」是一次有界的目录挑选，读到的还是**世界书条目**；Agent Skills 真正的消费方式是
渐进式披露的**文件读取**（正文与 `references/` 由模型按需 `read`）。这一节补上那块：模型拿到一张
可读文件清单和一个 `read_file` 工具，自己决定读哪些，读到的东西作为独立区块进提示词。

- **协议用原生 tool calling**：一次非流式 `chatWithTools` 带上 `tools: [read_file]`，
  读 `choices[0].message.tool_calls` 回答，再带上 `role: 'tool'` 结果继续，直到模型不再要文件或用满上限。
  代价是端点必须支持 `tools`——不支持时这一次调用 400，进 catch，变成一条 warning，**回合照常发生**。
  纯文本补全模式没有 chat 消息，agent 通道自然为空。
- **可读清单 = 技能包文件 + 卡内嵌书条目**。技能文件名直接取自导入时写下的
  `extensions.tavern.skill.files`（zip 里的 entry 名）；内嵌书条目 id 是 `book/<bookId>/<uid>`。
  **挂载的世界书不在内**——那是关键词/向量/点名的地盘。
- **只读白名单**：`read_file` 的 `path` 必须精确命中清单里的一项，读取走 `AgentSource`（技能包从
  `characters/<id>/skill.zip` 里按 entry 名取；条目从已解析的卡里取）。模型编的路径、`..`、绝对路径
  只会得到一句「no such file」。**不执行任何东西，也永远不会碰技能包以外的文件**——这正是风险表里
  「接 agent 必须重新评估」的答案：这里接的是**只读、白名单、有界**的读取，不是代码执行。
- **上限**：`retrieval.agentMaxRounds`（默认 3，1–8）、`agentMaxFiles`（默认 6，1–20），另有单文件
  24k 字符 / 单轮 96k 字符的固定上限；超过会在 warning 里说清楚。读过的 id 不重复读。
- **透明**：读到的文件渲染成 `agentSkillFiles` 区块（`[skill file: <id>]` + 正文，绝对注入、system），
  和记忆区块同款：有 token 计数、右栏可见、方向键能开关。生成流的 `prompt` 帧还带 `agentReads`
  （这一轮读了哪些 id）。**预览不调用模型**（`allowModel: false`），所以预览里这块是空的、0 token。
- **纯函数可测**：`buildAgentCatalog` / `parseReadPaths` / `agentSystemPrompt` / `readSkillFile` /
  `agentSource` 全是纯的，`collectAgentDocs` 通过 `fetchImpl` 注入假 provider，于是整个循环
  （宽松解析、白名单、上限、失败保留）在 `test:prompt` 里不碰网络就能钉住；`test:api` 的假 provider
  学会回 `tool_calls`，端到端证明「技能包文件与内嵌书条目都读得到、读过的东西真的进了 prompt」。

### 7.34 多服务商接入：协议收敛之后，只有数据和怪癖

目标是不引入任何依赖地支持 GLM、OpenAI 等更多服务商。调研（2026）的结论是这条路已经不需要适配器：

- **协议收敛了**。DeepSeek / 智谱 GLM / Z.AI / Moonshot / 通义（compatible-mode）/ 硅基流动 / Groq /
  Mistral / xAI / Together / OpenRouter / 本地运行时全是 OpenAI Chat Completions；**Google 有官方
  `/v1beta/openai/`**，**Anthropic 也有官方 OpenAI 兼容层**（代价：无 prompt caching、无 extended
  thinking——要用全功能得另写原生适配器，暂时不做）。所以「支持一家新服务商」的代价从「一段代码」变成
  「一条数据」。
- **没引 SDK**。实测运行时依赖闭包：Vercel AI SDK（4 家 provider）14 个包、LangChain.js 30、LlamaIndex.TS 41、
  Mastra 149（还同时塞了三个 `@ai-sdk/provider` 大版本）、Genkit 402、token.js 232，官方 `openai` 只有 1 个。
  它们都能用，但都会用它们自己的 stream/tool/usage 抽象**换掉**本项目的透明装配层，还要求 `npm install`
  ——破坏「拷目录、`node src/server.ts` 就能跑」。开源实现的 provider 描述表做法值得借鉴（一张 provider 描述表 +
  共享的实现 + 生成的模型目录），它的 8 个直接依赖不值得引入。
- **落在数据层**：`src/llm/providers.ts` 一张预设表（`id / label / baseUrl / note / models[]`，模型带
  `contextWindow` 与 `maxTokens`）共 **29 条**（含 OpenCode Zen / OpenCode Go、Cerebras、Fireworks、
  NVIDIA NIM、Hugging Face Router、Baseten、Vercel AI Gateway、Xiaomi MiMo、Ant Ling、国内编码端点），
  配 `matchProvider` / `matchModel` / `providersPayload` 三个纯函数；地址取自各厂商文档与 pi 的 provider
  注册表（`pi/packages/ai/src/providers/*.ts`，一处一处核对过，不是拼出来的）。
  `GET /api/providers` 把表与匹配结果一起给出，`?baseUrl=&model=` 可以判断**还没保存**的值，
  所以设置页选中预设后提示立刻跟着变。
- **下拉的坑（实测踩到）**：选项列表**只建一次**，且渲染函数**绝不回写 `select.value`**。否则任何一处
  字段编辑都会触发 `refreshDynamic()` → 重渲染 → 把选项重建、把值改回服务端算出的旧值，用户看到的就是
  「点了没反应」。`test:ui` 现在钉住这条：选完立刻断言值仍是刚选的那项（不等异步回来）。
- **诚实优先**：窗口/输出上限**只登记厂商文档写明的值**，其余是 `null`，UI 显示「未记录」而不是猜；
  已知值给一个「套用窗口」按钮填进 `maxContext`（DeepSeek 1M/384K 是实测+文档双证，先按这个填）。
- **已知窗口自动生效**（用户报的"窗口还是 65536"）：光有表 + 按钮不够——不点就永远不对，而 65k 离 1M 太远，
  溢出学习也永远不会触发。现在 `Store.loadConfig()` 里 `adoptKnownWindow()`：**`maxContext` 还等于出厂默认
  65536 且当前端点+模型有已知窗口**（`knownContextWindow()`：实测值 > 文档表 > null）时，直接用已知值；
  用户填过的任何数值（含刻意调小）**一律不动**。读路径不改文件，下一次保存把它持久化，所以字段与生效值不会
  各说各话。`test:api` 钉住两条：默认值被替换、显式值不被碰。
- **顺手修的坑**：`normalizeBaseUrl` 原先是「不以 `/vN` 结尾就补 `/v1`」，会把 Google 的
  `/v1beta/openai` 补成 404。现在按 URL 解析：路径为空才补 `/v1`，带路径的原样使用（`/v1`、`/api/paas/v4`、
  `/compatible-mode/v1` 都因此正确）。
- **设置页只填字段、不替你保存**：选预设只是把 baseUrl（必要时首个模型 id）写进上面的输入框，仍旧要点
  「保存」；这与既有的「改完字段先保存，再回来测连接」一致，也让自动化测试能断言「选完地址就变了」。

### 7.35 上下文窗口：超了才学，而且不花钱

「每次新会话第一次调用顺带把窗口更新了」这个想法走不通，原因在响应本身：**成功的响应里永远没有窗口**，
只有这次用了多少 token（`usage`）；`/models` 也没有（DeepSeek 实测只有 `id/object/owned_by`）。
但**溢出报错里有**，而且被拒的请求不计费——所以窗口的学法只有一个：**等它超一次，从错误里读出来**。

**实测（本项目，用真实 DeepSeek Key，全部 400 被拒 = 零成本）**

| 请求 | 结果 |
|---|---|
| 非流式：700k 输入 + `max_tokens=393216` | `This model's maximum context length is 1048576 tokens. However, you requested 1093247 tokens (700031 in the messages, 393216 in the completion).` |
| 流式：1.2M 输入（**走我们自己的 `streamChat`**） | 同样措辞，`provider returned 400: {...}` 里数字完整可解析 |
| `max_tokens=1e9` | `valid range of max_tokens is [1, 393216]` ← 这是**输出上限**，不是窗口 |

顺带发现：**流式下 DeepSeek 会把过大的 `max_tokens` 夹到剩余空间而不报错**（700k 输入 + 393216 输出直接成功），
所以探测窗口必须让**输入本身**超窗。

**实现**

- `src/engine/limits.ts`：`isContextOverflow()`（20+ 家措辞，参考开源实现的 `utils/overflow.ts` 清单并核对格式）、
  `parseContextFailure()`（抽窗口与「你这次用了多少」）、`limitKey()`（`归一化端点#模型`）。
  抽数正则示例如 `maximum context length is ([\d,]+) tokens`、`([\d,]+) in the messages`、
  `tokens > ([\d,]+) maximum`、`maximum number of tokens allowed \(([\d,]+)\)`、
  `context length \(([\d,]+) tokens\)`、`maximum prompt length is ([\d,]+)`、`Range of input length should be \[1, ([\d,]+)\]`。
- `data/model-limits.json`（机器写、可删）：学到就存，key 是端点+模型，所以**一次学会，所有会话共用**。
- `generate.ts` 把「装配 → prompt 帧 → 消费流」抽成 `runAttempt(maxContext)`，溢出时**只重试一次**；检索与
  agent 读文件不重跑，只按新窗口重新装配（历史会被裁掉）。
- 新窗口怎么算：`next = min(window, reserve + floor(我们的计数 × window ÷ 服务商的计数))`。按比例把「我们的
  估数」对齐到「服务商的真数」，**一次同时覆盖两种情况**：窗口填大了（两个数接近，结果≈窗口），以及我们的
  估算低估了（中文常见，按比例缩小后下一次才真的装得下）。只拿到窗口没拿到计数 → 直接用窗口；两者都没有
  → 只告警、不重试、不猜。
- 白赚一次校准：报错里那句「你这次实际用了 N tokens」直接写成该会话的 `usageAnchor`（和成功时同一条路），
  下次预览的已用值就是 provider 实测的。
- 客户端新增 `warning` SSE 帧的处理器：toast 说清改了什么、把 `state.config.maxContext` 就地更新（进度条
  立刻正确），并且**清掉 `failed`**——否则重试成功的那条回复会被上一轮的 error 帧当成失败丢掉。

**边界与诚实**：z.ai **静默接受**溢出、Xiaomi MiMo **直接截断输入**，这两类永远学不到，只能靠预设表/文档；
Groq 之类只说 `Please reduce the length of the messages` → 只告警；限流错误里也可能出现 `too many tokens`，
所以有一张 `NON_OVERFLOW_PATTERNS` 把它排除，避免把限流当成溢出（`test:prompt` 钉住这条）。
学到的值在设置页标「（实测）」并**盖过文档值**——服务商自己说的比我们抄的表权威。

---

### 7.36 界面语言：字典 + 属性，不含给模型的「内容」

**问题**：界面文案一直硬编码中文，要支持中英、并能持续加语言，同时不能碰给模型的提示词内容。

**边界（最重要的一条）**：`outputLanguage` / `languageInstruction` / memory prompt / story template /
翻译提示词 / `LANGUAGE_PRESETS` 的语言名是**数据/内容**，永远不进字典；字典只管**界面文案**。
「回复语言」和「界面语言」是两条正交的轴。

**结构**

- `web/js/i18n.js`：locale 注册表 + `t(key, params)` + `setLocale` + `onLocaleChange` +
  `applyStaticI18n` + `formatNumber` + `translationKeys`。`t()` 用单花括号 `{name}` 插值（避免误伤
  hint 文本里的 `{{macro}}`）；`params.count` 存在时按 `Intl.PluralRules(current)` 取
  `${key}_one`/`${key}_other`，回退 `_other` → 基础 key，所以复数**按 key 选择性启用**。
- `web/js/locales/{zh-CN,en}.js`：纯 ESM 字典（零构建，故为 `.js` 而非 `.json`）。`zh-CN` 是源语言兼回退，
  缺 key 显示源语言而不是裸 key 路径。**加一门语言 = 一个文件 + `i18n.js` 两行注册**，设置里的下拉自动多一项。
- 偏好存 `data/config.json` 的 `uiLanguage`（服务端将来也要用同一语言输出元数据），localStorage
  （`teahouse.uiLanguage.v1`）只是首帧镜像。
- 静态骨架：`index.html` 用 `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` /
  `data-i18n-aria-label`；`i18n-boot.js` 是 `<body>` 末尾的 **classic** 脚本，在首帧前用一份内联「壳字典」
  把静态文案一次性写好（`theme-boot.js` 的同一思路：模块是 deferred 的，会先闪一下）。
- schema 与表单：字段文案存 `labelKey`/`hintKey`/`placeholderKey`/`groupKey`，`components/form-field.js`
  统一解析（无 `*Key` 时仍按字面量渲染，世界书编辑器那个服务端元数据暂时不受影响）。
- 切换语言：`loadConfig` 的分支 → `setLocale(config.uiLanguage)` → `onLocaleChange`，各视图就地重渲染，
  不刷新页面；`<html lang/dir>` 由 `setLocale` 同步。

**契约（`test:web` / `test:ui` / `test:boot` 钉住）**

- 每个 locale 与源语言的 key 集**完全一致**（含 `_one`/`_other`）；加第三门语言会被自动比较并打印差集。
- schema 的每个 `*Key`、`index.html` 的每个 `data-i18n*` key，在每个 locale 都能解析。
- 壳字典必须**恰好等于** `index.html` 的静态 key 子集，且取值与字典逐字相等——否则首帧会闪源语言。
- 「库外无 CJK 字面量」扫描：剥离注释后，`web/js/**`（除 `locales/`）不得出现 CJK，白名单仅限**数据**：
  命令的开关别名（`开/是/关/否`，用户要输入）、检索 `reason` 匹配正则（`递归`）、`LANGUAGE_PRESETS`、
  `translate.js` 的 CJK 检测正则、`i18n-boot.js` 的壳字典。

**Phase 2（服务端元数据）**：`entry-fields.ts` / `providers.ts` 的 label / hint / note / option 存
`LocalizedText`；`localizedEntryFields(lang)` 与 `providersPayload(..., lang)` 按路由读到的 `?lang=`（缺省源语言）
拍平成字符串。客户端 `loadFieldMeta()` 与服务商预设请求带上 `?lang=`，语言切换时 `resetFieldMeta()` 让编辑器重新取。

**Phase 3（服务端消息）**：服务端不翻译，只**命名**——`Notice { code, params?, text }`（`src/i18n.ts`）。
- `HttpError` 带 `code`/`params`，JSON 体里与 `error` 文本并存；客户端 `api.js` 优先 `noticeText(record)`。
- `generate.ts` 的 SSE `warning` 帧带 `code`/`params` 与 `detailCode`/`detailParams`；聊天视图优先用它们，
  回退 `message`/`detail`。
- 提示词装配的诊断（上下文模板 / 正则改写 / 模型点名 / agent / 向量 / 重复注入）改成 `Notice[]`，
  在右栏按当前语言渲染。
- 客户端 `i18n.js` 的 `noticeText(notice)`：优先查 `server.<code>` 字典，否则回退服务端 `text`，再回退 code，
  所以服务端加了新 code 而字典没跟上时，界面仍可读。
- 契约：`test:web` 扫描 `src/**` 的 `notice('...')` / `badRequest(..., '...')` 以及 generate 的 `code:`，
  断言每个 code 在字典里都有 `server.<code>`；`test-api` 断言参数越界与溢出告警确实带上 code。

**仍保留中文（有意为之）**：活动记录 label（`chats.ts` / `memory.ts` 写进会话数据的「编辑了一条回复」等）
是历史记录，按写入时的语言存文本，不做回译；`embeddings.ts` 的底层网络错误串与正则校验明细同理——
它们是技术细节，深度依赖上下文，回译收益低于风险。

---

### 7.37 字体：系统书法体直接列名，开源字体按需联网加载

**问题**：字体列表只有 `font-family: "名字", …`，这只表示「用本机安装的同名字体」，**不会触发下载**；
用户没装那几款开源字体时，整排卡片都回退成同一个系统黑体（于是「草书」看着像黑体）。

**两条来源，各用各的**

- **系统自带**（Windows/Office 的 `KaiTi` / `STKaiti` / `LiSu` / `STLiti` / `STXingkai` / `STXinwei` /
  `FangSong` / `YouYuan` / `FZShuTi`）：只写家族名，本机有就直接渲染。仓库同样不内置它们（和既有的
  `PingFang SC` / `SimSun` 引用一致）。楷、隶、行、魏碑都在这一档，选中立即见效。
- **开源字体**（Noto SC / Iansui / Klee One / Ma Shan Zheng / Zhi Mang Xing / Liu Jian Mao Cao / Long Cang）：
  栈里带 `webFont`（Google Fonts 家族名）。选中时 `ensureWebFont()` 注入一条
  `https://fonts.googleapis.com/css2?family=…` 的 `<link>`；它返回按 `unicode-range` 分片的 `@font-face`，
  浏览器只下载当前页面用到的字形分片。`fonts.loli.net` 作为镜像（Google Fonts 在大陆常不可达）在
  `link.onerror` 时接替；两边都失败就静默回退到栈里下一个字体，离线无害。朱雀仿宋不在 Google Fonts
  （GitHub 发布），保持「需先安装」；霞鹜文楷 SC 亦不在，保持本机优先。

**约束的边界**：这是本项目第一处**运行期联网依赖**——只在用户主动选一款 `webFont` 字体时触发，
不预加载、不阻塞首屏，也不内置任何字体二进制进仓库。`test-boot` 的字体流程默认不被触发（默认 `system`
栈没有 `webFont`），所以离线测试路径不变。

---

## 8. 路线图与非目标

已实现的不再列（见 README 的功能总览）。还值得做的，按性价比排序：

| 方向 | 说明 |
|---|---|
| 语音输入 | 浏览器 `SpeechRecognition`，量级小，只有 Chrome 系支持 |
| 绘图（SD） | 一个文生图后端 + 图库 UI + 二进制存储，是独立子系统，不是角色扮演逻辑 |
| 纯文本补全的参数覆盖 | 名字写进消息、模板带出的停止串已在用；text-completion 那条路本身已通（§7.22） |

**明确不做**：扩展脚本系统（与"消毒是结构性的、不走 `innerHTML`"正面冲突）、
多用户与鉴权（本地单用户；真要远程访问，最小解是绑定地址 + 一个 token，不是账号体系）。

## 9. 已知取舍与安全边界

| 取舍 | 说明 |
|---|---|
| 世界书变体比想象的多 | 覆盖报告强制暴露「未识别字段」，遇到就补映射 + 加进 corpus |
| 世界书触发语义细节（递归 × sticky × 分组）组合爆炸 | 每个语义单独写最小用例，不靠整体手感验证 |
| 角色卡是**不可信输入**（可能含提示词注入） | 本项目**不接任何工具执行**。§7.33 的 agent 模式接的是**只读、白名单、有界**的 `read_file`：路径必须命中导入时记下的文件清单，读的是应用自己存的技能包与卡内嵌书，不碰文件系统其他地方，也不执行任何代码。若将来要接**能执行**的工具，必须重新评估 |
| 上下文预算算错导致体验崩 | itemization 全程可视，用户能立刻看出是哪块吃掉了预算 |
| 零依赖实现 PNG 有坑 | 只处理 tEXt（未压缩），读时跳过其余分块；写时插到 IEND 前，CRC32 自己算并写测试 |
