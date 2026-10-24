// 截图与预览用的示例数据（不会进入正式运行）。画面都是画布画的几何图形，名称都带「示例」。
import type { Row } from '../kit/runner';

/** 透明背景的「商品」小图：画布上只画主体，背景保持透明 */
function cutout(i: number): string {
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const g = c.getContext('2d')!;
  const hues = [165, 28, 205, 350];
  g.fillStyle = `hsl(${hues[i % 4]} 45% 36%)`;
  g.beginPath();
  g.ellipse(80, 92, 36, 56, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#F2B134';
  g.beginPath();
  g.arc(80, 40, 20, 0, Math.PI * 2);
  g.fill();
  return c.toDataURL('image/png');
}

const names = ['示例-商品视频.mp4', '示例-商品视频-侧拍.mp4', '示例-商品视频-旋转.mov', '示例-商品视频-细节.mp4'];
const sizes = [96_377, 2_410_000, 5_120_000, 1_870_000];
const summary = ['透明 WebM · 96 帧 · 识别 49 次 · 1 分 4 秒', '透明 WebM · 240 帧 · 识别 121 次 · 1 分 38 秒 · 前 10 秒', '', ''];

export const rows = (state: string): Row[] =>
  state === 'empty' ? [] : names.map((name, i) => {
    const status: Row['status'] = state === 'done' ? 'ok' : i < 2 ? 'ok' : i === 2 ? 'run' : 'wait';
    return {
      item: { id: `v${i}`, name, path: `/示例/${name}`, size: sizes[i] },
      status,
      progress: status === 'run' ? 0.46 : status === 'ok' ? 1 : 0,
      result: status === 'ok' ? { summary: summary[i] || '透明 WebM · 120 帧 · 识别 61 次 · 1 分 21 秒', preview: cutout(i), outputPath: '/tmp/out.webm' } : undefined,
    };
  });

export const params = { bg: 'transparent', format: 'webm', model: 'light', maxSecs: 10, maskFps: '12', smooth: 'mid' };
export const notice = { kind: 'ok' as const, text: '已完成 2 个，正在处理第 3 个' };
