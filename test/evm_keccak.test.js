import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, functionSelector } from '../src/evm/keccak.js';

test('keccak256 of empty input matches known Ethereum vector', () => {
  // keccak256("") = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
  assert.equal(
    keccak256(new Uint8Array(0)),
    '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
});

test('keccak256 of "abc" matches known Ethereum vector', () => {
  // keccak256("abc") = 0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45
  assert.equal(
    keccak256(new TextEncoder().encode('abc')),
    '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  );
});

test('keccak256 accepts hex-string input', () => {
  // Hex "0x616263" is the bytes for "abc".
  assert.equal(
    keccak256('0x616263'),
    '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  );
});

test('functionSelector returns known Ethereum selectors', () => {
  assert.equal(functionSelector('getReserves()'), '0x0902f1ac');
  assert.equal(
    functionSelector('getAmountsOut(uint256,address[])'),
    '0xd06ca61f',
  );
  assert.equal(functionSelector('transfer(address,uint256)'), '0xa9059cbb');
});
