# Windows 发布

[最新版 v1.3.4](https://github.com/SJT-bright/video-production-os-windows/releases/tag/v1.3.4) · [源码及构建说明](WINDOWS-REPRODUCE.md)。

完整解压 `VideoProductionOS-Windows-x64.zip`，双击里面的 `视频制作OS.exe`。不要只提取或移动 EXE；软件运行需要同目录的 DLL、resources、locales 和音频组件。

升级时只替换软件文件夹，不删除 `%APPDATA%\视频制作 OS`，素材和登录不放在发布包内。源码运行与下载版工作区独立，不会自动导入作者的数据或源码开发数据。

构建必须在实际 Windows runner 完成启动验收；仅在 Mac 生成 EXE 文件不算 Windows 运行通过。每次 Release 附有 SHA256SUMS、FFmpeg 对应源码与第三方说明。
