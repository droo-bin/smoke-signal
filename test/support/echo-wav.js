// Writes a WAV of ten short messages as heard in a room: the direct sound plus an echo a few
// milliseconds late, as when a phone's speaker plays into another phone's microphone.
// Usage: node echo-wav.js <baud> <echo-ms> <echo-gain> <out.wav>
const M = require('../../src/modem.js'), fs = require('fs');
const [baud, echoMs, gain, out] = [+process.argv[2], +process.argv[3], +process.argv[4], process.argv[5]], sr = 48000;
let parts = [new Float32Array(sr)];
for (let i = 0; i < 10; i++) {
  const f = M.buildFrame('M7ABC', 'SMOKE', M.msgInfo(i + 1, 'Echo test message number ' + i + ' from the kitchen'));
  parts.push(M.modulate([f], { sampleRate: sr, txDelayMs: 300, baud }), new Float32Array(sr / 2));
}
parts.push(new Float32Array(sr));
const n = parts.reduce((s, p) => s + p.length, 0), x = new Float32Array(n);
let o = 0; for (const p of parts) { x.set(p, o); o += p.length; }
const d = Math.round(echoMs / 1000 * sr), y = new Int16Array(n);
let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (let i = 0; i < n; i++) {
  const v = 0.5 * x[i] + gain * 0.5 * (x[i - d] || 0) + 0.01 * (rnd() - 0.5);
  y[i] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
}
const h = Buffer.alloc(44);
h.write('RIFF'); h.writeUInt32LE(36 + n * 2, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(n * 2, 40);
fs.writeFileSync(out, Buffer.concat([h, Buffer.from(y.buffer)]));
