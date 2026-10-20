// Fountain-layer tests: overhead (symbols needed per block) and speed, without the camera.
//  1. one segment, K blocks: systematic pass with `loss`, then repair symbols; and a receiver that joins late
//  2. multi-segment file through Sender.schedule() / Collector with random loss, checked byte for byte
//  3. throughput of encode + decode for a 1024-block segment (what a 1 GB transfer does ~1100 times)
"use strict";
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'lightdrop.html'), 'utf8');
const LD = new Function(html.match(/<script id="ld-core">([\s\S]*?)<\/script>/)[1] + '\nreturn LD;')();
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const S = LD.layout(128, 3).S;

for (const K of [1, 5, 30, 100, 300, 1024]) for (const [name, loss, late] of [['loss 30%', 0.3, 0], ['late join', 0, 1]]) {
  let tot = 0; const trials = 5;
  for (let t = 0; t < trials; t++) {
    const data = new Uint8Array(K * S).map(() => rnd() * 256);
    const sender = new LD.Sender(data.length, 128, 3, (rnd() * 2 ** 32) >>> 0, data);
    const dec = new LD.SegDecoder(K, S, LD.segKey(sender.session, 0));
    let got = 0;
    for (let esi = late ? K : 0; !dec.done; esi++) if (rnd() >= loss) { dec.add(esi, sender.symbol(0, esi)); got++; }
    if (Buffer.compare(Buffer.from(dec.output()), Buffer.from(data))) throw new Error('decode mismatch');
    tot += got / K;
  }
  console.log(`K=${K}\t${name}\treceived/K = ${(tot / trials).toFixed(3)}`);
}

{ // multi-segment, 20% random symbol loss, through the real schedule
  const total = 5 * 1024 * S + 12345, data = new Uint8Array(total).map(() => rnd() * 256);
  const sender = new LD.Sender(total, 128, 3, 0xABCDEF, data); sender.rho = 0.3;
  const col = new LD.Collector({ G: 128, bpc: 3, session: 0xABCDEF, total, segK: sender.segK });
  const it = sender.schedule([...Array(sender.nseg).keys()]);
  let sent = 0, t0 = Date.now();
  while (!col.complete) { const [j, e] = it.next().value; sent++; if (rnd() >= 0.2) col.add(j, e, sender.symbol(j, e)); }
  const ok = Buffer.compare(Buffer.from(col.output()), Buffer.from(data)) === 0;
  console.log(`${sender.nseg} segments, 20% loss: sent ${sent} for K=${sender.K} (${(sent / sender.K).toFixed(3)}x) ${ok ? 'OK' : 'MISMATCH'} ${Date.now() - t0} ms`);
  if (!ok) process.exit(1);
}

{ // speed of a full 1024-block segment where 25% of the plain blocks were lost
  const K = 1024, data = new Uint8Array(K * S).map(() => rnd() * 256);
  const sender = new LD.Sender(data.length, 128, 3, 99, data), dec = new LD.SegDecoder(K, S, LD.segKey(99, 0));
  let te = 0, td = 0, n = 0;
  for (let esi = 0; !dec.done; esi++) {
    if (esi < K && rnd() < 0.25) continue;
    let t = process.hrtime.bigint(); const s = sender.symbol(0, esi); te += Number(process.hrtime.bigint() - t);
    t = process.hrtime.bigint(); dec.add(esi, s); td += Number(process.hrtime.bigint() - t); n++;
  }
  let t = process.hrtime.bigint(); dec.output(); const tb = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`K=1024 S=${S}: encode ${(te / n / 1e6).toFixed(3)} ms/sym, decode ${(td / n / 1e6).toFixed(3)} ms/sym, back-substitution ${tb.toFixed(0)} ms`);
  console.log(`=> 1 GB ≈ ${Math.ceil(2 ** 30 / (K * S))} segments, receiver fountain CPU ≈ ${((td / 1e9 + tb / 1e3) * 2 ** 30 / (K * S) / 60).toFixed(1)} min total`);
}
