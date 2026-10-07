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

test('clean rows are ordered by net descending and come before suspicious', () => {
  const ranked = rankCandidates(mixed());
  const clean = ranked.filter((r) => r.trapVerdict === 'ok');
  const nets = clean.map((r) => r.net);
  const sorted = [...nets].sort((a, b) => b - a);
  assert.deepEqual(nets, sorted);
  // Best CLEAN survivor first (not the higher-net suspicious row).
  assert.equal(clean[0].pair, 'cbETH/WETH');
});

test('a suspicious soft-trap row never outranks a clean survivor', () => {
  // DEGEN/WETH is suspicious with net 40. It must sit BELOW every clean row,
  // including the clean but NEGATIVE-net DAI/USDC (net -5): a soft trap is not
  // a clean opportunity regardless of its (often overstated) net.
  const ranked = rankCandidates(mixed());
  const clean = ranked.filter((r) => r.trapVerdict === 'ok');
  const suspicious = ranked.filter((r) => r.trapVerdict === 'suspicious');
  const avoided = ranked.filter((r) => r.trapVerdict === 'avoid');

  const lastCleanIdx = ranked.indexOf(clean[clean.length - 1]);
  const degenIdx = ranked.indexOf(suspicious[0]);
  assert.equal(suspicious[0].pair, 'DEGEN/WETH');
  assert.ok(degenIdx > lastCleanIdx, 'suspicious ranks below all clean rows');
  assert.equal(suspicious[0].rowVerdict, 'suspicious');
  assert.equal(suspicious[0].actionable, false);

  // Avoid rows remain at the very bottom, below suspicious.
  const firstAvoidIdx = ranked.indexOf(avoided[0]);
  assert.ok(firstAvoidIdx > degenIdx, 'avoid ranks below suspicious');
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
  // DEGEN/WETH is a soft trap: its verdict is 'suspicious', NOT the net ladder.
  assert.equal(byPair['DEGEN/WETH'].rowVerdict, 'suspicious'); // trap wins
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
  // A soft trap maps to 'suspicious' regardless of net sign/size: a high net
  // must NOT present a suspicious pair as 'profitable'.
  assert.equal(rowVerdict(1000, 'suspicious', 1), 'suspicious');
  assert.equal(rowVerdict(-5, 'suspicious', 1), 'suspicious');
});

test('accepts trapVerdict shorthand field as well as trap.verdict', () => {
  const ranked = rankCandidates([
    { pair: 'A', net: 10, trapVerdict: 'avoid' },
    { pair: 'B', net: 5, trapVerdict: 'ok' },
  ]);
  assert.equal(ranked[0].pair, 'B');
  assert.equal(ranked[ranked.length - 1].pair, 'A');
});
