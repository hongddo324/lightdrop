// Camera-channel simulator for LightDrop.
// Models real timing: a 60 Hz display showing the code at `fps`, scanned out top to bottom, filmed by a 30 fps
// rolling-shutter camera (so captures straddling a frame change are torn / blended), plus a slowly drifting
// hand-held pose, perspective, blur, colour crosstalk, vignetting, noise and occasional big shakes.
// Usage: [BRIGHT=0.5] node test/sim.js [G] [bpc] [fileKB] [cellPx] [fps]
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

const G = +(process.argv[2] || 128), bpc = +(process.argv[3] || 3), KB = +(process.argv[4] || 100), cellPx = +(process.argv[5] || 5), FPS = +(process.argv[6] || 15);
const W = 1280, H = 720, CAM = 30, TV = 1 / 60, ROLL = 0.022, EXPO = 0.008;
const BRIGHT = +(process.env.BRIGHT || 1);              // sender's brightness setting (camera exposure is not modelled)
const PAL = [[0,0,0],[0,0,255],[0,255,0],[0,255,255],[255,0,0],[255,0,255],[255,255,0],[255,255,255]].map(c => c.map(v => v * BRIGHT));

const file = new Uint8Array(KB * 1024).map(() => rnd() * 256);
const stream = LD.packStream({ n: 'test.bin', t: '', s: file.length, c: LD.crc32(file), z: 0 }, file);
const sender = new LD.Sender(stream.length, G, bpc, 0xC0FFEE, stream);
const N = G + 2 * LD.QUIET, nb = sender.L.nb, sched = sender.schedule([...Array(sender.nseg).keys()]);
const grids = [];
const gridAt = (k) => { while (grids.length <= k) grids.push(sender.frame(Array.from({ length: nb }, () => sched.next().value))); return grids[k]; };
const m = Math.round(60 / FPS);                          // vsyncs per code frame (rAF stepping)
const shown = (t, s) => Math.max(0, Math.floor((t - s * TV) / (m * TV)));   // code frame index visible at time t, screen row s

function render(t0, dst) {
  const Hm = LD.homography(dst, [[0, 0], [N, 0], [N, N], [0, N]]);   // camera -> code cells
  const img = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const t = t0 + (y / H) * ROLL;
    for (let x = 0; x < W; x++) {
      const acc = [0, 0, 0];
      for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const X = x + sx, Y = y + sy, w = Hm[6] * X + Hm[7] * Y + 1;
        const u = (Hm[0] * X + Hm[1] * Y + Hm[2]) / w, v = (Hm[3] * X + Hm[4] * Y + Hm[5]) / w;
        let c;
        if (u < -2 || v < -2 || u >= N + 2 || v >= N + 2) c = [12, 12, 14];             // dark surroundings
        else if (u < 0 || v < 0 || u >= N || v >= N) c = PAL[7];
        else {
          const gc = Math.floor(u) - LD.QUIET, gr = Math.floor(v) - LD.QUIET;
          if (gc < 0 || gr < 0 || gc >= G || gr >= G) c = PAL[7];
          else {
            // exposure window [t, t+EXPO] may straddle the scan-out of the next code frame at this screen row
            const s = 0.25 + 0.5 * v / N, k1 = shown(t, s), k2 = shown(t + EXPO, s);
            const c1 = PAL[gridAt(k1)[gr * G + gc]];
            if (k1 === k2) c = c1;
            else {
              const f = Math.min(1, Math.max(0, (t + EXPO - (k2 * m * TV + s * TV)) / EXPO)), c2 = PAL[gridAt(k2)[gr * G + gc]];
              c = [c1[0] * (1 - f) + c2[0] * f, c1[1] * (1 - f) + c2[1] * f, c1[2] * (1 - f) + c2[2] * f];
            }
          }
        }
        acc[0] += c[0] / 4; acc[1] += c[1] / 4; acc[2] += c[2] / 4;
      }
      img.set(acc, (y * W + x) * 3);
    }
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

const reader = new LD.Reader();
let col = null;
const size = N * cellPx;
let procMs = 0, procN = 0, bands = 0, bandsOk = 0, useful = 0, dup = 0, frames = 0;
let px = 0, py = 0, pa = 0, pp = 0;                      // hand-held pose: slow random walk
const t0 = Date.now(), phase = rnd() / CAM;
console.log(`G=${G} bpc=${bpc} file=${KB}KB fps=${FPS} K=${sender.K} segs=${sender.nseg} bands=${nb}x${sender.S}B = ${nb * sender.S}B/frame, code=${size}px`);
while (frames < 4000) {
  const t = phase + frames++ / CAM;
  px = px * 0.95 + gauss() * 1.5; py = py * 0.95 + gauss() * 1.5; pa = pa * 0.95 + gauss() * 0.004; pp = pp * 0.95 + gauss() * 0.003;
  const shake = frames % 90 < 3;                         // a big jolt every 3 s
  if (rnd() < 0.05) continue;                            // receiver was busy / dropped this camera frame
  const cx = W / 2 + px + (shake ? 25 : 0), cy = H / 2 + py, a = 0.1 + pa + (shake ? 0.05 : 0), h = size / 2;
  const dst = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y], i) => {
    const sc = 1 + (i === 1 || i === 2 ? 0.04 + pp : -0.04 - pp);
    return [cx + (x * Math.cos(a) - y * Math.sin(a)) * sc, cy + (x * Math.sin(a) + y * Math.cos(a)) * sc];
  });
  const im = render(t, dst), tp = process.hrtime.bigint();
  const res = reader.read(im);
  if (res.hdr) {
    if (!col) col = new LD.Collector(res.hdr);
    bands += res.nb; bandsOk += res.syms.length;
    for (const s of res.syms) col.add(s.seg, s.esi, s.data) ? useful++ : dup++;
  }
  procMs += Number(process.hrtime.bigint() - tp) / 1e6; procN++;
  if (frames % 30 === 0 || (col && col.complete))
    console.log(`t=${t.toFixed(1)}s cam ${frames} code#${shown(t, 0.5)} ${res.state} progress=${col ? (col.progress * 100).toFixed(1) : 0}% bands ${bandsOk}/${bands} useful ${useful} dup ${dup}`);
  if (col && col.complete) break;
}
if (!col || !col.complete) { console.log('FAILED: not complete'); process.exit(1); }
const { meta, body } = LD.unpackStream(col.output());
const ok = body.length === meta.s && LD.crc32(body) === meta.c && Buffer.compare(Buffer.from(body), Buffer.from(file)) === 0;
const simT = frames / CAM;
console.log(`receiver ${(procMs / procN).toFixed(1)} ms/frame · bands ok ${(bandsOk / bands * 100).toFixed(1)}% · useful ${useful} for K=${sender.K} (${(useful / sender.K).toFixed(3)}x) · dup ${dup}`);
console.log(`${ok ? 'SUCCESS' : 'MISMATCH'}: ${simT.toFixed(1)} s simulated → ${(stream.length / 1024 / simT).toFixed(1)} KB/s, wall ${(Date.now() - t0) / 1000}s`);
if (!ok) process.exit(1);
