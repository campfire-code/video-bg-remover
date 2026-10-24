import { describe, expect, it } from 'vitest';
import { LIGHT_SIZE, MODEL_SIZE, clampMask, coverRect, compositeOnImage, toInputLight } from './core';
import { frameMask, refineInterpolated, type Infer } from './pipeline';

const gray = (w: number, h: number, v = 128) => new Uint8ClampedArray(w * h * 4).fill(v);

/** 假模型：中心圆内给 hi、圆外给 lo */
const fake = (n: number, hi: number, lo: number): { infer: Infer; seen: () => number } => {
  let len = 0;
  return {
    seen: () => len,
    infer: async (input) => {
      len = input.length;
      const out = new Float32Array(n * n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = Math.hypot(x - n / 2, y - n / 2) < n / 4 ? hi : lo;
      return out;
    },
  };
};

describe('单帧蒙版（假模型）', () => {
  it('轻模型：输入 1×3×320×320，输出直接当概率，放大到帧尺寸', async () => {
    const m = fake(LIGHT_SIZE, 1, 0);
    const out = await frameMask('light', gray(LIGHT_SIZE, LIGHT_SIZE), gray(64, 48), 64, 48, m.infer, false);
    expect(m.seen()).toBe(3 * LIGHT_SIZE * LIGHT_SIZE);
    expect(out.length).toBe(64 * 48);
    expect(out[24 * 64 + 32]).toBeCloseTo(1);
    expect(out[0]).toBeCloseTo(0);
  });
  it('高清模型：输入 512×512，输出是 logits，要过 sigmoid', async () => {
    const m = fake(MODEL_SIZE, 12, -12);
    const out = await frameMask('hd', gray(MODEL_SIZE, MODEL_SIZE), gray(40, 40), 40, 40, m.infer, false);
    expect(m.seen()).toBe(3 * MODEL_SIZE * MODEL_SIZE);
    expect(out[20 * 40 + 20]).toBeGreaterThan(0.99);
    expect(out[0]).toBeLessThan(0.01);
  });
  it('开启边缘精修后结果仍在 0–1', async () => {
    const m = fake(LIGHT_SIZE, 1, 0);
    const out = await frameMask('light', gray(LIGHT_SIZE, LIGHT_SIZE), gray(64, 64), 64, 64, m.infer, true);
    for (const v of out) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
  });
  it('模型输出大小不对时报错', async () => {
    await expect(frameMask('light', gray(LIGHT_SIZE, LIGHT_SIZE), gray(8, 8), 8, 8, async () => new Float32Array(10), false)).rejects.toThrow('模型输出大小不对');
  });
});

describe('轻模型输入输出', () => {
  it('输入：按整图最大值归一化后标准化', () => {
    const px = new Uint8ClampedArray(4 * 4).fill(0);
    px.set([200, 100, 50, 255], 0);
    const v = toInputLight(px, 2);
    expect(v[0]).toBeCloseTo((200 / 200 - 0.485) / 0.229);
    expect(v[4]).toBeCloseTo((100 / 200 - 0.456) / 0.224);
  });
  it('输出只截断到 0–1，不按每帧最小最大值拉伸（避免视频闪烁）', () => {
    expect([...clampMask(new Float32Array([-0.2, 0.3, 0.6, 1.4]))].map((v) => +v.toFixed(2))).toEqual([0, 0.3, 0.6, 1]);
  });
});

describe('图片背景', () => {
  it('cover：横图铺满竖画面，居中裁切', () => expect(coverRect(1600, 900, 540, 960)).toEqual({ x: -583, y: 0, w: 1707, h: 960 }));
  it('cover：同比例不裁', () => expect(coverRect(100, 200, 50, 100)).toEqual({ x: 0, y: 0, w: 50, h: 100 }));
  it('合成：透明处显示背景，不透明处保持前景，半透明按比例混合', () => {
    const fg = new Uint8ClampedArray([255, 0, 0, 0, /**/ 0, 255, 0, 255, /**/ 0, 0, 255, 128]);
    const bg = new Uint8ClampedArray([10, 20, 30, 255, /**/ 10, 20, 30, 255, /**/ 10, 20, 30, 255]);
    const r = compositeOnImage(fg, bg);
    expect([...r.slice(0, 8)]).toEqual([10, 20, 30, 255, 0, 255, 0, 255]);
    expect([...r.slice(8)]).toEqual([5, 10, 143, 255]);
    expect(() => compositeOnImage(new Uint8ClampedArray(4), new Uint8ClampedArray(8))).toThrow('尺寸不一致');
  });
});

describe('插值蒙版精修', () => {
  it('重影被拉回到画面里真实的边缘：左半亮、右半暗的画面，蒙版边缘错开 3 像素后精修回到边界上', () => {
    const w = 64, h = 16;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.fill(x < 32 ? 230 : 20, (y * w + x) * 4, (y * w + x) * 4 + 3);
    const mask = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = x < 35 ? 1 : 0;
    const r = refineInterpolated(rgba, mask, w, h);
    expect(r[8 * w + 20]).toBeGreaterThan(0.95);
    expect(r[8 * w + 50]).toBeLessThan(0.05);
    expect(r[8 * w + 33]).toBeLessThan(mask[8 * w + 33]);
    for (const v of r) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
  });
});
