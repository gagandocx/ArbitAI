import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readV2Reserves,
  readV2AmountsOut,
  readV3Quote,
  simulateSell,
} from '../src/evm/pools.js';
import { encodeParameters } from '../src/evm/abi.js';
import { JsonRpcProvider, OfflineError } from '../src/evm/rpc.js';

const PAIR = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x2222222222222222222222222222222222222222';
const QUOTER = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const REF = '0x5555555555555555555555555555555555555555';

// A stub provider whose call() returns pre-baked ABI hex, no network involved.
function stubProvider(returnHex) {
  return {
    calls: [],
    async call(to, data, blockTag) {
      this.calls.push({ to, data, blockTag });
      return returnHex;
    },
  };
}

test('readV2Reserves decodes (uint112,uint112,uint32)', async () => {
  const reserve0 = 4000000000000000000000n;
  const reserve1 = 12120000000000n;
  const ts = 1700000000n;
  const hex = '0x' + encodeParameters(
    ['uint112', 'uint112', 'uint256'],
    [reserve0, reserve1, ts],
  );
  const provider = stubProvider(hex);
  const out = await readV2Reserves(provider, PAIR);
  assert.equal(out.reserve0, reserve0);
  assert.equal(out.reserve1, reserve1);
  assert.equal(out.blockTimestampLast, ts);
  assert.equal(provider.calls[0].to, PAIR);
});

test('readV2AmountsOut decodes a uint256[] amounts array', async () => {
  const amounts = [1000000000000000000n, 3030000000n];
  const hex = '0x' + encodeParameters(['uint256[]'], [amounts]);
  const provider = stubProvider(hex);
  const out = await readV2AmountsOut(provider, ROUTER, 10n ** 18n, [TOKEN, REF]);
  assert.deepEqual(out, amounts);
});

test('readV2AmountsOut rejects a too-short path', async () => {
  const provider = stubProvider('0x');
  await assert.rejects(
    () => readV2AmountsOut(provider, ROUTER, 1n, [TOKEN]),
    /at least 2 addresses/,
  );
});

test('readV3Quote decodes a single uint256 amountOut', async () => {
  const amountOut = 3000000000n;
  const hex = '0x' + encodeParameters(['uint256'], [amountOut]);
  const provider = stubProvider(hex);
  const out = await readV3Quote(provider, QUOTER, {
    tokenIn: TOKEN,
    tokenOut: REF,
    fee: 500,
    amountIn: 10n ** 18n,
  });
  assert.equal(out, amountOut);
});

test('simulateSell reports a healthy sell as sellable', async () => {
  const amounts = [10n ** 18n, 1500000000n];
  const hex = '0x' + encodeParameters(['uint256[]'], [amounts]);
  const provider = stubProvider(hex);
  const res = await simulateSell(provider, {
    kind: 'v2',
    router: ROUTER,
    token: TOKEN,
    referenceToken: REF,
    amountIn: 10n ** 18n,
  });
  assert.equal(res.sellReverted, false);
  assert.equal(res.simulatedSellOut, 1500000000n);
});

test('simulateSell interprets a reverting call as non-sellable', async () => {
  const provider = {
    async call() {
      throw new Error('execution reverted');
    },
  };
  const res = await simulateSell(provider, {
    kind: 'v2',
    router: ROUTER,
    token: TOKEN,
    referenceToken: REF,
    amountIn: 10n ** 18n,
  });
  assert.equal(res.sellReverted, true);
  assert.equal(res.simulatedSellOut, 0n);
  assert.match(res.error, /reverted/);
});

test('simulateSell interprets a zero output as non-sellable', async () => {
  const amounts = [10n ** 18n, 0n];
  const hex = '0x' + encodeParameters(['uint256[]'], [amounts]);
  const provider = stubProvider(hex);
  const res = await simulateSell(provider, {
    kind: 'v2',
    router: ROUTER,
    token: TOKEN,
    referenceToken: REF,
    amountIn: 10n ** 18n,
  });
  assert.equal(res.sellReverted, false);
  assert.equal(res.simulatedSellOut, 0n);
});

test('JsonRpcProvider throws a typed OfflineError when fetch rejects', async () => {
  const provider = new JsonRpcProvider('https://rpc.invalid.example', {
    fetch: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await assert.rejects(
    () => provider.call(PAIR, '0x'),
    (err) => {
      assert.ok(err instanceof OfflineError, 'should be an OfflineError');
      assert.equal(err.name, 'OfflineError');
      assert.match(err.message, /RPC endpoint unreachable/);
      assert.match(err.message, /--offline/);
      assert.equal(err.url, 'https://rpc.invalid.example');
      return true;
    },
  );
});

test('JsonRpcProvider throws OfflineError on a non-2xx HTTP status', async () => {
  const provider = new JsonRpcProvider('https://rpc.invalid.example', {
    fetch: async () => ({ status: 503, async json() { return {}; } }),
  });
  await assert.rejects(
    () => provider.getBlockNumber(),
    (err) => {
      assert.ok(err instanceof OfflineError);
      assert.match(err.message, /HTTP 503/);
      return true;
    },
  );
});

test('send() refuses a method not on the read-only allowlist', async () => {
  let fetched = false;
  const provider = new JsonRpcProvider('https://rpc.ok.example', {
    fetch: async () => {
      fetched = true;
      return { status: 200, async json() { return { result: '0x1' }; } };
    },
  });
  // A disallowed (non-read) method must throw BEFORE any request is built.
  await assert.rejects(
    () => provider.send('eth_submitWork', []),
    (err) => {
      assert.equal(err.name, 'RpcError');
      assert.equal(err.code, 'E_METHOD_NOT_ALLOWED');
      assert.match(err.message, /not permitted/);
      assert.match(err.message, /read-only/);
      return true;
    },
  );
  assert.equal(fetched, false, 'no request may be issued for a refused method');
});

test('send() allows the read methods on the allowlist', async () => {
  const provider = new JsonRpcProvider('https://rpc.ok.example', {
    fetch: async () => ({
      status: 200,
      async json() { return { jsonrpc: '2.0', id: 1, result: '0x2105' }; },
    }),
  });
  // Each public read helper routes through an allowlisted method and succeeds.
  assert.equal(await provider.chainId(), 0x2105);
  assert.equal(await provider.getBlockNumber(), 0x2105);
  assert.equal(await provider.call(PAIR, '0x'), '0x2105');
  assert.equal(await provider.getGasPrice(), 0x2105n);
});

test('JsonRpcProvider returns a decoded result on a healthy response', async () => {
  const provider = new JsonRpcProvider('https://rpc.ok.example', {
    fetch: async () => ({
      status: 200,
      async json() {
        return { jsonrpc: '2.0', id: 1, result: '0x2105' };
      },
    }),
  });
  const chainId = await provider.chainId();
  assert.equal(chainId, 0x2105); // 8453 (Base)
});
