// Run with: node --test test/modem.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const M = require('../src/modem.js');

/* ---------- helpers ---------- */
function seeded(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gaussian(r) { return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()); }

// Adds white noise so that signal-to-noise ratio (over the whole audio band) is snrDb.
function addNoise(audio, snrDb, seed = 1) {
  const r = seeded(seed);
  let p = 0, n = 0;
  for (const x of audio) if (x) { p += x * x; n++; }
  const sigma = Math.sqrt(p / n / Math.pow(10, snrDb / 10));
  return audio.map(x => x + sigma * gaussian(r));
}
// Plays audio back slightly fast or slow, as happens when two sound cards' clocks differ.
function resample(audio, ratio) {
  const out = new Float32Array(Math.floor(audio.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const t = i * ratio, j = Math.floor(t), f = t - j;
    out[i] = (audio[j] || 0) * (1 - f) + (audio[j + 1] || 0) * f;
  }
  return out;
}
// First-order low-pass: makes 2200 Hz weaker than 1200 Hz, like FM de-emphasis on many radios.
function tilt(audio, fs, cutoff) {
  const a = Math.exp(-2 * Math.PI * cutoff / fs); let y = 0;
  return audio.map(x => (y = (1 - a) * x + a * y) * 2);
}
function decodeAll(audio, fs) {
  const got = [];
  new M.Demodulator(fs, f => got.push(f)).process(audio);
  return got;
}
function frames(n, text = i => `Test message number ${i}: water point at St Mary's church, 3-5pm`) {
  return Array.from({ length: n }, (_, i) => M.buildFrame('M7ABC-1', 'SMOKE', M.textInfo(text(i))));
}
function sendSeparately(fs, list, opts = {}) {
  const parts = list.map(f => M.modulate([f], { sampleRate: fs, txDelayMs: 100, ...opts }));
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function wav(samples, fs) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(fs, 24);
  b.writeUInt32LE(fs * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((x, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x * 32767))), 44 + i * 2));
  return b;
}
function readWav(buf) {
  let off = 12, fs = 0, data = null, ch = 1;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4), len = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = buf.readUInt16LE(off + 10); fs = buf.readUInt32LE(off + 12); }
    if (id === 'data') data = buf.subarray(off + 8, off + 8 + len);
    off += 8 + len + (len & 1);
  }
  const n = data.length / 2 / ch, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2 * ch) / 32768;
  return { fs, samples: out };
}
const DIREWOLF = process.env.DIREWOLF_BIN || '/tmp/direwolf/build/src';
const haveDirewolf = fs.existsSync(path.join(DIREWOLF, 'atest'));

/* ---------- framing ---------- */
test('CRC matches the standard X.25 check value', () => {
  assert.strictEqual(M.crc16(Buffer.from('123456789'), 9), 0x906E);
});

test('frames carry callsigns and text', () => {
  const f = M.parseFrame(M.buildFrame('M7ABC-1', 'SMOKE', M.textInfo('Hello £ 🚒')));
  assert.deepStrictEqual([f.src, f.dest, M.readText(f.info)], ['M7ABC-1', 'SMOKE', 'Hello £ 🚒']);
});

test('bad callsigns are refused', () => {
  assert.throws(() => M.parseCall('not a call'), /Callsign/);
  assert.throws(() => M.parseCall('M7ABC-16'), /Callsign/);
});

/* ---------- the modem ---------- */
for (const fs of [44100, 48000, 22050]) {
  test(`clean audio round trip at ${fs} Hz`, () => {
    const list = frames(10);
    assert.strictEqual(decodeAll(sendSeparately(fs, list), fs).length, 10);
  });
}

test('several frames in one transmission all decode', () => {
  const list = frames(8);
  assert.strictEqual(decodeAll(M.modulate(list, { sampleRate: 48000 }), 48000).length, 8);
});

for (const [snr, need] of [[12, 30], [8, 29], [6, 27]]) {
  test(`decodes through noise at ${snr} dB SNR (at least ${need} of 30)`, () => {
    const got = decodeAll(addNoise(sendSeparately(48000, frames(30)), snr, snr), 48000).length;
    assert.ok(got >= need, `decoded ${got} of 30`);
  });
}

for (const ratio of [0.995, 1.005]) {
  test(`copes with sound-card clocks ${((ratio - 1) * 100).toFixed(1)}% apart`, () => {
    assert.strictEqual(decodeAll(resample(sendSeparately(48000, frames(10)), ratio), 48000).length, 10);
  });
}

test('copes with radios that weaken the high tone (de-emphasis)', () => {
  const audio = addNoise(tilt(sendSeparately(48000, frames(20)), 48000, 1000), 15, 3);
  assert.ok(decodeAll(audio, 48000).length >= 19);
});

test('copes with quiet and loud input', () => {
  for (const amp of [0.02, 0.95]) {
    assert.strictEqual(decodeAll(sendSeparately(48000, frames(5), { amplitude: amp }), 48000).length, 5, `amplitude ${amp}`);
  }
});

/* ---------- bulletins ---------- */
const PLACES = ['Holbrook Community Centre', "St Mary's church hall", 'Foleshill library', 'Radford leisure centre',
  'Earlsdon primary school', 'Wyken Croft surgery', 'the Bell Green fire station', 'Stoke Aldermoor shops'];
const NEEDS = ['drinking water', 'phone charging', 'hot food', 'a warm room', 'insulin storage', 'nappies and formula', 'pet food', 'blankets'];
const LONG = Array.from({ length: 30 }, (_, i) =>
  `${String(i + 1).padStart(2, '0')}:${(i * 7) % 60} ${PLACES[i % 8]} has ${NEEDS[(i * 3) % 8]} until ${(i % 9) + 13}:00. ` +
  `Ask for ${['Sam', 'Jo', 'Pat', 'Alex', 'Ravi', 'Chen'][i % 6]} (ref ${(i * 7919) % 10007}).`).join('\n');

test('a bulletin almost always survives a quarter of its packets being lost', async () => {
  // With the default of twice as many packets as blocks, losing a random 25% should rarely matter.
  const c = await M.compress(M.encode(LONG));
  let ok = 0;
  for (let trial = 1; trial <= 200; trial++) {
    const packets = M.bulletinPackets(4242 + trial, c.bytes, c.compressed);
    const r = seeded(trial), keep = packets.filter(() => r() > 0.25);
    const first = M.parseBulletin(keep[0]);
    const d = new M.BulletinDecoder(first.id, first.k, first.length, first.compressed);
    for (const p of keep.sort(() => r() - 0.5)) { const b = M.parseBulletin(p); d.add(b.seed, b.data); }
    if (d.done()) { ok++; assert.strictEqual(M.decode(await M.decompress(d.bytes())), LONG); }
  }
  console.log(`    25% loss, one pass of twice the blocks: rebuilt ${ok} of 200 bulletins`);
  assert.ok(ok >= 180, `rebuilt ${ok} of 200`);
});

test('sending more packets finishes every bulletin, even with heavy loss', async () => {
  const c = await M.compress(M.encode(LONG));
  for (let trial = 1; trial <= 100; trial++) {
    const packets = M.bulletinPackets(9000 + trial, c.bytes, c.compressed, 5); // a long stream of fresh packets
    const r = seeded(trial), first = M.parseBulletin(packets[0]);
    const d = new M.BulletinDecoder(first.id, first.k, first.length, first.compressed);
    for (const p of packets) { if (r() < 0.4) continue; const b = M.parseBulletin(p); d.add(b.seed, b.data); if (d.done()) break; }
    assert.ok(d.done(), `trial ${trial}`);
  }
});

test('a bulletin needs only about two packets more than its block count', () => {
  const bytes = M.encode(LONG), extraNeeded = [];
  for (let trial = 1; trial <= 200; trial++) {
    const packets = M.bulletinPackets(trial, bytes, false, 3);
    const r = seeded(trial), order = packets.slice().sort(() => r() - 0.5);
    const first = M.parseBulletin(order[0]);
    const d = new M.BulletinDecoder(first.id, first.k, first.length, false);
    let used = 0;
    for (const p of order) { const b = M.parseBulletin(p); d.add(b.seed, b.data); used++; if (d.done()) break; }
    assert.ok(d.done());
    assert.strictEqual(M.decode(d.bytes()), LONG);
    extraNeeded.push(used - first.k);
  }
  const mean = extraNeeded.reduce((a, b) => a + b, 0) / extraNeeded.length;
  console.log(`    ${M.parseBulletin(M.bulletinPackets(1, bytes, false)[0]).k} blocks: needed ${mean.toFixed(2)} extra packets on average, at most ${Math.max(...extraNeeded)}`);
  assert.ok(mean < 2.5, `mean extra ${mean}`);
});

test('a bulletin goes over audio with noise and lost packets', async () => {
  const c = await M.compress(M.encode(LONG));
  const packets = M.bulletinPackets(7, c.bytes, c.compressed, 0.8);
  const r = seeded(99);
  const sent = packets.filter(() => r() > 0.2).map(p => M.buildFrame('M7ABC', 'SMOKE', p));
  const got = decodeAll(addNoise(sendSeparately(48000, sent), 10, 5), 48000);
  const first = M.parseBulletin(M.parseFrame(got[0]).info);
  const d = new M.BulletinDecoder(first.id, first.k, first.length, first.compressed);
  for (const f of got) { const b = M.parseBulletin(M.parseFrame(f).info); d.add(b.seed, b.data); }
  assert.ok(d.done(), `rebuilt ${d.knownCount} of ${d.k}`);
  assert.strictEqual(M.decode(await M.decompress(d.bytes())), LONG);
});

/* ---------- works with standard packet radio software (Direwolf) ---------- */
test('Direwolf decodes our frames', { skip: !haveDirewolf && 'Direwolf not built' }, () => {
  const file = path.join(os.tmpdir(), 'smoke-to-direwolf.wav');
  const list = Array.from({ length: 10 }, (_, i) => M.buildFrame('M7ABC-1', 'SMOKE', M.encode('Hello Direwolf ' + i)));
  fs.writeFileSync(file, wav(sendSeparately(44100, list), 44100));
  const out = execFileSync(path.join(DIREWOLF, 'atest'), [file], { encoding: 'utf8' });
  assert.match(out, /10 packets decoded/);
  assert.match(out, /M7ABC-1>SMOKE:Hello Direwolf 9/);
});

test('we decode Direwolf\'s noisy benchmark as well as Direwolf does', { skip: !haveDirewolf && 'Direwolf not built' }, () => {
  const file = path.join(os.tmpdir(), 'direwolf-bench.wav');
  execFileSync(path.join(DIREWOLF, 'gen_packets'), ['-n', '100', '-o', file], { stdio: 'ignore' });
  const theirs = +/(\d+) packets decoded/.exec(execFileSync(path.join(DIREWOLF, 'atest'), [file], { encoding: 'utf8' }))[1];
  const { fs: rate, samples } = readWav(fs.readFileSync(file));
  const ours = decodeAll(samples, rate).length;
  console.log(`    noisy benchmark: Direwolf ${theirs}/100, Smoke Signal ${ours}/100`);
  assert.ok(ours >= theirs * 0.95, `ours ${ours}, Direwolf ${theirs}`);
});

test('someone who tunes in for a later round still gets the whole bulletin', () => {
  const bytes = M.encode(LONG), sender = new M.BulletinSender(321, bytes, false);
  const round = () => Array.from({ length: 2 * sender.k + 2 }, () => sender.next());
  round(); // the first round goes out before the listener tunes in
  const second = round(), first = M.parseBulletin(second[0]);
  assert.ok(first.seed >= first.k, 'later rounds are fresh mixed packets');
  const d = new M.BulletinDecoder(first.id, first.k, first.length, false);
  for (const p of second) { const b = M.parseBulletin(p); d.add(b.seed, b.data); }
  assert.ok(d.done());
  assert.strictEqual(M.decode(d.bytes()), LONG);
});

/* ---------- knowing when the channel is busy ---------- */
function busyTimeline(audio, fs, step = fs / 50) {
  const d = new M.Demodulator(fs, () => {}), out = [];
  for (let i = 0; i < audio.length; i += step) { d.process(audio.subarray(i, i + step)); out.push(d.busy()); }
  return out;
}

test('the channel shows busy while a packet is being sent', () => {
  const fs = 48000, quiet = new Float32Array(fs), tail = new Float32Array(fs * 3);
  const packet = M.modulate(frames(4), { sampleRate: fs, txDelayMs: 300 }); // several packets back to back
  const audio = addNoise(Float32Array.from([...quiet, ...packet, ...tail]), 10, 7);
  const t = busyTimeline(audio, fs), per = 50, end = 1 + packet.length / fs;
  const during = t.slice(Math.ceil(per * 1.15), Math.floor(per * end) - 2);
  assert.ok(during.every(Boolean), `busy ${during.filter(Boolean).length}/${during.length} while sending`);
  const before = t.slice(0, per - 2), after = t.slice(Math.ceil(per * (end + 1.5)));
  assert.ok(!before.some(Boolean), 'not busy before');
  assert.ok(!after.some(Boolean), 'clear again within about a second');
});

test('noise alone rarely looks like a busy channel', () => {
  const fs = 48000, r = seeded(11);
  const noise = Float32Array.from({ length: fs * 60 }, () => 0.2 * gaussian(r));
  const t = busyTimeline(noise, fs), busy = t.filter(Boolean).length;
  const d = new M.Demodulator(fs, () => {}); d.process(noise);
  assert.strictEqual(d.damaged, 0, 'noise is not reported as damaged packets');
  console.log(`    60 s of noise: busy ${(100 * busy / t.length).toFixed(2)}% of the time`);
  assert.ok(busy / t.length < 0.01);
});

/* ---------- messages with ids, and acknowledgements ---------- */
test('a message carries an id that comes back in the acknowledgement', () => {
  const f = M.parseFrame(M.buildFrame('M7ABC', 'G4XYZ', M.msgInfo(51234, 'Can you bring the generator?')));
  const m = M.parseMsg(f.info);
  assert.deepStrictEqual([f.dest, m.id, m.text, M.readText(f.info)], ['G4XYZ', 51234, 'Can you bring the generator?', 'Can you bring the generator?']);
  const ack = M.parseFrame(M.buildFrame('G4XYZ', 'M7ABC', M.ackInfo(m.id)));
  assert.deepStrictEqual([ack.src, ack.dest, M.parseAck(ack.info).id], ['G4XYZ', 'M7ABC', 51234]);
  assert.strictEqual(M.readText(ack.info), null, 'acknowledgements are not shown as text');
  assert.strictEqual(M.parseAck(M.msgInfo(1, 'x')), null);
});

test('an acknowledgement is short on air', () => {
  const f = M.buildFrame('G4XYZ-7', 'M7ABC-1', M.ackInfo(7));
  assert.ok(M.airtime([f.length], 300) < 0.6, `${M.airtime([f.length], 300).toFixed(2)} s`);
  assert.strictEqual(decodeAll(M.modulate([f], { sampleRate: 48000 }), 48000).length, 1);
});

test('damaged packets are counted, and clean ones are not', () => {
  const fs = 48000, list = frames(10), parts = [];
  for (let i = 0; i < list.length; i++) {
    const a = M.modulate([list[i]], { sampleRate: fs, txDelayMs: 200 });
    if (i % 2) { // damage the middle of every other packet with a loud burst
      const mid = Math.floor(a.length * 0.7), r = seeded(i);
      for (let j = mid; j < mid + fs * 0.03; j++) a[j] = (r() - 0.5) * 3;
    }
    parts.push(a, new Float32Array(fs / 2));
  }
  const audio = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { audio.set(p, o); o += p.length; }
  const d = new M.Demodulator(fs, () => {});
  for (let i = 0; i < audio.length; i += 4096) d.process(audio.subarray(i, i + 4096));
  d.process(new Float32Array(fs));
  assert.deepStrictEqual([d.frames, d.damaged], [5, 5]);
});

test('a "send me more" request names the bulletin and how many packets', () => {
  const f = M.parseFrame(M.buildFrame('G4XYZ', 'M7ABC', M.needInfo(4242, 17)));
  assert.deepStrictEqual(M.parseNeed(f.info), { id: 4242, count: 17 });
  assert.strictEqual(M.readText(f.info), null);
  assert.strictEqual(M.parseNeed(M.ackInfo(1)), null);
});

test('clean packets are never reported as damaged', () => {
  const fs = 44100, audio = addNoise(sendSeparately(fs, frames(30)), 20, 9);
  const d = new M.Demodulator(fs, () => {});
  for (let i = 0; i < audio.length; i += 4096) d.process(audio.subarray(i, i + 4096));
  d.process(new Float32Array(fs));
  assert.deepStrictEqual([d.frames, d.damaged], [30, 0]);
});

/* ---------- resending the same file ---------- */
test('the same file always gets the same id, and different files almost never share one', () => {
  const a = M.encode(LONG), b = M.encode(LONG + '!');
  assert.strictEqual(M.contentId(a, false), M.contentId(a.slice(), false));
  assert.notStrictEqual(M.contentId(a, false), M.contentId(b, false));
  const ids = new Set(); for (let i = 0; i < 2000; i++) ids.add(M.contentId(M.encode('file ' + i), false));
  assert.ok(ids.size > 1960, `${ids.size} distinct ids from 2000 files`);
});

test('a resend carries on with fresh packets that complete the earlier attempt', () => {
  const bytes = M.encode(LONG), id = M.contentId(bytes, false);
  const first = new M.BulletinSender(id, bytes, false);
  const d = new M.BulletinDecoder(id, first.k, bytes.length, false);
  const r = seeded(4);
  for (let i = 0; i < 2 * first.k; i++) { const p = M.parseBulletin(first.next()); if (r() < 0.3) d.add(p.seed, p.data); } // most lost
  assert.ok(!d.done());
  const again = new M.BulletinSender(M.contentId(bytes, false), bytes, false, first.seed); // a later send of the same file
  let used = 0;
  while (!d.done()) { const p = M.parseBulletin(again.next()); assert.ok(p.seed >= 2 * first.k, 'no repeats of earlier packets'); d.add(p.seed, p.data); used++; }
  assert.strictEqual(M.decode(d.bytes()), LONG);
  assert.ok(used <= first.k + 6, `needed ${used} more packets`);
});

test('specific blocks can be resent, and a half-received file can be restored from its saved packets', () => {
  const bytes = M.encode(LONG), id = M.contentId(bytes, false), s = new M.BulletinSender(id, bytes, false);
  const d = new M.BulletinDecoder(id, s.k, bytes.length, false);
  for (let i = 0; i < s.k; i += 2) { const p = M.parseBulletin(s.packet(i)); d.add(p.seed, p.data); } // every other block
  const saved = d.packets.map(([seed, data]) => [seed, Buffer.from(data).toString('base64')]);
  const restored = new M.BulletinDecoder(id, s.k, bytes.length, false);
  for (const [seed, b64] of saved) restored.add(seed, Buffer.from(b64, 'base64'));
  assert.strictEqual(restored.knownCount, d.knownCount);
  for (let i = 1; i < s.k; i += 2) { const p = M.parseBulletin(s.packet(i)); restored.add(p.seed, p.data); } // the missing blocks
  assert.ok(restored.done());
  assert.strictEqual(M.decode(restored.bytes()), LONG);
});

/* ---------- 300 baud for echoey rooms, and listening at both speeds ---------- */
function withEcho(audio, ms, gain, fs) { const d = Math.round(fs * ms / 1000), y = Float32Array.from(audio); for (let i = d; i < audio.length; i++) y[i] += gain * audio[i - d]; return y; }
function sendAt(fs, list, baud) { return sendSeparately(fs, list, { baud }); }

test('300 baud survives the echoes that defeat 1200 baud (a speaker heard through a room)', () => {
  const fs = 48000, list = frames(10);
  const slow = new M.Demodulator(fs, () => {}, { bauds: [300] }); slow.process(withEcho(sendAt(fs, list, 300), 5, 0.6, fs));
  const fast = new M.Demodulator(fs, () => {}); fast.process(withEcho(sendAt(fs, list, 1200), 5, 0.6, fs));
  console.log(`    5 ms echo: 1200 baud ${fast.frames}/10, 300 baud ${slow.frames}/10`);
  assert.strictEqual(slow.frames, 10);
});

test('one listener hears both speeds at once and says which', () => {
  const fs = 48000, got = [];
  const d = new M.Demodulator(fs, (f, baud) => got.push(baud), { bauds: [1200, 300] });
  d.process(sendAt(fs, frames(3), 1200)); d.process(sendAt(fs, frames(3, i => 'slow ' + i), 300)); d.process(new Float32Array(fs));
  assert.deepStrictEqual(got, [1200, 1200, 1200, 300, 300, 300]);
});

test('airtime at 300 baud is three to four times longer (the lead-in is the same length)', () => {
  const t1 = M.airtime([80, 80], 300, 1200), t3 = M.airtime([80, 80], 300, 300);
  assert.ok(t3 / t1 > 3 && t3 / t1 < 4.2, `${t1.toFixed(2)} s vs ${t3.toFixed(2)} s`);
});

/* ---------- no fixed size limit ---------- */
test('a bulletin of more than 255 blocks (40 KB) goes through', () => {
  const r = seeded(21), bytes = Uint8Array.from({ length: 40000 }, () => Math.floor(r() * 256));
  const s = new M.BulletinSender(M.contentId(bytes, false), bytes, false), first = M.parseBulletin(s.next());
  assert.ok(s.k > 255); assert.strictEqual(first.k, s.k); assert.strictEqual(first.length, 40000);
  const d = new M.BulletinDecoder(first.id, first.k, first.length, false); d.add(first.seed, first.data);
  const t0 = Date.now();
  while (!d.done()) { const p = M.parseBulletin(s.next()); if (r() < 0.8) d.add(p.seed, p.data); }
  assert.deepStrictEqual(Array.from(d.bytes()), Array.from(bytes));
  console.log(`    ${s.k} blocks rebuilt in ${Date.now() - t0} ms`);
});

test('the older bulletin format is still understood', () => {
  const p = new Uint8Array(9 + 64); p[0] = 0x02; p[1] = 1; p[2] = 2; p[3] = 5; p[4] = 1; p[5] = 44; p[6] = 0; p[7] = 0; p[8] = 3;
  assert.deepStrictEqual((({ id, k, length, seed }) => ({ id, k, length, seed }))(M.parseBulletin(p)), { id: 258, k: 5, length: 300, seed: 3 });
});
