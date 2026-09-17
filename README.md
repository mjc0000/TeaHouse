<img src="teahouse/web/logo.svg" width="96" alt="teahouse，一杯冒热气的茶" />

**中文** | [English](./README.en.md)

# teahouse · 茶馆

本地单用户 AI 角色扮演前端：**角色卡**、**世界书**、**提示词栈**，外加一个 Windows 桌面壳。

SillyTavern 是喧闹的大酒馆，teahouse 是街角安静的茶馆——坐下来，慢慢聊。它**完全兼容 SillyTavern 的世界书文件**（网上能用的 JSON 世界书，这里都能用，原文字节存盘、无损回写），提示词栈的每一块都能开关、单独计 token、导出真实请求，所见即所得。

- 角色卡 / 世界书 / 会话三面板，流式输出、swipe 变体、消息级编辑、从任意一条重开或分叉
- 世界书命中解释（命中了哪条、哪个键、为什么没命中）、请求预览、token 构成明细
- 群聊（5 种发言模式 + 每成员独立接口）、长期记忆、向量检索、模型点名、agent 按需读文件
- 立绘看板、语音朗读（本机免费 / 在线）、翻译、中英界面、6 配色 × 明暗主题
- 零运行时依赖：Node 直接跑，无构建步骤；数据全是 `data/` 下的纯文本文件

```
teahouse-suite/
  teahouse/            Web 应用本体（src/ + web/ 是唯一真相）
  teahouse-desktop/    Tauri v2 桌面外壳（无边框窗口 + 自带服务端）
```

## 快速开始

### 前置要求

| | Windows | Linux | macOS |
|---|---|---|---|
| Git | [git-scm.com](https://git-scm.com) | 发行版自带或包管理器 | Xcode CLT 自带 |
| Node ≥ 23 | [nodejs.org](https://nodejs.org) | 同左 | 同左 |
| 桌面版另需 | Rust（[rustup.rs](https://rustup.rs)，装时选 MSVC）+ WebView2（Win10/11 自带） | Rust + [Tauri 系统依赖](https://tauri.app/start/prerequisites/)（主要是 webkit2gtk） | Rust + Xcode CLT |

```powershell
node --version   # v23 以上
cargo --version  # 只跑桌面版需要
```

### 1. Web 版（三个系统一样，三行命令）

Windows（PowerShell）：

```powershell
git clone https://github.com/<你>/<仓库>.git
cd teahouse-suite\teahouse
npm start
```

Linux / macOS（bash）：

```bash
git clone https://github.com/<你>/<仓库>.git
cd teahouse-suite/teahouse
npm start
```

浏览器打开 http://127.0.0.1:8787，点右上角「设置」填接口地址、API Key、模型名，保存开聊。
例如 DeepSeek：`https://api.deepseek.com/v1` + `deepseek-chat`；本机 Ollama / LM Studio 直接填本地地址、Key 留空。

### 2. 桌面版（Windows）

最省事：去 [Releases](../../releases) 下载 `teahouse_*_x64-setup.exe`，双击安装。

从源码跑 debug 版：

```powershell
cd teahouse-suite\teahouse-desktop\src-tauri
cargo run
```

外壳会自动：找 Node → 在空闲端口上起 `teahouse/src/server.ts` → 等 `/api/health` 通 → 打开无边框窗口。
日常前端开发可以先 `npm start`，再设 `$env:TEAHOUSE_URL = "http://127.0.0.1:8787"` 后 `cargo run`，这样外壳只开窗口、改完前端刷新即可。

Linux / macOS 从源码跑桌面版同理（`cd teahouse-suite/teahouse-desktop/src-tauri && cargo run`），
外加两条系统依赖见上表。注意：非 Windows 上没有 `%APPDATA%`，请先指定数据目录再启动，
否则数据会落在系统临时目录：

```bash
export TEAHOUSE_DATA="$HOME/.teahouse/data"
cargo run
```

### 3. 打安装包（Windows）

```powershell
# 1. 把 teahouse/src、teahouse/web 拷进 teahouse-desktop/src-tauri/resources/app/
# 2. 放好 Node 23.6+ 的 node.exe 到 teahouse-desktop/src-tauri/resources/runtime/
#    （cargo install tauri-cli --version "^2" 只需一次）
cd teahouse-suite\teahouse-desktop\src-tauri
cargo tauri build --bundles nsis
```

产物在 `target\release\bundle\nsis\`。安装包走 GitHub Releases 发布，不进版本库。

## 数据在哪

| | Web 版（`npm start`） | 桌面版 |
|---|---|---|
| Windows | `teahouse\data\`（检出目录下） | `%APPDATA%\teahouse\data\` |
| Linux / macOS | `teahouse/data/`（检出目录下） | `$TEAHOUSE_DATA`（没设就是系统临时目录，**一定手动设**） |

`data/` 下是 `config.json`（含 API Key，**永远不要提交**）+ `characters/` + `worlds/`（导入原文字节）+ `chats/`。
全纯文本，可直接备份。跑测试：Web 版 `cd teahouse && npm test`，外壳 `cargo test`。

## 兼容与致谢

- 世界书 6 种来源（SillyTavern 原生 / 独立 CharacterBook / 卡片内嵌 / Agnai / Risu / NovelAI）与扫描语义对齐上游；
  聊天记录、快捷回复、上下文模板与酒馆双向互导。SillyTavern（AGPL-3.0）与 TavernAI 是各自独立的项目，
  这里只是兼容它们的文件格式。
