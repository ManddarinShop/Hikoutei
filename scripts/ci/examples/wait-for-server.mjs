/**
 * Wait until a URL answers with any HTTP response, or fail after a timeout.
 *
 * Any status code (2xx/4xx/5xx) proves a server is accepting connections;
 * fetch only rejects while nothing is listening yet. Used by the example
 * scenario scripts in this directory. The optional `init` is passed through
 * to fetch, so POST-based probes (e.g. tRPC) can use the same helper.
 *
 * @param {string} url - probe URL
 * @param {{ timeoutMs?: number, intervalMs?: number, init?: RequestInit }} options
 * @returns {Promise<Response>} the first HTTP response received
 * @throws {Error} when no response arrives before the timeout
 */
export async function waitForServer(url, { timeoutMs = 30_000, intervalMs = 500, init } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(
    `server at ${url} did not respond within ${timeoutMs}ms (last error: ${lastError?.message ?? "none"})`,
  );
}
