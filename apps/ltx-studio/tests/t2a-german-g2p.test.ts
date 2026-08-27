import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { analysisPythonExecutable, appRoot } from "../server/config.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import {
  INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
  parseIndependentIpaPhase,
} from "../shared/independentIpa.js";
import { buildT2aReferenceIpaDocument } from "../shared/t2aIpaAdjudication.js";
import {
  T2A_GERMAN_G2P_DATA_ROOT,
  T2A_GERMAN_G2P_ELF_CLOSURE_SHA256,
  T2A_GERMAN_G2P_ESPEAK_ARGS,
  T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256,
  T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256,
  T2A_GERMAN_G2P_LOADER_POLICY_SHA256,
  T2A_GERMAN_G2P_MAX_OUTPUT_BYTES,
  T2A_GERMAN_G2P_MAX_TREE_BYTES,
  T2A_GERMAN_G2P_NORMALIZATION_POLICY_SHA256,
  T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256,
  T2A_GERMAN_G2P_VOCAB_PATH,
  buildT2aGermanG2pRequest,
  captureT2aGermanG2pDataManifest,
  captureT2aGermanG2pRuntimeManifest,
  normalizeT2aGermanTargetText,
  parseT2aGermanG2pExecution,
  parseT2aGermanG2pVocabulary,
  t2aGermanG2pDataManifestSchema,
  t2aGermanG2pDataManifestSha256,
  t2aGermanG2pRuntimeManifestSchema,
  t2aGermanG2pRuntimeManifestSha256,
  verifyT2aGermanG2pRequest,
  type T2aGermanG2pDataManifest,
  type T2aGermanG2pRequest,
  type T2aGermanG2pResult,
  type T2aGermanG2pRuntimeManifest,
} from "../shared/t2aGermanG2p.js";

const runnerPath = join(appRoot, "scripts", "t2a_german_g2p.py");
const runnerSha256 = createHash("sha256").update(readFileSync(runnerPath)).digest("hex");
const userTargetText = "Dein Befehl reißt mich in die Höhe. Ich schreie deinen Namen aus, während alles um mich herum explodiert. Wellen reiner Lust durchströmen meinen ganzen Körper. Ich spüre, wie ich dich immer enger umschlinge. Wie fühlt es sich an, mich so komplett zu besitzen?";
const temporaryRoots: string[] = [];

let dataManifest: T2aGermanG2pDataManifest;
let runtimeManifest: T2aGermanG2pRuntimeManifest;
let goldenRequest: T2aGermanG2pRequest;
let goldenExecution: ReturnType<typeof runPython>;
let goldenResult: T2aGermanG2pResult;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function runPython(request: T2aGermanG2pRequest) {
  return spawnSync(analysisPythonExecutable, ["-I", runnerPath], {
    cwd: appRoot,
    encoding: "buffer",
    env: { PATH: process.env.PATH, PYTHONNOUSERSITE: "1" },
    input: Buffer.from(canonicalJson(request), "utf8"),
    maxBuffer: T2A_GERMAN_G2P_MAX_OUTPUT_BYTES + 64 * 1024,
    timeout: 30_000,
  });
}

function runRawPythonRequest(request: unknown) {
  return spawnSync(analysisPythonExecutable, ["-I", runnerPath], {
    cwd: appRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH, PYTHONNOUSERSITE: "1" },
    input: canonicalJson(request),
    timeout: 10_000,
  });
}

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "ltx-g2p-tree-"));
  temporaryRoots.push(root);
  chmodSync(root, 0o755);
  return root;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nestedKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nestedKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...nestedKeys(item)]);
}

beforeAll(() => {
  dataManifest = captureT2aGermanG2pDataManifest();
  runtimeManifest = captureT2aGermanG2pRuntimeManifest(dataManifest);
  goldenRequest = buildT2aGermanG2pRequest({
    targetText: userTargetText,
    g2pRunnerSha256: runnerSha256,
    dataManifest,
    runtimeManifest,
  });
  goldenExecution = runPython(goldenRequest);
  goldenResult = parseT2aGermanG2pExecution({
    status: goldenExecution.status,
    signal: goldenExecution.signal,
    stdout: goldenExecution.stdout,
    stderr: goldenExecution.stderr,
    ...(goldenExecution.error === undefined ? {} : { error: goldenExecution.error }),
  }, goldenRequest);
}, 60_000);

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

describe("pinned German eSpeak G2P reference contract", () => {
  it("reproduces the real user-text golden output through TS -> Python -> TS", () => {
    expect(goldenExecution.status, goldenExecution.stderr.toString("utf8")).toBe(0);
    expect(goldenResult.targetTextSha256)
      .toBe("8357f353b67ae01ed4b5723ca9c14f1be450d76e3480afec09b6cefd429243d9");
    expect(goldenResult.normalizedTargetTextSha256).toBe(goldenResult.targetTextSha256);
    expect(goldenResult.espeakStdoutSha256)
      .toBe("cc5ad2b3ce7e296964576cee7efe7430f63cdf0b654f53ac9cc79abd0c5ee2ce");
    expect(goldenResult.referenceIpaTokens).toHaveLength(170);
    expect(sha256(canonicalJson(goldenResult.referenceIpaTokens)))
      .toBe("ebc408024f8bbe94af09e5654c27a74d6a041842eb7301e2656d9e9814111cb9");
    expect(goldenResult.referenceIpaTokens).toContain("??");
    expect(canonicalJson(JSON.parse(goldenExecution.stdout.toString("utf8"))))
      .toBe(goldenExecution.stdout.toString("utf8"));
  });

  it("pins the exact data tree, full loader/ELF closure, locale and license closure", () => {
    expect(dataManifest.summary).toEqual({
      directoryCount: 38,
      regularFileCount: 488,
      totalRegularFileBytes: 11_627_324,
    });
    expect(dataManifest.entries).toHaveLength(526);
    expect(t2aGermanG2pDataManifestSha256(dataManifest))
      .toBe(T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256);
    expect(runtimeManifest.loaderPolicySha256).toBe(T2A_GERMAN_G2P_LOADER_POLICY_SHA256);
    expect(runtimeManifest.elfClosureSha256).toBe(T2A_GERMAN_G2P_ELF_CLOSURE_SHA256);
    expect(runtimeManifest.elfClosure.objects).toHaveLength(36);
    expect(Object.keys(runtimeManifest.loaderPolicy.entries)).toHaveLength(1_406);
    expect(runtimeManifest.localeFiles.map(({ logicalName }) => logicalName)).toEqual([
      "C.utf8-LC_CTYPE", "locale-alias", "locale-archive",
    ]);
    expect(runtimeManifest.licenseFiles.map(({ logicalName }) => logicalName)).toEqual([
      "espeak-ng-debian-copyright", "gnu-gpl-3-license",
    ]);
    expect(t2aGermanG2pRuntimeManifestSha256(runtimeManifest))
      .toBe(T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256);
    expect(T2A_GERMAN_G2P_NORMALIZATION_POLICY_SHA256)
      .toBe("c8ed3c0cb746212a9858bc028da8899ff411c1023c88b5b329e55e1e50c34563");
  });

  it("normalizes line endings and NFC identically while preserving raw and normalized digests", () => {
    const raw = "Ka\u0308se\r\nund Öl";
    const normalized = normalizeT2aGermanTargetText(raw);
    expect(normalized.normalizedText).toBe("Käse\nund Öl");
    expect(normalized.targetTextSha256).not.toBe(normalized.normalizedTargetTextSha256);
    const request = buildT2aGermanG2pRequest({
      targetText: raw,
      g2pRunnerSha256: runnerSha256,
      dataManifest,
      runtimeManifest,
    });
    const execution = runPython(request);
    const result = parseT2aGermanG2pExecution({
      status: execution.status,
      signal: execution.signal,
      stdout: execution.stdout,
      stderr: execution.stderr,
      ...(execution.error === undefined ? {} : { error: execution.error }),
    }, request);
    expect(result.targetTextSha256).toBe(normalized.targetTextSha256);
    expect(result.normalizedTargetTextSha256).toBe(normalized.normalizedTargetTextSha256);
  });

  it.each([
    ["soft hyphen", "a\u00adb"],
    ["combining grapheme joiner", "a\u034fb"],
    ["Arabic letter mark", "a\u061cb"],
    ["bidi override", "a\u202eb"],
    ["supplementary variation selector", `a${String.fromCodePoint(0xe0100)}b`],
    ["tag character", `a${String.fromCodePoint(0xe0020)}b`],
    ["Unicode-version drift vector", `${String.fromCodePoint(0x105d2)}\u0307`],
  ])("rejects the %s adversarial Unicode input in both runtimes", (_name, targetText) => {
    expect(() => normalizeT2aGermanTargetText(targetText)).toThrow(/source-text policy/iu);
    const request = {
      ...goldenRequest,
      targetText,
      targetTextSha256: sha256(Buffer.from(targetText, "utf8")),
    };
    const execution = runRawPythonRequest(request);
    expect(execution.status).toBe(2);
    expect(execution.stderr).toMatch(/forbidden control|target text/iu);
  });

  it("rejects request split-bindings, unknown fields, argv/env/path tamper and manifest drift", () => {
    const splitRequest = { ...goldenRequest, targetText: "Anderer Text" };
    expect(() => verifyT2aGermanG2pRequest(splitRequest)).toThrow(/digest mismatch/iu);
    expect(() => verifyT2aGermanG2pRequest({ ...goldenRequest, threshold: 0.1 }))
      .toThrow();

    const runtimeArgs = clone(runtimeManifest) as unknown as Record<string, unknown>;
    (runtimeArgs.invocation as { arguments: string[] }).arguments = [...T2A_GERMAN_G2P_ESPEAK_ARGS, "--tie=z"];
    expect(t2aGermanG2pRuntimeManifestSchema.safeParse(runtimeArgs).success).toBe(false);

    const runtimeEnv = clone(runtimeManifest) as unknown as Record<string, unknown>;
    (runtimeEnv.invocation as { environment: Record<string, string> }).environment.HOME = "/tmp";
    expect(t2aGermanG2pRuntimeManifestSchema.safeParse(runtimeEnv).success).toBe(false);

    const runtimePath = clone(runtimeManifest) as unknown as Record<string, unknown>;
    const loader = runtimePath.loaderPolicy as { cache: { path: string } };
    loader.cache.path = "/tmp/ld.so.cache";
    expect(t2aGermanG2pRuntimeManifestSchema.safeParse(runtimePath).success).toBe(false);

    const extraManifest = { ...dataManifest, rootPath: T2A_GERMAN_G2P_DATA_ROOT };
    expect(t2aGermanG2pDataManifestSchema.safeParse(extraManifest).success).toBe(false);
    const badSummary = clone(dataManifest);
    badSummary.summary.totalRegularFileBytes += 1;
    expect(t2aGermanG2pDataManifestSchema.safeParse(badSummary).success).toBe(false);
    const badOrder = clone(dataManifest);
    [badOrder.entries[1], badOrder.entries[2]] = [badOrder.entries[2]!, badOrder.entries[1]!];
    expect(t2aGermanG2pDataManifestSchema.safeParse(badOrder).success).toBe(false);
  });

  it("rejects symlinks, hardlinks, special files, non-NFC names, TOCTOU and oversized trees", () => {
    const symlinkRoot = makeTree();
    symlinkSync("/etc/hosts", join(symlinkRoot, "link"));
    expect(() => captureT2aGermanG2pDataManifest(symlinkRoot, { requireRootOwnership: false }))
      .toThrow(/symlink/iu);

    const hardlinkRoot = makeTree();
    const first = join(hardlinkRoot, "first");
    writeFileSync(first, "x");
    chmodSync(first, 0o644);
    linkSync(first, join(hardlinkRoot, "second"));
    expect(() => captureT2aGermanG2pDataManifest(hardlinkRoot, { requireRootOwnership: false }))
      .toThrow(/single-link/iu);

    const specialRoot = makeTree();
    const fifo = join(specialRoot, "fifo");
    expect(spawnSync("/usr/bin/mkfifo", [fifo]).status).toBe(0);
    expect(() => captureT2aGermanG2pDataManifest(specialRoot, { requireRootOwnership: false }))
      .toThrow(/single-link regular file/iu);

    const nfcRoot = makeTree();
    writeFileSync(join(nfcRoot, "e\u0301"), "x");
    expect(() => captureT2aGermanG2pDataManifest(nfcRoot, { requireRootOwnership: false }))
      .toThrow(/NFC/iu);

    const raceRoot = makeTree();
    const raced = join(raceRoot, "raced");
    writeFileSync(raced, "before");
    chmodSync(raced, 0o644);
    expect(() => captureT2aGermanG2pDataManifest(raceRoot, {
      requireRootOwnership: false,
      hooks: {
        afterEntryRead: (path) => {
          if (path === raced) writeFileSync(raced, "after!");
        },
      },
    })).toThrow(/changed during capture/iu);

    const largeRoot = makeTree();
    const large = join(largeRoot, "large");
    writeFileSync(large, "");
    truncateSync(large, T2A_GERMAN_G2P_MAX_TREE_BYTES + 1);
    chmodSync(large, 0o644);
    expect(() => captureT2aGermanG2pDataManifest(largeRoot, { requireRootOwnership: false }))
      .toThrow(/byte bound/iu);
  });

  it("rejects invalid runner UTF-8, split-bound expected requests, OOV and special result tokens", () => {
    expect(() => parseT2aGermanG2pExecution({
      status: 0,
      signal: null,
      stdout: Buffer.from([0xff]),
      stderr: Buffer.alloc(0),
    }, goldenRequest)).toThrow(/strict UTF-8/iu);

    expect(() => parseT2aGermanG2pExecution({
      status: goldenExecution.status,
      signal: goldenExecution.signal,
      stdout: goldenExecution.stdout,
      stderr: goldenExecution.stderr,
    }, { ...goldenRequest, targetText: "Mutierter Text" })).toThrow(/digest mismatch/iu);

    for (const token of ["evil", "<pad>", "<unk>"]) {
      const result = { ...goldenResult, referenceIpaTokens: [token] };
      expect(() => parseT2aGermanG2pExecution({
        status: 0,
        signal: null,
        stdout: Buffer.from(canonicalJson(result), "utf8"),
        stderr: Buffer.alloc(0),
      }, goldenRequest)).toThrow(/pinned vocabulary|outside/iu);
    }
  });

  it("builds the downstream reference only from a fully verified G2P execution", () => {
    const authorityAudioSha256 = "a".repeat(64);
    const phase = parseIndependentIpaPhase({
      schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
      status: "insufficient",
      reasonCode: "duration-exceeds-independent-ipa-window",
      authorityAudioSha256,
      sourceAudioSha256: authorityAudioSha256,
      normalization: null,
      observation: null,
      error: null,
    });
    const built = buildT2aReferenceIpaDocument({
      phase,
      g2pRequest: goldenRequest,
      g2pExecution: {
        status: goldenExecution.status,
        signal: goldenExecution.signal,
        stdout: goldenExecution.stdout,
        stderr: goldenExecution.stderr,
      },
      adjudicatorRunnerSha256: "f".repeat(64),
    });
    expect(built.reference.referenceIpaTokens).toEqual(goldenResult.referenceIpaTokens);
    expect(built.reference.g2pResultSha256)
      .toBe(sha256(built.g2pResultCanonicalJson));

    const forged = { ...goldenResult, referenceIpaTokens: ["evil"] };
    expect(() => buildT2aReferenceIpaDocument({
      phase,
      g2pRequest: goldenRequest,
      g2pExecution: {
        status: 0,
        signal: null,
        stdout: Buffer.from(canonicalJson(forged), "utf8"),
        stderr: Buffer.alloc(0),
      },
      adjudicatorRunnerSha256: "f".repeat(64),
    })).toThrow(/pinned vocabulary|outside/iu);
  });

  it("enforces Python timeout, nonblocking stdin and stderr/stdout overflow bounds", () => {
    const probe = (body: string) => spawnSync(
      analysisPythonExecutable,
      ["-I", "-c", [
        "import os,runpy,sys",
        "m=runpy.run_path(sys.argv[1])",
        "try:",
        ...body.split("\n").map((line) => `    ${line}`),
        "except m['G2pError'] as e:",
        "    print(str(e))",
        "    raise SystemExit(0)",
        "raise SystemExit(9)",
      ].join("\n"), runnerPath],
      { encoding: "utf8", timeout: 5_000 },
    );

    const timeout = probe([
      "fd=os.open('/usr/bin/python3.12',os.O_RDONLY)",
      "m['_run_bounded'](fd,('-c','import time; time.sleep(2)'),b'x'*(1024*1024),maximum_stdout_bytes=16,maximum_stderr_bytes=16,timeout_seconds=0.05)",
    ].join("\n"));
    expect(timeout.status, timeout.stderr).toBe(0);
    expect(timeout.stdout).toMatch(/timed out/iu);

    const stderr = probe([
      "fd=os.open('/usr/bin/python3.12',os.O_RDONLY)",
      "m['_run_bounded'](fd,('-c',\"import sys; sys.stderr.write('x'*100)\"),b'',maximum_stdout_bytes=16,maximum_stderr_bytes=8,timeout_seconds=1)",
    ].join("\n"));
    expect(stderr.status, stderr.stderr).toBe(0);
    expect(stderr.stdout).toMatch(/stderr exceeded/iu);

    const stdout = probe(`m['_reference_tokens'](b'x'*${T2A_GERMAN_G2P_MAX_OUTPUT_BYTES + 1},{'x'})`);
    expect(stdout.status, stdout.stderr).toBe(0);
    expect(stdout.stdout).toMatch(/byte bound/iu);
  });

  it("emits no plaintext, paths, thresholds, homophone logic or decisions", () => {
    const keys = nestedKeys(goldenResult);
    expect(keys).not.toEqual(expect.arrayContaining([
      "targetText", "normalizedText", "path", "audioPath", "threshold", "decision",
      "qualified", "eligible", "homophone", "wordMatch",
    ]));
    expect(JSON.stringify(goldenResult)).not.toContain(userTargetText);
    expect(JSON.stringify(goldenResult)).not.toContain("/usr/");
    const vocabulary = parseT2aGermanG2pVocabulary(readFileSync(T2A_GERMAN_G2P_VOCAB_PATH));
    expect(vocabulary.has("??")).toBe(true);
    expect(vocabulary.has("<pad>")).toBe(false);
    expect(vocabulary.has("<unk>")).toBe(false);
    expect(T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256).toMatch(/^[0-9a-f]{64}$/u);
  });
});
