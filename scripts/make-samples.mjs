// 生成示例素材：node scripts/make-samples.mjs
// 用本机 ffmpeg 合成一段几何图形动画（渐变背景 + 左右摆动、轻微起伏的「商品」+ 一段提示音），不含任何真实品牌或人物。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

const dir = new URL('../src-tauri/binaries/', import.meta.url).pathname;
const f = existsSync(dir) ? readdirSync(dir).find((n) => n.startsWith('ffmpeg-') && !n.endsWith('.txt')) : undefined;
const bin = f ? dir + f : 'ffmpeg';
const out = new URL('../samples/', import.meta.url).pathname;
const ff = (a) => execFileSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });

const W = 540, H = 960, FPS = 24, SECS = 4;
const ellipse = (c, w, h) => `color=c=${c}:s=${w}x${h}:r=${FPS}:d=${SECS},format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(hypot((X-W/2)/(W/2),(Y-H/2)/(H/2)),1),255,0)'`;

// 背景：竖向渐变 + 淡色横条，纯程序生成
ff(['-f', 'lavfi', '-i', `gradients=s=${W}x${H}:d=${SECS}:r=${FPS}:c0=0xBFD8E8:c1=0xF3E6D3:x0=0:y0=0:x1=0:y1=${H}`,
  '-f', 'lavfi', '-i', ellipse('0x2E7D6B', 260, 400),
  '-f', 'lavfi', '-i', ellipse('0xF2B134', 120, 120),
  '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${SECS}`,
  '-filter_complex',
  `[0:v]drawbox=x=0:y=640:w=${W}:h=40:color=white@0.35:t=fill,drawbox=x=0:y=700:w=${W}:h=12:color=white@0.25:t=fill[bg];` +
  `[bg][1:v]overlay=x='140+50*sin(2*PI*t/${SECS})':y='300+16*sin(4*PI*t/${SECS})':format=auto[a];` +
  `[a][2:v]overlay=x='210+50*sin(2*PI*t/${SECS})':y='250+16*sin(4*PI*t/${SECS})':format=auto,format=yuv420p[v];` +
  `[3:a]volume=0.2[a]`,
  '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', '-t', String(SECS), out + '示例-商品视频.mp4']);

// 换背景用的图片：斜条纹
ff(['-f', 'lavfi', '-i', `gradients=s=${W}x${H}:d=1:r=1:c0=0x2B2F3A:c1=0x6B5B95:type=radial`, '-frames:v', '1', out + '示例-背景图.png']);
console.log('已生成 samples/示例-商品视频.mp4、示例-背景图.png');
