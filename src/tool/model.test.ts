import { describe, expect, it } from 'vitest';
import { MODEL, downloadBytes, loadModelBytes, sha256Hex, type FetchedResponse, type ModelDeps } from './model';

const bytesOf = (n: number, v = 7) => new Uint8Array(n).fill(v);
const respond = (data: Uint8Array, chunk: number, over: Partial<FetchedResponse> = {}): FetchedResponse => ({
  ok: true, status: 200,
  headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(data.length) : null) },
  body: new ReadableStream({
    start(c) { for (let i = 0; i < data.length; i += chunk) c.enqueue(data.slice(i, i + chunk)); c.close(); },
  }),
  ...over,
});

describe('下载', () => {
  it('分块下载并回报进度，结果与原数据一致', async () => {
    const data = bytesOf(1000);
    const seen: number[] = [];
    const out = await downloadBytes(async () => respond(data, 300), 'u', 1000, (r) => seen.push(r));
    expect(out).toEqual(data);
    expect(seen[0]).toBeCloseTo(0.3);
    expect(seen.at(-1)).toBe(1);
  });
  it('长度不对 → 报下载不完整', async () => {
    await expect(downloadBytes(async () => respond(bytesOf(900), 300), 'u', 1000, () => {})).rejects.toThrow('下载不完整');
  });
  it('服务器报错 → 带状态码的提示', async () => {
    await expect(downloadBytes(async () => respond(bytesOf(1), 1, { ok: false, status: 404 }), 'u', 1, () => {})).rejects.toThrow('404');
  });
  it('连不上 → 提示换网络或用本地文件', async () => {
    await expect(downloadBytes(async () => { throw new Error('dns'); }, 'u', 1, () => {})).rejects.toThrow('已下载好的模型文件');
  });
  it('已取消 → 报「已取消」', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(downloadBytes(async () => { throw new Error('x'); }, 'u', 1, () => {}, ac.signal)).rejects.toThrow('已取消');
  });
});

/** 用一个很小的假文件冒充模型：换一份 MODEL 常量会改源码，所以这里用 sha256 注入 */
function fakeDeps(opts: { cache?: Uint8Array | null; remote?: Uint8Array; hashOk?: (d: Uint8Array) => boolean }) {
  const log = { fetched: 0, written: null as null | Uint8Array, readPaths: [] as string[] };
  const deps: ModelDeps = {
    fetch: async () => { log.fetched++; return respond(opts.remote ?? new Uint8Array(0), 1 << 20); },
    read: async (p) => { log.readPaths.push(p); return p === '/cache/m.onnx' ? opts.cache ?? null : p === '/local/m.onnx' ? opts.cache ?? null : null; },
    write: async (_p, d) => { log.written = d; },
    sha256: async (d) => ((opts.hashOk ?? (() => true))(d) ? MODEL.sha256 : 'bad'),
  };
  return { deps, log };
}
const fullSize = () => new Uint8Array(MODEL.size);

describe('取得模型', () => {
  it('缓存存在且校验通过 → 不联网', async () => {
    const { deps, log } = fakeDeps({ cache: fullSize() });
    await loadModelBytes(deps, '/cache/m.onnx');
    expect(log.fetched).toBe(0);
  });
  it('缓存损坏（校验失败）→ 重新下载并覆盖缓存', async () => {
    let first = true;
    const { deps, log } = fakeDeps({ cache: fullSize(), remote: fullSize(), hashOk: () => (first ? ((first = false), false) : true) });
    await loadModelBytes(deps, '/cache/m.onnx');
    expect(log.fetched).toBe(1);
    expect(log.written?.length).toBe(MODEL.size);
  });
  it('没有缓存 → 下载、校验、写入，并回报下载进度', async () => {
    const { deps, log } = fakeDeps({ cache: null, remote: fullSize() });
    const seen: number[] = [];
    await loadModelBytes(deps, '/cache/m.onnx', { onDownload: (r) => seen.push(r) });
    expect(log.written?.length).toBe(MODEL.size);
    expect(seen.at(-1)).toBe(1);
  });
  it('下载完校验不通过 → 报错且不写缓存', async () => {
    const { deps, log } = fakeDeps({ cache: null, remote: fullSize(), hashOk: () => false });
    await expect(loadModelBytes(deps, '/cache/m.onnx')).rejects.toThrow('校验不通过');
    expect(log.written).toBeNull();
  });
  it('指定本地模型：不联网不写缓存；校验失败给明确提示；文件不存在也给提示', async () => {
    const ok = fakeDeps({ cache: fullSize() });
    await loadModelBytes(ok.deps, '/cache/m.onnx', { localPath: '/local/m.onnx' });
    expect(ok.log.fetched).toBe(0);
    expect(ok.log.written).toBeNull();
    const bad = fakeDeps({ cache: fullSize(), hashOk: () => false });
    await expect(loadModelBytes(bad.deps, '/cache/m.onnx', { localPath: '/local/m.onnx' })).rejects.toThrow('不是本工具需要的');
    await expect(loadModelBytes(ok.deps, '/cache/m.onnx', { localPath: '/nope.onnx' })).rejects.toThrow('找不到');
  });
  it('SHA-256 实现：空串的已知摘要', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
