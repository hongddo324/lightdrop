// Camera-channel simulator for LightDrop.
// Usage: node test/sim.js [G] [bpc] [fileKB] [cellPx]
"use strict";
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'lightdrop.html'), 'utf8');
const core = html.match(/<script id="ld-core">([\s\S]*?)<\/script>/)[1];
const LD = new Function(core + '\nreturn LD;')();

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// ---- RS self-test ----
{
  let ok = 0;
  for (let t = 0; t < 300; t++) {
    const len = 20 + Math.floor(rnd() * 200), nsym = 32, msg = new Uint8Array(len).map(() => rnd() * 256);
    const cw = LD.rsEncode(msg, nsym), nerr = Math.floor(rnd() * 17);
    for (let e = 0; e < nerr; e++) cw[Math.floor(rnd() * cw.length)] ^= 1 + Math.floor(rnd() * 255);
    const d = LD.rsDecode(cw, nsym);
    if (d && Buffer.compare(Buffer.from(d), Buffer.from(msg)) === 0) ok++;
  }
  console.log(`RS self-test: ${ok}/300 corrected (<=16 errors each)`);
}

const G = +(process.argv[2] || 96), bpc = +(process.argv[3] || 3), KB = +(process.argv[4] || 60), cellPx = +(process.argv[5] || 6);
const W = 1280, H = 720;
const PAL = [[0,0,0],[0,0,255],[0,255,0],[0,255,255],[255,0,0],[255,0,255],[255,255,0],[255,255,255]];

const file = new Uint8Array(KB * 1024).map(() => rnd() * 256);
const stream = LD.packStream({ n: 'test.bin', t: '', s: file.length, c: LD.crc32(file), z: 0 }, file);
const sender = new LD.Sender(stream, G, bpc, 0xC0FFEE);
const N = G + 2 * LD.QUIET;

function render(grids, dst, mix) {
  // dst: 4 corners in camera px of the full code canvas (incl. quiet zone)
  const Hm = LD.homography(dst, [[0, 0], [N, 0], [N, N], [0, N]]);   // camera -> code cells
  const img = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let acc = [0, 0, 0];
    for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const X = x + sx, Y = y + sy, w = Hm[6] * X + Hm[7] * Y + 1;
      const u = (Hm[0] * X + Hm[1] * Y + Hm[2]) / w, v = (Hm[3] * X + Hm[4] * Y + Hm[5]) / w;
      let c;
      if (u < -2 || v < -2 || u >= N + 2 || v >= N + 2) c = [40, 40, 45];           // monitor bezel
      else if (u < 0 || v < 0 || u >= N || v >= N) c = [255, 255, 255];
      else {
        const gc = Math.floor(u) - LD.QUIET, gr = Math.floor(v) - LD.QUIET;
        // torn frame: lower part shows the next frame (display refresh mid-capture)
        const g = (mix !== null && v > mix) ? grids[1] : grids[0];
        c = (gc < 0 || gr < 0 || gc >= G || gr >= G) ? PAL[7] : PAL[g[gr * G + gc]];
      }
      acc[0] += c[0] / 4; acc[1] += c[1] / 4; acc[2] += c[2] / 4;
    }
    img.set(acc, (y * W + x) * 3);
  }
  // blur 3x3, crosstalk, black level/gain, vignetting, noise
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = [0, 0, 0];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy)), wgt = (dx || dy) ? (dx && dy ? 0.05 : 0.1) : 0.4;
      const p = (yy * W + xx) * 3; s[0] += img[p] * wgt; s[1] += img[p + 1] * wgt; s[2] += img[p + 2] * wgt;
    }
    const r = s[0] * 0.80 + s[1] * 0.15 + s[2] * 0.05, g = s[0] * 0.12 + s[1] * 0.78 + s[2] * 0.10, b = s[0] * 0.04 + s[1] * 0.18 + s[2] * 0.78;
    const vig = 1 - 0.35 * (((x - W / 2) / W) ** 2 + ((y - H / 2) / H) ** 2) * 2;
    const p = (y * W + x) * 4;
    out[p] = (25 + r * 0.75) * vig + gauss() * 6;
    out[p + 1] = (25 + g * 0.80) * vig + gauss() * 6;
    out[p + 2] = (30 + b * 0.70) * vig + gauss() * 8;
    out[p + 3] = 255;
  }
  return { width: W, height: H, data: out };
}

const rx = new LD.Receiver();
const size = N * cellPx;
let seq = 0, frames = 0, procMs = 0, procN = 0;
const t0 = Date.now();
console.log(`G=${G} bpc=${bpc} file=${KB}KB K=${sender.K} S=${sender.S}B/frame code=${size}px`);
while (frames < 3000) {
  frames++;
  // camera pose wobbles: perspective + rotation + offset
  const cx = W / 2 + (rnd() - 0.5) * 60, cy = H / 2 + (rnd() - 0.5) * 30, a = (rnd() - 0.5) * 0.25 + (frames % 50 < 5 ? 0.5 : 0), h = size / 2;
  const persp = (rnd() - 0.5) * 0.12;
  const dst = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y], i) => {
    const sc = 1 + (i === 1 || i === 2 ? persp : -persp);
    return [cx + (x * Math.cos(a) - y * Math.sin(a)) * sc, cy + (x * Math.sin(a) + y * Math.cos(a)) * sc];
  });
  const drop = rnd() < 0.15;                       // camera missed this displayed frame entirely
  const torn = rnd() < 0.2 ? rnd() * N : null;     // captured during a screen refresh
  const g0 = sender.frame(seq), g1 = sender.frame(seq + 1);
  seq++;
  if (drop) continue;
  const im = render([g0, g1], dst, torn), tp = Date.now();
  const res = rx.process(im); procMs += Date.now() - tp; procN++;
  if (frames % 20 === 0 || res.state === 'done')
    console.log(`frame ${frames} seq ${seq} state=${res.state} progress=${(rx.progress * 100).toFixed(1)}%`, JSON.stringify(rx.stats));
  if (res.state === 'done') break;
}
const out = rx.output();
if (!out) { console.log('FAILED: not complete'); process.exit(1); }
const { meta, body } = LD.unpackStream(out);
const ok = body.length === meta.s && LD.crc32(body) === meta.c && Buffer.compare(Buffer.from(body), Buffer.from(file)) === 0;
console.log(JSON.stringify(rx.stats), `receiver ${(procMs / procN).toFixed(1)} ms/frame`);
console.log(`${ok ? 'SUCCESS' : 'MISMATCH'}: displayed ${seq} frames for K=${sender.K} (overhead ${(seq / sender.K).toFixed(2)}x), wall ${(Date.now() - t0) / 1000}s`);
