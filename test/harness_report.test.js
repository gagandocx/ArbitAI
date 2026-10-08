import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWatcherCsv,
  firingRows,
  topFiringBlocks,
  CSV_HEADER,
} from '../harness/parse_fires.mjs';

import {
  parseForkLog,
  verdictForPairing,
  verdictForForkLog,
  buildReportMarkdown,
  buildHistoryRow,
  summarizeHistory,
  HISTORY_HEADER,
} from '../harness/make_report.mjs';

import {
  isPlaceholder,
  validateConfig,
  watcherArgs,
} from '../harness/config.mjs';

// ---------------------------------------------------------------------------
// All numbers/addresses here are SYNTHETIC test fixtures. No network is used.
// ---------------------------------------------------------------------------

// A sample watcher CSV: header + firing and non-firing rows across several blocks.
const SAMPLE_CSV = [
  CSV_HEADER,
  '100,A<->B,A->B,1000,1.50,0.20,1.30,true',
  '101,A<->B,A->B,5000,0.05,0.20,-0.15,false',
  '102,A<->C,B->A,20000,3.10,0.25,2.85,true',
  '103,B<->C,A->B,1000,0.90,0.30,0.60,true',
  '',
  '104,A<->B,A->B,1000,0.40,0.30,0.10,false',
  // block 102 fires again at a different size with a LOWER net -> dedup keeps the best
  '102,A<->B,A->B,1000,1.00,0.20,0.80,true',
].join('\n');

test('parseWatcherCsv parses rows, coerces types, skips header + blanks', () => {
  const rows = parseWatcherCsv(SAMPLE_CSV);
  assert.equal(rows.length, 6, 'six data rows (header + blank skipped)');
  const r0 = rows[0];
  assert.equal(r0.block, 100);
  assert.equal(r0.pair, 'A<->B');
  assert.equal(r0.size_usd, 1000);
  assert.equal(r0.net_usd, 1.30);
  assert.equal(r0.would_fire, true);
  assert.equal(typeof r0.would_fire, 'boolean');
  assert.equal(rows[1].would_fire, false);
});

test('firingRows keeps only would_fire==true, ranked by net desc', () => {
  const firing = firingRows(parseWatcherCsv(SAMPLE_CSV));
  // firing blocks: 100(1.30), 102(2.85), 103(0.60), 102(0.80) -> 4 rows
  assert.equal(firing.length, 4);
  assert.equal(firing[0].net_usd, 2.85, 'highest net first');
  assert.ok(firing.every((r) => r.would_fire === true));
});

test('topFiringBlocks dedups a block to its best net and returns top-N by net', () => {
  const picks = topFiringBlocks(parseWatcherCsv(SAMPLE_CSV), 3);
  assert.equal(picks.length, 3);
  // distinct blocks, ordered by net desc: 102(2.85), 100(1.30), 103(0.60)
  assert.deepEqual(picks.map((p) => p.block), [102, 100, 103]);
  // block 102 kept its BEST (2.85), not the 0.80 duplicate
  assert.equal(picks[0].net_usd, 2.85);
});

test('topFiringBlocks with zero firing rows returns empty (zero-signal case)', () => {
  const noneCsv = [
    CSV_HEADER,
    '200,A<->B,A->B,1000,0.05,0.20,-0.15,false',
    '201,A<->B,A->B,5000,0.08,0.20,-0.12,false',
  ].join('\n');
  assert.equal(topFiringBlocks(parseWatcherCsv(noneCsv), 3).length, 0);
});

// ---------------------------------------------------------------------------
// Fork-log parsing + verdicts.
// ---------------------------------------------------------------------------

// A synthetic REAL fork log: usdc_out > usdc_in at the smallest size AND the gross
// gap HOLDS (grows) as size scales -> REAL.
const FORK_REAL = `
Running 1 test for test/WethUsdcCycle.t.sol:WethUsdcCycleTest
==== pairing: A->B (buy on A, sell on B)
--- size USD: 1000
  USDC in  (6dec) : 1000000000
  WETH bought (18dec): 400000000000000000
  USDC out (6dec) : 1004000000
  2-leg GROSS +USDC (6dec): 4000000
--- size USD: 5000
  USDC in  (6dec) : 5000000000
  WETH bought (18dec): 2000000000000000000
  USDC out (6dec) : 5020000000
  2-leg GROSS +USDC (6dec): 20000000
--- size USD: 20000
  USDC in  (6dec) : 20000000000
  WETH bought (18dec): 8000000000000000000
  USDC out (6dec) : 20080000000
  2-leg GROSS +USDC (6dec): 80000000
--- size USD: 50000
  USDC in  (6dec) : 50000000000
  WETH bought (18dec): 20000000000000000000
  USDC out (6dec) : 50200000000
  2-leg GROSS +USDC (6dec): 200000000
`;

// A B3-style MIRAGE: positive at 1k but the gross USDC OUT flatlines at larger sizes
// (shallow depth), so the gross gap collapses -> MIRAGE.
const FORK_MIRAGE_COLLAPSE = `
==== pairing: A->B (buy on A, sell on B)
--- size USD: 1000
  USDC in  (6dec) : 1000000000
  WETH bought (18dec): 400000000000000000
  USDC out (6dec) : 1000500000
  2-leg GROSS +USDC (6dec): 500000
--- size USD: 5000
  USDC in  (6dec) : 5000000000
  WETH bought (18dec): 1900000000000000000
  USDC out (6dec) : 4800000000
  2-leg LOSS -USDC (6dec): 200000000
--- size USD: 20000
  USDC in  (6dec) : 20000000000
  WETH bought (18dec): 6000000000000000000
  USDC out (6dec) : 15000000000
  2-leg LOSS -USDC (6dec): 5000000000
`;

// A MIRAGE where even the smallest size does not clear gas.
const FORK_MIRAGE_SUBGAS = `
==== pairing: A->B
--- size USD: 1000
  USDC in  (6dec) : 1000000000
  WETH bought (18dec): 400000000000000000
  USDC out (6dec) : 1000050000
  2-leg GROSS +USDC (6dec): 50000
--- size USD: 5000
  USDC in  (6dec) : 5000000000
  WETH bought (18dec): 2000000000000000000
  USDC out (6dec) : 5000300000
  2-leg GROSS +USDC (6dec): 300000
`;

test('parseForkLog extracts pairings, sizes, and derives grossUsd', () => {
  const pairings = parseForkLog(FORK_REAL);
  assert.equal(pairings.length, 1);
  assert.equal(pairings[0].label, 'A->B (buy on A, sell on B)');
  assert.equal(pairings[0].sizes.length, 4);
  const s0 = pairings[0].sizes[0];
  assert.equal(s0.sizeUsd, 1000);
  assert.equal(s0.usdcIn, 1000);           // 1000000000 / 1e6
  assert.equal(s0.usdcOut, 1004);
  assert.equal(s0.wethOut, 0.4);           // 4e17 / 1e18
  assert.equal(Number(s0.grossUsd.toFixed(6)), 4);
});

test('verdictForPairing: REAL when gap clears gas AND holds as size grows', () => {
  const pairings = parseForkLog(FORK_REAL);
  const v = verdictForPairing(pairings[0].sizes, 1.0); // gas floor $1
  assert.equal(v.verdict, 'REAL');
  assert.equal(v.scales, true);
  assert.equal(Number(v.smallestNetUsd.toFixed(4)), 3.0); // 4 gross - 1 gas
});

test('verdictForPairing: MIRAGE when gross gap collapses as size grows (B3 shallow depth)', () => {
  const pairings = parseForkLog(FORK_MIRAGE_COLLAPSE);
  const v = verdictForPairing(pairings[0].sizes, 0.1);
  assert.equal(v.verdict, 'MIRAGE');
  assert.equal(v.scales, false);
  assert.match(v.reason, /collapse/i);
});

test('verdictForPairing: MIRAGE when smallest-size gap does not clear gas', () => {
  const pairings = parseForkLog(FORK_MIRAGE_SUBGAS);
  // smallest gross is $0.05; gas floor $0.10 -> does not clear
  const v = verdictForPairing(pairings[0].sizes, 0.10);
  assert.equal(v.verdict, 'MIRAGE');
  assert.match(v.reason, /gas/i);
});

test('verdictForPairing: MIRAGE when usdc_out <= usdc_in at smallest size', () => {
  const neg = parseForkLog(`
==== pairing: A->B
--- size USD: 1000
  USDC in  (6dec) : 1000000000
  USDC out (6dec) : 999000000
--- size USD: 5000
  USDC in  (6dec) : 5000000000
  USDC out (6dec) : 4990000000
`);
  const v = verdictForPairing(neg[0].sizes, 0);
  assert.equal(v.verdict, 'MIRAGE');
  assert.match(v.reason, /usdc_out <= usdc_in/i);
});

test('verdictForForkLog: block is REAL if ANY pairing is REAL', () => {
  // one MIRAGE pairing + one REAL pairing in the same log
  const combined = FORK_MIRAGE_COLLAPSE + '\n' + FORK_REAL.replace('A->B (buy on A, sell on B)', 'A->C');
  const v = verdictForForkLog(combined, 1.0);
  assert.equal(v.verdict, 'REAL');
  assert.equal(v.pairings.length, 2);
  assert.match(v.reason, /A->C/);
});

// ---------------------------------------------------------------------------
// Report + history row + rolling summary.
// ---------------------------------------------------------------------------

test('buildReportMarkdown + buildHistoryRow for a REAL confirmed run', () => {
  const run = {
    timestamp: '20260101T000000Z',
    chain: 'arbitrum',
    minutes: 30,
    csvPath: '/x/watch.csv',
    blocksWatched: 400,
    signals: 1,
    confirmed: [
      { block: 102, quoteNetUsd: 2.85, gasUsd: 1.0, forkText: FORK_REAL },
    ],
  };
  const md = buildReportMarkdown(run);
  assert.match(md, /Block 102 - \*\*REAL\*\*/);
  assert.match(md, /Run verdict: \*\*REAL\*\*/);
  assert.match(md, /watcher quote net/);

  const row = buildHistoryRow(run);
  const cols = row.split(',');
  assert.equal(cols[0], '20260101T000000Z');
  assert.equal(cols[1], '400');     // blocks_watched
  assert.equal(cols[2], '1');       // signals
  assert.equal(cols[3], '102');     // top_block
  assert.equal(cols[4], '2.8500');  // quote_net
  assert.equal(Number(cols[5]), 3); // fork_real_net_1k (4 gross - 1 gas)
  assert.equal(cols[6], 'REAL');    // verdict
});

test('buildReportMarkdown + history for a zero-signal run (clean, no fork step)', () => {
  const run = {
    timestamp: '20260101T010000Z',
    chain: 'arbitrum',
    minutes: 30,
    csvPath: '/x/watch.csv',
    blocksWatched: 400,
    signals: 0,
    confirmed: [],
  };
  const md = buildReportMarkdown(run);
  assert.match(md, /0 WOULD-FIRE signals/);
  assert.match(md, /No fork-confirmed blocks/);

  const row = buildHistoryRow(run);
  const cols = row.split(',');
  assert.equal(cols[2], '0');          // signals
  assert.equal(cols[3], '');           // no top_block
  assert.equal(cols[6], 'NO_SIGNAL');  // verdict
});

test('buildHistoryRow marks a MIRAGE run and summarizeHistory rolls it up', () => {
  const mirageRun = {
    timestamp: '20260101T020000Z', chain: 'arbitrum', minutes: 30, csvPath: '/x', blocksWatched: 300, signals: 2,
    confirmed: [{ block: 55, quoteNetUsd: 0.9, gasUsd: 0.1, forkText: FORK_MIRAGE_COLLAPSE }],
  };
  const mrow = buildHistoryRow(mirageRun);
  assert.equal(mrow.split(',')[6], 'MIRAGE');

  const history = [
    HISTORY_HEADER,
    '20260101T000000Z,400,1,102,2.8500,3.0000,REAL',
    '20260101T010000Z,400,0,,,,NO_SIGNAL',
    mrow,
  ].join('\n');
  const s = summarizeHistory(history);
  assert.equal(s.totalRuns, 3);
  assert.equal(s.totalSignals, 3);        // 1 + 0 + 2
  assert.equal(s.real, 1);
  assert.equal(s.mirage, 1);
  assert.equal(s.bestRealNet, 3.0);
  assert.equal(s.first, '20260101T000000Z');
  assert.equal(s.last, '20260101T020000Z');
  assert.match(s.text, /total runs\s+:\s+3/);
  assert.match(s.text, /best REAL net/);
});

// ---------------------------------------------------------------------------
// Config validation + placeholder blocking.
// ---------------------------------------------------------------------------

test('isPlaceholder: empty / non-address / stand-in are placeholders; real address is not', () => {
  assert.equal(isPlaceholder(''), true);
  assert.equal(isPlaceholder(null), true);
  assert.equal(isPlaceholder('0xPANCAKE_V3_WETH_USDC_ARBITRUM'), true);
  assert.equal(isPlaceholder('0x123'), true);
  assert.equal(isPlaceholder('0xC6962004f452bE9203591991D15f6b388e09E8D0'), false);
});

test('validateConfig refuses a config with a Pancake placeholder, accepts a filled one', () => {
  const base = {
    chain: 'arbitrum',
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    pools: {
      A: { dex: 'Uniswap V3', pool: '0xC6962004f452bE9203591991D15f6b388e09E8D0', quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' },
      B: { dex: 'PancakeSwap V3', pool: '0xPANCAKE_V3_WETH_USDC_ARBITRUM', quoter: '0xPANCAKE_V3_QUOTER_ARBITRUM' },
      C: { dex: 'SushiSwap V3', pool: '0xf3eb87c1f6020982173c908e7eb31aa66c1f0296', quoter: '0xSUSHI_V3_QUOTER_ARBITRUM' },
    },
  };
  const bad = validateConfig(base);
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => /PancakeSwap V3.*placeholder/.test(p)));
  assert.ok(bad.problems.some((p) => /SushiSwap V3.*quoter.*placeholder/.test(p)));

  // fill in Pancake + Sushi quoter -> ok
  const good = JSON.parse(JSON.stringify(base));
  good.pools.B.pool = '0x1234567890123456789012345678901234567890';
  good.pools.B.quoter = '0x2234567890123456789012345678901234567890';
  good.pools.C.quoter = '0x3234567890123456789012345678901234567890';
  const ok = validateConfig(good);
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
});

test('watcherArgs flattens config to watcher CLI flags', () => {
  const cfg = {
    chain: 'arbitrum', sizes: '1000,5000', min_profit_usd: 0.10,
    weth: '0xw', usdc: '0xu',
    pools: {
      A: { pool: '0xaaa', quoter: '0xqa' },
      B: { pool: '0xbbb', quoter: '0xqb' },
      C: { pool: '0xccc', quoter: '0xqc' },
    },
  };
  const args = watcherArgs(cfg);
  const joined = args.join(' ');
  assert.match(joined, /--chain arbitrum/);
  assert.match(joined, /--poolA 0xaaa --quoterA 0xqa/);
  assert.match(joined, /--poolB 0xbbb --quoterB 0xqb/);
  assert.match(joined, /--poolC 0xccc --quoterC 0xqc/);
  assert.match(joined, /--sizes 1000,5000/);
  assert.match(joined, /--min-profit-usd 0.1/);
});
