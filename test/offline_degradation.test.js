import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { JsonRpcProvider, OfflineError } from '../src/evm/rpc.js';
import { RpcDataSource } from '../src/datasource.js';
import { buildConfig } from '../src/config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CLI = join(REPO_ROOT, 'bin', 'arbitai.js');

// A fetch stub that always rejects, simulating an unreachable public RPC.
function rejectingFetch() {
  return Promise.reject(new Error('getaddrinfo ENOTFOUND rpc.invalid'));
}

test('provider.call rejects with a typed OfflineError carrying an actionable message', async () => {
  const url = 'https://bsc-dataseed.binance.org';
  const provider = new JsonRpcProvider(url, { fetch: rejectingFetch });

  await assert.rejects(
    () => provider.call('0x0000000000000000000000000000000000000001', '0x'),
    (err) => {
      assert.ok(err instanceof OfflineError, 'expected an OfflineError');
      assert.equal(err.name, 'OfflineError');
      assert.equal(err.url, url);
      assert.ok(err.message.includes(url), 'message should mention the url');
      assert.match(err.message, /--offline/, 'message should mention --offline');
      return true;
    },
  );
});

test('a rejecting fetch is NOT silently swallowed into a non-typed error', async () => {
  const provider = new JsonRpcProvider('https://arb1.arbitrum.io/rpc', {
    fetch: rejectingFetch,
  });
  const err = await provider.getGasPrice().then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof OfflineError, 'getGasPrice should raise OfflineError offline');
});

test('RpcDataSource surfaces the OfflineError through a configured chain (bsc)', async () => {
  const config = buildConfig({ chainKey: 'bsc', env: {} });
  const provider = new JsonRpcProvider(config.rpcUrl, { fetch: rejectingFetch });
  const dataSource = new RpcDataSource(provider, config);

  await assert.rejects(
    () => dataSource.getPairData(config.pairs[0]),
    (err) => err instanceof OfflineError,
  );
});

function runCli(args) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  // Force an unreachable endpoint so the live path fails fast and
  // deterministically regardless of sandbox DNS behavior.
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    timeout: 60000,
  });
}

for (const chain of ['bsc', 'arbitrum']) {
  test(`CLI --chain ${chain} against an unreachable RPC exits 1 with an actionable message, no stack trace`, () => {
    // Point at a guaranteed-unresolvable host so the request fails quickly.
    const res = runCli(['--chain', chain, '--rpc', 'https://rpc.invalid.localhost./']);
    assert.equal(res.status, 1, `expected exit 1, got ${res.status}: ${res.stderr}`);
    assert.match(res.stderr, /Network error/, 'stderr should carry the actionable Network error hint');
    assert.match(res.stderr, /--offline/, 'stderr should suggest --offline');
    // No raw stack trace frames leaked to the user.
    assert.ok(!/\n\s+at\s+/.test(res.stderr), 'stderr must not contain a raw stack trace');
  });
}
