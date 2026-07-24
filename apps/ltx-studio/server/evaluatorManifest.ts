import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";

import {
  phonemeVisemeEvaluatorManifestSchema,
  unavailablePhonemeVisemeResult,
  type PhonemeVisemeBlockerCode,
  type PhonemeVisemeEvaluatorManifest,
  type PhonemeVisemeResult,
} from "../shared/phonemeVisemeEvaluator.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;

export type PhonemeVisemeEvaluatorState = {
  fingerprint: string;
  result: PhonemeVisemeResult;
};

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readRegularFile(path: string, maximumBytes: number): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Evaluator-Artefakt ist keine reguläre Datei: ${path}`);
  }
  if (before.size <= 0 || before.size > maximumBytes) {
    throw new Error(`Evaluator-Artefaktgröße außerhalb des Limits: ${path}`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs) {
      throw new Error(`Evaluator-Artefakt wurde während der Prüfung verändert: ${path}`);
    }
    const result = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) {
      throw new Error(`Evaluator-Artefakt wurde während des Lesens verändert: ${path}`);
    }
    return result;
  } finally {
    closeSync(descriptor);
  }
}

function parseStrictJson(raw: Buffer): unknown {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  let cursor = 0;
  const skipWhitespace = () => {
    while (cursor < source.length && /\s/u.test(source[cursor]!)) cursor += 1;
  };
  const parseString = (): string => {
    const start = cursor;
    if (source[cursor] !== "\"") throw new Error(`String bei Position ${cursor} erwartet.`);
    cursor += 1;
    let escaped = false;
    while (cursor < source.length) {
      const character = source[cursor]!;
      cursor += 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        return JSON.parse(source.slice(start, cursor)) as string;
      }
    }
    throw new Error("Nicht abgeschlossener JSON-String.");
  };
  const parseValue = (): void => {
    skipWhitespace();
    const character = source[cursor];
    if (character === "{") {
      cursor += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[cursor] === "}") {
        cursor += 1;
        return;
      }
      while (cursor < source.length) {
        const key = parseString();
        if (keys.has(key)) throw new Error(`Doppelter JSON-Schlüssel: ${key}`);
        keys.add(key);
        skipWhitespace();
        if (source[cursor] !== ":") throw new Error(`Doppelpunkt bei Position ${cursor} erwartet.`);
        cursor += 1;
        parseValue();
        skipWhitespace();
        if (source[cursor] === "}") {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ",") throw new Error(`Komma bei Position ${cursor} erwartet.`);
        cursor += 1;
        skipWhitespace();
      }
      throw new Error("Nicht abgeschlossenes JSON-Objekt.");
    }
    if (character === "[") {
      cursor += 1;
      skipWhitespace();
      if (source[cursor] === "]") {
        cursor += 1;
        return;
      }
      while (cursor < source.length) {
        parseValue();
        skipWhitespace();
        if (source[cursor] === "]") {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ",") throw new Error(`Komma bei Position ${cursor} erwartet.`);
        cursor += 1;
      }
      throw new Error("Nicht abgeschlossenes JSON-Array.");
    }
    if (character === "\"") {
      parseString();
      return;
    }
    const start = cursor;
    while (cursor < source.length && !/[\s,\]}]/u.test(source[cursor]!)) cursor += 1;
    if (start === cursor) throw new Error(`JSON-Wert bei Position ${cursor} erwartet.`);
    JSON.parse(source.slice(start, cursor));
  };
  parseValue();
  skipWhitespace();
  if (cursor !== source.length) throw new Error(`Unerwartete Daten bei Position ${cursor}.`);
  return JSON.parse(source) as unknown;
}

function blankStageResult(
  status: "failed" | "not-available",
  reason: string,
  manifest: PhonemeVisemeEvaluatorManifest | null,
  manifestSha256: string | null,
  blockerCode: Exclude<PhonemeVisemeBlockerCode, "none">,
): PhonemeVisemeResult {
  return {
    ...unavailablePhonemeVisemeResult(reason, blockerCode),
    status,
    manifestReleaseId: manifest?.releaseId ?? null,
    manifestSha256,
    preprocessingVersion: manifest?.preprocessing.version ?? null,
    visemeMapVersion: manifest?.visemeMap.version ?? null,
    gateVersion: manifest?.productGo.status === "release-candidate" && manifest.calibration
      ? manifest.calibration.gateVersion
      : null,
    productGo: {
      status: "blocked",
      reason,
    },
  };
}

export function resolvePhonemeVisemeEvaluatorState(
  configuredPath = process.env.LTX_STUDIO_PHONEME_VISEME_MANIFEST?.trim() ?? "",
): PhonemeVisemeEvaluatorState {
  if (!configuredPath) {
    const result = unavailablePhonemeVisemeResult();
    return { fingerprint: "manifest-missing.v1", result };
  }
  let raw: Buffer;
  try {
    raw = readRegularFile(resolve(configuredPath), MAX_MANIFEST_BYTES);
  } catch (error) {
    const reason = `Evaluator-Manifest nicht lesbar: ${error instanceof Error ? error.message : String(error)}`;
    return {
      fingerprint: `manifest-unreadable:${createHash("sha256").update(reason).digest("hex")}`,
      result: blankStageResult("failed", reason, null, null, "manifest-invalid"),
    };
  }
  const manifestSha256 = sha256(raw);
  let body: unknown;
  try {
    body = parseStrictJson(raw);
  } catch (error) {
    const reason = `Evaluator-Manifest enthält ungültiges JSON: ${error instanceof Error ? error.message : String(error)}`;
    return {
      fingerprint: `manifest-invalid-json:${manifestSha256}`,
      result: blankStageResult("failed", reason, null, manifestSha256, "manifest-invalid"),
    };
  }
  const parsed = phonemeVisemeEvaluatorManifestSchema.safeParse(body);
  if (!parsed.success) {
    const reason = `Evaluator-Manifest ungültig: ${parsed.error.issues[0]?.message ?? "Schemafehler"}`;
    return {
      fingerprint: `manifest-invalid:${manifestSha256}`,
      result: blankStageResult("failed", reason, null, manifestSha256, "manifest-invalid"),
    };
  }
  const manifest = parsed.data;
  if (manifest.productGo.status === "blocked") {
    const reason = `Phonem-/Visem-Evaluator im Legal Hold: ${manifest.productGo.reason}`;
    return {
      fingerprint: `manifest-blocked:${manifestSha256}`,
      result: blankStageResult("not-available", reason, manifest, manifestSha256, "legal-hold"),
    };
  }
  if (!manifest.artifacts || !manifest.calibration || !manifest.legal) {
    const reason = "Evaluator-Release-Kandidat enthält keine vollständigen Kandidatenartefakte.";
    return {
      fingerprint: `manifest-candidate-incomplete:${manifestSha256}`,
      result: blankStageResult("failed", reason, manifest, manifestSha256, "manifest-invalid"),
    };
  }
  const reason = "Release-Kandidat erkannt; Product-GO-Prüfung und CPU-Inferenzrunner sind in diesem Build noch nicht aktiviert.";
  return {
    fingerprint: `manifest-runner-unavailable:${manifestSha256}`,
    result: blankStageResult("not-available", reason, manifest, manifestSha256, "runner-unavailable"),
  };
}
