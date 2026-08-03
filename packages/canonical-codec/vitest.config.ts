import { defineConfig } from "vitest/config";

// Package-owned Vitest configuration. The codec package owns its own test
// entrypoints so `npm test --workspace @hikoutei/canonical-codec` runs the
// golden-vector and boundary tests independently of the root repository suite.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
