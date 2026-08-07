import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ikisakiSource = fileURLToPath(
  new URL("./packages/ikisaki/src/index.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      // Tests exercise the consistency-queue kernel directly against its
      // TypeScript source; the built package is used by root dist at runtime.
      "@hikoutei/ikisaki": ikisakiSource,
    },
  },
  test: {
    include: ["test/**/*.test.ts", "packages/ikisaki/test/**/*.test.ts"],
  },
});
