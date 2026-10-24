// 界面：空状态（视频逐帧抠图示意）与单条结果（帧时间轴：哪些帧识别、哪些帧插值）
import { Clapperboard, Gauge, Layers, ScanLine } from 'lucide-react';
import type { InputItem, ItemResult } from '../kit/types';
import { fileSrc } from '../kit/platform';
import './tool.css';

/** 示意用的一条胶片：8 格，商品从左往右移动 */
function Strip({ keep }: { keep: boolean }) {
  return (
    <svg viewBox="0 0 320 64" className={`vb-strip${keep ? ' keep' : ''}`} aria-hidden="true">
      <rect width="320" height="64" rx="6" fill="#16181D" />
      {Array.from({ length: 8 }, (_, i) => (
        <g key={i} transform={`translate(${6 + i * 39} 8)`}>
          <rect width="35" height="48" rx="3" fill={keep ? 'url(#vb-chk)' : '#A98A66'} />
          {!keep && <rect width="35" height="48" rx="3" fill="none" stroke="#7B6248" strokeWidth="6" strokeDasharray="4 5" opacity=".45" />}
          <rect x={7 + i * 1.6} y="14" width="14" height="26" rx="4" fill="#E3566F" />
          <circle cx={14 + i * 1.6} cy="11" r="5" fill="#F2B134" />
        </g>
      ))}
    </svg>
  );
}

export function Empty({ hover }: { hover: boolean }) {
  return (
    <div className={`vb-empty${hover ? ' hover' : ''}`}>
      <svg width="0" height="0" aria-hidden="true"><defs><pattern id="vb-chk" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#F3F4F6" /><rect width="4" height="4" fill="#CBD0D8" /><rect x="4" y="4" width="4" height="4" fill="#CBD0D8" /></pattern></defs></svg>
      <div className="vb-flow" aria-hidden="true">
        <figure><Strip keep={false} /><figcaption>原视频：商品在杂乱背景里移动</figcaption></figure>
        <div className="vb-flow-mid"><span /><b>逐帧抠图</b><span /></div>
        <figure><Strip keep /><figcaption>成片：透明背景，或换成纯色、自选图片</figcaption></figure>
      </div>
      <h2>一段商品视频，逐帧去掉背景</h2>
      <p>软件把视频拆成一帧一帧，隔几帧识别一次商品，中间的帧用插值补上，再合成回视频。想换背景就在右侧选纯色或图片。</p>
      <ul className="vb-points">
        <li><ScanLine size={14} />识别密度可调</li>
        <li><Layers size={14} />透明 WebM / ProRes 或 MP4</li>
        <li><Gauge size={14} />轻模型快，高清模式边缘更细</li>
        <li><Clapperboard size={14} />默认处理前 10 秒</li>
      </ul>
      <p className="vb-hint">把商品视频拖进窗口，也可以点右上角的添加按钮选择文件。</p>
    </div>
  );
}

interface Facts { label: string; frames: number; shots: number; took: string; head: string }
function parse(summary?: string): Facts | null {
  if (!summary) return null;
  const parts = summary.split(' · ');
  const frames = Number(parts.find((p) => /帧$/.test(p))?.replace(/\D/g, ''));
  const shots = Number(parts.find((p) => p.startsWith('识别'))?.replace(/\D/g, ''));
  if (!frames || !shots) return null;
  const head = parts.find((p) => /^前 \d+ 秒$/.test(p)) ?? '';
  const took = parts.find((p) => /秒$/.test(p) && !/^前/.test(p) && !p.startsWith('识别')) ?? '';
  return { label: parts[0], frames, shots, took, head };
}

const CELLS = 48;

export function ResultBody({ item, result }: { item: InputItem; result: ItemResult }) {
  const f = parse(result.summary);
  const src = result.preview ? fileSrc(result.preview) : '';
  // 时间轴只画开头的 48 帧：按识别次数算出哪些帧做过识别，其余是插值帧
  const cells = f ? Math.min(CELLS, f.frames) : 0;
  const keys = new Set<number>();
  if (f) for (let k = 0; k < f.shots; k++) keys.add(f.shots > 1 ? Math.round((k * (f.frames - 1)) / (f.shots - 1)) : 0);
  return (
    <div className="vb-result">
      <div className="vb-poster" title="第 1 帧的抠图结果">{src && <img src={src} alt={`${item.name} 第 1 帧`} />}<em>第 1 帧</em></div>
      <div className="vb-film">
        {f ? (
          <>
            <div className="vb-reel" role="img" aria-label={`共 ${f.frames} 帧，识别 ${f.shots} 次，其余帧插值`}>
              {Array.from({ length: cells }, (_, i) => <i key={i} className={keys.has(i) ? 'key' : ''} />)}
            </div>
            <div className="vb-ruler"><span>第 1 帧</span><span>{f.frames > cells ? `只画前 ${cells} 帧，共 ${f.frames} 帧` : `第 ${f.frames} 帧`}</span></div>
            <div className="vb-legend"><span><i className="key" />识别帧 {f.shots}</span><span><i />插值帧 {Math.max(0, f.frames - f.shots)}</span></div>
            <div className="vb-facts">
              <span><b className="k-num">{f.frames}</b>帧</span>
              <span><b className="k-num">{f.shots}</b>次识别</span>
              {f.took && <span><b className="k-num">{f.took}</b>耗时</span>}
              <span className="vb-tagline">{f.label}{f.head ? ` · ${f.head}` : ''}</span>
            </div>
          </>
        ) : <span className="k-muted">{result.summary}</span>}
      </div>
    </div>
  );
}
