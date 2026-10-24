import { describe, expect, it } from 'vitest';
import { bracket, keyIndexes, processFrames, type Frame, type FrameIO } from './process';

describe('识别帧规划', () => {
  it('每 3 帧识别一次，最后一帧一定包含', () => {
    expect(keyIndexes(10, 3)).toEqual([0, 3, 6, 9]);
    expect(keyIndexes(11, 3)).toEqual([0, 3, 6, 9, 10]);
    expect(keyIndexes(1, 3)).toEqual([0]);
    expect(keyIndexes(0, 3)).toEqual([]);
    expect(keyIndexes(4, 1)).toEqual([0, 1, 2, 3]);
    expect(keyIndexes(4, 0)).toEqual([0, 1, 2, 3]);
  });
  it('每一帧夹在哪两个识别帧之间', () => {
    const keys = [0, 3, 6, 7];
    expect(bracket(0, keys)).toEqual({ lo: 0, hi: 3, t: 0 });
    expect(bracket(1, keys)).toEqual({ lo: 0, hi: 3, t: 1 / 3 });
    expect(bracket(3, keys)).toEqual({ lo: 3, hi: 6, t: 0 });
    expect(bracket(7, keys)).toEqual({ lo: 7, hi: 7, t: 0 });
  });
});

/** 假模型：第 i 帧的蒙版是常数 i/100（把帧序号编在像素里），记录识别过的帧 */
function fakeIO(count: number) {
  const log = { inferred: [] as number[], written: [] as { i: number; alpha: number }[], reads: [] as number[] };
  const io: FrameIO = {
    count,
    read: async (i) => { log.reads.push(i); return { rgba: new Uint8ClampedArray(4).fill(i), w: 1, h: 1 }; },
    infer: async (f: Frame) => { log.inferred.push(f.rgba[0]); return new Float32Array([f.rgba[0] / 100]); },
    write: async (i, _f, alpha) => void log.written.push({ i, alpha: alpha[0] }),
  };
  return { io, log };
}

describe('逐帧流程（假推理）', () => {
  it('只在识别帧上推理，其余帧用线性插值', async () => {
    const { io, log } = fakeIO(7);
    const r = await processFrames(io, { step: 3, smooth: 'off' });
    expect(log.inferred).toEqual([0, 3, 6]);
    expect(r.inferences).toBe(3);
    expect(log.written.map((w) => +w.alpha.toFixed(2))).toEqual([0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06]);
    expect(log.written.map((w) => w.i)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it('精修只用在插值得到的帧上，识别帧不重复处理', async () => {
    const { io } = fakeIO(5);
    const refined: number[] = [];
    io.refine = (f, a) => { refined.push(f.rgba[0]); return a; };
    await processFrames(io, { step: 2, smooth: 'off' });
    expect(refined).toEqual([1, 3]);
  });
  it('每帧都识别时没有插值', async () => {
    const { io, log } = fakeIO(4);
    await processFrames(io, { step: 1, smooth: 'off' });
    expect(log.inferred).toEqual([0, 1, 2, 3]);
  });
  it('开启平滑：识别帧的蒙版与上一识别帧混合', async () => {
    const { io, log } = fakeIO(3);
    await processFrames(io, { step: 1, smooth: 'mid' }); // 权重 0.5
    expect(log.written.map((w) => +w.alpha.toFixed(4))).toEqual([0, 0.005, 0.0125]);
  });
  it('每帧最多读一次（识别帧读取后复用）', async () => {
    const { io, log } = fakeIO(8);
    await processFrames(io, { step: 3, smooth: 'low' });
    expect(new Set(log.reads).size).toBe(log.reads.length);
  });
  it('取消后立即停止', async () => {
    const { io, log } = fakeIO(10);
    const ac = new AbortController();
    io.write = async (i) => { log.written.push({ i, alpha: 0 }); if (i === 2) ac.abort(); };
    await expect(processFrames(io, { step: 2, smooth: 'off', signal: ac.signal })).rejects.toThrow('已取消');
    expect(log.written).toHaveLength(3);
  });
  it('进度回调到 100%', async () => {
    const { io } = fakeIO(5);
    const seen: number[] = [];
    await processFrames(io, { step: 2, smooth: 'off', onProgress: (d, t) => seen.push(d / t) });
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen).toHaveLength(5);
  });
  it('0 帧不做任何事', async () => {
    const { io } = fakeIO(0);
    expect(await processFrames(io, { step: 2, smooth: 'off' })).toEqual({ inferences: 0 });
  });
});
