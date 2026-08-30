import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ikisakiSource = fileURLToPath(
  new URL("./packages/ikisaki/src/index.ts", import.meta.url),
);

const contractsSource = fileURLToPath(
  new URL("./packages/hikoutei-contracts/src/", import.meta.url),
);

// P8-D2 phase 1 leaves resolve to source so suites never depend on a stale
// dist build (same convention as @hikoutei/contracts above).
const storageSource = fileURLToPath(
  new URL("./packages/hikoutei-storage/src/", import.meta.url),
);
const sheetsSource = fileURLToPath(
  new URL("./packages/hikoutei-sheets/src/", import.meta.url),
);
// P8-D2 phase 1 transitional bridge: the moved leaves import root src through
// this specifier; tests compile everything from source so it maps to the
// root src tree (P8-D2 phase 2 removes the specifier and the alias).
const appSrc = fileURLToPath(new URL("./src/", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Tests exercise the consistency-queue kernel directly against its
      // TypeScript source; the built package is used by root dist at runtime.
      "@hikoutei/ikisaki": ikisakiSource,
      // Contract leaf resolves to source so suites (incl. the kernel mirror
      // drift guards) never depend on a stale contracts dist build.
      "@hikoutei/contracts": contractsSource,
      "@hikoutei/storage": storageSource,
      "@hikoutei/sheets": sheetsSource,
      "@hikoutei-app-src": appSrc,
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