**中文** | [English](./README.en.md)

# teahouse-desktop

`teahouse` 的 Windows 桌面外壳：一个 Tauri v2 窗口，指向**应用自己的本地 HTTP 服务**。
前端和后端仍是 `teahouse` 仓库里那套，原样不动——外壳只负责找 Node 运行时、在空闲端口上起
`src/server.ts`、等 `/api/health` 通了、再把窗口打开到那个地址。

数据固定放在 `%APPDATA%\teahouse\`，随安装/更新都不丢。

## 运行需要

- **Rust**（含 MSVC 工具链）——装 Rust 时会问；本机用 VS 2022 的 VC 工具。
- **WebView2 Runtime**——Win10/11 一般自带。
- **Node ≥ 23.6**——`teahouse` 的 `src/server.ts` 靠 Node 原生跑 TypeScript。

开发时不需要 Tauri CLI，`cargo run` 就够了；只有打安装包时才需要：
`cargo install tauri-cli --version "^2"`。

## 开发

```powershell
# 方式一：外壳自己起服务端（跑同级的 teahouse 检出，或 TEAHOUSE_APP 指定的目录）
cd teahouse-desktop\src-tauri
cargo run

# 方式二（推荐日常）：先 npm start，再让外壳只开窗口、不起服务端
cd ..\teahouse
npm start
cd ..\teahouse-desktop\src-tauri
$env:TEAHOUSE_URL = "http://127.0.0.1:8787"
cargo run
```

方式二下改前端刷新即可，等同浏览器开发。

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `TEAHOUSE_URL` | 直接打开这个地址，不起子进程 | 空 |
| `TEAHOUSE_APP` | 要运行的 app 源码目录（含 `src/`、`web/`） | `%APPDATA%\teahouse\app`，没有就种一份或用同级检出 |
| `TEAHOUSE_NODE` | node 可执行文件 | `resources\runtime\node.exe`，没有就用 PATH 上的 `node` |
| `TEAHOUSE_DATA` | 数据目录 | `%APPDATA%\teahouse\data` |

端口由外壳在 `127.0.0.1` 上挑空闲的，不和开发版的 8787 抢。

## 标题栏与菜单

窗口是**无边框**的（`decorations: false`），没有系统标题栏和菜单栏；外壳用一段注入到页面里的脚本（`src-tauri/scripts/titlebar.js`）把标题栏画进 app 自己的 `.topbar`：

- **右侧**只有三个窗口按钮：最小化 / 最大化还原 / 关闭。
- **左侧**一个 **☰**：打开数据目录 / 打开程序目录 / 打开日志 / 重启服务端 / 检查更新… / 退出前确认（勾选）/ 退出。
- 顶栏空白处可**拖动窗口**，**双击最大化还原**。

窗口边缘与四角仍是系统原生缩放（实测 `WM_NCHITTEST` 返回 `HTLEFT/HTRIGHT/HTTOP/…`），不需要自绘热区。

这几个动作走外壳自己的命令（`shell_control` / `shell_action` / `shell_state`），并通过 `capabilities/default.json` 只授权给 `http://127.0.0.1:*` 这个本地源。

## 缩放

- **Ctrl + 鼠标滚轮**、**Ctrl + `+`**、**Ctrl + `-`** 调整界面缩放，**Ctrl + `0`** 复位。
- 档位 50%–200%，每次 10%，存进 `%APPDATA%\teahouse\shell.json` 的 `zoom`，下次打开保持。
- 走外壳命令 `shell_zoom`（同样只在本地源被授权）。浏览器里这组键是浏览器原生的页面缩放，不需要外壳参与。

## 自动更新

外壳能把一份新的 `src/` + `web/` 下载下来、校验、暂存，重启后换上——**不用重新打包**。

1. 把源码打成一个 zip，**根目录就是 `src/` 与 `web/`**：

   ```
   teahouse-app-0.2.0.zip
     src/...
     web/...
   ```

2. 放一份清单 JSON（`version` 变了就会更新；`sha256` 可选，小写十六进制）：

   ```json
   {
     "version": "0.2.0",
     "url": "https://example.com/teahouse-app-0.2.0.zip",
     "sha256": "……"
   }
   ```

3. 把清单地址配给外壳：环境变量 `TEAHOUSE_UPDATE_URL`，或写进 `%APPDATA%\teahouse\shell.json` 的 `updateUrl`。
4. 菜单 **检查更新…** → 下载并解压到 `%APPDATA%\teahouse\update\staged`（zip-slip 会被拒、校验不过会中止）→ 弹框「已下载 vX，重启后生效」可**立即重启**。
5. 下次启动时，外壳把 `update\staged` 原子地换成 `app\`（失败会回滚到 `app.bak`），并把 `appVersion` 记进 `shell.json`。

`shell.json` 字段：`updateUrl`、`confirmQuit`、`appVersion`。

## 打包与更新（手动）

1. 备好运行时与基线源码：

   ```
   src-tauri\resources\runtime\node.exe      ← Node ≥ 23.6 的 node.exe
   src-tauri\resources\app\src\...           ← 从 teahouse 仓库拷 src/
   src-tauri\resources\app\web\...           ← 从 teahouse 仓库拷 web/
   ```

2. 生成图标（占位，之后可换成自己的）：`node scripts/make-icons.mjs`，或用
   `cargo tauri icon 你的.png` 一次生成全套。图标以 `src-tauri/icons/teahouse.svg`
   为准，`make-icons.mjs` 把同一杯茶零依赖光栅化出来。
3. 出安装包：`cargo install tauri-cli --version "^2"` 然后 `cargo tauri build --bundles nsis`
   → 安装包在 `target\release\bundle\nsis\`。
   - **无控制台**（正式）：`cargo tauri build --bundles nsis`
   - **带命令行窗口**（排障）：`cargo tauri build --bundles nsis --features console`
     —— 同一个 release 构建，只是把 PE 子系统留成 console，会多一个终端窗口。
    - 两个产物同名（`teahouse_<版本>_x64-setup.exe`），先后编译要各自另存，别互相覆盖。
4. 手动更新也可以：直接覆盖 `%APPDATA%\teahouse\app` 里的 `src/`、`web/`，重开应用即可。

## 测试

外壳自身的单元测试：`cd src-tauri; cargo test`（覆盖 zip 解压与暂存更新的换入/记录）。

## 目录

```
%APPDATA%\teahouse\
  app\           ← 实际运行的源码（首次从安装包的 resources/app 种下，更新时被替换）
  data\          ← config.json / characters / worlds / chats（用户的真实数据）
  logs\server.log← 服务端 stdout+stderr
  update\        ← 下载暂存（staged + version）
  shell.json     ← updateUrl / confirmQuit / appVersion
```

## 启动失败怎么办

外壳 25 秒等不到 `/api/health` 会显示一个本地兜底页，并告诉你去看
`%APPDATA%\teahouse\logs\server.log`。常见原因是 node.exe 版本不对或 `app\` 不完整。
