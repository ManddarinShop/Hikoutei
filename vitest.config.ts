import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const outboxSource = fileURLToPath(
  new URL("./packages/outbox/src/index.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      // Tests exercise the consistency-queue kernel directly against its
      // TypeScript source; the built package is used by root dist at runtime.
      "@hikoutei/outbox": outboxSource,
    },
  },
  test: {
    include: ["test/**/*.test.ts", "packages/outbox/test/**/*.test.ts"],
  },
});
