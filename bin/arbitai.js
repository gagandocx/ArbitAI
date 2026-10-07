#!/usr/bin/env node
// ArbitAI CLI entrypoint — read-only DEX-to-DEX arbitrage SCANNER.
//
// READ-ONLY SAFETY (reinforced): this tool only performs eth_call / view reads.
// It holds no private keys, never authorizes or submits transactions, and
// cannot move funds. There is no key material anywhere in this process. The
// read-only boundary is enforced by test/readonly_guard.test.js.

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildConfig } from '../src/config/index.js';
import { scan } from '../src/scanner.js';
import { FixtureDataSource, RpcDataSource } from '../src/datasource.js';
import { JsonRpcProvider, OfflineError } from '../src/evm/rpc.js';
import { renderTable } from '../src/render/table.js';

const BANNER = 'ArbitAI — READ-ONLY scanner: view reads only, no keys, no transactions, no funds at risk.';

const USAGE = `ArbitAI — read-only DEX-to-DEX arbitrage scanner

Usage:
  arbitai [options]

Options:
  --chain <key>        Chain to scan (default: base).
  --rpc <url>          RPC endpoint URL override (else RPC_URL / ALCHEMY_KEY env).
  --trade-size <num>   Notional trade size in quote currency (default: 10000).
  --slippage <num>     Slippage tolerance as a fraction, e.g. 0.005 (default: 0.005).
  --pairs <list>       Comma-separated pairs to scan, e.g. "WETH/USDC,DAI/USDC".
  --offline            Run against bundled/offline fixtures (no network).
  --fixture <path>     Path to a fixture JSON (implies --offline).
  --verbose            Show the per-row cost breakdown (fees, slippage, gas).
  --json               Emit ranked candidates as JSON instead of a table.
  --help               Show this help.

Examples:
  arbitai --offline --fixture test/fixtures/base_sample.json
  RPC_URL=https://mainnet.base.org arbitai
  ALCHEMY_KEY=your_key_here arbitai --chain base --trade-size 5000
`;

const OPTIONS = {
  chain: { type: 'string' },
  rpc: { type: 'string' },
  'trade-size': { type: 'string' },
  slippage: { type: 'string' },
  pairs: { type: 'string' },
  offline: { type: 'boolean', default: false },
  fixture: { type: 'string' },
  verbose: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

/** Parse "WETH/USDC,DAI/USDC" into [{base,quote}, ...]. */
function parsePairs(spec) {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [base, quote] = s.split('/').map((t) => t.trim());
      if (!base || !quote) {
        throw new Error(`Invalid pair "${s}". Use BASE/QUOTE, e.g. WETH/USDC.`);
      }
      return { base, quote };
    });
}

function parsePositiveNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be a positive number (got "${value}").`);
  }
  return n;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ options: OPTIONS, allowPositionals: false });
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const { values } = parsed;

  if (values.help) {
    process.stdout.write(`${USAGE}`);
    return;
  }

  // One-line read-only banner on every run (to stderr so --json stdout is clean).
  process.stderr.write(`${BANNER}\n`);

  // Assemble overrides from flags.
  const overrides = {};
  if (values.rpc) overrides.rpcUrl = values.rpc;
  if (values['trade-size'] !== undefined) {
    overrides.tradeSize = parsePositiveNumber(values['trade-size'], '--trade-size');
  }
  if (values.slippage !== undefined) {
    overrides.slippageTolerance = parsePositiveNumber(values.slippage, '--slippage');
  }
  if (values.pairs !== undefined) {
    overrides.pairs = parsePairs(values.pairs);
  }

  const config = buildConfig({ chainKey: values.chain ?? 'base', overrides });

  // Choose the data source: offline/fixture avoids the network entirely.
  const useOffline = values.offline || values.fixture !== undefined;
  let dataSource;
  if (useOffline) {
    const fixturePath = values.fixture
      ? resolve(process.cwd(), values.fixture)
      : resolve(process.cwd(), 'test/fixtures/base_sample.json');
    let fixtureJson;
    try {
      fixtureJson = JSON.parse(readFileSync(fixturePath, 'utf8'));
    } catch (err) {
      throw new Error(`Could not read fixture "${fixturePath}": ${err.message}`);
    }
    dataSource = new FixtureDataSource(fixtureJson);
  } else {
    const provider = new JsonRpcProvider(config.rpcUrl);
    // Route non-fatal data-source warnings (e.g. a V2 leg skipped for lack of a
    // configured pair address) to stderr so --json stdout stays clean and the
    // user sees why a pair came back one-sided.
    dataSource = new RpcDataSource(provider, config, {
      onWarn: (msg) => process.stderr.write(`Warning: ${msg}\n`),
    });
  }

  const ranked = await scan(config, dataSource);

  if (values.json) {
    // Serialize BigInt-free rows; replace any residual BigInt defensively.
    const json = JSON.stringify(
      ranked,
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    );
    process.stdout.write(`${json}\n`);
    return;
  }

  process.stdout.write(`${renderTable(ranked, { verbose: values.verbose })}\n`);
}

main().catch((err) => {
  // Clear, actionable messages only — never a raw stack trace.
  if (err instanceof OfflineError) {
    process.stderr.write(
      `\nNetwork error: ${err.message}\n` +
        'Hint: re-run with --offline (or --fixture <path>) to use bundled data.\n',
    );
  } else {
    process.stderr.write(`\nError: ${err && err.message ? err.message : String(err)}\n`);
  }
  process.exitCode = 1;
});
