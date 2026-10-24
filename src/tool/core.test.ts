import { describe, expect, it } from 'vitest';
import {
  applyAlpha, boxFilter, compositeOnColor, featherMask, fitWithin, guidedFilter, hexToRgb, normalizeColor,
  refineRadius, resizeBilinear, sigmoidMask, tightenMask, toAlpha8, toGray, toInput,
} from './core';

describe('模型输入输出', () => {
  it('除以 255 后标准化，排成通道优先', () => {
    const x = toInput(new Uint8ClampedArray([255, 51, 0, 255]), 1);
    expect(x[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(x[1]).toBeCloseTo((0.2 - 0.456) / 0.224, 5);
    expect(x[2]).toBeCloseTo((0 - 0.406) / 0.225, 5);
  });
  it('sigmoid：0 → 0.5，大正数 → 1，大负数 → 0', () => {
    const m = sigmoidMask(new Float32Array([0, 20, -20]));
    expect(m[0]).toBeCloseTo(0.5, 6);
    expect(m[1]).toBeCloseTo(1, 6);
    expect(m[2]).toBeCloseTo(0, 6);
  });
  it('0–1 蒙版转 0–255', () => expect([...toAlpha8(new Float32Array([0, 0.5, 1]))]).toEqual([0, 128, 255]));
});

describe('缩放', () => {
  it('长边限制，小图不放大', () => {
    expect(fitWithin(4000, 3000, 2048)).toEqual({ w: 2048, h: 1536 });
    expect(fitWithin(800, 600, 2048)).toEqual({ w: 800, h: 600 });
  });
  it('双线性放大 2×2 到 4×4：四角保持，中间渐变', () => {
    const o = resizeBilinear(new Float32Array([0, 1, 0, 1]), 2, 2, 4, 4);
    expect(o[0]).toBeCloseTo(0, 5);
    expect(o[3]).toBeCloseTo(1, 5);
    expect(o[1]).toBeCloseTo(0.25, 5);
    expect(o[2]).toBeCloseTo(0.75, 5);
    expect(o[12]).toBeCloseTo(o[0], 5);
  });
  it('同尺寸缩放不改变数据，Uint8 类型保持', () => {
    const o = resizeBilinear(new Uint8ClampedArray([0, 100, 200, 255]), 2, 2, 2, 2);
    expect(o).toBeInstanceOf(Uint8ClampedArray);
    expect([...o]).toEqual([0, 100, 200, 255]);
  });
});

describe('边缘精修', () => {
  it('盒式滤波：常数图不变，单点能量守恒（内部）', () => {
    expect([...boxFilter(new Float32Array(9).fill(0.4), 3, 3, 1)].every((v) => Math.abs(v - 0.4) < 1e-6)).toBe(true);
    const a = new Float32Array(25); a[12] = 9;
    const b = boxFilter(a, 5, 5, 1);
    expect(b[12]).toBeCloseTo(1, 5);
    expect(b[6]).toBeCloseTo(1, 5);
    expect(b[0]).toBe(0);
  });
  it('引导滤波：蒙版边缘贴合引导图的真实边缘', () => {
    // 引导图：左 10 列黑、右 10 列白，边缘在 x=10；蒙版故意把边缘放偏到 x=12 并模糊
    const w = 20, h = 8;
    const guide = new Float32Array(w * h), p = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      guide[y * w + x] = x >= 10 ? 1 : 0;
      p[y * w + x] = Math.min(1, Math.max(0, (x - 10) / 4));
    }
    const q = guidedFilter(guide, p, w, h, 3, 1e-4);
    const at = (x: number) => q[3 * w + x];
    // 原蒙版跨过引导图边缘（x=9→10）只上升 0.25，精修后在这条边上的落差变大
    expect(at(10) - at(9)).toBeGreaterThan(0.3);
    expect(at(18)).toBeGreaterThan(0.95);
    expect(at(2)).toBeLessThan(0.05);
  });
  it('引导滤波结果限制在 0–1', () => {
    const g = new Float32Array(16).map((_, i) => i / 15);
    const q = guidedFilter(g, new Float32Array(16).map((_, i) => (i % 2 ? 1 : 0)), 4, 4, 1, 1e-6);
    expect([...q].every((v) => v >= 0 && v <= 1)).toBe(true);
  });
  it('收紧：低于 0.08 归零，高于 0.92 归一，中点不变', () => {
    const t = tightenMask(new Float32Array([0.05, 0.5, 0.95]));
    expect(t[0]).toBe(0);
    expect(t[1]).toBeCloseTo(0.5, 5);
    expect(t[2]).toBe(1);
  });
  it('羽化 0 不改动，羽化 1 让阶跃边缘变柔', () => {
    const m = new Float32Array([0, 0, 1, 1]);
    expect(featherMask(m, 4, 1, 0)).toBe(m);
    const f = featherMask(m, 4, 1, 1);
    expect(f[1]).toBeCloseTo(1 / 3, 5);
    expect(f[2]).toBeCloseTo(2 / 3, 5);
  });
  it('灰度与引导半径', () => {
    expect(toGray(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1)[0]).toBeCloseTo(1, 5);
    expect(refineRadius(512, 512)).toBe(4);
    expect(refineRadius(2048, 1536)).toBe(10);
    expect(refineRadius(8000, 8000)).toBe(16);
  });
});

describe('合成', () => {
  it('蒙版写进透明度通道', () => {
    const px = applyAlpha(new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]), new Uint8ClampedArray([0, 128]));
    expect([px[3], px[7]]).toEqual([0, 128]);
    expect([px[0], px[4]]).toEqual([10, 40]);
  });
  it('压在白底上：全透明变白，半透明按比例混合，不透明保持', () => {
    const out = compositeOnColor(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 128, 200, 100, 0, 255]), [255, 255, 255]);
    expect([...out.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    expect(out[4]).toBe(127);
    expect(out[7]).toBe(255);
    expect([...out.slice(8, 12)]).toEqual([200, 100, 0, 255]);
  });
  it('颜色代码转 RGB', () => expect(hexToRgb('#F5F5F5')).toEqual([245, 245, 245]));
});

describe('其他', () => {
  it('颜色', () => { expect(normalizeColor('#f5f5f5')).toBe('#F5F5F5'); expect(normalizeColor('#abc')).toBe('#AABBCC'); expect(normalizeColor('白色')).toBeNull(); });
});
