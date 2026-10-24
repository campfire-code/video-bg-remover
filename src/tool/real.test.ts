// 真机验证：默认跳过。E05_REAL=1 pnpm exec vitest run src/tool/real.test.ts
// 1) 用本机 ffmpeg 抽帧、合成，读回像素格式确认透明通道真的保留（WebM / ProRes / MP4）；
// 2) 再加 E05_MODEL=1：用真实的 u2netp 在 Node 里跑完整流水线（耗时与蒙版质量）；E05_HD=/path/model.onnx 同理跑高清模型。
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeArgs, extractArgs, frameInName, frameOutName, type OutKind } from './plan';
import { frameMask, INPUT_SIZE, refineInterpolated } from './pipeline';
import { processFrames } from './process';
import { applyAlpha, toAlpha8 } from './core';

const bin = (() => {
  const dir = 'src-tauri/binaries';
  const f = existsSync(dir) ? readdirSync(dir).find((n) => n.startsWith('ffmpeg-') && !n.endsWith('.txt')) : undefined;
  return f ? join(dir, f) : 'ffmpeg';
})();
const ff = (args: string[]) => execFileSync(bin, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe', maxBuffer: 1 << 28 });
const probe = (path: string, decoder?: string) =>
  spawnSync(bin, ['-hide_banner', ...(decoder ? ['-c:v', decoder] : []), '-i', path], { encoding: 'utf8' }).stderr;
const sample = 'samples/示例-商品视频.mp4';
const lim = { maxSecs: 4, fps: 12, maxSide: 480 };

describe.runIf(process.env.E05_REAL === '1')('真机：ffmpeg 抽帧与合成', () => {
  const dir = process.env.E05_KEEP ? join(process.env.E05_KEEP, 'ffmpeg') : join(tmpdir(), `e05-${process.pid}`);
  let frames = 0;
  beforeAll(() => {
    mkdirSync(dir, { recursive: true });
    ff(extractArgs(sample, dir, lim));
    frames = readdirSync(dir).filter((n) => /^in\d{5}\.jpg$/.test(n)).length;
  });

  it('抽出 4 秒 × 12 帧 = 48 帧，宽高为偶数且长边不超过 480', () => {
    expect(frames).toBe(48);
    const m = /Video: mjpeg.*?, (\d+)x(\d+)/.exec(probe(join(dir, frameInName(0))))!;
    expect(+m[1] % 2 + +m[2] % 2).toBe(0);
    expect(Math.max(+m[1], +m[2])).toBeLessThanOrEqual(480);
  });

  // 用椭圆形透明度把抽出的帧转成带透明度的 PNG，模拟抠图结果
  const makeOut = (kind: OutKind) => {
    for (let i = 0; i < frames; i++) {
      const vf = kind === 'mp4' ? 'null' : "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot((X-W/2)/(W/3),(Y-H/2)/(H/3)),1),255,0)'";
      ff(['-i', join(dir, frameInName(i)), '-vf', vf, '-frames:v', '1', join(dir, frameOutName(i, kind))]);
    }
  };
  const enc = (kind: OutKind, audio: boolean) => {
    makeOut(kind);
    const out = join(dir, `result.${kind}`);
    ff(encodeArgs({ framesDir: dir, kind, fps: lim.fps, frames, audioFrom: audio ? sample : undefined, out }));
    return out;
  };

  it('WebM：VP9 解码后仍是 yuva420p（透明度保留），带 opus 音轨，时长 4 秒', () => {
    const info = probe(enc('webm', true), 'libvpx-vp9');
    expect(info).toMatch(/Video: vp9.*yuva420p/);
    expect(info).toMatch(/Audio: opus/);
    expect(info).toMatch(/Duration: 00:00:04/);
  });
  it('MOV：ProRes 4444 带 alpha（yuva444p10le/12le）', () => {
    const info = probe(enc('mov', false));
    expect(info).toMatch(/Video: prores.*4444.*yuva444p1[02]le/);
  });
  it('MP4：H.264 yuv420p，带 aac 音轨', () => {
    const info = probe(enc('mp4', true));
    expect(info).toMatch(/Video: h264.*yuv420p/);
    expect(info).toMatch(/Audio: aac/);
  });
  it('原视频没有音轨时，开着「保留原声」也不报错', () => {
    const silent = join(dir, 'silent.mp4');
    ff(['-i', sample, '-an', '-c:v', 'copy', silent]);
    makeOut('webm');
    ff(encodeArgs({ framesDir: dir, kind: 'webm', fps: lim.fps, frames, audioFrom: silent, out: join(dir, 'silent.webm') }));
    expect(statSync(join(dir, 'silent.webm')).size).toBeGreaterThan(0);
  });
});

/** 读一帧的 RGBA 像素 */
const rgba = (path: string, w: number, h: number) => new Uint8ClampedArray(ff(['-i', path, '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']));

async function realModel(kind: 'light' | 'hd', file: string) {
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.numThreads = 1;
  const s = await ort.InferenceSession.create(readFileSync(file), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const size = INPUT_SIZE[kind];
  return async (path: string, w: number, h: number) => {
    const t0 = performance.now();
    const m = await frameMask(kind, rgba(path, size, size), rgba(path, w, h), w, h, async (input) => {
      const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]) });
      return r[s.outputNames[0]].data as Float32Array;
    }, true);
    return { mask: m, ms: performance.now() - t0 };
  };
}

describe.runIf(process.env.E05_REAL === '1' && (process.env.E05_MODEL === '1' || process.env.E05_HD))('真机：真实模型逐帧（Node WASM 单线程）', () => {
  const dir = process.env.E05_KEEP ? join(process.env.E05_KEEP, 'model') : join(tmpdir(), `e05m-${process.pid}`);
  let n = 0;
  beforeAll(() => {
    mkdirSync(dir, { recursive: true });
    ff(extractArgs(sample, dir, { maxSecs: 4, fps: 8, maxSide: 540 }));
    n = readdirSync(dir).filter((x) => /^in\d{5}\.jpg$/.test(x)).length;
  });
  const w = 304;
  const h = 540;
  const cases: ['light' | 'hd', string][] = [];
  if (process.env.E05_MODEL === '1') cases.push(['light', 'public/models/u2netp.onnx']);
  if (process.env.E05_HD) cases.push(['hd', process.env.E05_HD]);

  for (const [kind, file] of cases) {
    it(`${kind}：32 帧每 3 帧识别一次，输出 PNG 序列，并报告耗时与主体占比`, async () => {
      const run = await realModel(kind, file);
      const t0 = performance.now();
      const per: number[] = [];
      const ratios: number[] = [];
      const outDir = join(dir, kind);
      mkdirSync(outDir, { recursive: true });
      await processFrames({
        count: n,
        read: async (i) => ({ rgba: rgba(join(dir, frameInName(i)), w, h), w, h }),
        infer: async (f) => {
          const tmp = join(dir, 'tmp.png');
          // 把当前帧的像素写成 PNG 再交给 ffmpeg 缩放，与浏览器端「帧 → 模型尺寸」的路径一致
          writeFileSync(join(dir, 'raw.rgba'), f.rgba);
          ff(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', join(dir, 'raw.rgba'), '-frames:v', '1', tmp]);
          const r = await run(tmp, w, h);
          per.push(r.ms);
          return r.mask;
        },
        refine: (f, a) => refineInterpolated(f.rgba, a, f.w, f.h),
        write: async (i, f, alpha) => {
          ratios.push(alpha.reduce((a, b) => a + b, 0) / alpha.length);
          const px = new Uint8ClampedArray(f.rgba);
          applyAlpha(px, toAlpha8(alpha));
          writeFileSync(join(outDir, 'raw.rgba'), px);
          ff(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', join(outDir, 'raw.rgba'), '-frames:v', '1', join(outDir, frameOutName(i, 'webm'))]);
        },
      }, { step: 3, smooth: 'mid' });
      const total = performance.now() - t0;
      console.log(`[${kind}] ${n} 帧，识别 ${per.length} 次，平均每次 ${(per.reduce((a, b) => a + b, 0) / per.length).toFixed(0)} ms（含放大与精修），总用时 ${(total / 1000).toFixed(1)} 秒；主体占比 ${Math.min(...ratios).toFixed(3)}–${Math.max(...ratios).toFixed(3)}；输出 ${outDir}`);
      expect(per.length).toBe(Math.ceil(n / 3) + (n % 3 === 1 ? 0 : 1));
      // 示例里主体约占画面 15–25%
      for (const r of ratios) expect(r).toBeGreaterThan(0.05);
    }, 900_000);
  }
});
