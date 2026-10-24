// 单帧蒙版流水线（纯函数 + 注入的推理函数）：模型输入 → 推理 → 放大到帧尺寸 → 可选边缘精修。
import { LIGHT_SIZE, MODEL_SIZE, clampMask, guidedFilter, refineRadius, resizeBilinear, sigmoidMask, tightenMask, toGray, toInput, toInputLight } from './core';
import type { ModelKey } from './plan';

export type Infer = (input: Float32Array) => Promise<Float32Array>;

/** 各模型送入网络的边长 */
export const INPUT_SIZE: Record<ModelKey, number> = { light: LIGHT_SIZE, hd: MODEL_SIZE };

/**
 * @param modelRgba 缩放到模型输入边长的帧像素
 * @param frameRgba 原帧像素（w×h），作为引导滤波的引导图
 * @returns w×h 的 0–1 蒙版
 */
export async function frameMask(
  kind: ModelKey, modelRgba: Uint8ClampedArray, frameRgba: Uint8ClampedArray, w: number, h: number, infer: Infer, refine: boolean,
): Promise<Float32Array> {
  const size = INPUT_SIZE[kind];
  const pred = await infer(kind === 'light' ? toInputLight(modelRgba, size) : toInput(modelRgba, size));
  if (pred.length !== size * size) throw new Error(`模型输出大小不对（${pred.length}），模型文件可能不匹配`);
  const prob = kind === 'light' ? clampMask(pred) : sigmoidMask(pred);
  let m = resizeBilinear(prob, size, size, w, h);
  if (refine) m = tightenMask(guidedFilter(toGray(frameRgba, w, h), m, w, h, refineRadius(w, h), 1e-3));
  return m;
}

/**
 * 插值蒙版的再精修：商品在两个识别帧之间移动时，线性插值会出现半透明的重影；
 * 用该帧自己的画面做引导滤波，把蒙版边缘拉回到画面里真实的边缘上。半径取长边的 1/40（4–24 像素）。
 */
export function refineInterpolated(frameRgba: Uint8ClampedArray, mask: Float32Array, w: number, h: number): Float32Array {
  const r = Math.min(24, Math.max(4, Math.round(Math.max(w, h) / 40)));
  return tightenMask(guidedFilter(toGray(frameRgba, w, h), mask, w, h, r, 1e-3));
}
