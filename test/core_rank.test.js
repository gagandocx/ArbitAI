import test from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates, rowVerdict } from '../src/core/rank.js';

const mixed = () => [
  { pair: 'WETH/USDC', net: 120, trap: { verdict: 'ok' } },
  { pair: 'SCAM/USDC', net: 999, trap: { verdict: 'avoid' } }, // huge net but trap
  { pair: 'DEGEN/WETH', net: 40, trap: { verdict: 'suspicious' } },
  { pair: 'DAI/USDC', net: -5, trap: { verdict: 'ok' } },
  { pair: 'cbETH/WETH', net: 300, trap: { verdict: 'ok' } },
];

test('survivors are ordered by net descending', () => {
  const ranked = rankCandidates(mixed());
  const survivors = ranked.filter((r) => r.trapVerdict !== 'avoid');
  const nets = survivors.map((r) => r.net);
  const sorted = [...nets].sort((a, b) => b - a);
  assert.deepEqual(nets, sorted);
  // Best survivor first.
  assert.equal(survivors[0].pair, 'cbETH/WETH');
});

test('avoid rows are demoted to the bottom even with the highest net', () => {
  const ranked = rankCandidates(mixed());
  const last = ranked[ranked.length - 1];
  assert.equal(last.pair, 'SCAM/USDC');
  assert.equal(last.trapVerdict, 'avoid');
  assert.equal(last.rowVerdict, 'trap/avoid');
  assert.equal(last.actionable, false);
});

test('excludeAvoid drops trap rows entirely', () => {
  const ranked = rankCandidates(mixed(), { excludeAvoid: true });
  assert.ok(!ranked.some((r) => r.pair === 'SCAM/USDC'));
  assert.equal(ranked.length, 4);
});

test('per-row verdict combines net sign and trap verdict', () => {
  const ranked = rankCandidates(mixed(), { marginalNetFloor: 50 });
  const byPair = Object.fromEntries(ranked.map((r) => [r.pair, r]));
  assert.equal(byPair['cbETH/WETH'].rowVerdict, 'profitable'); // net 300 >= 50
  assert.equal(byPair['DEGEN/WETH'].rowVerdict, 'marginal'); // net 40, 0<40<50
  assert.equal(byPair['DAI/USDC'].rowVerdict, 'unprofitable'); // net -5
  assert.equal(byPair['SCAM/USDC'].rowVerdict, 'trap/avoid');
});

test('actionable flag is true only for non-avoid rows with positive net', () => {
  const ranked = rankCandidates(mixed());
  const byPair = Object.fromEntries(ranked.map((r) => [r.pair, r]));
  assert.equal(byPair['cbETH/WETH'].actionable, true);
  assert.equal(byPair['DAI/USDC'].actionable, false); // net negative
  assert.equal(byPair['SCAM/USDC'].actionable, false); // trap
});

test('rowVerdict helper is pure and matches the mapping', () => {
  assert.equal(rowVerdict(100, 'ok', 1), 'profitable');
  assert.equal(rowVerdict(0.5, 'ok', 1), 'marginal');
  assert.equal(rowVerdict(0, 'ok', 1), 'unprofitable');
  assert.equal(rowVerdict(1000, 'avoid', 1), 'trap/avoid');
});

test('accepts trapVerdict shorthand field as well as trap.verdict', () => {
  const ranked = rankCandidates([
    { pair: 'A', net: 10, trapVerdict: 'avoid' },
    { pair: 'B', net: 5, trapVerdict: 'ok' },
  ]);
  assert.equal(ranked[0].pair, 'B');
  assert.equal(ranked[ranked.length - 1].pair, 'A');
});
