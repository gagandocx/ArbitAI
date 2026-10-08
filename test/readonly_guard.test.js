import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..', 'src');
const BIN_DIR = join(__dirname, '..', 'bin');
const SIM_DIR = join(__dirname, '..', 'sim');

// Transaction-sending / signing / key-holding primitives that must NEVER
// appear anywhere in the read-only codebase. Matched case-insensitively.
const FORBIDDEN = [
  'eth_sendTransaction',
  'eth_sendRawTransaction',
  'eth_sign',
  'privateKey',
  'Wallet',
  'signer',
];

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith('.js') || full.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

test('the src/bin/sim tree contains no transaction-sending or signing primitives', () => {
  const files = [...walk(SRC_DIR), ...walk(BIN_DIR), ...walk(SIM_DIR)];
  assert.ok(files.length > 0, 'expected source files to scan');

  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8').toLowerCase();
    for (const term of FORBIDDEN) {
      if (text.includes(term.toLowerCase())) {
        offenders.push(`${file} contains forbidden token "${term}"`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `read-only boundary violated:\n${offenders.join('\n')}`,
  );
});
