/** Self-contained Apps Script source for the stable_encode_v1 runtime adapter. */

/**
 * This fragment is interpolated into dynamic operation functions. It uses only
 * Apps Script globals and intentionally keeps every helper name prefixed so it
 * cannot collide with operation-specific helpers or an older Code.gs global.
 */
export const APPS_SCRIPT_STABLE_CODEC_SOURCE = String.raw`
  function codecStableHash_(value) {
    return codecSha256Hex_(codecStableEncode_(value, []));
  }
  function codecStableEncode_(value, ancestors) {
    if (ancestors === undefined) ancestors = [];
    if (value === null) return "n";
    if (value === true) return "b1";
    if (value === false) return "b0";
    if (typeof value === "number") return codecStableEncodeNumber_(value);
    if (typeof value === "string") return codecStableEncodeString_(value);
    if (codecIsDateValue_(value)) return codecEncodeDate_(value.value);
    if (Array.isArray(value)) {
      if (!codecIsDenseArray_(value)) throw new Error("stable array must be dense");
      codecEnterContainer_(value, ancestors);
      try {
        return "a" + value.length + "[" + value.map(function (item) {
          return codecStableEncode_(item, ancestors);
        }).join("") + "]";
      } finally {
        codecLeaveContainer_(value, ancestors);
      }
    }
    if (codecIsPlainRecord_(value)) {
      codecEnterContainer_(value, ancestors);
      try {
        var entries = Object.keys(value).map(function (key) {
          var normalized = codecNormalizeScalarString_(key);
          return { key: normalized, bytes: codecUtf8Bytes_(normalized), value: value[key] };
        });
        var normalizedKeys = Object.create(null);
        entries.forEach(function (entry) {
          if (normalizedKeys[entry.key]) throw new Error("stable object has duplicate NFC key");
          normalizedKeys[entry.key] = true;
        });
        entries.sort(function (left, right) { return codecCompareBytes_(left.bytes, right.bytes); });
        return "o" + entries.length + "{" + entries.map(function (entry) {
          return "s" + entry.bytes.length + ":" + entry.key + codecStableEncode_(entry.value, ancestors);
        }).join("") + "}";
      } finally {
        codecLeaveContainer_(value, ancestors);
      }
    }
    throw new Error("stable value is unsupported");
  }
  function codecStableEncodeNumber_(value) {
    if (!isFinite(value)) throw new Error("stable number is not finite");
    var decimal = value === 0 ? "0" : String(value).replace(/e\+/, "e").replace(/e(-?)0+(\d+)/, "e$1$2");
    return "f" + codecUtf8ByteLength_(decimal) + ":" + decimal;
  }
  function codecStableEncodeString_(value) {
    var normalized = codecNormalizeScalarString_(value);
    return "s" + codecUtf8ByteLength_(normalized) + ":" + normalized;
  }
  function codecEncodeDate_(value) {
    if (!codecIsCanonicalDate_(value)) throw new Error("stable date is invalid");
    return "d24:" + value;
  }
  function codecIsDateValue_(value) {
    return codecIsPlainRecord_(value) && Object.keys(value).length === 2 &&
      Object.prototype.hasOwnProperty.call(value, "kind") &&
      Object.prototype.hasOwnProperty.call(value, "value") &&
      value.kind === "date" && typeof value.value === "string";
  }
  function codecIsCanonicalDate_(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    var parsed = new Date(value);
    return !isNaN(parsed.getTime()) && parsed.toISOString() === value;
  }
  function codecIsPlainRecord_(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }
  function codecIsDenseArray_(value) {
    for (var index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
    }
    return true;
  }
  function codecEnterContainer_(value, ancestors) {
    if (ancestors.indexOf(value) >= 0) throw new Error("stable value cannot contain cycles");
    ancestors.push(value);
  }
  function codecLeaveContainer_(value, ancestors) { ancestors.pop(); }
  function codecNormalizeScalarString_(value) {
    for (var index = 0; index < value.length; index += 1) {
      var codeUnit = value.charCodeAt(index);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        var next = value.charCodeAt(index + 1);
        if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) throw new Error("stable string has an unpaired high surrogate");
        index += 1;
      } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        throw new Error("stable string has an unpaired low surrogate");
      }
    }
    return value.normalize("NFC");
  }
  function codecSha256Hex_(value) {
    return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
      .map(function (byte) { var unsigned = byte < 0 ? byte + 256 : byte; return ("0" + unsigned.toString(16)).slice(-2); })
      .join("");
  }
  function codecUtf8Bytes_(value) { return Utilities.newBlob(value).getBytes(); }
  function codecUtf8ByteLength_(value) { return codecUtf8Bytes_(value).length; }
  function codecCompareBytes_(left, right) {
    var count = Math.min(left.length, right.length);
    for (var index = 0; index < count; index += 1) {
      var a = left[index] < 0 ? left[index] + 256 : left[index];
      var b = right[index] < 0 ? right[index] + 256 : right[index];
      if (a !== b) return a - b;
    }
    return left.length - right.length;
  }
`;
