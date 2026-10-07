// Ranked-table renderer. Takes the ranked candidate rows from the scanner and
// produces a clean, fixed-width ASCII table. Plain text by default (no color
// dependency). Numbers are right-aligned. A --verbose breakdown of the cost
// components can be appended under each row.
//
// STRICTLY READ-ONLY tool: this module only formats already-computed numbers.

const COLUMNS = [
  { key: 'pair', header: 'PAIR', align: 'left' },
  { key: 'route', header: 'BUY@ / SELL@', align: 'left' },
  { key: 'rawGapPct', header: 'RAW GAP %', align: 'right' },
  { key: 'netPct', header: 'NET %', align: 'right' },
  { key: 'netQuote', header: 'NET (quote)', align: 'right' },
  { key: 'flags', header: 'TRAP FLAGS', align: 'left' },
  { key: 'verdict', header: 'VERDICT', align: 'left' },
];

function pct(fraction) {
  if (!Number.isFinite(fraction)) return '-';
  return `${(fraction * 100).toFixed(2)}%`;
}

function money(n) {
  if (!Number.isFinite(n)) return '-';
  const sign = n < 0 ? '-' : '';
  return `${sign}${Math.abs(n).toFixed(2)}`;
}

function routeLabel(row) {
  if (!row.buyDex || !row.sellDex) return '-';
  return `${row.buyDex} -> ${row.sellDex}`;
}

/**
 * Map a ranked candidate row into its display cells.
 * @param {object} row ranked candidate (see src/core/rank.js).
 * @returns {Record<string,string>}
 */
function toCells(row) {
  const flags = Array.isArray(row.flags) && row.flags.length ? row.flags.join(',') : '-';
  return {
    pair: String(row.pair ?? '-'),
    route: routeLabel(row),
    rawGapPct: pct(row.rawGapFraction),
    netPct: pct(row.netFraction),
    netQuote: money(Number(row.net)),
    flags,
    verdict: String(row.rowVerdict ?? '-'),
  };
}

function pad(text, width, align) {
  const s = String(text);
  if (s.length >= width) return s;
  const gap = ' '.repeat(width - s.length);
  return align === 'right' ? gap + s : s + gap;
}

function hr(widths, left, mid, right, fill) {
  return left + widths.map((w) => fill.repeat(w + 2)).join(mid) + right;
}

/**
 * Render the ranked candidates as a fixed-width ASCII table.
 *
 * @param {Array<object>} rankedCandidates rows from scan().
 * @param {object} [opts]
 * @param {boolean} [opts.verbose=false] append a per-row cost breakdown.
 * @returns {string} the table (no trailing newline).
 */
export function renderTable(rankedCandidates = [], opts = {}) {
  const verbose = opts.verbose === true;

  if (!Array.isArray(rankedCandidates) || rankedCandidates.length === 0) {
    return 'No candidates to display.';
  }

  const rows = rankedCandidates.map(toCells);

  // Column widths: max of header and all cells.
  const widths = COLUMNS.map((col) => {
    let w = col.header.length;
    for (const r of rows) w = Math.max(w, r[col.key].length);
    return w;
  });

  const lines = [];
  lines.push(hr(widths, '+', '+', '+', '-'));

  const headerCells = COLUMNS.map((col, i) => ` ${pad(col.header, widths[i], col.align)} `);
  lines.push('|' + headerCells.join('|') + '|');
  lines.push(hr(widths, '+', '+', '+', '='));

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const cells = COLUMNS.map((col, i) => ` ${pad(row[col.key], widths[i], col.align)} `);
    lines.push('|' + cells.join('|') + '|');

    if (verbose) {
      const src = rankedCandidates[r];
      const breakdown =
        `    costs: fees=${money(Number(src.feeCost))}  ` +
        `slippage=${money(Number(src.slippageCost))}  ` +
        `gas=${money(Number(src.gasCost))}  ` +
        `(raw gap=${money(Number(src.rawGap))} quote)`;
      lines.push(breakdown);
    }
  }

  lines.push(hr(widths, '+', '+', '+', '-'));

  // Legend so a reader understands the verdicts without the README.
  lines.push(
    'Verdicts: profitable = net above floor | marginal = thin positive net | ' +
      'unprofitable = net <= 0 | trap/avoid = honeypot / rigged pair.',
  );

  return lines.join('\n');
}

export default renderTable;
