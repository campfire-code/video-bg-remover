// 工具声明：商品短视频去背景
// 流程：ffmpeg 抽帧 → 逐帧（隔几帧识别一次，其余插值）抠图并平滑 → ffmpeg 合成透明视频或换背景的 MP4。
import { Film } from 'lucide-react';
import { join as pathJoin, tempDir } from '@tauri-apps/api/path';
import type { BatchTool } from '../kit/types';
import { normalizeColor } from './core';
import { decodeImage, getSession, makeInfer, makeThumb, makeWriter, readFrame, type Background } from './engine';
import {
  IMAGE_EXTS, SEC_PER_INFER, VIDEO_EXTS, effectiveSecs, encodeArgs, estimate, extractArgs, fmtDuration, frameInName, frameOutName, keyStep,
  outputName, type Limits, type ModelKey, type OutKind,
} from './plan';
import { refineInterpolated } from './pipeline';
import { processFrames } from './process';
import type { SmoothKey } from './temporal';
import { Empty, ResultBody } from './ui';

/** 可替换的外部依赖，测试里换成假的 */
export const deps = {
  tempDir: async () => pathJoin(await tempDir(), `video-bg-remover-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
  async countFrames(dir: string): Promise<number> {
    const { readDir } = await import('@tauri-apps/plugin-fs');
    return (await readDir(dir)).filter((e) => /^in\d{5}\.jpg$/.test(e.name)).length;
  },
  async removeDir(dir: string) {
    try {
      const { remove } = await import('@tauri-apps/plugin-fs');
      await remove(dir, { recursive: true });
    } catch {
      // 临时文件删不掉就留给系统清理，不影响成片
    }
  },
};

// 帮助文字里的耗时示例，用同一个预估函数算出，避免与实际逻辑不一致
const EXAMPLE = { secs: 10, fps: 24 };
const exampleHelp = (() => {
  const lim: Limits = { maxSecs: EXAMPLE.secs, fps: EXAMPLE.fps, maxSide: 0 };
  const t = (maskFps: number, m: ModelKey) => fmtDuration(estimate(EXAMPLE.secs, lim, maskFps, m).seconds);
  return `识别越密，运动中的商品越贴合，但越慢。例：${EXAMPLE.secs} 秒视频、${EXAMPLE.fps} 帧/秒，每秒识别 12 次，轻模型约 ${t(12, 'light')}、高清约 ${t(12, 'hd')}；每秒识别 6 次，轻模型约 ${t(6, 'light')}、高清约 ${t(6, 'hd')}。两次识别之间的画面用插值补上，商品移动快时间隔太大边缘会发虚。这是苹果芯片 Mac 上的实测推算（轻模型每次约 ${SEC_PER_INFER.light} 秒，高清每次约 ${SEC_PER_INFER.hd} 秒），只含识别，抽帧和合成另计，你的电脑会有差别`;
})();

const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

const tool: BatchTool = {
  id: 'e05',
  name: '商品短视频去背景',
  tagline: '逐帧抠掉商品视频的背景，输出透明背景视频，或换成纯色、自选图片背景的 MP4。全部在本机完成，不联网（高清模式首次需下载模型）。',
  icon: Film,
  category: '电商运营',
  type: 'media',
  mode: 'batch',
  resultView: 'list',
  Empty,
  ResultBody,
  concurrency: 1,
  accept: { label: '商品视频', extensions: VIDEO_EXTS },
  check: (item) => (VIDEO_EXTS.includes(ext(item.name)) ? null : `不是支持的视频格式（支持 ${VIDEO_EXTS.join('、')}）`),
  params: [
    { key: 'bg', label: '背景', type: 'segment', options: [['transparent', '透明'], ['color', '纯色'], ['image', '自选图片']], default: 'transparent' },
    {
      key: 'format', label: '透明视频格式', type: 'select', when: (p) => p.bg === 'transparent', default: 'webm',
      options: [['webm', 'WebM（VP9，体积小，多用于网页）'], ['mov', 'MOV（ProRes 4444，体积大，多用于剪辑软件）']],
      help: '能否识别透明通道取决于你的播放器或剪辑软件，请以实际软件为准',
    },
    { key: 'color', label: '背景颜色', type: 'text', when: (p) => p.bg === 'color', default: '#FFFFFF', placeholder: '#FFFFFF', help: '写颜色代码，例如纯白 #FFFFFF；输出为 MP4' },
    { key: 'bgImage', label: '背景图片', type: 'file', when: (p) => p.bg === 'image', extensions: IMAGE_EXTS, fileLabel: '图片', default: '', help: '等比放大铺满画面，多余部分居中裁掉；输出为 MP4' },
    {
      key: 'model', label: '抠图模型', type: 'segment', options: [['light', '轻模型（快）'], ['hd', '高清模式（慢）']], default: 'light',
      help: '轻模型随应用自带；高清模式用 BiRefNet 模型，边缘更细，每次识别约慢 5 倍，首次使用需下载约 183 MB 模型',
    },
    { key: 'modelFile', label: '本地模型文件（可选）', type: 'file', when: (p) => p.model === 'hd', extensions: ['onnx'], fileLabel: '模型文件', default: '', help: '下载不了时，可手动下载 birefnet-lite-512 的 model.onnx 在这里选择' },
    { key: 'maxSecs', label: '最多处理前几秒', type: 'number', default: 10, min: 1, max: 60, unit: '秒', help: '视频更长时只处理开头这一段，避免等太久；想处理更长可调大' },
    {
      key: 'maskFps', label: '识别密度', type: 'select', default: '12', help: exampleHelp,
      options: [['6', '每秒识别 6 次（最快，商品移动慢时用）'], ['12', '每秒识别 12 次（推荐）'], ['0', '每帧都识别（最慢）']],
    },
    { key: 'smooth', label: '闪烁抑制', type: 'segment', options: [['off', '关'], ['low', '弱'], ['mid', '中'], ['high', '强']], default: 'mid', help: '让相邻识别结果更接近，边缘不再忽大忽小；商品运动很快时调低，避免拖影' },
    { key: 'refine', label: '边缘精修', type: 'toggle', default: true, help: '用每一帧自己的画面收紧边缘、减轻移动时的重影，每帧多花一点时间' },
    { key: 'fps', label: '输出帧率', type: 'select', default: '24', options: [['15', '15 帧/秒'], ['24', '24 帧/秒'], ['30', '30 帧/秒']], help: '按这个帧率重新取帧；原视频帧率更低时会重复帧，更高时会丢帧' },
    { key: 'maxSide', label: '画面最长边', type: 'select', default: '1280', options: [['720', '720 像素（快）'], ['1280', '1280 像素'], ['1920', '1920 像素（慢，占内存）'], ['0', '保持原尺寸']], help: '比原视频小才会缩小，不会放大' },
    { key: 'audio', label: '保留原声', type: 'toggle', default: true },
    { key: 'out', label: '保存到', type: 'folder', default: '' },
  ],
  async run(item, ctx) {
    if (!item.path) throw new Error('缺少视频路径');
    const p = ctx.params;
    const started = Date.now();
    const kind: ModelKey = p.model === 'hd' ? 'hd' : 'light';
    const transparent = p.bg === 'transparent';
    const outKind: OutKind = transparent ? (p.format === 'mov' ? 'mov' : 'webm') : 'mp4';

    // 先把参数检查完，再做耗时的事
    let bg: Background = { type: 'transparent' };
    if (p.bg === 'color') {
      const hex = normalizeColor(String(p.color));
      if (!hex) throw new Error(`背景颜色「${p.color}」写法不对，请写成 #FFFFFF 这样的颜色代码`);
      bg = { type: 'color', hex };
    } else if (p.bg === 'image') {
      if (!String(p.bgImage ?? '')) throw new Error('请先选择背景图片');
      bg = { type: 'image', img: await decodeImage(await ctx.readFile(String(p.bgImage))) };
    }
    const lim: Limits = { maxSecs: Number(p.maxSecs), fps: Number(p.fps), maxSide: Number(p.maxSide) };
    const step = keyStep(lim.fps, Number(p.maskFps));

    const dir = await deps.tempDir();
    try {
      await ctx.mkdir(dir);
      // 1. 抽帧
      const total = await ctx.duration(item.path);
      const secs = effectiveSecs(total, lim.maxSecs);
      await ctx.ffmpeg(extractArgs(item.path, dir, lim), (s) => ctx.progress(Math.min(0.07, (s / secs) * 0.07)));
      const count = await deps.countFrames(dir);
      if (!count) throw new Error('没有从视频里取到画面，文件可能已损坏或格式不受支持');

      // 2. 加载模型（高清模式首次会下载）
      const session = await getSession(kind, String(p.modelFile ?? ''), (r) => ctx.progress(0.07 + r * 0.03), ctx.signal);
      ctx.progress(0.1);
      const infer = makeInfer(kind, session, p.refine !== false);
      const write = makeWriter(bg, outKind);

      // 3. 逐帧抠图
      const { inferences } = await processFrames(
        {
          count,
          read: (i) => ctx.join(dir, frameInName(i)).then(readFrame),
          infer,
          refine: p.refine === false ? undefined : (f, a) => refineInterpolated(f.rgba, a, f.w, f.h),
          write: async (i, frame, alpha) => ctx.writeFile(await ctx.join(dir, frameOutName(i, outKind)), await write(frame, alpha)),
        },
        { step, smooth: String(p.smooth) as SmoothKey, signal: ctx.signal, onProgress: (d, t) => ctx.progress(0.1 + 0.8 * (d / t)) },
      );

      // 4. 合成
      const outName = outputName(item.name, outKind, transparent);
      const outputPath = await ctx.join(ctx.outputDir, outName);
      await ctx.mkdir(ctx.outputDir);
      const dur = count / lim.fps;
      await ctx.ffmpeg(
        encodeArgs({ framesDir: dir, kind: outKind, fps: lim.fps, frames: count, audioFrom: p.audio === false ? undefined : item.path, out: outputPath }),
        (s) => ctx.progress(Math.min(0.99, 0.9 + (s / dur) * 0.09)),
      );
      const preview = await makeThumb(await ctx.readFile(await ctx.join(dir, frameOutName(0, outKind)))).catch(() => undefined);
      const label = transparent ? (outKind === 'mov' ? '透明 ProRes' : '透明 WebM') : bg.type === 'color' ? `背景 ${bg.hex}` : '图片背景';
      return { outputPath, preview, summary: `${label} · ${count} 帧 · 识别 ${inferences} 次 · ${fmtDuration((Date.now() - started) / 1000)}${total > lim.maxSecs ? ` · 前 ${lim.maxSecs} 秒` : ''}` };
    } finally {
      await deps.removeDir(dir);
    }
  },
};

export default tool;
