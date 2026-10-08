#!/usr/bin/env node
/*
 * DEX REGISTRY (pure data + pure accessors) — per-chain V3 factory/quoter
 * addresses plus canonical token addresses, used by the smarter autonomous
 * search to auto-discover pools and quote them read-only.
 *
 * SAFETY: this module has NO network side effects. It is pure data and pure
 * accessor functions only. It issues no RPC, holds no key material, and sends
 * no transactions. The actual chain access (eth_call only) lives in the I/O
 * layer and is injected into the discovery/scoring modules as a callFn/quoteFn.
 *
 * ADDRESS PROVENANCE — read before trusting an address:
 *   VERIFIED (verified:true)   — confirmed in-repo (sim/base_live_check.mjs for the
 *                                Base factories/quoters) or in context.json's
 *                                verified_addresses block (the per-DEX QuoterV2
 *                                deployments). Reuse these as-is.
 *   UNVERIFIED (verified:false) — a sensible, well-known multi-chain default that has
 *                                NOT been independently confirmed for this exact
 *                                chain in this repo. The USER MUST confirm each one on
 *                                Arbiscan/Basescan or the DEX's official docs before a
 *                                live run, and may override it (mirrors how
 *                                harness/pools.arbitrum.json documents its UNVERIFIED
 *                                Uniswap pool). Discovery still works with these — a
 *                                wrong factory simply returns address(0) for every
 *                                tier (no pool), which is visible and harmless.
 *
 * The V3 factory getPool(address,address,uint24) selector is 0x1698ee82 (confirmed in
 * sim/base_live_check.mjs as v3GetPool); discovery.mjs reuses it.
 */

const lower = (a) => String(a).toLowerCase();

// Standard Uniswap-style V3 fee tiers (hundredths of a bip). Pancake V3 additionally
// uses 2500 (0.25%) instead of 3000 on some chains, which is reflected per-DEX below.
export const FEE_TIERS = Object.freeze({
    LOWEST: 100,
    LOW: 500,
    PANCAKE_MED: 2500,
    MEDIUM: 3000,
    HIGH: 10000,
});

// Canonical token addresses per chain (well-known deployments). Stored lowercased.
// WETH/USDC are reused from context.json.verified_addresses and the watcher; the rest
// are well-known deployments (USDT/WBTC/DAI, plus ARB on arbitrum, cbETH on base).
export const TOKENS = Object.freeze({
    arbitrum: Object.freeze({
        WETH: lower("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"),
        USDC: lower("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"), // native USDC
        USDT: lower("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"),
        WBTC: lower("0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f"),
        DAI: lower("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"),
        ARB: lower("0x912CE59144191C1204E64559FE8253a0e49E6548"),
    }),
    base: Object.freeze({
        WETH: lower("0x4200000000000000000000000000000000000006"),
        USDC: lower("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), // native USDC
        USDT: lower("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"),
        WBTC: lower("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"), // cbBTC (canonical wrapped BTC on Base)
        DAI: lower("0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb"),
        cbETH: lower("0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22"),
    }),
});

// Per-chain, per-DEX registry. factory = V3 factory (getPool); quoter = QuoterV2
// (quoteExactInputSingle). verified reflects the provenance rules documented above.
//
// Base factories/quoters: VERIFIED, lifted verbatim from sim/base_live_check.mjs.
// Per-DEX QuoterV2 on Arbitrum: VERIFIED per context.json (Uniswap QuoterV2 reused
//   from the watcher; Pancake QuoterV2 0xB048... confirmed in-repo; Sushi QuoterV2
//   0x0524... verified per briefing).
// Arbitrum factories: UNVERIFIED well-known multi-chain defaults — USER MUST CONFIRM on
//   Arbiscan/official docs and may override.
const RAW_REGISTRY = {
    arbitrum: {
        uniswap: {
            // Uniswap V3 factory is the canonical multi-chain deployment 0x1F98431c...
            // UNVERIFIED for Arbitrum in this repo — confirm on Arbiscan/docs before a live run.
            factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
            factoryVerified: false,
            quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", // VERIFIED (watcher)
            tiers: [FEE_TIERS.LOWEST, FEE_TIERS.LOW, FEE_TIERS.MEDIUM, FEE_TIERS.HIGH],
        },
        pancake: {
            // Pancake V3 factory 0x41ff9AA7... is the known multi-chain deployment.
            // UNVERIFIED for Arbitrum in this repo — confirm on Arbiscan/docs before a live run.
            factory: "0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9",
            factoryVerified: false,
            quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997", // VERIFIED (same multi-chain QuoterV2)
            tiers: [FEE_TIERS.LOWEST, FEE_TIERS.LOW, FEE_TIERS.PANCAKE_MED, FEE_TIERS.HIGH],
        },
        sushi: {
            // Sushi V3 factory 0x1af415a1... multi-chain default.
            // UNVERIFIED for Arbitrum in this repo — confirm on Arbiscan/docs before a live run.
            factory: "0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e",
            factoryVerified: false,
            quoter: "0x0524e833ccd057e4d7a296e3aaab9f7675964ce1", // VERIFIED (briefing)
            tiers: [FEE_TIERS.LOWEST, FEE_TIERS.LOW, FEE_TIERS.MEDIUM, FEE_TIERS.HIGH],
        },
    },
    base: {
        uniswap: {
            factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", // VERIFIED (base_live_check)
            factoryVerified: true,
            quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", // VERIFIED
            tiers: [FEE_TIERS.LOWEST, FEE_TIERS.LOW, FEE_TIERS.MEDIUM, FEE_TIERS.HIGH],
        },
        pancake: {
            factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", // VERIFIED (base_live_check)
            factoryVerified: true,
            quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997", // VERIFIED
            tiers: [FEE_TIERS.LOWEST, FEE_TIERS.LOW, FEE_TIERS.PANCAKE_MED, FEE_TIERS.HIGH],
        },
        sushi: {
            factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", // VERIFIED (base_live_check)
            factoryVerified: true,
            quoter: "0xb1E835Dc2785b52265711e17fCCb0fd018226a6e", // VERIFIED
            tiers: [FEE_TIERS.LOWEST, FEE_TIERS.LOW, FEE_TIERS.MEDIUM, FEE_TIERS.HIGH],
        },
    },
};

// Build the frozen, lowercased public registry. `verified` is true only when BOTH the
// factory and quoter are verified for that chain+DEX (the factory is the weak link on
// Arbitrum). `factoryVerified`/`quoterVerified` are exposed for finer-grained checks.
function buildRegistry(raw) {
    const out = {};
    for (const [chain, dexes] of Object.entries(raw)) {
        out[chain] = {};
        for (const [dex, cfg] of Object.entries(dexes)) {
            const factoryVerified = !!cfg.factoryVerified;
            const quoterVerified = true; // all quoters here are verified per provenance notes
            out[chain][dex] = Object.freeze({
                chain,
                dex,
                factory: lower(cfg.factory),
                quoter: lower(cfg.quoter),
                tiers: Object.freeze([...cfg.tiers]),
                factoryVerified,
                quoterVerified,
                verified: factoryVerified && quoterVerified,
            });
        }
        out[chain] = Object.freeze(out[chain]);
    }
    return Object.freeze(out);
}

export const DEX_REGISTRY = buildRegistry(RAW_REGISTRY);

// getDexConfig(chain, dex) -> the frozen registry entry, or throws a clear error.
// PURE: no I/O. The returned object is read-only (frozen).
export function getDexConfig(chain, dex) {
    const c = String(chain || "").toLowerCase();
    const d = String(dex || "").toLowerCase();
    const chainEntry = DEX_REGISTRY[c];
    if (!chainEntry) {
        throw new Error(`Unknown chain "${chain}". Supported: ${Object.keys(DEX_REGISTRY).join(", ")}.`);
    }
    const entry = chainEntry[d];
    if (!entry) {
        throw new Error(`Unknown dex "${dex}" on ${c}. Supported: ${Object.keys(chainEntry).join(", ")}.`);
    }
    return entry;
}

// getTokens(chain) -> the frozen canonical token map for a chain, or throws.
export function getTokens(chain) {
    const c = String(chain || "").toLowerCase();
    const t = TOKENS[c];
    if (!t) throw new Error(`Unknown chain "${chain}". Supported: ${Object.keys(TOKENS).join(", ")}.`);
    return t;
}

// listDexes(chain) -> array of dex keys for a chain (pure helper for iteration).
export function listDexes(chain) {
    const c = String(chain || "").toLowerCase();
    const chainEntry = DEX_REGISTRY[c];
    if (!chainEntry) throw new Error(`Unknown chain "${chain}". Supported: ${Object.keys(DEX_REGISTRY).join(", ")}.`);
    return Object.keys(chainEntry);
}
