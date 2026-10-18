// Copyright 2026 The Smoke Signal contributors
// SPDX-License-Identifier: Apache-2.0
/* Smoke Signal modem core. Plain JavaScript, no dependencies; runs in browsers and Node.
   - 1200 baud AFSK (Bell 202: mark 1200 Hz = 1, space 2200 Hz), NRZI, HDLC framing with bit stuffing
   - AX.25 UI frames with CRC-16 (X.25), so standard packet radio software can read them
   - Fountain-coded bulletins: a long message is cut into blocks and sent as a stream of mixed packets;
     a listener rebuilds it from any slightly-more-than-K of them, in any order, with no replies needed. */
var Modem = (function () {
  'use strict';

  var BAUD = 1200, MARK = 1200, SPACE = 2200;

  /* ---------- CRC-16/X.25 (AX.25 frame check sequence) ---------- */
  var CRC_TABLE = (function () {
    var t = new Uint16Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var j = 0; j < 8; j++) c = (c & 1) ? (c >>> 1) ^ 0x8408 : c >>> 1;
      t[i] = c;
    }
    return t;
  })();
  function crc16(bytes, len) {
    var c = 0xFFFF;
    for (var i = 0; i < len; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
    return (c ^ 0xFFFF) & 0xFFFF;
  }

  /* ---------- AX.25 UI frames ---------- */
  function parseCall(s) {
    var m = /^([A-Z0-9]{1,6})(?:-(\d{1,2}))?$/.exec(String(s || '').trim().toUpperCase());
    if (!m || +(m[2] || 0) > 15) throw new Error('Callsign should look like M7ABC or M7ABC-1');
    return { call: m[1], ssid: +(m[2] || 0) };
  }
  function encodeAddress(out, a, last, command) {
    var c = (a.call + '      ').slice(0, 6);
    for (var i = 0; i < 6; i++) out.push(c.charCodeAt(i) << 1);
    out.push((command ? 0x80 : 0) | 0x60 | (a.ssid << 1) | (last ? 1 : 0));
  }
  function decodeAddress(b, off) {
    var call = '';
    for (var i = 0; i < 6; i++) call += String.fromCharCode(b[off + i] >> 1);
    call = call.trim();
    var ssid = (b[off + 6] >> 1) & 0x0F;
    return call + (ssid ? '-' + ssid : '');
  }
  // dest is a tocall such as "SMOKE"; info is a Uint8Array
  function buildFrame(src, dest, info) {
    var out = [];
    encodeAddress(out, parseCall(dest), false, true);
    encodeAddress(out, parseCall(src), true, false);
    out.push(0x03, 0xF0); // UI frame, no layer 3
    for (var i = 0; i < info.length; i++) out.push(info[i]);
    var crc = crc16(out, out.length);
    out.push(crc & 0xFF, crc >>> 8);
    return new Uint8Array(out);
  }
  function parseFrame(b) {
    // b includes the two CRC bytes, already checked
    var n = b.length - 2, off = 14;
    if (n < 16) return null;
    var dest = decodeAddress(b, 0), src = decodeAddress(b, 7);
    var path = [];
    while (!(b[off - 1] & 1) && off + 7 <= n) { path.push(decodeAddress(b, off)); off += 7; }
    if (b[off] !== 0x03 || b[off + 1] !== 0xF0) return null;
    return { src: src, dest: dest, path: path, info: b.slice(off + 2, n) };
  }

  /* ---------- Modulator ---------- */
  // Returns a Float32Array of audio for one or more frames sent back to back.
  function modulate(frames, opts) {
    opts = opts || {};
    var fs = opts.sampleRate || 48000, amp = opts.amplitude == null ? 0.5 : opts.amplitude;
    var baud = opts.baud || BAUD;
    var leadFlags = Math.ceil((opts.txDelayMs == null ? 300 : opts.txDelayMs) / 1000 * baud / 8);
    var bits = [];
    function pushByte(v, stuff) {
      for (var i = 0; i < 8; i++) {
        var bit = (v >> i) & 1;
        bits.push(bit);
        if (stuff) {
          if (bit) { if (++ones === 5) { bits.push(0); ones = 0; } } else ones = 0;
        }
      }
    }
    var ones = 0, i, j;
    for (i = 0; i < leadFlags; i++) pushByte(0x7E, false);
    for (j = 0; j < frames.length; j++) {
      pushByte(0x7E, false); ones = 0;
      for (i = 0; i < frames[j].length; i++) pushByte(frames[j][i], true);
      pushByte(0x7E, false); pushByte(0x7E, false);
    }
    for (i = 0; i < 2; i++) pushByte(0x7E, false);
    // NRZI: a 0 bit changes the tone, a 1 keeps it
    var spb = fs / baud, total = Math.ceil(bits.length * spb);
    var pad = Math.round(fs * 0.05), out = new Float32Array(total + 2 * pad);
    var tone = 1, phase = 0, t = 0;
    for (i = 0; i < bits.length; i++) {
      if (!bits[i]) tone ^= 1;
      var w = 2 * Math.PI * (tone ? MARK : SPACE) / fs;
      var end = Math.round((i + 1) * spb);
      for (; t < end; t++) { out[pad + t] = amp * Math.sin(phase); phase += w; }
      if (phase > 1e4) phase %= 2 * Math.PI;
    }
    // short fade in/out to avoid clicks
    var f = Math.min(Math.round(fs * 0.004), total >> 1);
    for (i = 0; i < f; i++) { out[pad + i] *= i / f; out[pad + total - 1 - i] *= i / f; }
    return out;
  }

  /* ---------- Demodulator ---------- */
  function Biquad(type, f0, q, fs) {
    var w = 2 * Math.PI * f0 / fs, a = Math.sin(w) / (2 * q), c = Math.cos(w), b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    var a0 = 1 + a;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = -2 * c / a0; this.a2 = (1 - a) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  Biquad.prototype.run = function (x) {
    var y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  };

  // One demodulator "slicer". Several run side by side with different settings; any of them can find a frame.
  function Slicer(fs, onFrame, opts) {
    this.fs = fs; this.onFrame = onFrame;
    var baud = opts.baud || BAUD; this.baud = baud;
    var n = Math.max(4, Math.round(fs / baud * (opts.window || 1)));
    this.n = n;
    this.ring = new Float32Array(n * 4); this.pos = 0;
    this.sums = new Float64Array(4);
    this.wm = 2 * Math.PI * MARK / fs; this.ws = 2 * Math.PI * SPACE / fs;
    this.pm = 0; this.ps = 0;
    this.mPeak = 1e-6; this.sPeak = 1e-6;
    this.decay = 1 - 1 / (fs * 0.08);
    this.pll = 0; this.step = Math.round(4294967296 * baud / fs) | 0;
    this.prevD = 0; this.lastRaw = 0;
    this.pat = 0; this.olen = -1; this.oacc = 0; this.buf = [];
    // carrier detect: a run of 3+ flags 8 bits apart means a real transmission, not noise
    this.bits = 0; this.lastFlag = -99; this.flagRun = 0; this.locked = false; this.onActivity = null;
  }
  Slicer.prototype.push = function (x) {
    // mix down to mark and space, then a moving sum over one bit gives each tone's strength
    var r = this.ring, p = this.pos * 4, s = this.sums;
    var mi = x * Math.cos(this.pm), mq = x * Math.sin(this.pm), si = x * Math.cos(this.ps), sq = x * Math.sin(this.ps);
    this.pm += this.wm; this.ps += this.ws;
    if (this.pm > 6.283185307179586) this.pm -= 6.283185307179586;
    if (this.ps > 6.283185307179586) this.ps -= 6.283185307179586;
    s[0] += mi - r[p]; s[1] += mq - r[p + 1]; s[2] += si - r[p + 2]; s[3] += sq - r[p + 3];
    r[p] = mi; r[p + 1] = mq; r[p + 2] = si; r[p + 3] = sq;
    this.pos = (this.pos + 1) % this.n;
    var m = Math.sqrt(s[0] * s[0] + s[1] * s[1]);
    var sp = Math.sqrt(s[2] * s[2] + s[3] * s[3]);
    // separate automatic gain for each tone copes with radios that tilt the audio (pre-emphasis)
    this.mPeak = m > this.mPeak ? m : this.mPeak * this.decay;
    this.sPeak = sp > this.sPeak ? sp : this.sPeak * this.decay;
    var d = m / this.mPeak - sp / this.sPeak;

    // clock recovery: transitions pull the bit clock into line; sample half a bit later
    var prev = this.pll;
    this.pll = (this.pll + this.step) | 0;
    if (prev > 0 && this.pll < 0) this.bit(d > 0 ? 1 : 0);
    if ((d > 0) !== (this.prevD > 0)) this.pll = Math.round(this.pll * (this.olen >= 0 ? 0.74 : 0.5)) | 0;
    this.prevD = d;
  };
  Slicer.prototype.bit = function (raw) {
    var b = raw === this.lastRaw ? 1 : 0; // NRZI
    this.lastRaw = raw;
    this.pat = (this.pat >> 1) | (b << 7);
    this.bits++;
    if (this.pat === 0x7E) {
      this.flagRun = this.bits - this.lastFlag === 8 ? this.flagRun + 1 : 1;
      this.lastFlag = this.bits;
      if (this.flagRun >= 3) this.locked = true;
      if (this.locked && this.onActivity) this.onActivity();
      if (this.olen === 7 && this.buf.length >= 18) this.deliver();
      else if (this.locked && this.buf.length >= 10 && this.onBad) this.onBad(); // ended out of step: damaged
      this.olen = 0; this.buf = [];
    } else if (this.pat === 0xFE) {
      if (this.locked && this.buf.length >= 10 && this.onBad) this.onBad(); // a packet cut off part way
      this.olen = -1; this.buf = []; this.locked = false; // seven 1s: abort
    } else if ((this.pat & 0xFC) === 0x7C) {
      // a stuffed 0 after five 1s: drop it
    } else if (this.olen >= 0) {
      this.oacc = (this.oacc >> 1) | (b << 7);
      if (++this.olen === 8) {
        this.olen = 0;
        this.buf.push(this.oacc);
        if (this.buf.length > 400) { this.olen = -1; this.buf = []; this.locked = false; }
      }
    }
  };
  Slicer.prototype.deliver = function () {
    var b = this.buf, n = b.length;
    if (crc16(b, n - 2) === (b[n - 2] | (b[n - 1] << 8))) this.onFrame(new Uint8Array(b));
    else if (this.locked && this.onBad) this.onBad(); // a real transmission, but bits were damaged
  };

  // Demodulator: band-pass filter, then several slicers in parallel; duplicate frames are dropped.
  // opts.bauds lists the speeds to listen for at once, e.g. [1200, 300]; a sender can use either.
  function Demodulator(sampleRate, onFrame, opts) {
    opts = opts || {};
    var bauds = opts.bauds || [BAUD];
    this.fs = sampleRate;
    this.hp = new Biquad('hp', 700, 0.707, sampleRate); this.hp2 = new Biquad('hp', 700, 0.707, sampleRate);
    this.lp = new Biquad('lp', 2700, 0.707, sampleRate); this.lp2 = new Biquad('lp', 2700, 0.707, sampleRate);
    var self = this, recent = [];
    this.frames = 0;
    function got(frame, baud) {
      var key = Array.prototype.join.call(frame.subarray(frame.length - 2)) + ':' + frame.length;
      var now = self.t;
      for (var i = 0; i < recent.length; i++) if (recent[i].k === key && now - recent[i].t < sampleRate * 0.5) return;
      recent.push({ k: key, t: now });
      if (recent.length > 32) recent.shift();
      self.frames++; self.pendingBad = null; self.lastGood = self.t; self.lastBaud = baud;
      onFrame(frame, baud);
    }
    // Different window lengths trade noise against timing; together they match Direwolf on its own noise benchmark.
    this.slicers = [];
    bauds.forEach(function (baud) {
      [1, 1.2, 1.4, 1.6].forEach(function (w) { self.slicers.push(new Slicer(sampleRate, function (f) { got(f, baud); }, { window: w, baud: baud })); });
    });
    this.t = 0; this.level = 0; this.lastActivity = -Infinity;
    this.slicers.forEach(function (sl) {
      sl.onActivity = function () { self.lastActivity = self.t; };
      sl.onBad = function () {
        // ignore a decoder failing on a packet another decoder has just read
        if (self.t - self.lastGood < self.fs * 0.6) return;
        if (self.pendingBad == null && self.t - self.lastCounted > self.fs * 0.6) self.pendingBad = self.t;
      };
    });
    // A packet counts as damaged only if none of the decoders managed to read it.
    this.damaged = 0; this.pendingBad = null; this.lastCounted = -Infinity; this.lastGood = -Infinity;
  }
  // True while another station is transmitting. Runs of flags start and separate every packet, and no packet
  // here lasts much over a second, so the channel counts as busy until 1 s after the last run of flags.
  Demodulator.prototype.busy = function () { return this.t - this.lastActivity < this.fs * 1.0; };
  Demodulator.prototype.process = function (samples) {
    var sl = this.slicers, k = sl.length;
    for (var i = 0; i < samples.length; i++) {
      var x = this.lp2.run(this.lp.run(this.hp2.run(this.hp.run(samples[i]))));
      this.level = Math.max(Math.abs(samples[i]), this.level * 0.9995);
      for (var j = 0; j < k; j++) sl[j].push(x);
      this.t++;
    }
    if (this.pendingBad != null && this.t - this.pendingBad > this.fs * 0.3) { this.damaged++; this.pendingBad = null; this.lastCounted = this.t; }
  };

  /* ---------- Fountain-coded bulletins (random linear code over GF(2)) ----------
     The first k packets are the plain blocks. Every packet after that is the XOR of a random half of the blocks.
     A listener can rebuild the message from any k packets that are independent, which in practice means
     k plain-or-mixed packets plus one or two more, in any order. */
  var BLOCK = 64, HEADER = 9, TYPE_TEXT = 0x01, TYPE_BULLETIN = 0x02, TYPE_ACK = 0x03, TYPE_MSG = 0x04, TYPE_NEED = 0x05;
  // Bulletins are sent in the larger format: [0x06][id:2][blocks:2][length:3][flags:1][seed:2][64 bytes]. The older
  // format (0x02, one byte of block count) is still understood.
  var TYPE_BULLETIN2 = 0x06, HEADER2 = 11, MAX_BLOCKS = 65535, MAX_LENGTH = 16777215;

  function rng(seed) { // mulberry32
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Which source blocks are mixed into the packet with this seed, as a bit mask over k blocks.
  function mask(id, k, seed) {
    var words = new Uint32Array((k + 31) >> 5);
    if (seed < k) { words[seed >> 5] = 1 << (seed & 31); return words; }
    var r = rng((Math.imul(id, 2654435761) ^ Math.imul(seed, 40503) ^ 0x5EED) >>> 0), any = false;
    for (var i = 0; i < k; i++) if (r() < 0.5) { words[i >> 5] |= 1 << (i & 31); any = true; }
    if (!any) { var j = Math.floor(r() * k); words[j >> 5] |= 1 << (j & 31); }
    return words;
  }
  function hasBit(w, i) { return (w[i >> 5] >>> (i & 31)) & 1; }

  // Splits bytes into packets. extra = how many mixed packets to add on top of the k plain ones (fraction of k).
  function bulletinPackets(id, bytes, compressed, extra) {
    var k = Math.max(1, Math.ceil(bytes.length / BLOCK));
    if (k > MAX_BLOCKS || bytes.length > MAX_LENGTH) throw new Error('Too big to send: the most a single transfer can hold is 4 MB after compression');
    var blocks = [];
    for (var i = 0; i < k; i++) {
      var b = new Uint8Array(BLOCK);
      b.set(bytes.subarray(i * BLOCK, Math.min(bytes.length, (i + 1) * BLOCK)));
      blocks.push(b);
    }
    var total = k + Math.max(3, Math.ceil(k * (extra == null ? 1 : extra))), out = [];
    for (var seed = 0; seed < total; seed++) out.push(bulletinPacket(id, k, bytes.length, compressed, seed, blocks));
    return out;
  }
  function bulletinPacket(id, k, length, compressed, seed, blocks) {
    var data = new Uint8Array(BLOCK), m = mask(id, k, seed);
    for (var j = 0; j < k; j++) if (hasBit(m, j)) for (var x = 0; x < BLOCK; x++) data[x] ^= blocks[j][x];
    var p = new Uint8Array(HEADER2 + BLOCK);
    p[0] = TYPE_BULLETIN2; p[1] = id >> 8; p[2] = id & 0xFF; p[3] = k >> 8; p[4] = k & 0xFF;
    p[5] = (length >> 16) & 0xFF; p[6] = (length >> 8) & 0xFF; p[7] = length & 0xFF; p[8] = compressed ? 1 : 0;
    p[9] = seed >> 8; p[10] = seed & 0xFF;
    p.set(data, HEADER2);
    return p;
  }

  // Collects bulletin packets and rebuilds the message once enough independent ones have arrived.
  // Gaussian elimination kept in echelon form: each stored row has no bits below its pivot.
  function BulletinDecoder(id, k, length, compressed) {
    this.id = id; this.k = k; this.length = length; this.compressed = compressed;
    this.rows = new Array(k); this.rank = 0; this.seeds = {}; this.received = 0; this.solved = null;
    this.packets = []; // what arrived, so a half-received file can be saved and picked up again later
  }
  BulletinDecoder.prototype.add = function (seed, data) {
    if (this.seeds[seed] || this.done()) return false;
    this.seeds[seed] = 1; this.received++;
    this.packets.push([seed, new Uint8Array(data)]);
    var m = mask(this.id, this.k, seed), d = new Uint8Array(data), x;
    for (var c = 0; c < this.k; c++) {
      if (!hasBit(m, c)) continue;
      var row = this.rows[c];
      if (!row) {
        this.rows[c] = { m: m, d: d }; this.rank++;
        if (this.rank === this.k) this.solve();
        return true;
      }
      for (x = 0; x < m.length; x++) m[x] ^= row.m[x];
      for (x = 0; x < BLOCK; x++) d[x] ^= row.d[x];
    }
    return true; // arrived but added nothing new
  };
  BulletinDecoder.prototype.solve = function () {
    for (var c = this.k - 1; c >= 0; c--) {
      var row = this.rows[c];
      for (var j = c + 1; j < this.k; j++) {
        if (!hasBit(row.m, j)) continue;
        var other = this.rows[j];
        for (var x = 0; x < BLOCK; x++) row.d[x] ^= other.d[x];
        row.m[j >> 5] &= ~(1 << (j & 31));
      }
    }
    this.solved = true;
  };
  BulletinDecoder.prototype.done = function () { return !!this.solved; };
  Object.defineProperty(BulletinDecoder.prototype, 'knownCount', { get: function () { return this.rank; } });
  BulletinDecoder.prototype.bytes = function () {
    var out = new Uint8Array(this.k * BLOCK);
    for (var i = 0; i < this.k; i++) out.set(this.rows[i].d, i * BLOCK);
    return out.subarray(0, this.length);
  };
  // Produces a bulletin's packets one at a time, forever if needed: plain blocks first, then fresh mixes.
  // A file's id comes from its content, so sending the same file again (even after a reload) adds to the
  // copy a listener is already rebuilding, instead of starting a separate one. FNV-1a, folded to 16 bits.
  function contentId(bytes, compressed) {
    var h = 0x811C9DC5;
    for (var i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
    h ^= compressed ? 0xA5 : 0x5A; h = Math.imul(h, 0x01000193);
    return ((h >>> 16) ^ (h & 0xFFFF)) & 0xFFFF;
  }
  // startSeed lets a resend carry on with fresh packets rather than repeat ones already sent.
  function BulletinSender(id, bytes, compressed, startSeed) {
    this.id = id; this.bytes = bytes; this.compressed = compressed;
    this.k = Math.max(1, Math.ceil(bytes.length / BLOCK));
    if (this.k > MAX_BLOCKS || bytes.length > MAX_LENGTH) throw new Error('Too big to send: the most a single transfer can hold is 4 MB after compression');
    this.blocks = [];
    for (var i = 0; i < this.k; i++) {
      var b = new Uint8Array(BLOCK);
      b.set(bytes.subarray(i * BLOCK, Math.min(bytes.length, (i + 1) * BLOCK)));
      this.blocks.push(b);
    }
    this.seed = startSeed || 0;
  }
  BulletinSender.prototype.next = function () {
    if (this.seed > 65535) this.seed = this.k; // wrap round the mixed packets
    return bulletinPacket(this.id, this.k, this.bytes.length, this.compressed, this.seed++, this.blocks);
  };
  // A specific packet: seeds 0..k-1 are the plain blocks themselves, so packet(i) resends block i+1.
  BulletinSender.prototype.packet = function (seed) {
    return bulletinPacket(this.id, this.k, this.bytes.length, this.compressed, seed, this.blocks);
  };

  function parseBulletin(info) {
    if (info.length === HEADER2 + BLOCK && info[0] === TYPE_BULLETIN2)
      return { id: (info[1] << 8) | info[2], k: (info[3] << 8) | info[4], length: (info[5] << 16) | (info[6] << 8) | info[7],
               compressed: !!(info[8] & 1), seed: (info[9] << 8) | info[10], data: info.subarray(HEADER2) };
    if (info.length !== HEADER + BLOCK || info[0] !== TYPE_BULLETIN) return null;
    return { id: (info[1] << 8) | info[2], k: info[3], length: (info[4] << 8) | info[5], compressed: !!(info[6] & 1),
             seed: (info[7] << 8) | info[8], data: info.subarray(HEADER) };
  }

  /* ---------- What a bulletin carries: text, or a file with its name and type ---------- */
  function packContent(c) {
    var name = enc.encode((c.name || '').slice(0, 100)), type = enc.encode((c.type || '').slice(0, 100));
    var body = c.text != null ? enc.encode(c.text) : c.bytes;
    var out = new Uint8Array(3 + name.length + type.length + body.length), o = 0;
    out[o++] = c.text != null ? 0 : 1;
    out[o++] = name.length; out.set(name, o); o += name.length;
    out[o++] = type.length; out.set(type, o); o += type.length;
    out.set(body, o);
    return out;
  }
  function unpackContent(b) {
    var o = 1, nl = b[o++], name = dec.decode(b.subarray(o, o + nl)); o += nl;
    var tl = b[o++], type = dec.decode(b.subarray(o, o + tl)); o += tl;
    var body = b.subarray(o);
    return b[0] === 0 ? { text: dec.decode(body) } : { name: name, type: type, bytes: body };
  }

  // Seconds on air for frames of these byte lengths, sent in one transmission.
  function airtime(lengths, txDelayMs, baud) {
    baud = baud || BAUD;
    var bits = (txDelayMs == null ? 300 : txDelayMs) / 1000 * baud;
    for (var i = 0; i < lengths.length; i++) bits += (lengths[i] * 8 * 1.03) + 24;
    return bits / baud + 0.1;
  }

  /* ---------- Text helpers and compression ---------- */
  var enc = new TextEncoder(), dec = new TextDecoder();
  function textInfo(s) { var t = enc.encode(s), b = new Uint8Array(t.length + 1); b[0] = TYPE_TEXT; b.set(t, 1); return b; }
  // A short message with a 16-bit id, so the receiver can acknowledge it.
  function msgInfo(id, s) { var t = enc.encode(s), b = new Uint8Array(t.length + 3); b[0] = TYPE_MSG; b[1] = id >> 8; b[2] = id & 0xFF; b.set(t, 3); return b; }
  function parseMsg(info) { return info.length >= 3 && info[0] === TYPE_MSG ? { id: (info[1] << 8) | info[2], text: dec.decode(info.subarray(3)) } : null; }
  // "Got it": acknowledges a message or bulletin by its id. Sent back to the original sender.
  function ackInfo(id) { return new Uint8Array([TYPE_ACK, id >> 8, id & 0xFF]); }
  function parseAck(info) { return info.length === 3 && info[0] === TYPE_ACK ? { id: (info[1] << 8) | info[2] } : null; }
  // "Send me N more": a receiver missing pieces of a bulletin asks its sender for more packets.
  function needInfo(id, count) { return new Uint8Array([TYPE_NEED, id >> 8, id & 0xFF, Math.min(255, count)]); }
  function parseNeed(info) { return info.length === 4 && info[0] === TYPE_NEED ? { id: (info[1] << 8) | info[2], count: info[3] } : null; }
  function readText(info) {
    if (info[0] === TYPE_TEXT) return dec.decode(info.subarray(1));
    if (info[0] === TYPE_MSG && info.length >= 3) return dec.decode(info.subarray(3));
    if (info[0] === TYPE_ACK || info[0] === TYPE_NEED) return null;
    // plain APRS-style text from other software
    var printable = 0;
    for (var i = 0; i < info.length; i++) if (info[i] >= 32 && info[i] < 127) printable++;
    return printable >= info.length * 0.9 ? dec.decode(info) : null;
  }
  async function pipe(bytes, stream) {
    var res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await res.arrayBuffer());
  }
  async function compress(bytes) {
    if (typeof CompressionStream === 'undefined') return { bytes: bytes, compressed: false };
    var c = await pipe(bytes, new CompressionStream('deflate-raw'));
    return c.length < bytes.length ? { bytes: c, compressed: true } : { bytes: bytes, compressed: false };
  }
  async function decompress(bytes) { return pipe(bytes, new DecompressionStream('deflate-raw')); }

  return {
    BAUD: BAUD, MARK: MARK, SPACE: SPACE, BLOCK: BLOCK, MAX_BLOCKS: MAX_BLOCKS,
    crc16: crc16, parseCall: parseCall, buildFrame: buildFrame, parseFrame: parseFrame,
    modulate: modulate, Demodulator: Demodulator,
    bulletinPackets: bulletinPackets, BulletinDecoder: BulletinDecoder, BulletinSender: BulletinSender, parseBulletin: parseBulletin, contentId: contentId,
    packContent: packContent, unpackContent: unpackContent, airtime: airtime,
    textInfo: textInfo, readText: readText, msgInfo: msgInfo, parseMsg: parseMsg, ackInfo: ackInfo, parseAck: parseAck, needInfo: needInfo, parseNeed: parseNeed, compress: compress, decompress: decompress,
    encode: function (s) { return enc.encode(s); }, decode: function (b) { return dec.decode(b); }
  };
})();
if (typeof module !== 'undefined') module.exports = Modem;
