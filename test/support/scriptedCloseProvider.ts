import type { ScalarEntityPersistenceProvider } from "@hikoutei/contracts/storage/scalar.js";

/**
 * Provider with scripted close behavior: `close()` fails the first
 * `failuresBeforeSuccess` calls with the recorded original error, then
 * succeeds. Call counts are recorded so tests can assert that a retry
 * genuinely re-invokes the provider cleanup. All other provider methods are
 * unused in the close tests and throw if reached.
 */
export class ScriptedCloseProvider implements ScalarEntityPersistenceProvider {
  closeCalls = 0;
  readonly originalCloseError = new Error("scripted-provider-close-failure");
  constructor(private readonly failuresBeforeSuccess: number) {}

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeCalls <= this.failuresBeforeSuccess) {
      throw this.originalCloseError;
    }
  }

  async beginTransaction(): Promise<never> {
    throw new Error("unused in close tests");
  }
  async read(): Promise<never> {
    throw new Error("unused in close tests");
  }
  async count(): Promise<never> {
    throw new Error("unused in close tests");
  }
  async readSnapshot(): Promise<never> {
    throw new Error("unused in close tests");
  }
}