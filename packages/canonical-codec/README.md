# @hikoutei/canonical-codec

Runtime-neutral **canonical codec** primitives shared across Hikoutei runtimes:
the `stable_encode_v1` byte grammar and the canonical-JSON text grammar used for
signed payloads. The package has no runtime dependencies and no Google SDK,
SQLite, or Node-specific types in its public surface, so the same codecs can run
in the Node service, the Apps Script gateway, and golden-vector characterization
tests.

> **Status (0.1.0): Stage 1 scaffold.**
> This version publishes the public API *contract* only. Type definitions, the
> structured error classes, and the error-code constants are in place. The
> encoder and guard *implementations* are stubs that throw and will be migrated
> from the in-repo codec in Stage 2 of the package-extraction plan. Until then,
> do not depend on this package from application code.

## When to use

Use this package when you need byte-stable serialization that is identical
across runtimes:

- `stableEncode(value)` — encodes a value into the versioned stable byte grammar
  (the input to SHA-256 fingerprints and event identity).
- `canonicalJson(value)` — encodes a JSON-compatible value into sorted-key,
  finite-number, dense-array text suitable for signing.

Both grammars reject values that cannot be encoded deterministically
(non-finite numbers, unsupported types, cyclic structures, duplicate keys after
NFC normalization, unpaired UTF-16 surrogates) with a typed
`CanonicalCodecError` / `StableCodecError` carrying a machine-readable `code`.

## Public API

```ts
import {
  // Encoders
  stableEncode, // (value: StableCodecValue) => Uint8Array
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
encoded on the date path, not as plain objects.

## Implementation note

The codec's grammars are versioned (`stable_encode_v1`) and exist in two
mirrors: this package and the deployed Apps Script gateway. Stage 2 wires the
real implementations in so the two mirrors continue to produce identical bytes.

## License

MIT © ManddarinShop
