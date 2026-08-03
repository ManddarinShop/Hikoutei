# @hikoutei/canonical-codec

Runtime-neutral **canonical codec** primitives shared across Hikoutei runtimes:
the `stable_encode_v1` byte grammar and the canonical-JSON text grammar used for
signed payloads. The package has no runtime dependencies and no Google SDK,
SQLite, or Node-specific types in its public surface. It uses standard runtime
facilities such as `Uint8Array`, `TextEncoder`, and `String.prototype.normalize`.
The deployed Apps Script gateway keeps a self-contained source mirror; Apps
Script does not import this npm package at runtime.

The public API contract, type definitions, structured error classes, error-code
constants, and the real `stableEncode` / `canonicalJson` implementations are
wired into the Hikoutei workspace and are checked against the Apps Script mirror.

## Installation

```sh
npm install @hikoutei/canonical-codec
```

The package is ESM-only. Import it from a modern Node.js or other runtime that
provides the standard `Uint8Array`/`TextEncoder` APIs. CommonJS compatibility is
not part of this package's contract.

## When to use

Use this package when you need byte-stable serialization that is identical
across runtimes:

- `stableEncode(value)` — encodes a value into the versioned stable byte grammar
  (the input to SHA-256 fingerprints and event identity).
- `canonicalJson(value)` — encodes a JSON-compatible value into sorted-key,
  finite-number, dense-array text suitable for signing.

`stableEncode` rejects values that cannot be encoded deterministically
(non-finite numbers, unsupported types, cyclic structures, duplicate keys after
NFC normalization, invalid tagged dates, and unpaired UTF-16 surrogates).
`canonicalJson` separately rejects non-finite numbers, unsupported values, sparse
arrays, and cyclic structures. Both throw a typed `CanonicalCodecError` /
`StableCodecError` carrying a machine-readable `code`.

## Public API

```ts
import {
  // Encoders
  stableEncode, // (value: unknown) => Uint8Array; validates StableCodecValue at runtime
  canonicalJson, // (value: unknown) => string
  isCanonicalJsonValue, // (value: unknown) => value is CanonicalJsonValue
  // Value types
  type StableCodecValue,
  type StableCodecDateValue,
  type CanonicalJsonValue,
  // Errors
  CanonicalCodecError,
  StableCodecError,
  CANONICAL_CODEC_ERROR_CODES,
  STABLE_ENCODING_ERROR_CODES,
} from "@hikoutei/canonical-codec";
```

`StableCodecValue` accepts scalars, arrays, objects with string keys, and tagged
dates (`{ kind: "date", value: "<canonical UTC ISO-8601>" }`). Tagged dates are
encoded on the date path, not as plain objects. The package intentionally does
not provide a SHA-256 helper: Hikoutei keeps its Node `node:crypto` wrapper and
`HikouteiStableHash` brand at the application boundary.

## Implementation note

The stable grammar is versioned as `stable_encode_v1`, and canonical JSON is a
separate signed-payload text format. The package implementation and the
self-contained Apps Script mirror are kept in parity by shared golden vectors.
A change that would alter existing `stable_encode_v1` bytes or canonical JSON
text must not be silently released as a compatible change; introduce a new
encoding/protocol version instead.

## License

MIT © ManddarinShop
