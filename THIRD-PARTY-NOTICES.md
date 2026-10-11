# 第三方组件

应用自有源码及界面资源按 [MIT](LICENSE) 发布。Electron、Chromium 和其他组件的许可文件保留在完整应用包内，不使用本项目 MIT 许可证替代它们。

人物音轨提取使用 FFmpeg 6.1.1，Copyright FFmpeg developers，按 LGPL-2.1-or-later 发布。应用通过独立命令行进程调用它，不将 FFmpeg 库链接进应用。公开构建禁用 GPL、nonfree、version3 和外部编码器库；许可原文、实际配置和组件 SHA-256 位于 `vendor/media-tools/<platform>-<arch>/`。

每个平台的 GitHub Release 同时提供 `FFmpeg-6.1.1-source.tar.xz`，即本版本组件所用的完整、未修改源码。源码 SHA-256：`8684f4b00f94b85461884c3719382f1261f0d9eb3d59640a1f4ac0873616f968`。构建步骤与选项见源码仓库的 `scripts/build-ffmpeg.sh`，可自行修改或替换该独立工具。

- [Mac 对应组件源码](https://github.com/SJT-bright/video-production-os/releases/download/v1.3.4/FFmpeg-6.1.1-source.tar.xz)
- [Windows 对应组件源码](https://github.com/SJT-bright/video-production-os-windows/releases/download/v1.3.4/FFmpeg-6.1.1-source.tar.xz)
- [FFmpeg 项目](https://ffmpeg.org/) · [许可说明](https://ffmpeg.org/legal.html)

FFmpeg 的部分代码源自 Independent JPEG Group，版权及其他 MIT/BSD 组件说明见随工具保留的 `FFmpeg-LICENSE.md`；本项目未修改这些源文件。完整源包内含各许可证原文。
