打包时把 Node 运行时放在这里：

  src-tauri/resources/runtime/node.exe

要求 Node >= 23.6（`teahouse` 的 `src/server.ts` 是靠 Node 直接跑 TypeScript 的）。
开发时这里可以空着：外壳会自动用 PATH 上的 `node`，或用环境变量 `TEAHOUSE_NODE` 指定的路径。
