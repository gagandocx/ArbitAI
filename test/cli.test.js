import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CLI = join(REPO_ROOT, 'bin', 'arbitai.js');
const FIXTURE = join('test', 'fixtures', 'base_sample.json');

function run(args) {
  // Strip NODE_OPTIONS so the sandbox proxy bootstrap does not break the child
  // node process; this is a sandbox quirk, not a project requirement.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  });
}

test('--help prints usage listing all flags', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0);
  const out = res.stdout;
  for (const flag of [
    '--chain',
    '--rpc',
    '--trade-size',
    '--slippage',
    '--pairs',
    '--offline',
    '--fixture',
    '--verbose',
    '--json',
    '--help',
  ]) {
    assert.ok(out.includes(flag), `usage should mention ${flag}`);
  }
  assert.match(out, /read-only/i);
});

test('--offline --fixture prints a ranked table with a profitable pair and a trap row, exit 0', () => {
  const res = run(['--offline', '--fixture', FIXTURE]);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
  const out = res.stdout;

  // Column headers present.
  assert.ok(out.includes('PAIR'), 'has PAIR column');
  assert.ok(out.includes('RAW GAP %'), 'has RAW GAP % column');
  assert.ok(out.includes('NET %'), 'has NET % column');
  assert.ok(out.includes('TRAP FLAGS'), 'has TRAP FLAGS column');
  assert.ok(out.includes('VERDICT'), 'has VERDICT column');

  // The genuinely profitable pair appears and is marked profitable.
  assert.ok(out.includes('WETH/USDC'), 'profitable pair present');
  assert.ok(out.includes('profitable'), 'a profitable verdict is shown');

  // A trap/avoid row is flagged (sell-blocked or fee-on-transfer).
  assert.ok(out.includes('trap/avoid'), 'an avoid verdict is shown');
  assert.ok(
    out.includes('SELL_BLOCKED') || out.includes('FEE_ON_TRANSFER'),
    'a honeypot/trap flag is shown',
  );

  // The read-only banner is emitted (on stderr).
  assert.match(res.stderr, /READ-ONLY/i);
});

test('--json emits machine-readable ranked candidates offline, exit 0', () => {
  const res = run(['--offline', '--fixture', FIXTURE, '--json']);
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.some((r) => r.pair === 'WETH/USDC'));
});
