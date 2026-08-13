---
title: Release process
description: Release checklist — semver policy, verify, publish, manifest sync, and GitHub Release.
---

# Release process

The release checklist lives in the repository:

- [docs/release-process.md](https://github.com/ManddarinShop/Hikoutei/blob/develop/docs/release-process.md)

It documents the semver policy, the verify → publish → verify sequence, the
manifest sync back to `develop`, the GitHub Release step, benchmark
recording, and failure handling.

Current automation (`.github/workflows/`):

- `main-version.yml` — a `main` merge advances the minor version and creates
  the stable release tag (there is no `stable-version.yml`).
- `develop-version.yml` — a `develop` merge advances the patch version and
  creates a non-production release tag.
- `stable-publish.yml` — verifies and publishes the tagged package;
  `develop-publish.yml` plays the same role for develop tags.

Root verification commands: `npm test`, `npm run typecheck`,
`npm run typecheck:test`, `npm run build`, `npm pack --dry-run`.
