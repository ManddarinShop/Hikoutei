import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ikisakiSource = fileURLToPath(
  new URL("./packages/ikisaki/src/index.ts", import.meta.url),
);
const hikouteiSource = fileURLToPath(
  new URL("./src/index.ts", import.meta.url),
);
const hikouteiSyncStatusSource = fileURLToPath(
  new URL("./src/internal/syncStatus.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      // The subpath must precede the bare package so the more specific key
      // wins; both point MCP tests at the root TypeScript sources.
      "hikoutei/internal/sync-status": hikouteiSyncStatusSource,
      hikoutei: hikouteiSource,
      // Tests exercise the consistency-queue kernel directly against its
      // TypeScript source; the built package is used by root dist at runtime.
      "@hikoutei/ikisaki": ikisakiSource,
    },
  },
  test: {
    include: [
      "test/**/*.test.ts",
      "packages/ikisaki/test/**/*.test.ts",
      "packages/mcp/test/**/*.test.ts",
    ],
  },
});
