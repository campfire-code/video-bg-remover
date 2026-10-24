import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Frame } from './process';

// 引擎（onnxruntime、画布）依赖浏览器，这里换成假的：每帧 2×2，蒙版全 0.5
const engine = vi.hoisted(() => ({
  infers: 0,
  decodeImage: vi.fn(async () => ({ naturalWidth: 4, naturalHeight: 4 })),
  getSession: vi.fn(async () => ({})),
  makeInfer: vi.fn(() => async (_f: Frame) => { engine.infers++; return new Float32Array(4).fill(0.5); }),
  makeWriter: vi.fn(() => async () => new Uint8Array([1, 2, 3])),
  makeThumb: vi.fn(async () => 'data:image/png;base64,AA'),
  readFrame: vi.fn(async (): Promise<Frame> => ({ rgba: new Uint8ClampedArray(16), w: 2, h: 2 })),
}));
vi.mock('./engine', () => engine);

import tool, { deps } from './index';
import type { InputItem, Params, RunContext } from '../kit/types';

const defaults = (over: Params = {}): Params => ({ ...Object.fromEntries(tool.params.map((f) => [f.key, f.default])), ...over });
const item = (name: string): InputItem => ({ id: name, name, path: '/in/' + name });

function fakeCtx(params: Params, duration = 6) {
  const calls = { ffmpeg: [] as string[][], written: [] as string[], progress: [] as number[] };
  const ctx = {
    params, outputDir: '/out', signal: new AbortController().signal, progress: (r: number) => void calls.progress.push(r),
    readFile: async () => new Uint8Array(), readText: async () => '',
    writeFile: async (p: string) => void calls.written.push(p),
    writeText: async () => {}, mkdir: async () => {},
    join: async (...parts: string[]) => parts.join('/'),
    llm: async () => '', sidecar: async () => '',
    ffmpeg: async (args: string[], onTime?: (s: number) => void) => { calls.ffmpeg.push(args); onTime?.(1); },
    duration: async () => duration,
  } as RunContext;
  return { ctx, calls };
}

const orig = { ...deps };
const removed: string[] = [];
beforeEach(() => {
  engine.infers = 0;
  removed.length = 0;
  Object.assign(deps, orig, { tempDir: async () => '/tmp/job', countFrames: async () => 10, removeDir: async (d: string) => void removed.push(d) });
});

describe('声明', () => {
  it('不出现大模型设置', () => expect(tool.needsLLM).toBeFalsy());
  it('check 只放行视频格式', () => {
    const check = tool.check!;
    expect(check(item('a.MP4'))).toBeNull();
    expect(check(item('a.png'))).toContain('不是支持的视频格式');
  });
  it('参数的显示条件', () => {
    const f = (k: string) => tool.params.find((x) => x.key === k)!;
    expect(f('format').when!(defaults())).toBe(true);
    expect(f('format').when!(defaults({ bg: 'color' }))).toBe(false);
    expect(f('color').when!(defaults({ bg: 'color' }))).toBe(true);
    expect(f('bgImage').when!(defaults({ bg: 'image' }))).toBe(true);
    expect(f('modelFile').when!(defaults({ model: 'hd' }))).toBe(true);
    expect(f('modelFile').when!(defaults())).toBe(false);
  });
  it('默认值：轻模型、前 10 秒、24 帧、每秒识别 12 次', () => {
    const d = defaults();
    expect(d).toMatchObject({ model: 'light', maxSecs: 10, fps: '24', maskFps: '12', smooth: 'mid', bg: 'transparent', format: 'webm' });
  });
  it('耗时说明里有预估示例', () => {
    const help = (tool.params.find((x) => x.key === 'maskFps') as { help: string }).help;
    expect(help).toMatch(/轻模型约 \d+ 秒/);
    expect(help).toContain('高清约');
  });
});

describe('处理流程', () => {
  it('抽帧 → 逐帧写出 → 合成 WebM，并删掉临时目录', async () => {
    const { ctx, calls } = fakeCtx(defaults());
    const r = await tool.run(item('杯子.mp4'), ctx);
    expect(calls.ffmpeg).toHaveLength(2);
    expect(calls.ffmpeg[0]).toContain('-t');
    expect(calls.ffmpeg[0][calls.ffmpeg[0].length - 1]).toBe('/tmp/job/in%05d.jpg');
    const enc = calls.ffmpeg[1].join(' ');
    expect(enc).toContain('libvpx-vp9');
    expect(enc).toContain('-i /in/杯子.mp4');
    expect(calls.written).toHaveLength(10);
    expect(calls.written[0]).toBe('/tmp/job/out00001.png');
    expect(r.outputPath).toBe('/out/杯子-去背景.webm');
    expect(r.summary).toContain('10 帧');
    expect(r.preview).toMatch(/^data:image\/png/);
    expect(removed).toEqual(['/tmp/job']);
    expect(Math.max(...calls.progress)).toBeLessThanOrEqual(1);
  });
  it('每秒识别 12 次、24 帧：10 帧识别第 0、2、4、6、8、9 帧共 6 次', async () => {
    const { ctx } = fakeCtx(defaults());
    await tool.run(item('a.mp4'), ctx);
    expect(engine.infers).toBe(6);
  });
  it('MOV：ProRes；纯色背景：MP4 + JPEG 帧，文件名带「换背景」', async () => {
    const a = fakeCtx(defaults({ format: 'mov' }));
    expect((await tool.run(item('a.mp4'), a.ctx)).outputPath).toBe('/out/a-去背景.mov');
    expect(a.calls.ffmpeg[1].join(' ')).toContain('prores_ks');
    const b = fakeCtx(defaults({ bg: 'color', color: '#fff' }));
    const r = await tool.run(item('a.mp4'), b.ctx);
    expect(r.outputPath).toBe('/out/a-换背景.mp4');
    expect(b.calls.written[0]).toMatch(/\.jpg$/);
    expect(r.summary).toContain('#FFFFFF');
  });
  it('关闭「保留原声」时合成不读原视频', async () => {
    const { ctx, calls } = fakeCtx(defaults({ audio: false }));
    await tool.run(item('a.mp4'), ctx);
    expect(calls.ffmpeg[1].join(' ')).not.toContain('/in/a.mp4');
  });
  it('视频比上限长时，结果里提示只处理了前几秒', async () => {
    const { ctx } = fakeCtx(defaults({ maxSecs: 5 }), 30);
    expect((await tool.run(item('a.mp4'), ctx)).summary).toContain('前 5 秒');
  });
  it('颜色写错、图片背景没选图：在抽帧前就报错', async () => {
    const a = fakeCtx(defaults({ bg: 'color', color: '白色' }));
    await expect(tool.run(item('a.mp4'), a.ctx)).rejects.toThrow('写法不对');
    const b = fakeCtx(defaults({ bg: 'image' }));
    await expect(tool.run(item('a.mp4'), b.ctx)).rejects.toThrow('请先选择背景图片');
    expect(a.calls.ffmpeg).toHaveLength(0);
    expect(b.calls.ffmpeg).toHaveLength(0);
  });
  it('抽不出画面时报错并清理临时目录', async () => {
    deps.countFrames = async () => 0;
    const { ctx } = fakeCtx(defaults());
    await expect(tool.run(item('a.mp4'), ctx)).rejects.toThrow('没有从视频里取到画面');
    expect(removed).toEqual(['/tmp/job']);
  });
  it('合成失败时也会清理临时目录', async () => {
    const { ctx } = fakeCtx(defaults());
    let n = 0;
    ctx.ffmpeg = async () => { if (++n === 2) throw new Error('ffmpeg 处理失败'); };
    await expect(tool.run(item('a.mp4'), ctx)).rejects.toThrow('ffmpeg 处理失败');
    expect(removed).toEqual(['/tmp/job']);
  });
  it('高清模式把本地模型路径交给引擎', async () => {
    const { ctx } = fakeCtx(defaults({ model: 'hd', modelFile: '/m/model.onnx' }));
    await tool.run(item('a.mp4'), ctx);
    expect(engine.getSession.mock.calls.at(-1)!.slice(0, 2)).toEqual(['hd', '/m/model.onnx']);
  });
});
