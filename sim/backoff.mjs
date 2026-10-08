#!/usr/bin/env node
/*
 * BACKOFF + RATE-LIMIT HELPERS (pure) — let the live scan DEGRADE GRACEFULLY on a
 * free RPC tier (e.g. Alchemy free, which returns HTTP 429 under load) instead of
 * crashing the loop.
 *
 * SAFETY: pure, deterministic functions. No I/O, no network, no key material, no
 * transactions, no module-level timers. Jitter is optional and injectable so the
 * functions stay deterministic in tests.
 */

// isRateLimited(error) -> true when the error (or its text) indicates HTTP 429 /
// "rate limit" / "Too Many Requests". PURE. Accepts an Error, a string, or an object
// with { status | code | message }.
export function isRateLimited(error) {
    if (!error) return false;
    if (typeof error === "number") return error === 429;
    const status = (error && (error.status ?? error.statusCode ?? error.code)) ?? null;
    if (status === 429 || status === "429") return true;
    const text = String(
        (error && error.message) != null ? error.message : error
    ).toLowerCase();
    return (
        text.includes("429") ||
        text.includes("too many requests") ||
        text.includes("rate limit") ||
        text.includes("rate-limit") ||
        text.includes("ratelimit")
    );
}

// nextBackoffMs({ attempt, baseMs, maxMs, jitter }) -> exponential backoff in ms,
// capped at maxMs. PURE. attempt is 0-based (attempt 0 -> baseMs). jitter is an
// optional number in [0,1) injected for determinism; when provided the result is
// scaled by (1 + jitter) BEFORE the cap, so it never exceeds maxMs.
export function nextBackoffMs({ attempt = 0, baseMs = 500, maxMs = 30000, jitter = 0 } = {}) {
    const a = Math.max(0, Math.floor(attempt));
    const base = Math.max(0, baseMs);
    const cap = Math.max(base, maxMs);
    const raw = base * 2 ** a;
    const jittered = raw * (1 + Math.max(0, Math.min(0.999, jitter)));
    return Math.min(cap, Math.round(jittered));
}

// decideScanDelayMs({ recent429, baseDelayMs, maxDelayMs, step }) -> the inter-call
// spacing (ms) to use for the next scan window. PURE. When recent 429s were seen the
// delay grows (doubling per recent 429, capped at maxDelayMs); when none were seen it
// decays back toward baseDelayMs. `current` (the previous delay) lets the decay be
// gradual; omit it to compute purely from recent429.
export function decideScanDelayMs({ recent429 = 0, baseDelayMs = 250, maxDelayMs = 5000, current = null } = {}) {
    const base = Math.max(0, baseDelayMs);
    const cap = Math.max(base, maxDelayMs);
    const n = Math.max(0, Math.floor(recent429));

    if (n > 0) {
        // grow from the current delay (or base) by 2^n, capped
        const from = current != null && Number.isFinite(current) ? Math.max(base, current) : base;
        return Math.min(cap, Math.round(from * 2 ** n));
    }
    // no recent 429s -> decay toward base. Halve the current delay but never below base.
    if (current != null && Number.isFinite(current) && current > base) {
        return Math.max(base, Math.round(current / 2));
    }
    return base;
}

// makeThrottle({ delayMs }) -> a PURE factory returning a function next(lastTs, now)
// -> the earliest timestamp the next call may run at (lastTs + delayMs). No timers; the
// I/O layer decides how to wait until that time. Kept here because it is a pure helper;
// the actual pacing/sleep stays in the harness/IO layer (FEAT-003).
export function makeThrottle({ delayMs = 0 } = {}) {
    const d = Math.max(0, delayMs);
    return (lastTs = 0, now = 0) => Math.max(now, (lastTs || 0) + d);
}
