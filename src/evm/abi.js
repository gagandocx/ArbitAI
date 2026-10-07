// Minimal, bounded ABI encoder/decoder for the exact set of types this
// project needs. This is NOT a general-purpose ABI library — it supports only:
//
//   - address      (20-byte, right-aligned in a 32-byte word)
//   - uint112      (unsigned, same wire format as uint256)
//   - uint256      (unsigned 256-bit, native BigInt)
//   - bool         (0 or 1 in a 32-byte word)
//   - uint256[]    (dynamic array of uint256)
//
// It follows the Solidity ABI spec: each "head" slot is 32 bytes; dynamic
// types (here only uint256[]) place a 32-byte offset in the head pointing to a
// tail that holds the length followed by the elements.
//
// All big integers use native BigInt. The function selector comes from the
// keccak-256 helper so no external crypto dependency is required.

import { functionSelector } from './keccak.js';

const WORD = 32; // bytes per ABI word
const SUPPORTED = new Set(['address', 'uint112', 'uint256', 'bool', 'uint256[]']);

function assertSupported(type) {
  if (!SUPPORTED.has(type)) {
    throw new Error(`abi: unsupported type "${type}"`);
  }
}

function isDynamic(type) {
  return type === 'uint256[]';
}

// --- hex helpers ------------------------------------------------------------

function stripHex(hex) {
  if (typeof hex !== 'string') throw new Error('abi: expected hex string');
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

function hexToBytes(hex) {
  const s = stripHex(hex);
  if (s.length % 2 !== 0) throw new Error('abi: odd-length hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// Encode a non-negative BigInt into a left-padded 32-byte word (hex, no 0x).
function uintToWord(value) {
  let v;
  try {
    v = BigInt(value);
  } catch {
    throw new Error(`abi: cannot convert "${value}" to BigInt`);
  }
  if (v < 0n) throw new Error('abi: negative value not supported');
  const hex = v.toString(16);
  if (hex.length > 64) throw new Error('abi: uint value exceeds 256 bits');
  return hex.padStart(64, '0');
}

// Encode a single static value (address, uint*, bool) into one 32-byte word.
function encodeStaticWord(type, value) {
  switch (type) {
    case 'address': {
      const s = stripHex(String(value)).toLowerCase();
      if (s.length !== 40) throw new Error('abi: address must be 20 bytes');
      if (!/^[0-9a-f]+$/.test(s)) throw new Error('abi: invalid address hex');
      return s.padStart(64, '0');
    }
    case 'uint112':
    case 'uint256':
      return uintToWord(value);
    case 'bool':
      return (value ? 1n : 0n).toString(16).padStart(64, '0');
    default:
      throw new Error(`abi: encodeStaticWord cannot handle "${type}"`);
  }
}

// Encode a uint256[] tail: length word + one word per element.
function encodeUintArrayTail(values) {
  if (!Array.isArray(values)) throw new Error('abi: uint256[] expects an array');
  let out = uintToWord(values.length);
  for (const v of values) out += uintToWord(v);
  return out;
}

/**
 * Encode a function call into 0x-prefixed calldata.
 * @param {string} signature e.g. "getAmountsOut(uint256,address[])".
 * @param {string[]} argTypes supported type names in order.
 * @param {any[]} argValues values matching argTypes.
 * @returns {string} 0x calldata (selector + ABI-encoded args).
 */
export function encodeFunctionCall(signature, argTypes, argValues) {
  const selector = functionSelector(signature); // 0x + 8 hex
  return selector + encodeParameters(argTypes, argValues);
}

/**
 * Encode a tuple of parameters (no selector) to a hex string WITHOUT 0x prefix.
 * Exposed for building/inspecting calldata and for tests.
 */
export function encodeParameters(argTypes, argValues) {
  if (argTypes.length !== argValues.length) {
    throw new Error('abi: argTypes/argValues length mismatch');
  }
  argTypes.forEach(assertSupported);

  const headWords = argTypes.length;
  let head = '';
  let tail = '';

  for (let i = 0; i < argTypes.length; i++) {
    const type = argTypes[i];
    if (isDynamic(type)) {
      // Head holds the byte offset to this arg's tail data.
      const offsetBytes = headWords * WORD + tail.length / 2;
      head += uintToWord(offsetBytes);
      tail += encodeUintArrayTail(argValues[i]);
    } else {
      head += encodeStaticWord(type, argValues[i]);
    }
  }

  return head + tail;
}

// --- decoding ---------------------------------------------------------------

function wordAt(bytes, byteOffset) {
  if (byteOffset + WORD > bytes.length) {
    throw new Error('abi: data too short while decoding');
  }
  return bytes.subarray(byteOffset, byteOffset + WORD);
}

function wordToBigInt(word) {
  return BigInt('0x' + bytesToHex(word));
}

function decodeStaticWord(type, word) {
  switch (type) {
    case 'address':
      // Lower 20 bytes, re-prefixed with 0x.
      return '0x' + bytesToHex(word.subarray(12, 32));
    case 'uint112':
    case 'uint256':
      return wordToBigInt(word);
    case 'bool':
      return wordToBigInt(word) !== 0n;
    default:
      throw new Error(`abi: decodeStaticWord cannot handle "${type}"`);
  }
}

/**
 * Decode ABI-encoded return data into JS values.
 * @param {string[]} returnTypes supported type names in order.
 * @param {string} hexdata 0x-prefixed (or bare) ABI return data.
 * @returns {any[]} decoded values matching returnTypes.
 */
export function decodeResult(returnTypes, hexdata) {
  returnTypes.forEach(assertSupported);
  const bytes = hexToBytes(hexdata);

  const out = [];
  for (let i = 0; i < returnTypes.length; i++) {
    const type = returnTypes[i];
    const headOffset = i * WORD;
    if (isDynamic(type)) {
      // Read the offset to the tail, then length + elements.
      const offset = Number(wordToBigInt(wordAt(bytes, headOffset)));
      const length = Number(wordToBigInt(wordAt(bytes, offset)));
      const arr = [];
      for (let j = 0; j < length; j++) {
        arr.push(wordToBigInt(wordAt(bytes, offset + WORD + j * WORD)));
      }
      out.push(arr);
    } else {
      out.push(decodeStaticWord(type, wordAt(bytes, headOffset)));
    }
  }
  return out;
}
