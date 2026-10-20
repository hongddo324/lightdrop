// Builds a fake-camera .y4m clip (I420, so colours also go through 4:2:0 chroma subsampling)
// of a LightDrop transmission, for feeding into Chrome/Edge via --use-file-for-fake-video-capture.
// Usage: node test/make_y4m.js out.y4m [G] [bpc] [fileKB]
"use strict";
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'lightdrop.html'), 'utf8');
const LD = new Function(html.match(/<script id="ld-core">([\s\S]*?)<\/script>/)[1] + '\nreturn LD;')();
const out = process.argv[2], G = +(process.argv[3] || 80), bpc = +(process.argv[4] || 3), KB = +(process.argv[5] || 20);
const W = 960, H = 540, N = G + 2 * LD.QUIET, size = 500, CAM_PER_FRAME = 4;
const PAL = [[0,0,0],[0,0,255],[0,255,0],[0,255,255],[255,0,0],[255,0,255],[255,255,0],[255,255,255]];
let seed = 99; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const file = Buffer.from(Array.from({ length: KB * 1024 }, (_, i) => (i * 7 + (i >> 5)) & 0xFF)); // compressible-ish
const stream = LD.packStream({ n: 'sample.bin', t: 'application/octet-stream', s: file.length, c: LD.crc32(file), z: 0 }, file);
const sender = new LD.Sender(stream, G, bpc, 0xBEEF);
const nFrames = Math.ceil(sender.K * 1.4) + 4;

const fd = fs.openSync(out, 'w');
fs.writeSync(fd, `YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`);
const rgb = new Float32Array(W * H * 3);
for (let f = 0; f < nFrames * CAM_PER_FRAME; f++) {
  const seq = Math.floor(f / CAM_PER_FRAME), torn = f % CAM_PER_FRAME === 0 ? rnd() * N : null;
  const g0 = sender.frame(seq), g1 = sender.frame(seq + 1);
  const a = 0.08 * Math.sin(f / 9), cx = W / 2 + 10 * Math.sin(f / 7), cy = H / 2, h = size / 2, p = 0.05;
  const dst = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y], i) => { const sc = 1 + (i === 1 || i === 2 ? p : -p);
    return [cx + (x * Math.cos(a) - y * Math.sin(a)) * sc, cy + (x * Math.sin(a) + y * Math.cos(a)) * sc]; });
  const Hm = LD.homography(dst, [[0, 0], [N, 0], [N, N], [0, N]]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const acc = [0, 0, 0];
    for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const X = x + sx, Y = y + sy, w = Hm[6] * X + Hm[7] * Y + 1, u = (Hm[0] * X + Hm[1] * Y + Hm[2]) / w, v = (Hm[3] * X + Hm[4] * Y + Hm[5]) / w;
      let c;
      if (u < -4 || v < -4 || u >= N + 4 || v >= N + 4) c = [50, 50, 55];
      else if (u < 0 || v < 0 || u >= N || v >= N) c = PAL[7];
      else { const gc = Math.floor(u) - LD.QUIET, gr = Math.floor(v) - LD.QUIET, g = torn !== null && v > torn ? g1 : g0;
        c = gc < 0 || gr < 0 || gc >= G || gr >= G ? PAL[7] : PAL[g[gr * G + gc]]; }
      acc[0] += c[0] / 4; acc[1] += c[1] / 4; acc[2] += c[2] / 4;
    }
    const k = (y * W + x) * 3;
    rgb[k] = 20 + acc[0] * 0.8; rgb[k + 1] = 20 + acc[1] * 0.8; rgb[k + 2] = 25 + acc[2] * 0.75;
  }
  const Y = Buffer.alloc(W * H), U = Buffer.alloc(W * H / 4), V = Buffer.alloc(W * H / 4);
  for (let i = 0; i < W * H; i++) Y[i] = Math.max(0, Math.min(255, 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2] + (rnd() - 0.5) * 8));
  for (let y = 0; y < H / 2; y++) for (let x = 0; x < W / 2; x++) {
    let r = 0, g = 0, b = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const k = ((2 * y + dy) * W + 2 * x + dx) * 3; r += rgb[k] / 4; g += rgb[k + 1] / 4; b += rgb[k + 2] / 4; }
    U[y * W / 2 + x] = Math.max(0, Math.min(255, 128 - 0.168736 * r - 0.331264 * g + 0.5 * b));
    V[y * W / 2 + x] = Math.max(0, Math.min(255, 128 + 0.5 * r - 0.418688 * g - 0.081312 * b));
  }
  fs.writeSync(fd, 'FRAME\n'); fs.writeSync(fd, Y); fs.writeSync(fd, U); fs.writeSync(fd, V);
}
fs.closeSync(fd);
console.log(`wrote ${out}: K=${sender.K}, ${nFrames} code frames, ${nFrames * CAM_PER_FRAME} camera frames`);
