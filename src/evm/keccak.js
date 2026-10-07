// Pure-JS Keccak-256 (the Ethereum variant), implemented with BigInt-free
// 32-bit lane arithmetic for the sponge permutation.
//
// IMPORTANT: This is the ORIGINAL Keccak used by Ethereum, which pads the
// message with 0x01 (then 0x80 on the final byte of the rate block). It is
// NOT the FIPS-202 SHA3-256 variant, which pads with 0x06. node:crypto's
// 'sha3-256' is the FIPS-202 variant and therefore produces the WRONG digest
// for Ethereum function selectors, so we implement Keccak directly here.
//
// Keccak-256 parameters: rate = 1088 bits = 136 bytes, capacity = 512 bits.

// Round constants (RC) for the iota step, split into [low32, high32] because
// JS cannot do 64-bit bitwise ops on Numbers. 24 rounds.
const RC = [
  [0x00000001, 0x00000000], [0x00008082, 0x00000000],
  [0x0000808a, 0x80000000], [0x80008000, 0x80000000],
  [0x0000808b, 0x00000000], [0x80000001, 0x00000000],
  [0x80008081, 0x80000000], [0x00008009, 0x80000000],
  [0x0000008a, 0x00000000], [0x00000088, 0x00000000],
  [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
  [0x8000808b, 0x00000000], [0x0000008b, 0x80000000],
  [0x00008089, 0x80000000], [0x00008003, 0x80000000],
  [0x00008002, 0x80000000], [0x00000080, 0x80000000],
  [0x0000800a, 0x00000000], [0x8000000a, 0x80000000],
  [0x80008081, 0x80000000], [0x00008080, 0x80000000],
  [0x80000001, 0x00000000], [0x80008008, 0x80000000],
];

// Rotation offsets for the rho step, laid out by lane index (x + 5*y).
const RHO = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

// Rotate a 64-bit lane (represented as [lo, hi] 32-bit words) left by n bits.
function rotl64(lo, hi, n) {
  n &= 63;
  if (n === 0) return [lo >>> 0, hi >>> 0];
  if (n === 32) return [hi >>> 0, lo >>> 0];
  if (n < 32) {
    const nlo = ((lo << n) | (hi >>> (32 - n))) >>> 0;
    const nhi = ((hi << n) | (lo >>> (32 - n))) >>> 0;
    return [nlo, nhi];
  }
  // n > 32
  const m = n - 32;
  const nlo = ((hi << m) | (lo >>> (32 - m))) >>> 0;
  const nhi = ((lo << m) | (hi >>> (32 - m))) >>> 0;
  return [nlo, nhi];
}

// The Keccak-f[1600] permutation operating on 25 lanes, each a [lo, hi] pair.
function keccakF(state) {
  const bc = new Array(10); // 5 lanes of [lo, hi]
  for (let round = 0; round < 24; round++) {
    // Theta
    for (let x = 0; x < 5; x++) {
      let lo = 0, hi = 0;
      for (let y = 0; y < 5; y++) {
        const idx = (x + 5 * y) * 2;
        lo ^= state[idx];
        hi ^= state[idx + 1];
      }
      bc[x * 2] = lo >>> 0;
      bc[x * 2 + 1] = hi >>> 0;
    }
    for (let x = 0; x < 5; x++) {
      const r = rotl64(bc[((x + 1) % 5) * 2], bc[((x + 1) % 5) * 2 + 1], 1);
      const tlo = (bc[((x + 4) % 5) * 2] ^ r[0]) >>> 0;
      const thi = (bc[((x + 4) % 5) * 2 + 1] ^ r[1]) >>> 0;
      for (let y = 0; y < 5; y++) {
        const idx = (x + 5 * y) * 2;
        state[idx] = (state[idx] ^ tlo) >>> 0;
        state[idx + 1] = (state[idx + 1] ^ thi) >>> 0;
      }
    }

    // Rho + Pi
    let loCur = state[2];
    let hiCur = state[3];
    let x = 1, y = 0;
    for (let t = 0; t < 24; t++) {
      const newX = y;
      const newY = (2 * x + 3 * y) % 5;
      const destIdx = (newX + 5 * newY) * 2;
      const laneIdx = x + 5 * y;
      const saveLo = state[destIdx];
      const saveHi = state[destIdx + 1];
      const r = rotl64(loCur, hiCur, RHO[laneIdx]);
      state[destIdx] = r[0];
      state[destIdx + 1] = r[1];
      loCur = saveLo;
      hiCur = saveHi;
      x = newX;
      y = newY;
    }

    // Chi
    for (let yy = 0; yy < 5; yy++) {
      const base = yy * 5;
      for (let xx = 0; xx < 5; xx++) {
        bc[xx * 2] = state[(base + xx) * 2];
        bc[xx * 2 + 1] = state[(base + xx) * 2 + 1];
      }
      for (let xx = 0; xx < 5; xx++) {
        const idx = (base + xx) * 2;
        const nlo = bc[((xx + 1) % 5) * 2];
        const nhi = bc[((xx + 1) % 5) * 2 + 1];
        const n2lo = bc[((xx + 2) % 5) * 2];
        const n2hi = bc[((xx + 2) % 5) * 2 + 1];
        state[idx] = (bc[xx * 2] ^ ((~nlo) & n2lo)) >>> 0;
        state[idx + 1] = (bc[xx * 2 + 1] ^ ((~nhi) & n2hi)) >>> 0;
      }
    }

    // Iota
    state[0] = (state[0] ^ RC[round][0]) >>> 0;
    state[1] = (state[1] ^ RC[round][1]) >>> 0;
  }
}

// Normalize input into a Uint8Array. Accepts Uint8Array, Buffer-like, or a
// hex string (with or without 0x prefix).
function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string') {
    let s = input;
    if (s.startsWith('0x') || s.startsWith('0X')) s = s.slice(2);
    if (s.length % 2 !== 0) {
      throw new Error('keccak256: hex string must have an even length');
    }
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) {
      const byte = parseInt(s.substr(i * 2, 2), 16);
      if (Number.isNaN(byte)) {
        throw new Error('keccak256: invalid hex string');
      }
      out[i] = byte;
    }
    return out;
  }
  throw new Error('keccak256: unsupported input type');
}

const RATE = 136; // bytes for keccak-256

/**
 * Compute Keccak-256 (Ethereum variant) of the input.
 * @param {Uint8Array|string} input bytes or hex string.
 * @returns {string} 0x-prefixed 32-byte (64 hex char) digest.
 */
export function keccak256(input) {
  const msg = toBytes(input);

  // Pad: multi-rate padding "pad10*1" using the Keccak domain byte 0x01.
  const padLen = RATE - (msg.length % RATE);
  const padded = new Uint8Array(msg.length + padLen);
  padded.set(msg, 0);
  padded[msg.length] ^= 0x01;          // Keccak padding start (NOT 0x06)
  padded[padded.length - 1] ^= 0x80;   // final bit of the pad

  // State: 25 lanes × 2 (lo, hi) 32-bit words.
  const state = new Int32Array(50);

  for (let offset = 0; offset < padded.length; offset += RATE) {
    // Absorb one rate-sized block, XORing bytes into the state (little-endian).
    for (let i = 0; i < RATE; i++) {
      const byte = padded[offset + i];
      const lane = (i >> 3);         // which 64-bit lane
      const bytePos = i & 7;         // byte position within the lane
      const wordIdx = lane * 2 + (bytePos < 4 ? 0 : 1);
      const shift = (bytePos & 3) * 8;
      state[wordIdx] = (state[wordIdx] ^ (byte << shift)) >>> 0;
    }
    keccakF(state);
  }

  // Squeeze: first 32 bytes of the state (little-endian per lane).
  let out = '';
  for (let i = 0; i < 32; i++) {
    const lane = (i >> 3);
    const bytePos = i & 7;
    const wordIdx = lane * 2 + (bytePos < 4 ? 0 : 1);
    const shift = (bytePos & 3) * 8;
    const byte = (state[wordIdx] >>> shift) & 0xff;
    out += byte.toString(16).padStart(2, '0');
  }
  return '0x' + out;
}

// UTF-8 encode a string into bytes.
const UTF8 = new TextEncoder();

/**
 * Compute the 4-byte Ethereum function selector for a signature string.
 * @param {string} signature e.g. "transfer(address,uint256)".
 * @returns {string} 0x-prefixed 4-byte selector.
 */
export function functionSelector(signature) {
  const digest = keccak256(UTF8.encode(signature));
  return '0x' + digest.slice(2, 10);
}
