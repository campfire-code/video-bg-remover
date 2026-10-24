import { describe, expect, it } from 'vitest';
import { encodeArgs, effectiveSecs, estimate, extractArgs, fmtDuration, frameInName, frameOutName, keyStep, outputName, SEC_PER_INFER } from './plan';

const lim = { maxSecs: 10, fps: 24, maxSide: 1280 };

describe('抽帧参数', () => {
  const a = extractArgs('/in/商品.mp4', '/tmp/x', lim);
  it('限制时长、帧率、长边，输出 JPEG 序列', () => {
    expect(a.slice(0, 4)).toEqual(['-t', '10', '-i', '/in/商品.mp4']);
    const vf = a[a.indexOf('-vf') + 1];
    expect(vf).toContain('fps=24');
    expect(vf).toContain("min(1280,iw)");
    expect(vf).toContain('force_divisible_by=2');
    expect(a[a.length - 1]).toBe('/tmp/x/in%05d.jpg');
  });
  it('长边设为 0：保持原尺寸，只把宽高取偶数', () => {
    const vf = extractArgs('/a.mp4', '/t', { ...lim, maxSide: 0 }).join(' ');
    expect(vf).toContain('trunc(iw/2)*2');
    expect(vf).not.toContain('min(');
  });
});

describe('合成参数', () => {
  const base = { framesDir: '/tmp/x', fps: 24, frames: 96, out: '/out/a.webm' };
  it('WebM：VP9 + yuva420p，关掉 auto-alt-ref 才保留透明度', () => {
    const a = encodeArgs({ ...base, kind: 'webm' }).join(' ');
    expect(a).toContain('-framerate 24 -i /tmp/x/out%05d.png');
    expect(a).toContain('-c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0');
    expect(a).not.toContain('-c:a');
    expect(a.endsWith('-t 4.000 /out/a.webm')).toBe(true);
  });
  it('MOV：ProRes 4444 + yuva444p10le', () => {
    const a = encodeArgs({ ...base, kind: 'mov', out: '/out/a.mov' }).join(' ');
    expect(a).toContain('-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le');
  });
  it('MP4：H.264 + yuv420p，读 JPEG 帧', () => {
    const a = encodeArgs({ ...base, kind: 'mp4', out: '/out/a.mp4' }).join(' ');
    expect(a).toContain('/tmp/x/out%05d.jpg');
    expect(a).toContain('-c:v libx264');
    expect(a).toContain('-pix_fmt yuv420p');
    expect(a).toContain('-movflags +faststart');
  });
  it('保留原声：第二路输入取原视频音轨（没有音轨也不报错），按格式选音频编码', () => {
    const args = (kind: 'webm' | 'mov' | 'mp4') => encodeArgs({ ...base, kind, audioFrom: '/in/v.mp4' }).join(' ');
    expect(args('webm')).toContain('-i /in/v.mp4 -map 0:v -map 1:a:0? ');
    expect(args('webm')).toContain('-c:a libopus');
    expect(args('mov')).toContain('-c:a aac');
    expect(args('mp4')).toContain('-c:a aac');
  });
});

describe('耗时预估', () => {
  it('10 秒、24 帧、每秒识别 8 次 → 81 次识别', () => {
    const e = estimate(30, lim, 8, 'light');
    expect(e.frames).toBe(240);
    expect(e.inferences).toBe(81);
    expect(e.seconds).toBeCloseTo(81 * SEC_PER_INFER.light);
  });
  it('视频比上限短时按实际时长；时长未知按上限', () => {
    expect(estimate(5, lim, 8, 'light').frames).toBe(120);
    expect(effectiveSecs(0, 10)).toBe(10);
    expect(effectiveSecs(3, 10)).toBe(3);
  });
  it('高清模型比轻模型慢', () => expect(estimate(10, lim, 8, 'hd').seconds).toBeGreaterThan(estimate(10, lim, 8, 'light').seconds * 4));
  it('每帧识别：识别次数 = 帧数 + 1 以内', () => expect(estimate(10, lim, 0, 'light').inferences).toBe(241));
  it('识别步长', () => {
    expect(keyStep(24, 8)).toBe(3);
    expect(keyStep(30, 4)).toBe(8);
    expect(keyStep(15, 30)).toBe(1);
    expect(keyStep(24, 0)).toBe(1);
  });
  it('时间显示', () => {
    expect(fmtDuration(45)).toBe('45 秒');
    expect(fmtDuration(65)).toBe('1 分 5 秒');
    expect(fmtDuration(120)).toBe('2 分');
  });
});

describe('命名', () => {
  it('帧文件名从 1 开始补零，与 ffmpeg 序列模式一致', () => {
    expect(frameInName(0)).toBe('in00001.jpg');
    expect(frameOutName(11, 'webm')).toBe('out00012.png');
    expect(frameOutName(11, 'mp4')).toBe('out00012.jpg');
  });
  it('输出名按背景类型区分，重名加序号', () => {
    expect(outputName('杯子.MP4', 'webm', true)).toBe('杯子-去背景.webm');
    expect(outputName('杯子.mov', 'mp4', false)).toBe('杯子-换背景.mp4');
    expect(outputName('杯子.mp4', 'mov', true, new Set(['杯子-去背景.mov']))).toBe('杯子-去背景-2.mov');
  });
});
