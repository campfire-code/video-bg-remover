// 纯函数：抽帧与合成的 ffmpeg 参数、耗时预估、命名。不依赖界面和本机能力。

export type ModelKey = 'light' | 'hd';
/**
 * 每次识别耗时（秒）：在 Apple 芯片 Mac 上用 onnxruntime-web 的 WASM 单线程实测（2026-10-23，node 22，输入随机数，连续 4 次取平均）：
 * u2netp 约 0.80 秒，BiRefNet lite 512 约 4.2 秒。别的电脑会快或慢，只作预估。
 */
export const SEC_PER_INFER: Record<ModelKey, number> = { light: 0.8, hd: 4.2 };

export type OutKind = 'webm' | 'mov' | 'mp4';
export const OUT_EXT: Record<OutKind, string> = { webm: 'webm', mov: 'mov', mp4: 'mp4' };
export const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'];
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp'];

export interface Limits {
  /** 最多处理前几秒 */
  maxSecs: number;
  /** 输出帧率 */
  fps: number;
  /** 输出画面长边上限（像素），0 表示不缩小 */
  maxSide: number;
}

/** 实际处理的秒数：视频时长未知（0）时按上限算 */
export const effectiveSecs = (duration: number, maxSecs: number) => (duration > 0 ? Math.min(duration, maxSecs) : maxSecs);

/** 每隔几帧识别一次；maskFps 为 0 表示每帧都识别 */
export const keyStep = (fps: number, maskFps: number) => (maskFps <= 0 ? 1 : Math.max(1, Math.round(fps / maskFps)));

export interface Estimate { frames: number; inferences: number; seconds: number }

/** 预估：只算识别耗时（抽帧、编码另计，通常比识别短很多） */
export function estimate(duration: number, lim: Limits, maskFps: number, model: ModelKey): Estimate {
  const secs = effectiveSecs(duration, lim.maxSecs);
  const frames = Math.max(1, Math.round(secs * lim.fps));
  const step = keyStep(lim.fps, maskFps);
  const inferences = Math.ceil(frames / step) + 1;
  return { frames, inferences, seconds: inferences * SEC_PER_INFER[model] };
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${s % 60 ? `${s % 60} 秒` : ''}`.trim();
}


/** 抽帧：按输出帧率取前 maxSecs 秒，缩到长边不超过 maxSide、宽高取偶数，存成 JPEG 序列 */
export function extractArgs(input: string, framesDir: string, lim: Limits): string[] {
  const vf = [`fps=${lim.fps}`];
  if (lim.maxSide > 0) vf.push(`scale=w='min(${lim.maxSide},iw)':h='min(${lim.maxSide},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`);
  else vf.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  return ['-t', String(lim.maxSecs), '-i', input, '-vf', vf.join(','), '-q:v', '2', `${framesDir}/${FRAME_IN}`];
}

export const FRAME_IN = 'in%05d.jpg';
/** 处理后的帧：透明输出存 PNG（带透明度），其余存 JPEG */
export const frameOutName = (i: number, kind: OutKind) => `out${String(i + 1).padStart(5, '0')}.${kind === 'mp4' ? 'jpg' : 'png'}`;
export const frameOutPattern = (kind: OutKind) => `out%05d.${kind === 'mp4' ? 'jpg' : 'png'}`;
export const frameInName = (i: number) => `in${String(i + 1).padStart(5, '0')}.jpg`;

export interface EncodeOptions {
  framesDir: string;
  kind: OutKind;
  fps: number;
  frames: number;
  /** 原视频路径；要保留原声时填 */
  audioFrom?: string;
  out: string;
}

/** 合成：webm = VP9 + 透明度（yuva420p）；mov = ProRes 4444 + 透明度；mp4 = H.264（不透明背景） */
export function encodeArgs(o: EncodeOptions): string[] {
  const dur = o.frames / o.fps;
  const args = ['-framerate', String(o.fps), '-i', `${o.framesDir}/${frameOutPattern(o.kind)}`];
  if (o.audioFrom) args.push('-i', o.audioFrom);
  args.push('-map', '0:v');
  if (o.audioFrom) args.push('-map', '1:a:0?');
  if (o.kind === 'webm') {
    // 透明度需要关掉 auto-alt-ref，否则 libvpx 不会保留 alpha
    args.push('-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '30', '-row-mt', '1');
    if (o.audioFrom) args.push('-c:a', 'libopus', '-b:a', '128k');
  } else if (o.kind === 'mov') {
    args.push('-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0');
    if (o.audioFrom) args.push('-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    if (o.audioFrom) args.push('-c:a', 'aac', '-b:a', '160k');
  }
  args.push('-t', dur.toFixed(3), o.out);
  return args;
}

/** 输出文件名：同名时在后面加序号，避免覆盖 */
export function outputName(name: string, kind: OutKind, transparent: boolean, taken: Set<string> = new Set()): string {
  const base = name.replace(/\.[^.]+$/, '');
  const tag = transparent ? '去背景' : '换背景';
  let n = `${base}-${tag}.${OUT_EXT[kind]}`;
  for (let i = 2; taken.has(n); i++) n = `${base}-${tag}-${i}.${OUT_EXT[kind]}`;
  return n;
}
