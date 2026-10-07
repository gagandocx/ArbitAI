// Strictly READ-ONLY JSON-RPC provider over the global fetch API.
//
// This provider exposes ONLY read methods (eth_call, eth_blockNumber,
// eth_gasPrice, eth_chainId). It deliberately does NOT implement any method
// that broadcasts or authorizes a state change, and it never touches keys of
// any kind. The read-only boundary is enforced by test/readonly_guard.test.js.
//
// On any network trouble (fetch rejection, non-2xx HTTP status, proxy block,
// or an aborted timeout) it throws a typed OfflineError carrying a clear,
// actionable message so the CLI can tell the user to check their connection or
// fall back to bundled fixtures with --offline.
//
// The fetch implementation and AbortController are injectable through the
// constructor so tests can supply stubs and run fully offline.

/**
 * Typed error raised when the RPC endpoint cannot be reached or returns a
 * transport-level failure. Carries the offending url and the original cause.
 */
export class OfflineError extends Error {
  constructor(message, { url, cause } = {}) {
    super(message);
    this.name = 'OfflineError';
    this.url = url;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Error raised when the RPC node returns a JSON-RPC error object (valid HTTP
 * response, but the node rejected the request). Kept distinct from
 * OfflineError because it is NOT a connectivity problem.
 */
export class RpcError extends Error {
  constructor(message, { code, data } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * A minimal read-only JSON-RPC provider.
 */
export class JsonRpcProvider {
  /**
   * @param {string} url RPC endpoint URL.
   * @param {object} [options]
   * @param {typeof fetch} [options.fetch] fetch implementation (injectable for
   *   tests). Defaults to the global fetch.
   * @param {typeof AbortController} [options.AbortController] abort controller
   *   constructor (injectable). Defaults to the global AbortController.
   * @param {number} [options.timeoutMs] per-request timeout in ms.
   */
  constructor(url, options = {}) {
    if (!url || typeof url !== 'string') {
      throw new Error('JsonRpcProvider: a string RPC url is required');
    }
    this.url = url;
    this._fetch = options.fetch ?? globalThis.fetch;
    this._AbortController =
      options.AbortController ?? globalThis.AbortController;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._id = 0;

    if (typeof this._fetch !== 'function') {
      throw new Error(
        'JsonRpcProvider: no fetch implementation available (Node >=18 or ' +
          'inject options.fetch).',
      );
    }
  }

  /**
   * Low-level JSON-RPC call. Read methods only. Throws OfflineError on any
   * transport failure and RpcError on a JSON-RPC error response.
   * @param {string} method JSON-RPC method name.
   * @param {any[]} params positional params.
   * @returns {Promise<any>} the `result` field of the response.
   */
  async send(method, params = []) {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: ++this._id,
      method,
      params,
    });

    const controller = this._AbortController
      ? new this._AbortController()
      : null;
    const timer =
      controller != null
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : null;

    let response;
    try {
      response = await this._fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      throw new OfflineError(
        `RPC endpoint unreachable: ${this.url}. ` +
          'Check network or use --offline to run against bundled fixtures.',
        { url: this.url, cause: err },
      );
    } finally {
      if (timer != null) clearTimeout(timer);
    }

    if (!response || typeof response.status !== 'number') {
      throw new OfflineError(
        `RPC endpoint returned no response: ${this.url}. ` +
          'Check network or use --offline to run against bundled fixtures.',
        { url: this.url },
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new OfflineError(
        `RPC endpoint unreachable: ${this.url} (HTTP ${response.status}). ` +
          'Check network or use --offline to run against bundled fixtures.',
        { url: this.url },
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new OfflineError(
        `RPC endpoint returned an invalid response: ${this.url}. ` +
          'Check network or use --offline to run against bundled fixtures.',
        { url: this.url, cause: err },
      );
    }

    if (payload && payload.error) {
      throw new RpcError(
        `RPC error ${payload.error.code}: ${payload.error.message}`,
        { code: payload.error.code, data: payload.error.data },
      );
    }

    return payload ? payload.result : undefined;
  }

  /**
   * eth_call — execute a read-only message call against the given contract.
   * @param {string} to target contract address.
   * @param {string} data 0x-prefixed calldata.
   * @param {string} [blockTag='latest'] block tag.
   * @returns {Promise<string>} 0x-prefixed return data.
   */
  async call(to, data, blockTag = 'latest') {
    return this.send('eth_call', [{ to, data }, blockTag]);
  }

  /**
   * eth_blockNumber — latest block height as a Number.
   * @returns {Promise<number>}
   */
  async getBlockNumber() {
    const hex = await this.send('eth_blockNumber', []);
    return Number(BigInt(hex));
  }

  /**
   * eth_gasPrice — current gas price as a BigInt (wei).
   * @returns {Promise<bigint>}
   */
  async getGasPrice() {
    const hex = await this.send('eth_gasPrice', []);
    return BigInt(hex);
  }

  /**
   * eth_chainId — chain id as a Number.
   * @returns {Promise<number>}
   */
  async chainId() {
    const hex = await this.send('eth_chainId', []);
    return Number(BigInt(hex));
  }
}

export default JsonRpcProvider;
