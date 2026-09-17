打包用的「基线」源码副本放这里（把 teahouse 仓库的 src/ 和 web/ 拷进来）：

  src-tauri/resources/app/src/...
  src-tauri/resources/app/web/...

首次启动时外壳会把它整份种到 %APPDATA%\teahouse\app，之后更新功能就是替换那个目录，
不用重新打包。开发时这里可以空着：外壳会直接用同级的 teahouse 检出，或用 TEAHOUSE_APP 指定的目录。
