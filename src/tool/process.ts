// 逐帧处理流程（纯逻辑）：哪些帧做识别、识别帧之间怎么插值、平滑。读帧、推理、写帧都由外部注入，测试里用假函数。
import { SMOOTH_WEIGHT, lerpMask, smoothMask, type SmoothKey } from './temporal';

export interface Frame { rgba: Uint8ClampedArray; w: number; h: number }

/** 做识别的帧序号：0、step、2·step……，最后一帧一定包含（插值要有终点） */
export function keyIndexes(total: number, step: number): number[] {
  if (total < 1) return [];
  const s = Math.max(1, Math.floor(step));
  const out: number[] = [];
  for (let i = 0; i < total; i += s) out.push(i);
  if (out[out.length - 1] !== total - 1) out.push(total - 1);
  return out;
}

/** 第 i 帧夹在哪两个识别帧之间，以及插值位置 t（0–1） */
export function bracket(i: number, keys: number[]): { lo: number; hi: number; t: number } {
  let k = 0;
  while (k + 1 < keys.length && keys[k + 1] <= i) k++;
  const lo = keys[k];
  const hi = keys[Math.min(k + 1, keys.length - 1)];
  return { lo, hi, t: hi === lo ? 0 : (i - lo) / (hi - lo) };
}

export interface FrameIO {
  count: number;
  read(i: number): Promise<Frame>;
  /** 对一帧做识别，返回与该帧同尺寸（w×h）的 0–1 主体蒙版 */
  infer(frame: Frame): Promise<Float32Array>;
  /** 输出一帧：alpha 为该帧的 0–1 蒙版 */
  write(i: number, frame: Frame, alpha: Float32Array): Promise<void>;
  /** 可选：插值得到的蒙版（非识别帧）用该帧自己的画面再贴合一次边缘，减轻商品移动造成的重影 */
  refine?(frame: Frame, alpha: Float32Array): Float32Array;
}

export interface ProcessOptions {
  /** 每隔几帧识别一次 */
  step: number;
  smooth: SmoothKey;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** 返回实际做了几次识别 */
export async function processFrames(io: FrameIO, opt: ProcessOptions): Promise<{ inferences: number }> {
  const keys = keyIndexes(io.count, opt.step);
  const weight = SMOOTH_WEIGHT[opt.smooth];
  const masks = new Map<number, Float32Array>();
  const frames = new Map<number, Frame>();
  let prevKey: Float32Array | null = null;
  let inferences = 0;

  const ensureKey = async (k: number) => {
    if (masks.has(k)) return;
    const f = frames.get(k) ?? (await io.read(k));
    frames.set(k, f);
    const m = smoothMask(prevKey, await io.infer(f), weight);
    inferences++;
    masks.set(k, m);
    prevKey = m;
  };

  for (let i = 0; i < io.count; i++) {
    if (opt.signal?.aborted) throw new Error('已取消');
    const { lo, hi, t } = bracket(i, keys);
    await ensureKey(lo);
    await ensureKey(hi);
    const frame = frames.get(i) ?? (await io.read(i));
    let alpha = lerpMask(masks.get(lo)!, masks.get(hi)!, t);
    if (t > 0 && io.refine) alpha = io.refine(frame, alpha);
    await io.write(i, frame, alpha);
    // 用不到的旧数据及时释放，内存里最多留两个识别帧
    for (const k of [...masks.keys()]) if (k < lo) masks.delete(k);
    for (const k of [...frames.keys()]) if (k <= i && k !== hi) frames.delete(k);
    opt.onProgress?.(i + 1, io.count);
  }
  return { inferences };
}
