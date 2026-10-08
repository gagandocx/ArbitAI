import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyScoreboard, updateScoreboard } from '../sim/scoreboard.mjs';
import { aggregateTopGaps, renderTopGapsTable } from '../sim/gaps.mjs';
import { isRateLimited, nextBackoffMs, decideScanDelayMs, makeThrottle } from '../sim/backoff.mjs';

// ---------------------------------------------------------------------------
// aggregateTopGaps: ranked rows by bestGap desc, limited.
// ---------------------------------------------------------------------------
test('aggregateTopGaps sorts by bestGap desc and respects the limit', () => {
  let board = emptyScoreboard();
  board = updateScoreboard(board, { key: 'k1', chain: 'arbitrum', pair: 'WETH/USDC', dexPair: 'uni<->sushi', gapBps: 10, ts: 1 });
  board = updateScoreboard(board, { key: 'k2', chain: 'base', pair: 'WETH/USDC', dexPair: 'uni<->pancake', gapBps: 90, ts: 2 });
  board = updateScoreboard(board, { key: 'k3', chain: 'arbitrum', pair: 'WBTC/USDC', dexPair: 'uni<->sushi', gapBps: 50, ts: 3 });

  const all = aggregateTopGaps(board, { limit: 10 });
  assert.deepEqual(all.map((r) => r.bestGap), [90, 50, 10], 'sorted by bestGap desc');
  assert.equal(all[0].chain, 'base');
  assert.equal(all[0].pair, 'WETH/USDC');
  assert.equal(all[0].dexPair, 'uni<->pancake');
  assert.equal(all[0].timesSeen, 1);
  assert.equal(all[0].lastSeen, 2);
  assert.ok(!('key' in all[0]), 'internal key is not leaked into the output rows');

  const limited = aggregateTopGaps(board, { limit: 2 });
  assert.equal(limited.length, 2, 'limited to the requested number');
  assert.deepEqual(limited.map((r) => r.bestGap), [90, 50]);
});

// ---------------------------------------------------------------------------
// renderTopGapsTable: Markdown table with the expected header columns.
// ---------------------------------------------------------------------------
test('renderTopGapsTable emits a Markdown table with the expected headers', () => {
  let board = emptyScoreboard();
  board = updateScoreboard(board, { key: 'k1', chain: 'arbitrum', pair: 'WETH/USDC', dexPair: 'uni<->sushi', gapBps: 12.5, ts: 42 });
  const rows = aggregateTopGaps(board, { limit: 5 });
  const md = renderTopGapsTable(rows);
  const lines = md.split('\n');

  assert.ok(lines[0].includes('chain'), 'header has chain');
  assert.ok(lines[0].includes('pair'), 'header has pair');
  assert.ok(lines[0].includes('DEX pair'), 'header has DEX pair');
  assert.ok(lines[0].includes('best gap'), 'header has best gap');
  assert.ok(lines[0].includes('median gap'), 'header has median gap');
  assert.ok(lines[0].includes('times seen'), 'header has times seen');
  assert.ok(lines[0].includes('last seen'), 'header has last seen');
  assert.ok(/^\|\s*---/.test(lines[1]), 'second line is the Markdown separator row');
  assert.ok(lines[2].includes('arbitrum') && lines[2].includes('WETH/USDC') && lines[2].includes('12.50'),
    'data row renders the market with 2dp gap');
});

// ---------------------------------------------------------------------------
// isRateLimited: detects 429 / "Too Many Requests" / "rate limit"; rejects others.
// ---------------------------------------------------------------------------
test('isRateLimited detects 429 / rate-limit messages and rejects unrelated errors', () => {
  assert.equal(isRateLimited(new Error('HTTP 429')), true);
  assert.equal(isRateLimited(new Error('Too Many Requests')), true);
  assert.equal(isRateLimited(new Error('rate limit exceeded')), true);
  assert.equal(isRateLimited({ status: 429 }), true);
  assert.equal(isRateLimited(429), true);
  assert.equal(isRateLimited('429 slow down'), true);

  assert.equal(isRateLimited(new Error('HTTP 500 internal error')), false);
  assert.equal(isRateLimited(new Error('connection refused')), false);
  assert.equal(isRateLimited({ status: 503 }), false);
  assert.equal(isRateLimited(null), false);
  assert.equal(isRateLimited(undefined), false);
});

// ---------------------------------------------------------------------------
// nextBackoffMs: grows exponentially, capped at maxMs; jitter is injectable.
// ---------------------------------------------------------------------------
test('nextBackoffMs grows exponentially and is capped at maxMs', () => {
  const base = 500, max = 8000;
  assert.equal(nextBackoffMs({ attempt: 0, baseMs: base, maxMs: max }), 500);
  assert.equal(nextBackoffMs({ attempt: 1, baseMs: base, maxMs: max }), 1000);
  assert.equal(nextBackoffMs({ attempt: 2, baseMs: base, maxMs: max }), 2000);
  assert.equal(nextBackoffMs({ attempt: 3, baseMs: base, maxMs: max }), 4000);
  assert.equal(nextBackoffMs({ attempt: 4, baseMs: base, maxMs: max }), 8000, 'reaches the cap');
  assert.equal(nextBackoffMs({ attempt: 10, baseMs: base, maxMs: max }), 8000, 'stays capped');

  // injectable jitter scales up but never exceeds the cap
  assert.equal(nextBackoffMs({ attempt: 1, baseMs: base, maxMs: max, jitter: 0.5 }), 1500);
  assert.equal(nextBackoffMs({ attempt: 10, baseMs: base, maxMs: max, jitter: 0.9 }), 8000, 'jitter cannot exceed the cap');
});

// ---------------------------------------------------------------------------
// decideScanDelayMs: increases delay under recent 429s, decays otherwise.
// ---------------------------------------------------------------------------
test('decideScanDelayMs increases under recent 429s and decays back to base', () => {
  const base = 250, max = 4000;
  // no 429s and no current delay -> base
  assert.equal(decideScanDelayMs({ recent429: 0, baseDelayMs: base, maxDelayMs: max }), base);

  // 429s seen -> grows (2^n from base), capped
  const one = decideScanDelayMs({ recent429: 1, baseDelayMs: base, maxDelayMs: max });
  assert.equal(one, 500, 'one recent 429 doubles the base delay');
  const many = decideScanDelayMs({ recent429: 5, baseDelayMs: base, maxDelayMs: max });
  assert.equal(many, max, 'many 429s saturate at the cap');

  // growth builds on the current delay
  const grown = decideScanDelayMs({ recent429: 1, baseDelayMs: base, maxDelayMs: max, current: 1000 });
  assert.equal(grown, 2000, 'grows from the current delay');

  // no recent 429s but a high current delay -> decays (halves toward base)
  const decayed = decideScanDelayMs({ recent429: 0, baseDelayMs: base, maxDelayMs: max, current: 2000 });
  assert.equal(decayed, 1000, 'decays by halving');
  const decayedToBase = decideScanDelayMs({ recent429: 0, baseDelayMs: base, maxDelayMs: max, current: 300 });
  assert.equal(decayedToBase, base, 'never decays below base');
});

// ---------------------------------------------------------------------------
// makeThrottle: a pure factory with no timers (I/O layer does the waiting).
// ---------------------------------------------------------------------------
test('makeThrottle returns a pure next-timestamp function with no timers', () => {
  const next = makeThrottle({ delayMs: 100 });
  assert.equal(typeof next, 'function');
  assert.equal(next(1000, 1000), 1100, 'next allowed time is lastTs + delay');
  assert.equal(next(1000, 2000), 2000, 'if now is already past, run now');
  assert.equal(next(0, 0), 100, 'from a cold start, first run is after one delay');
});
