import { createHash, timingSafeEqual } from "node:crypto";

const LOWERCASE_SHA256_PATTERN = /^[0-9a-f]{64}$/;

function hasOnlyPairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index]! < rightPoints[index]! ? -1 : 1;
    }
  }
  return leftPoints.length - rightPoints.length;
}

function pythonJsonNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number");
  const wireToken = JSON.stringify(value);
  if (!wireToken.includes(".") && !/[eE]/.test(wireToken)) return wireToken;

  const negative = wireToken.startsWith("-");
  const unsigned = negative ? wireToken.slice(1) : wireToken;
  const [coefficient = "", rawExponent = "0"] = unsigned.toLowerCase().split("e");
  const decimalIndex = coefficient.indexOf(".");
  const integerDigits = decimalIndex === -1 ? coefficient.length : decimalIndex;
  let digits = coefficient.replace(".", "");
  let decimalPosition = integerDigits + Number(rawExponent);
  const leadingZeros = digits.match(/^0*/)?.[0].length ?? 0;
  digits = digits.slice(leadingZeros);
  decimalPosition -= leadingZeros;
  if (!digits) return "0.0";
  const exponent = decimalPosition - 1;
  const sign = negative ? "-" : "";
  if (exponent < -4 || exponent >= 16) {
    const fraction = digits.slice(1);
    const exponentSign = exponent < 0 ? "-" : "+";
    const exponentDigits = String(Math.abs(exponent)).padStart(2, "0");
    return `${sign}${digits.charAt(0)}${fraction ? `.${fraction}` : ""}e${exponentSign}${exponentDigits}`;
  }
  if (decimalPosition <= 0) {
    return `${sign}0.${"0".repeat(-decimalPosition)}${digits}`;
  }
  if (decimalPosition >= digits.length) {
    return `${sign}${digits}${"0".repeat(decimalPosition - digits.length)}.0`;
  }
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

function serializeForPythonJson(
  value: unknown,
  ancestors: Set<object>,
): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    if (!hasOnlyPairedSurrogates(value)) throw new TypeError("invalid Unicode string");
    return JSON.stringify(value);
  }
  if (typeof value === "number") return pythonJsonNumber(value);
  if (typeof value !== "object") throw new TypeError("non-JSON value");
  if (ancestors.has(value)) throw new TypeError("cyclic JSON value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serializeForPythonJson(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("non-dictionary JSON object");
    }
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
      throw new TypeError("non-string JSON key");
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareUnicodeCodePoints(left, right));
    return `{${entries.map(([key, item]) => {
      if (!hasOnlyPairedSurrogates(key)) throw new TypeError("invalid Unicode key");
      return `${JSON.stringify(key)}:${serializeForPythonJson(item, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Mirrors the Runtime API's Python request digest contract:
 * json.dumps(..., ensure_ascii=False, sort_keys=True, separators=(",", ":"),
 * allow_nan=False), encoded as UTF-8. This is intentionally distinct from the
 * pretty, newline-terminated canonicalJson used by Studio persistence records.
 */
export function canonicalDgxRuntimeRequestJson(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return serializeForPythonJson(value, new Set());
  } catch {
    return null;
  }
}

export function dgxRuntimeRequestSha256(value: unknown): string | null {
  const canonical = canonicalDgxRuntimeRequestJson(value);
  return canonical === null
    ? null
    : createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function dgxRuntimeRequestSha256Matches(
  value: unknown,
  claimedDigest: unknown,
): claimedDigest is string {
  if (typeof claimedDigest !== "string" || !LOWERCASE_SHA256_PATTERN.test(claimedDigest)) {
    return false;
  }
  const expectedDigest = dgxRuntimeRequestSha256(value);
  if (expectedDigest === null) return false;
  return timingSafeEqual(
    Buffer.from(claimedDigest, "ascii"),
    Buffer.from(expectedDigest, "ascii"),
  );
}
