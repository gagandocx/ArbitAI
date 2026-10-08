#!/usr/bin/env node
/*
 * POOL DISCOVERY (read-only, measurement-only) — resolve a DEX's V3 pool address
 * for a token pair + fee tier from the on-chain factory via factory.getPool(
 * address,address,uint24), using ONLY a read-only eth_call.
 *
 * SAFETY: this is READ-ONLY. The chain is touched ONLY through an injected callFn
 * (callFn(to, data) -> hex result) which the production layer binds to a read-only
 * eth_call. There is no direct fetch in this module's pure path, no key material, and
 * no transactions. It only answers "does a pool exist, and at what address?".
 *
 * The factory returns address(0) for a pair/fee that has no pool; decodeGetPool maps
 * that (and an empty "0x") to null so callers can skip non-existent pools cleanly.
 *
 * Selector: factory.getPool(address,address,uint24) = 0x1698ee82 (confirmed in
 * sim/base_live_check.mjs as v3GetPool). ABI word/padding helpers are reimplemented
 * here identically to sim/live_two_dex_watcher.mjs (no new dependency).
 */

// ----------------------------------------------------- ABI helpers ----
// Identical to the helpers in sim/live_two_dex_watcher.mjs (kept local, no dependency).
const strip = (h) => (h || "").replace(/^0x/, "");
const word = (v) => BigInt(v).toString(16).padStart(64, "0");         // uint -> 32-byte hex
const aw = (a) => strip(a).toLowerCase().padStart(64, "0");           // address -> left-padded 32-byte
const addrW = (hex) => "0x" + strip(hex).slice(24).toLowerCase();     // last 20 bytes -> address

const V3_GET_POOL = "0x1698ee82"; // getPool(address,address,uint24)
const ZERO = "0x" + "0".repeat(40);

// encodeGetPool(tokenA, tokenB, fee) -> calldata hex for factory.getPool(a,b,fee).
// PURE. Token order does not matter to the factory (it sorts internally), so we pass
// them through as given. fee is a uint24 fee tier (e.g. 500/3000).
export function encodeGetPool(tokenA, tokenB, fee) {
    return V3_GET_POOL + aw(tokenA) + aw(tokenB) + word(fee);
}

// decodeGetPool(hex) -> the pool address (lowercased 0x+40) or null for the zero
// address / empty result. PURE. The factory returns address(0) for a non-existent
// pool, which we normalize to null.
export function decodeGetPool(hex) {
    if (!hex || hex === "0x") return null;
    const addr = addrW(hex);
    if (addr === ZERO) return null;
    return addr;
}

// discoverPools({ chain, dex, tokenA, tokenB, tiers, callFn, factory }) ->
//   [{ chain, dex, tier, pool }] for the NON-ZERO results only, one entry per tier
//   that has a real pool.
//
// Issues exactly ONE read-only eth_call per requested fee tier, through the injected
// callFn(to, data) -> hex. callFn is the ONLY way this function touches the chain, so
// it is fully testable against a mock with no network. The factory address must be
// supplied (callers pass getDexConfig(chain, dex).factory from the registry).
export async function discoverPools({ chain, dex, tokenA, tokenB, tiers, callFn, factory }) {
    if (typeof callFn !== "function") throw new Error("discoverPools requires a callFn(to, data) -> hex");
    if (!factory) throw new Error("discoverPools requires a factory address");
    if (!Array.isArray(tiers) || tiers.length === 0) throw new Error("discoverPools requires a non-empty tiers array");

    const found = [];
    for (const tier of tiers) {
        const data = encodeGetPool(tokenA, tokenB, tier);
        const res = await callFn(factory, data); // ONE read-only eth_call per tier
        const pool = decodeGetPool(res);
        if (pool) found.push({ chain, dex, tier, pool });
    }
    return found;
}

// makeCallFn(batchFn, blockTag) -> a callFn(to, data) bound to a read-only eth_call via
// the supplied batch function (e.g. the watcher's batch([[method, params]])). This keeps
// the real RPC wiring in the I/O layer; the pure path above never imports it. The batch
// function is responsible for enforcing the read-only ALLOWED method set.
export function makeCallFn(batchFn, blockTag = "latest") {
    return async (to, data) => {
        const [r] = await batchFn([["eth_call", [{ to, data }, blockTag]]]);
        return r;
    };
}
