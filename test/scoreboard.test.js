import test from 'node:test';
import assert from 'node:assert/strict';

import {
  marketKey,
  emptyScoreboard,
  updateScoreboard,
  rankMarkets,
  selectBatch,
} from '../sim/scoreboard.mjs';

// ---------------------------------------------------------------------------
// marketKey is a stable, case-insensitive id.
// ---------------------------------------------------------------------------
test('marketKey is stable and case-insensitive', () => {
  const a = marketKey({ chain: 'arbitrum', pair: 'WETH/USDC', dexPair: 'uniswap<->sushi' });
  const b = marketKey({ chain: 'ARBITRUM', pair: 'weth/usdc', dexPair: 'UNISWAP<->SUSHI' });
  assert.equal(a, b, 'same market -> same key regardless of casing');
  assert.equal(a, 'arbitrum|weth/usdc|uniswap<->sushi');
});

// ---------------------------------------------------------------------------
// updateScoreboard: increments timesChecked, tracks bestGap (max), computes
// medianGap from retained samples, sets lastChecked, and does NOT mutate input.
// ---------------------------------------------------------------------------
test('updateScoreboard is immutable and tracks the right stats', () => {
  const key = marketKey({ chain: 'arbitrum', pair: 'WETH/USDC', dexPair: 'uniswap<->sushi' });
  const board0 = emptyScoreboard();

  const board1 = updateScoreboard(board0, { chain: 'arbitrum', pair: 'WETH/USDC', dexPair: 'uniswap<->sushi', gapBps: 10, ts: 100 });
  // input not mutated
  assert.deepEqual(board0, { version: 1, markets: {} }, 'original board untouched');
  assert.notEqual(board1, board0, 'a new board object is returned');

  const m1 = board1.markets[key];
  assert.equal(m1.timesChecked, 1);
  assert.equal(m1.bestGap, 10);
  assert.equal(m1.medianGap, 10);
  assert.equal(m1.lastGap, 10);
  assert.equal(m1.lastChecked, 100);

  // second observation: larger gap -> bestGap updates, median of [10,30]=20
  const board2 = updateScoreboard(board1, { key, chain: 'arbitrum', pair: 'WETH/USDC', dexPair: 'uniswap<->sushi', gapBps: 30, ts: 200 });
  assert.equal(board1.markets[key].timesChecked, 1, 'board1 not mutated by the second update');
  const m2 = board2.markets[key];
  assert.equal(m2.timesChecked, 2);
  assert.equal(m2.bestGap, 30, 'bestGap is the max seen');
  assert.equal(m2.medianGap, 20, 'median of [10,30] is 20');
  assert.equal(m2.lastGap, 30);
  assert.equal(m2.lastChecked, 200);

  // third observation: smaller gap -> bestGap stays, median of [10,30,5] (sorted 5,10,30)=10
  const board3 = updateScoreboard(board2, { key, gapBps: 5, ts: 300 });
  const m3 = board3.markets[key];
  assert.equal(m3.timesChecked, 3);
  assert.equal(m3.bestGap, 30, 'bestGap unchanged by a smaller gap');
  assert.equal(m3.medianGap, 10, 'median of [5,10,30] is 10');
  assert.equal(m3.lastGap, 5);
});

// ---------------------------------------------------------------------------
// updateScoreboard caps the sample window (last 50) for the running median.
// ---------------------------------------------------------------------------
test('updateScoreboard caps the retained samples at 50', () => {
  const key = 'c|p|d';
  let board = emptyScoreboard();
  for (let i = 1; i <= 60; i++) board = updateScoreboard(board, { key, gapBps: i, ts: i });
  const m = board.markets[key];
  assert.equal(m.timesChecked, 60);
  assert.equal(m.bestGap, 60);
  assert.equal(m.samples.length, 50, 'only the last 50 samples are retained');
  assert.equal(m.samples[0], 11, 'oldest retained sample is the 11th observation');
  // median of 11..60 (50 values) -> average of 35th and 36th sorted = (35+36)/2? samples are 11..60
  // sorted ascending they are 11..60; mid indices 24,25 -> values 35,36 -> 35.5
  assert.equal(m.medianGap, 35.5);
});

// ---------------------------------------------------------------------------
// rankMarkets orders by bestGap desc with the documented tie-break + ranks.
// ---------------------------------------------------------------------------
test('rankMarkets orders by bestGap desc (tie-break medianGap) and assigns ranks', () => {
  let board = emptyScoreboard();
  board = updateScoreboard(board, { key: 'low', gapBps: 5, ts: 1 });
  board = updateScoreboard(board, { key: 'high', gapBps: 50, ts: 1 });
  // two markets tie on bestGap=20 but differ on medianGap
  board = updateScoreboard(board, { key: 'tieA', gapBps: 20, ts: 1 });
  board = updateScoreboard(board, { key: 'tieA', gapBps: 20, ts: 2 }); // median 20
  board = updateScoreboard(board, { key: 'tieB', gapBps: 20, ts: 1 });
  board = updateScoreboard(board, { key: 'tieB', gapBps: 0, ts: 2 });  // median 10

  const ranked = rankMarkets(board);
  assert.deepEqual(ranked.map((m) => m.key), ['high', 'tieA', 'tieB', 'low']);
  assert.deepEqual(ranked.map((m) => m.rank), [1, 2, 3, 4], 'sequential 1-based ranks');
});

// ---------------------------------------------------------------------------
// selectBatch: biases toward top-ranked markets AND guarantees the long tail
// (stale / never-seen keys) is scanned, never duplicating a key.
// ---------------------------------------------------------------------------
test('selectBatch biases to top rank but covers stale/never-seen without duplicates', () => {
  let board = emptyScoreboard();
  // HOT: big gap, checked very recently (top-ranked, but fresh)
  board = updateScoreboard(board, { key: 'hot', gapBps: 100, ts: 1000 });
  // WARM: medium gap, checked a while ago (stale-ish)
  board = updateScoreboard(board, { key: 'warm', gapBps: 50, ts: 100 });
  // COLD: tiny gap, checked long ago (very stale)
  board = updateScoreboard(board, { key: 'cold', gapBps: 1, ts: 10 });

  // allKeys includes a brand-new market never seen before
  const allKeys = ['hot', 'warm', 'cold', 'brandnew'];
  const batch = selectBatch(board, { batchSize: 2, allKeys, now: 1000, staleMs: 500 });

  assert.equal(batch.length, 2, 'at most batchSize keys');
  assert.equal(new Set(batch).size, batch.length, 'no duplicate keys');
  assert.ok(batch.includes('hot'), 'the top-ranked market is exploited');
  // explore slot should be a stale or never-seen key, not the fresh "hot"
  const exploreKey = batch.find((k) => k !== 'hot');
  assert.ok(['brandnew', 'cold', 'warm'].includes(exploreKey), 'explore slot covers the long tail');
  // brandnew (never-seen) is maximally stale -> it must win the explore slot here
  assert.equal(exploreKey, 'brandnew', 'never-before-seen market is picked up first (not starved)');
});

test('selectBatch returns unique keys up to batchSize across the universe', () => {
  let board = emptyScoreboard();
  const keys = [];
  for (let i = 0; i < 10; i++) {
    const k = 'm' + i;
    keys.push(k);
    board = updateScoreboard(board, { key: k, gapBps: i, ts: i });
  }
  const batch = selectBatch(board, { batchSize: 4, allKeys: keys, now: 100, staleMs: 0 });
  assert.equal(batch.length, 4);
  assert.equal(new Set(batch).size, 4, 'all unique');
  // highest bestGap is m9 -> must appear via the exploit half
  assert.ok(batch.includes('m9'), 'top-ranked market present');
  // least-recently-checked is m0 -> must appear via the explore half
  assert.ok(batch.includes('m0'), 'least-recently-checked market present');
});

test('selectBatch returns empty for zero batchSize or empty universe', () => {
  const board = emptyScoreboard();
  assert.deepEqual(selectBatch(board, { batchSize: 0, allKeys: ['a'] }), []);
  assert.deepEqual(selectBatch(board, { batchSize: 3, allKeys: [] }), []);
});
