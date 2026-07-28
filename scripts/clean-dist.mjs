import { rm } from "node:fs/promises";

const distributionDirectory = new URL("../dist/", import.meta.url);

// `dist/` is generated and ignored by Git. Removing it before compilation
// prevents files deleted or moved in `src/` from leaking into npm packages.
await rm(distributionDirectory, { force: true, recursive: true });
