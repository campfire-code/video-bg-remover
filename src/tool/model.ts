// 模型文件管理：首次使用时下载到应用数据目录，校验 SHA-256 后缓存；网络、文件读写都通过参数传入，便于不联网测试。

/**
 * 模型：BiRefNet_lite 的 512×512 ONNX 导出版（社区导出 studioludens/birefnet-lite-512，MIT；权重来自 ZhengPeng7/BiRefNet_lite，MIT）。
 * 官方 1024×1024 的 ONNX 在浏览器内核的 WASM 里会因内存不足无法推理，所以用 512 版。
 * 下载地址固定到某个提交，SHA-256 与 Hugging Face 页面显示的文件指纹一致。
 */
export const MODEL = {
  file: 'birefnet-lite-512.onnx',
  url: 'https://huggingface.co/studioludens/birefnet-lite-512/resolve/962e67969ec6acec9c19fab76acee4f5e22e990c/onnx/model.onnx',
  sha256: '1cb0fb360dadd15af77c639085d77a9df67db0c64315560c3de005f676345ac2',
  size: 191877254,
} as const;

export interface FetchedResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export interface ModelDeps {
  fetch(url: string, init: { signal?: AbortSignal }): Promise<FetchedResponse>;
  /** 读文件，不存在返回 null */
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  sha256(data: Uint8Array): Promise<string>;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 流式下载并回报进度（0–1）；长度不对或连接中断都抛出带原因的错误 */
export async function downloadBytes(
  fetchFn: ModelDeps['fetch'], url: string, expectedSize: number, onProgress: (r: number) => void, signal?: AbortSignal,
): Promise<Uint8Array> {
  let res: FetchedResponse;
  try {
    res = await fetchFn(url, { signal });
  } catch (e) {
    if (signal?.aborted) throw new Error('已取消');
    throw new Error(`连不上模型下载地址（${e instanceof Error ? e.message : e}）。可以换个网络重试，或在设置里指定已下载好的模型文件`);
  }
  if (!res.ok || !res.body) throw new Error(`模型下载失败（服务器返回 ${res.status}）`);
  const total = Number(res.headers.get('content-length')) || expectedSize;
  const buf = new Uint8Array(Math.max(total, expectedSize));
  let got = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > buf.length) throw new Error('下载内容比预期的大，已中止');
      buf.set(value, got);
      got += value.length;
      onProgress(Math.min(1, got / total));
    }
  } catch (e) {
    if (signal?.aborted) throw new Error('已取消');
    throw new Error(`下载中断：${e instanceof Error ? e.message : e}`);
  }
  if (got !== expectedSize) throw new Error(`下载不完整（收到 ${got} 字节，应为 ${expectedSize}）`);
  return buf.subarray(0, got);
}

/**
 * 取得模型字节：
 * 1. 指定了本地模型文件 → 读取并校验，不联网；
 * 2. 缓存路径上有文件且校验通过 → 直接用；
 * 3. 否则下载 → 校验 → 写入缓存。
 * onDownload 只在真正下载时回调。
 */
export async function loadModelBytes(
  deps: ModelDeps, cachePath: string, opt: { localPath?: string; onDownload?: (r: number) => void; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  if (opt.localPath) {
    const data = await deps.read(opt.localPath);
    if (!data) throw new Error(`找不到指定的模型文件：${opt.localPath}`);
    if ((await deps.sha256(data)) !== MODEL.sha256) throw new Error('指定的模型文件校验不通过，不是本工具需要的 birefnet-lite-512 模型');
    return data;
  }
  const cached = await deps.read(cachePath);
  if (cached && cached.length === MODEL.size && (await deps.sha256(cached)) === MODEL.sha256) return cached;
  const data = await downloadBytes(deps.fetch, MODEL.url, MODEL.size, opt.onDownload ?? (() => {}), opt.signal);
  if ((await deps.sha256(data)) !== MODEL.sha256) throw new Error('模型下载后校验不通过（文件可能被篡改或下载出错），请重试');
  await deps.write(cachePath, data);
  return data;
}
