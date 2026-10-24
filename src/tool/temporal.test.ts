import { describe, expect, it } from 'vitest';
import { MOTION_JUMP, SCENE_CUT, SMOOTH_WEIGHT, lerpMask, maskDiff, smoothMask } from './temporal';

const f = (...v: number[]) => new Float32Array(v);

describe('蒙版时间平滑', () => {
  it('平均绝对差', () => {
    expect(maskDiff(f(0, 1), f(0, 1))).toBe(0);
    expect(maskDiff(f(0, 0), f(1, 0))).toBeCloseTo(0.5);
    expect(() => maskDiff(f(0), f(0, 0))).toThrow('不一致');
  });
  it('平滑：权重 0.5 取两者平均；第一帧、权重 1 原样返回', () => {
    const prev = f(0.2, 0.6);
    const cur = f(0.4, 0.8);
    expect([...smoothMask(prev, cur, 0.5)].map((v) => +v.toFixed(2))).toEqual([0.3, 0.7]);
    expect(smoothMask(null, cur, 0.5)).toBe(cur);
    expect(smoothMask(prev, cur, 1)).toBe(cur);
  });
  it('平滑能压住闪烁：交替的 0.4 / 0.6 经过平滑后波动变小', () => {
    const seq = [0.4, 0.6, 0.4, 0.6, 0.4, 0.6].map((v) => f(v));
    const range = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    for (const w of [SMOOTH_WEIGHT.low, SMOOTH_WEIGHT.mid, SMOOTH_WEIGHT.high]) {
      let prev: Float32Array | null = null;
      const out: number[] = [];
      for (const m of seq) { prev = smoothMask(prev, m, w); out.push(prev[0]); }
      expect(range(out.slice(1))).toBeLessThan(0.2);
    }
  });
  it('强度档位：越强权重越小', () => {
    expect(SMOOTH_WEIGHT.off).toBe(1);
    expect(SMOOTH_WEIGHT.low).toBeGreaterThan(SMOOTH_WEIGHT.mid);
    expect(SMOOTH_WEIGHT.mid).toBeGreaterThan(SMOOTH_WEIGHT.high);
  });
  it('镜头切换（差异超过阈值）时不平滑，避免上一镜头的鬼影', () => {
    const prev = new Float32Array(10).fill(1);
    const cur = new Float32Array(10).fill(0);
    expect(maskDiff(prev, cur)).toBeGreaterThan(SCENE_CUT);
    expect(smoothMask(prev, cur, 0.35)).toBe(cur);
  });
  it('商品移动（逐像素差很大）的像素不参与平滑，避免重影', () => {
    // 像素 0：0 → 1（边缘扫过）；像素 1：0.5 → 0.6（噪声）；其余不变，使平均差低于镜头切换阈值
    const prev = new Float32Array(20).fill(0); prev[1] = 0.5;
    const cur = new Float32Array(20).fill(0); cur[0] = 1; cur[1] = 0.6;
    const r = smoothMask(prev, cur, 0.5);
    expect(r[0]).toBe(1);
    expect(r[1]).toBeCloseTo(0.55);
    expect(Math.abs(1 - 0)).toBeGreaterThan(MOTION_JUMP);
  });
  it('插值：移动的像素取近的识别帧，不出现半透明重影', () => {
    const a = f(1, 0.2);
    const b = f(0, 0.4);
    expect([...lerpMask(a, b, 0.25)].map((v) => +v.toFixed(2))).toEqual([1, 0.25]);
    expect([...lerpMask(a, b, 0.75)].map((v) => +v.toFixed(2))).toEqual([0, 0.35]);
  });
  it('线性插值', () => {
    const a = f(0.2, 0.4);
    const b = f(0.4, 0.2);
    expect([...lerpMask(a, b, 0.25)].map((v) => +v.toFixed(2))).toEqual([0.25, 0.35]);
    expect(lerpMask(a, b, 0)).toBe(a);
    expect(lerpMask(a, b, 1)).toBe(b);
  });
});
