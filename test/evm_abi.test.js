import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeFunctionCall,
  encodeParameters,
  decodeResult,
} from '../src/evm/abi.js';

const ADDR_A = '0x1111111111111111111111111111111111111111';
const ADDR_B = '0x2222222222222222222222222222222222222222';

test('round-trips a uint256', () => {
  const encoded = encodeParameters(['uint256'], [123456789n]);
  const [value] = decodeResult(['uint256'], '0x' + encoded);
  assert.equal(value, 123456789n);
});

test('round-trips a uint112', () => {
  const big = (1n << 111n) + 7n;
  const encoded = encodeParameters(['uint112'], [big]);
  const [value] = decodeResult(['uint112'], '0x' + encoded);
  assert.equal(value, big);
});

test('round-trips an address (lower-cased, left-padded)', () => {
  const encoded = encodeParameters(['address'], [ADDR_A]);
  const [value] = decodeResult(['address'], '0x' + encoded);
  assert.equal(value, ADDR_A);
});

test('round-trips a bool (true and false)', () => {
  for (const b of [true, false]) {
    const encoded = encodeParameters(['bool'], [b]);
    const [value] = decodeResult(['bool'], '0x' + encoded);
    assert.equal(value, b);
  }
});

test('round-trips a uint256[] dynamic array', () => {
  const arr = [1n, 2n, 1000000000000000000n];
  const encoded = encodeParameters(['uint256[]'], [arr]);
  const [value] = decodeResult(['uint256[]'], '0x' + encoded);
  assert.deepEqual(value, arr);
});

test('round-trips a getReserves-style tuple (uint112,uint112,uint256)', () => {
  const reserve0 = 123456789012345678901234n;
  const reserve1 = 987654321098765432109876n;
  const ts = 1700000000n;
  const encoded = encodeParameters(
    ['uint112', 'uint112', 'uint256'],
    [reserve0, reserve1, ts],
  );
  const [r0, r1, t] = decodeResult(['uint112', 'uint112', 'uint256'], '0x' + encoded);
  assert.equal(r0, reserve0);
  assert.equal(r1, reserve1);
  assert.equal(t, ts);
});

test('encodes getAmountsOut(uint256,address[]) to the expected hand-computed calldata', () => {
  // Signature selector is keccak256-derived: 0xd06ca61f.
  // Args: amountIn = 1e18, path = [ADDR_A, ADDR_B].
  // Head: [amountIn word][offset word = 0x40].
  // Tail: [length = 2][ADDR_A word][ADDR_B word].
  // NOTE: address[] is encoded here via explicit uint-array layout for the
  // offset check; the codec itself only ships address/uint*/bool/uint256[].
  // We therefore hand-build the calldata string to pin the wire format.
  const selector = '0xd06ca61f';
  const amountIn =
    '0000000000000000000000000000000000000000000000000de0b6b3a7640000'; // 1e18
  const offset =
    '0000000000000000000000000000000000000000000000000000000000000040'; // 64
  const length =
    '0000000000000000000000000000000000000000000000000000000000000002';
  const addrAWord =
    '0000000000000000000000001111111111111111111111111111111111111111';
  const addrBWord =
    '0000000000000000000000002222222222222222222222222222222222222222';
  const expected = selector + amountIn + offset + length + addrAWord + addrBWord;

  // Build the equivalent calldata through the codec: encode amountIn (uint256)
  // and the address path modeled as a uint256[] of the address integer values,
  // which produces an identical wire layout to Solidity's address[].
  const pathAsUints = [BigInt(ADDR_A), BigInt(ADDR_B)];
  const calldata = encodeFunctionCall(
    'getAmountsOut(uint256,address[])',
    ['uint256', 'uint256[]'],
    [1000000000000000000n, pathAsUints],
  );

  assert.equal(calldata, expected);
});

test('decodes a getAmountsOut-style result (uint256[] amounts)', () => {
  const amounts = [1000000000000000000n, 3300000000n];
  const encoded = encodeParameters(['uint256[]'], [amounts]);
  const [decoded] = decodeResult(['uint256[]'], '0x' + encoded);
  assert.deepEqual(decoded, amounts);
});
