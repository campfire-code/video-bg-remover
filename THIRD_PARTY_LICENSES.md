# 第三方开源组件

本工具使用了以下开源组件，许可证原文见各项目仓库。

| 组件 | 用途 | 许可证 |
|---|---|---|
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.22.0 | 在应用内运行抠图模型 | MIT |
| [U²-Net](https://github.com/xuebinqin/U-2-Net) 小模型 u2netp（取自 [rembg](https://github.com/danielgatis/rembg) 发布的 ONNX 版本，随应用打包） | 默认模型，识别商品主体 | Apache-2.0（模型）/ MIT（rembg） |
| [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) lite 模型（ONNX 512×512 导出版，取自 [studioludens/birefnet-lite-512](https://huggingface.co/studioludens/birefnet-lite-512)，提交 962e679）。模型不随安装包分发，选「高清模式」首次使用时由用户机器从 Hugging Face 下载 | 高清模式，识别商品主体 | MIT（Copyright (c) 2024 ZhengPeng；导出版 Copyright (c) 2026 Studio Ludens V.O.F.） |
| [Tauri](https://github.com/tauri-apps/tauri) 及官方插件 | 桌面应用框架 | MIT / Apache-2.0 |
| [React](https://github.com/facebook/react) | 界面 | MIT |
| [Lucide](https://github.com/lucide-icons/lucide) | 图标 | ISC |
| [Vite](https://github.com/vitejs/vite) | 构建 | MIT |
| [FFmpeg](https://ffmpeg.org) 6.x 静态构建（取自 [eugeneware/ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) b6.1.1；Windows 版来自 gyan.dev） | 音视频处理，作为独立程序随应用分发 | GPL-3.0（许可证随安装包附在 licenses/ffmpeg-LICENSE.txt；源码见 https://ffmpeg.org/download.html） |

轻模型的输入处理参考 rembg；引导滤波算法：K. He, J. Sun, X. Tang, "Guided Image Filtering"，本工具自行实现。蒙版平滑与插值为本工具自行实现。
