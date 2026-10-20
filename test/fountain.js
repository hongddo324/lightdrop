// Fountain-layer efficiency: how many received symbols are needed per source block.
// Scenario A: receiver sees the systematic pass with `loss`, then repair symbols.
// Scenario B: receiver joins late (only repair symbols).
"use strict";
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'lightdrop.html'), 'utf8');
const LD = new Function(html.match(/<script id="ld-core">([\s\S]*?)<\/script>/)[1] + '\nreturn LD;')();
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const S = 64;
for (const K of [10, 30, 100, 300, 1000, 3000]) for (const [name, loss, start] of [['A loss30%', 0.3, 0], ['B late join', 0.3, 1]]) {
  let tot = 0, ms = 0; const trials = K >= 1000 ? 2 : 5;
  for (let t = 0; t < trials; t++) {
    const data = new Uint8Array(K * S).map(() => rnd() * 256);
    const sender = new LD.Sender(data, 96, 3, (rnd() * 2 ** 32) >>> 0); sender.S = S; sender.data = data; sender.K = K;
    const dec = new LD.LTDecoder(K, S, sender.session);
    let got = 0, seq = start ? K : 0; const t0 = Date.now();
    while (!dec.done) { if (rnd() >= loss) { dec.add(seq, sender.symbol(seq)); got++; } seq++; }
    ms += Date.now() - t0;
    const out = dec.output(K * S);
    if (Buffer.compare(Buffer.from(out), Buffer.from(data))) throw new Error('decode mismatch');
    tot += got / K;
  }
  console.log(`K=${K}\t${name}\treceived/K = ${(tot / trials).toFixed(3)}\t${(ms / trials).toFixed(0)} ms`);
}
