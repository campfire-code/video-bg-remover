# 商品短视频去背景

> 篝火出品 · 收录于篝火 App 应用区

导入商品短视频，逐帧去掉背景，输出透明背景视频（WebM / ProRes 4444），或换成纯色、自选图片背景的 MP4。全部在本机完成。

![界面截图](docs/screenshot.png)

## 下载

到 [Releases](https://github.com/campfire-code/video-bg-remover/releases/latest) 下载对应安装包：

| 电脑 | 文件 |
|---|---|
| Windows 10 / 11 | `video-bg-remover_版本号_windows-x64-setup.exe` |
| Mac（Apple 芯片） | `video-bg-remover_版本号_mac-arm64.dmg` |
| Mac（Intel 芯片） | `video-bg-remover_版本号_mac-x64.dmg` |

第一次打开：
- **Windows**：如果弹出「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」。
- **Mac**：如果提示「无法验证开发者」，打开「系统设置 → 隐私与安全性」，在下方点「仍要打开」。

## 怎么用

1. 把商品视频拖进窗口（支持 mp4、mov、m4v、mkv、webm、avi），可一次拖多个。
2. 选背景：**透明**（输出 WebM 或 MOV）、**纯色**或**自选图片**（输出 MP4）。
3. 默认用轻模型，只处理前 10 秒、每秒识别 12 次。想要更细的边缘选「高清模式」（首次使用下载约 183 MB 模型，也可手动下载后在「本地模型文件」里选择）。
4. 点「开始」。每个视频的处理分三步：抽帧 → 逐帧抠图 → 合成；列表里显示进度，完成后显示用时。成片保存在「保存到」文件夹，文件名为「原名-去背景」或「原名-换背景」。

**耗时参考**（Apple 芯片 Mac，onnxruntime-web WASM 单线程实测，2026-10-23）：轻模型每次识别约 0.8 秒，高清模式约 4.2 秒。识别次数 =（秒数 × 帧率 ÷ 帧间隔），例如 10 秒、24 帧/秒、每秒识别 12 次约 121 次：轻模型约 1.6 分钟，高清约 8.5 分钟（只含识别，抽帧和合成另计）。参数面板里有同样的示例。

**怎么减少闪烁和重影**：识别之间的帧用插值补上，识别结果之间做平滑（「闪烁抑制」），商品移动导致的边缘变化不会被平滑掉；「边缘精修」会用每帧自己的画面把边缘拉回真实位置。商品移动很快时，调高识别密度。

**透明视频格式**：WebM 使用 VP9 + 透明通道，体积小；MOV 使用 ProRes 4444 + 透明通道，体积大。能否识别透明通道取决于你的播放器或剪辑软件，请以实际软件为准（未逐个软件核实）。

## 验收用例

用 `samples/示例-商品视频.mp4`（4 秒、540×960，程序生成的几何图形动画，带一段提示音）和 `samples/示例-背景图.png`：

1. 默认参数（透明、轻模型、WebM）处理示例视频 → 保存文件夹里出现 `示例-商品视频-去背景.webm`，约 4 秒、96 帧；列表里显示「透明 WebM · 96 帧 · 识别 49 次」，缩略图是抠出的绿色椭圆加黄色圆，背景透明。
2. 「透明视频格式」改 MOV → 得到 `示例-商品视频-去背景.mov`（ProRes 4444）。
3. 背景选「纯色」填 `#FFFFFF` → 得到 `示例-商品视频-换背景.mp4`，用播放器打开：白底、商品左右摆动、有声音。
4. 背景选「自选图片」，选 `示例-背景图.png` → 得到同名 MP4，商品位于深紫色背景上。
5. 「最多处理前几秒」改 2 → 成片约 2 秒、48 帧，列表里的说明带「前 2 秒」。
6. 把 `src/tool` 里的测试跑一遍：`pnpm test`；用本机 ffmpeg 与真实模型验证：`E05_REAL=1 E05_MODEL=1 pnpm exec vitest run src/tool/real.test.ts`。

实际得到的帧数以应用显示为准；以上数字来自本机用同样参数的实测。

## 自己编译

需要 Node.js 22、pnpm、Rust。

```bash
pnpm install
pnpm test          # 单元测试
pnpm tauri dev     # 开发运行
pnpm tauri build   # 打包
```

界面框架在 `src/kit`（所有 campfire-code 工具共用），本工具的逻辑在 `src/tool`。

## 致谢

抠图使用 U²-Net（u2netp，经 [rembg](https://github.com/danielgatis/rembg) 发布的 ONNX 版本，Apache-2.0 / MIT）和 [BiRefNet](https://github.com/ZhengPeng7/BiRefNet)（MIT），推理引擎为 ONNX Runtime Web（MIT）；音视频处理使用 FFmpeg（GPL-3.0，作为独立程序随应用分发）。总目录最初参考的 [nadermx/backgroundremover](https://github.com/nadermx/backgroundremover) 是 Python 项目，本工具没有使用它的代码。

## 归属

本工具由**篝火**出品，是篝火 App 应用区收录的开源工具之一，由篝火（GitHub 组织 [campfire-code](https://github.com/campfire-code)）维护与更新。全部工具的目录见 [toolkit-hub](https://github.com/campfire-code/toolkit-hub)。

## 许可证

MIT，版权方为篝火（campfire-code）。
