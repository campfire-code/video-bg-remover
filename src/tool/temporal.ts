// 蒙版的时间维度处理：相邻识别帧平滑（减少闪烁）、识别帧之间线性插值。纯函数。

/** 平滑强度 → 新蒙版所占权重（权重越小越稳，但动作快时会有轻微拖影） */
export type SmoothKey = 'off' | 'low' | 'mid' | 'high';
export const SMOOTH_WEIGHT: Record<SmoothKey, number> = { off: 1, low: 0.7, mid: 0.5, high: 0.35 };

/** 两张蒙版逐像素平均绝对差，0–1 */
export function maskDiff(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('蒙版大小不一致');
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return a.length ? s / a.length : 0;
}

/** 两张识别帧蒙版平均差超过这个值，认为镜头切换了，不再与上一张平滑 */
export const SCENE_CUT = 0.25;

/**
 * 逐像素差超过这个值，认为是商品真的移动了（边缘从背景变成主体或反过来），不参与平滑和线性插值。
 * 否则商品移动时，平滑会把前后两个位置的蒙版叠在一起，画面上出现重影。
 */
export const MOTION_JUMP = 0.35;

/**
 * 指数平滑：result = w·cur + (1-w)·prev，只作用在变化不大的像素上（抑制边缘忽大忽小的噪声）。
 * prev 为空、w≥1 或检测到镜头切换时直接返回 cur。
 */
export function smoothMask(prev: Float32Array | null, cur: Float32Array, weight: number): Float32Array {
  if (!prev || weight >= 1 || maskDiff(prev, cur) > SCENE_CUT) return cur;
  const w = Math.max(0, Math.min(1, weight));
  const out = new Float32Array(cur.length);
  for (let i = 0; i < cur.length; i++) out[i] = Math.abs(cur[i] - prev[i]) > MOTION_JUMP ? cur[i] : w * cur[i] + (1 - w) * prev[i];
  return out;
}

/**
 * 两个识别帧之间的插值：t=0 为 a，t=1 为 b。变化不大的像素线性过渡；
 * 变化很大（商品移动）的像素不做半透明过渡，取离得近的那个识别帧。
 */
export function lerpMask(a: Float32Array, b: Float32Array, t: number): Float32Array {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.abs(b[i] - a[i]) > MOTION_JUMP ? (t < 0.5 ? a[i] : b[i]) : a[i] + (b[i] - a[i]) * t;
  return out;
}
