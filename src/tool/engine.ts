// 推理与画布：用 onnxruntime-web（WASM，单线程）跑模型，读帧、写帧。依赖浏览器环境，不做单元测试。
import * as ort from 'onnxruntime-web/wasm';
import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, mkdir, readFile, writeFile } from '@tauri-apps/plugin-fs';
import { httpFetch } from '../kit/platform';
import { applyAlpha, compositeOnColor, compositeOnImage, coverRect, hexToRgb, toAlpha8 } from './core';
import { MODEL, loadModelBytes, sha256Hex, type ModelDeps } from './model';
import type { ModelKey, OutKind } from './plan';
import { INPUT_SIZE, frameMask } from './pipeline';
import type { Frame } from './process';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import mjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';

// 推理引擎文件随应用打包，离线可用
ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
ort.env.wasm.numThreads = 1;

const deps: ModelDeps = {
  fetch: (url, init) => httpFetch(url, { method: 'GET', signal: init.signal }) as unknown as ReturnType<ModelDeps['fetch']>,
  read: async (p) => ((await exists(p)) ? readFile(p) : null),
  write: async (p, d) => {
    await mkdir(p.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    await writeFile(p, d);
  },
  sha256: sha256Hex,
};

const sessions: Partial<Record<string, Promise<ort.InferenceSession>>> = {};
/** light：随应用打包的 u2netp；hd：BiRefNet lite 512，首次使用下载（localPath 可指定已下载的文件） */
export function getSession(kind: ModelKey, localPath: string, onDownload: (r: number) => void, signal?: AbortSignal) {
  const key = kind === 'light' ? 'light' : `hd:${localPath}`;
  return (sessions[key] ??= (async () => {
    try {
      if (kind === 'light') {
        return await ort.InferenceSession.create('/models/u2netp.onnx', { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      }
      const cache = await join(await appDataDir(), 'models', MODEL.file);
      const bytes = await loadModelBytes(deps, cache, { localPath: localPath || undefined, onDownload, signal });
      return await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    } catch (e) {
      delete sessions[key];
      if (kind === 'hd' && e instanceof Error && /下载|模型文件|校验|已取消/.test(e.message)) throw e;
      throw new Error(`抠图模型加载失败：${e instanceof Error ? e.message : e}`);
    }
  })());
}

const canvas = (w: number, h: number) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const toBlob = (c: HTMLCanvasElement, mime: string, q?: number) =>
  new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('帧编码失败，画面可能太大'))), mime, q));

export async function decodeImage(bytes: Uint8Array): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    throw new Error('无法识别这张图片，可能已损坏或格式不受支持');
  } finally {
    URL.revokeObjectURL(url);
  }
  return img;
}

export async function readFrame(path: string): Promise<Frame> {
  const img = await decodeImage(await readFile(path));
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const c = canvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  return { rgba: g.getImageData(0, 0, w, h).data, w, h };
}

/** 一帧的蒙版：缩到模型尺寸 → 推理 → 放大回帧尺寸 */
export function makeInfer(kind: ModelKey, session: ort.InferenceSession, refine: boolean) {
  const size = INPUT_SIZE[kind];
  const small = canvas(size, size);
  const sg = small.getContext('2d', { willReadFrequently: true })!;
  const src = canvas(1, 1);
  return async (f: Frame): Promise<Float32Array> => {
    src.width = f.w;
    src.height = f.h;
    const g = src.getContext('2d')!;
    g.putImageData(new ImageData(new Uint8ClampedArray(f.rgba), f.w, f.h), 0, 0);
    sg.imageSmoothingQuality = 'high';
    sg.drawImage(src, 0, 0, size, size);
    const modelRgba = sg.getImageData(0, 0, size, size).data;
    return frameMask(kind, modelRgba, f.rgba, f.w, f.h, async (input) => {
      const r = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]) });
      return r[session.outputNames[0]].data as Float32Array;
    }, refine);
  };
}

export type Background = { type: 'transparent' } | { type: 'color'; hex: string } | { type: 'image'; img: HTMLImageElement };

/** 输出帧编码器：透明 → PNG（带透明度）；纯色 / 图片背景 → 合成后存 JPEG */
export function makeWriter(bg: Background, kind: OutKind) {
  let bgPixels: Uint8ClampedArray | null = null;
  let bgKey = '';
  const out = canvas(1, 1);
  return async (f: Frame, alpha: Float32Array): Promise<Uint8Array> => {
    let px: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(f.rgba);
    if (bg.type === 'transparent') applyAlpha(px, toAlpha8(alpha));
    else {
      applyAlpha(px, toAlpha8(alpha));
      if (bg.type === 'color') px = compositeOnColor(px, hexToRgb(bg.hex)) as typeof px;
      else {
        const key = `${f.w}x${f.h}`;
        if (bgKey !== key) {
          const c = canvas(f.w, f.h);
          const g = c.getContext('2d', { willReadFrequently: true })!;
          const r = coverRect(bg.img.naturalWidth, bg.img.naturalHeight, f.w, f.h);
          g.imageSmoothingQuality = 'high';
          g.drawImage(bg.img, r.x, r.y, r.w, r.h);
          bgPixels = g.getImageData(0, 0, f.w, f.h).data;
          bgKey = key;
        }
        px = compositeOnImage(px, bgPixels!) as typeof px;
      }
    }
    out.width = f.w;
    out.height = f.h;
    out.getContext('2d')!.putImageData(new ImageData(px, f.w, f.h), 0, 0);
    const blob = kind === 'mp4' ? await toBlob(out, 'image/jpeg', 0.92) : await toBlob(out, 'image/png');
    return new Uint8Array(await blob.arrayBuffer());
  };
}

/** 结果预览：把输出的第一帧缩成小图（data 地址），在列表里显示 */
export async function makeThumb(bytes: Uint8Array, size = 160): Promise<string> {
  const img = await decodeImage(bytes);
  const k = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight));
  const c = canvas(Math.max(1, Math.round(img.naturalWidth * k)), Math.max(1, Math.round(img.naturalHeight * k)));
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
