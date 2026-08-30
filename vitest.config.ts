import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ikisakiSource = fileURLToPath(
  new URL("./packages/ikisaki/src/index.ts", import.meta.url),
);

const contractsSource = fileURLToPath(
  new URL("./packages/hikoutei-contracts/src/", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      // Tests exercise the consistency-queue kernel directly against its
      // TypeScript source; the built package is used by root dist at runtime.
      "@hikoutei/ikisaki": ikisakiSource,
      // Contract leaf resolves to source so suites (incl. the kernel mirror
      // drift guards) never depend on a stale contracts dist build.
      "@hikoutei/contracts": contractsSource,
      // Soak runner helpers import the public entrypoint through the package
      // self-reference; in tests that resolves to the current source tree so
      // runner coverage never depends on a stale ./dist build.
      hikoutei: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts", "packages/ikisaki/test/**/*.test.ts"],
  },
});