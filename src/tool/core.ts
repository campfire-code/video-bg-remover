// 纯函数：模型输入输出处理、蒙版放大与边缘精修、合成，不依赖界面和本机能力。
// 其中 BiRefNet 部分与 tools/hd-product-cutout 相同，轻模型 U²-Net(u2netp) 部分与 tools/bg-remover-batch 相同。

/** BiRefNet lite 导出版的固定输入边长 */
export const MODEL_SIZE = 512;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** RGBA 像素（已缩放到 size×size）转模型输入：除以 255 后按 ImageNet 均值方差标准化，排成 1×3×H×W */
export function toInput(rgba: Uint8ClampedArray, size = MODEL_SIZE): Float32Array {
  const n = size * size;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out[c * n + i] = (rgba[i * 4 + c] / 255 - MEAN[c]) / STD[c];
  }
  return out;
}

/** 模型输出是未经 sigmoid 的 logits，转成 0–1 的主体概率 */
export function sigmoidMask(logits: Float32Array): Float32Array {
  const out = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) out[i] = 1 / (1 + Math.exp(-logits[i]));
  return out;
}

/** 等比缩小到长边不超过 maxSide；小图不放大 */
export function fitWithin(w: number, h: number, maxSide: number) {
  const k = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** 单通道双线性缩放（像素中心对齐） */
export function resizeBilinear<T extends Float32Array | Uint8ClampedArray>(src: T, sw: number, sh: number, dw: number, dh: number): T {
  const out = new (src.constructor as { new (n: number): T })(dw * dh);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = sx - x0;
      const top = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const bot = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = top * (1 - ty) + bot * ty;
    }
  }
  return out;
}

/** 盒式均值滤波（边界按有效像素数取平均），用积分图实现，耗时与半径无关 */
export function boxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return src.slice();
  const W = w + 1;
  const sat = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const s = sat[y1 * W + x1] - sat[y0 * W + x1] - sat[y1 * W + x0] + sat[y0 * W + x0];
      out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** RGBA 转 0–1 灰度，作为引导滤波的引导图 */
export function toGray(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255;
  return out;
}

/**
 * 引导滤波（He et al.）：让放大后的模糊蒙版 p 沿着原图 I 的边缘收紧，
 * 模型只看 512 像素，发丝、细边靠这一步在原图分辨率上补回来。结果限制在 0–1。
 */
export function guidedFilter(guide: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h;
  const mulArr = (a: Float32Array, b: Float32Array) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = a[i] * b[i]; return o; };
  const meanI = boxFilter(guide, w, h, r);
  const meanP = boxFilter(p, w, h, r);
  const corrI = boxFilter(mulArr(guide, guide), w, h, r);
  const corrIP = boxFilter(mulArr(guide, p), w, h, r);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = corrI[i] - meanI[i] * meanI[i];
    const covIP = corrIP[i] - meanI[i] * meanP[i];
    a[i] = covIP / (varI + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }
  const meanA = boxFilter(a, w, h, r);
  const meanB = boxFilter(b, w, h, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.min(1, Math.max(0, meanA[i] * guide[i] + meanB[i]));
  return out;
}

/** 用 smoothstep 收紧蒙版：低于 lo 归 0，高于 hi 归 1，去掉边缘一圈灰雾 */
export function tightenMask(m: Float32Array, lo = 0.08, hi = 0.92): Float32Array {
  const out = new Float32Array(m.length);
  for (let i = 0; i < m.length; i++) {
    const t = Math.min(1, Math.max(0, (m[i] - lo) / (hi - lo)));
    out[i] = t * t * (3 - 2 * t);
  }
  return out;
}

/** 边缘羽化：对蒙版做半径 px 的均值模糊（0 表示不羽化） */
export function featherMask(m: Float32Array, w: number, h: number, px: number): Float32Array {
  if (px <= 0) return m;
  const f = boxFilter(m, w, h, Math.round(px));
  for (let i = 0; i < f.length; i++) f[i] = Math.min(1, Math.max(0, f[i]));
  return f;
}

/** 0–1 蒙版转 0–255 */
export function toAlpha8(m: Float32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(m.length);
  for (let i = 0; i < m.length; i++) out[i] = Math.round(m[i] * 255);
  return out;
}

/** 把蒙版写进 RGBA 的透明度通道（原地修改并返回） */
export function applyAlpha(rgba: Uint8ClampedArray, alpha: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < alpha.length; i++) rgba[i * 4 + 3] = alpha[i];
  return rgba;
}

/**
 * 把带透明度的前景 RGBA 压在纯色背景上，返回不透明 RGBA（原图不改动）。
 * 用于背景不透明的输出，也让测试可以直接核对像素。
 */
export function compositeOnColor(rgba: Uint8ClampedArray, bg: [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(rgba[i + c] * a + bg[c] * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** #RGB / #RRGGBB 校验与补全，不合法返回 null */
export function normalizeColor(s: string): string | null {
  const t = s.trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(t)) return ('#' + [...t.slice(1)].map((c) => c + c).join('')).toUpperCase();
  return null;
}

/** 引导滤波半径随图像大小取值：长边的 1/200，限制在 4–16 像素 */
export const refineRadius = (w: number, h: number) => Math.min(16, Math.max(4, Math.round(Math.max(w, h) / 200)));

// ---------- 轻模型 U²-Net(u2netp)：与 bg-remover-batch 相同的输入处理 ----------

/** u2netp 输入边长 */
export const LIGHT_SIZE = 320;

/** RGBA 像素（已缩放到 320×320）转 u2netp 输入：按整图最大值归一化，再按 ImageNet 均值方差标准化（与 rembg 一致） */
export function toInputLight(rgba: Uint8ClampedArray, size = LIGHT_SIZE): Float32Array {
  const n = size * size;
  let max = 1;
  for (let i = 0; i < n; i++) max = Math.max(max, rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out[c * n + i] = (rgba[i * 4 + c] / max - MEAN[c]) / STD[c];
  }
  return out;
}

/**
 * u2netp 输出已是 0–1 的主体概率，这里只截断到 0–1。
 * 静态图常按每张图的最小最大值拉伸，视频里这样会让相邻帧的蒙版忽强忽弱而闪烁，所以不拉伸。
 */
export function clampMask(pred: Float32Array): Float32Array {
  const out = new Float32Array(pred.length);
  for (let i = 0; i < pred.length; i++) out[i] = Math.min(1, Math.max(0, pred[i]));
  return out;
}

// ---------- 自选图片背景 ----------

/** 图片等比放大铺满 w×h（cover），居中裁切：返回绘制到目标画布的位置和大小 */
export function coverRect(iw: number, ih: number, w: number, h: number) {
  const k = Math.max(w / iw, h / ih);
  const dw = Math.round(iw * k);
  const dh = Math.round(ih * k);
  return { x: Math.round((w - dw) / 2), y: Math.round((h - dh) / 2), w: dw, h: dh };
}

/** 把带透明度的前景压在一张不透明背景图的像素上（两者同尺寸），返回不透明 RGBA */
export function compositeOnImage(rgba: Uint8ClampedArray, bg: Uint8ClampedArray): Uint8ClampedArray {
  if (rgba.length !== bg.length) throw new Error('前景与背景图尺寸不一致');
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(rgba[i + c] * a + bg[i + c] * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}
