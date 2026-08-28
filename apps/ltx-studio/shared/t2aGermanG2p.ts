import { spawnSync, type SpawnSyncOptionsWithBufferEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import {
  captureElfDependencyClosure,
  captureLoaderResolutionPolicy,
} from "../scripts/elf-dependency-lib.mjs";
import { canonicalJson } from "./canonicalJson.js";

export const T2A_GERMAN_G2P_DATA_MANIFEST_SCHEMA_VERSION =
  "ltx-studio-espeak-ng-data-tree-manifest.v1" as const;
export const T2A_GERMAN_G2P_RUNTIME_MANIFEST_SCHEMA_VERSION =
  "ltx-studio-espeak-ng-runtime-manifest.v1" as const;
export const T2A_GERMAN_G2P_REQUEST_SCHEMA_VERSION =
  "ltx-studio-t2a-german-g2p-request.v1" as const;
export const T2A_GERMAN_G2P_RESULT_SCHEMA_VERSION =
  "ltx-studio-t2a-german-g2p-result.v1" as const;

export const T2A_GERMAN_G2P_ESPEAK_PATH = "/usr/bin/espeak-ng" as const;
export const T2A_GERMAN_G2P_DATA_ROOT =
  "/usr/lib/aarch64-linux-gnu/espeak-ng-data" as const;
export const T2A_GERMAN_G2P_DATA_PARENT =
  "/usr/lib/aarch64-linux-gnu" as const;
export const T2A_GERMAN_G2P_VOCAB_PATH =
  "/var/lib/ltx-studio/models/facebook--wav2vec2-xlsr-53-espeak-cv-ft/2c733782da5604684829819a5eb744c193fe9398/vocab.json" as const;
export const T2A_GERMAN_G2P_ESPEAK_BINARY_SHA256 =
  "89402b6a13d29ab2edb0570c809796751b22a5d031828897cfb1b370dafa9c29" as const;
export const T2A_GERMAN_G2P_RUNNER_SHA256 =
  "b8eaf1b5e93da772bf2d765773af25d5ddbb69a12d5dac00f5c7c97dd6b31d36" as const;
export const T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256 =
  "a886ef7d07601c45d2982d91a546808f2cb1a99194ed07a443cb9d3839798658" as const;
export const T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256 =
  "d732ab2456c0c017930001dc9af0b41b3b93d25b2eb9740bf9d925508d7d87d0" as const;
export const T2A_GERMAN_G2P_LOADER_POLICY_SHA256 =
  "725633d3a57042eab0c56d5ff67d4c24c9f4f9071b0a5a1d75e9e492e0270287" as const;
export const T2A_GERMAN_G2P_ELF_CLOSURE_SHA256 =
  "62d8a4cebfda2cb872e7d3f564b801d2b6b632a4e1c00d0ce6139caaa97ac097" as const;
export const T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256 =
  "12370d2c3caea2c54afa50a4f95ab94eafdcaf71d46607d9bf0d7722225f3717" as const;
export const T2A_GERMAN_G2P_MAX_INPUT_BYTES = 16_384 as const;
export const T2A_GERMAN_G2P_MAX_OUTPUT_BYTES = 262_144 as const;
export const T2A_GERMAN_G2P_MAX_STDERR_BYTES = 4_096 as const;
export const T2A_GERMAN_G2P_TIMEOUT_MILLISECONDS = 5_000 as const;
export const T2A_GERMAN_G2P_MAX_TOKENS = 1_049 as const;
export const T2A_GERMAN_G2P_MAX_TREE_BYTES = 67_108_864 as const;

export const T2A_GERMAN_G2P_ESPEAK_ARGS = Object.freeze([
  "-q",
  "-b",
  "1",
  "-v",
  "de",
  "--stdin",
  "--ipa=1",
  "--sep=z",
  `--path=${T2A_GERMAN_G2P_DATA_PARENT}`,
] as const);

export const T2A_GERMAN_G2P_ENVIRONMENT = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
  TZ: "UTC",
});

export const T2A_GERMAN_G2P_NORMALIZATION_POLICY = Object.freeze({
  schemaVersion: "ltx-studio-t2a-german-g2p-normalization-policy.v1",
  locale: "de-DE",
  sourceEncoding: "utf-8-strict.v1",
  sourceDigest: "sha256-exact-source-utf8.v1",
  textCanonicalization: "crlf-and-cr-to-lf-then-unicode-nfc.v1",
  unicodeNormalizationAuthority: "unicode-normalization-stable-german-repertoire.v1",
  sourceRepertoire: "ascii-latin-combining-general-punctuation-symbol-ranges.v1",
  forbiddenInput: "nul-c0-c1-bom-bidi-and-default-ignorable-controls.v1",
  whitespacePolicy: "preserve-except-line-ending-canonicalization.v1",
  casePolicy: "preserve.v1",
  punctuationPolicy: "preserve-for-pinned-espeak.v1",
  espeakInvocation: "espeak-ng-1.51-de-ipa1-zwnj-fixed-argv-env.v1",
  phoneDelimiter: "U+200C",
  wordDelimiters: ["U+0020", "U+000A"],
  languageSwitchMarkers: "remove-strict-parenthesized-lower-bcp47.v1",
  stressMarksRemoved: ["U+02C8", "U+02CC"],
  phoneNormalization: "none-after-marker-and-stress-removal.v1",
  vocabularyPolicy: "exact-pinned-vocab-excluding-token-ids-0-through-3.v1",
  doubleQuestionTokenPolicy: "allow-pinned-vocab-token-id-85.v1",
  maximumSourceBytes: T2A_GERMAN_G2P_MAX_INPUT_BYTES,
  maximumNormalizedBytes: T2A_GERMAN_G2P_MAX_INPUT_BYTES,
  maximumEspeakStdoutBytes: T2A_GERMAN_G2P_MAX_OUTPUT_BYTES,
  maximumEspeakStderrBytes: T2A_GERMAN_G2P_MAX_STDERR_BYTES,
  maximumReferenceTokens: T2A_GERMAN_G2P_MAX_TOKENS,
});

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const T2A_GERMAN_G2P_NORMALIZATION_POLICY_SHA256 = sha256(
  canonicalJson(T2A_GERMAN_G2P_NORMALIZATION_POLICY),
);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const canonicalizationSchema = z.literal("ltx-studio-canonical-json.v1");
const digestAlgorithmSchema = z.literal("sha256");
const safeCountSchema = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const safeModeSchema = z.enum(["0444", "0555", "0644", "0755"]);
const absoluteAuthorityPathSchema = z.string().min(2).max(4_096).refine(
  (path) => isAbsolute(path) && resolve(path) === path && !path.includes("\\"),
  "authority path must be canonical POSIX absolute syntax",
);

const elfAuthorityFileSchema = z.object({
  path: absoluteAuthorityPathSchema,
  sizeBytes: safeCountSchema.max(T2A_GERMAN_G2P_MAX_TREE_BYTES),
  mode: z.number().finite().int().nonnegative().max(0o7777),
  sha256: sha256Schema,
}).strict();

const loaderPreloadSchema = z.object({
  configuration: elfAuthorityFileSchema.nullable(),
  entries: z.array(z.string().min(1).max(4_096)).max(1_024),
}).strict();

const loaderPolicyDocumentSchema = z.object({
  ldconfig: elfAuthorityFileSchema,
  cache: elfAuthorityFileSchema,
  outputSha256: sha256Schema,
  preload: loaderPreloadSchema,
  entries: z.record(
    z.string().min(1).max(512),
    z.array(absoluteAuthorityPathSchema).min(1).max(64),
  ),
}).strict();

const elfClosureDocumentSchema = z.object({
  schemaVersion: z.literal("ltx-studio-elf-dependency-closure.v2"),
  executable: absoluteAuthorityPathSchema,
  interpreter: absoluteAuthorityPathSchema,
  loaderPolicy: z.object({
    ldconfig: elfAuthorityFileSchema,
    cache: elfAuthorityFileSchema,
    outputSha256: sha256Schema,
    preload: loaderPreloadSchema,
  }).strict(),
  objects: z.array(elfAuthorityFileSchema.extend({
    needed: z.array(absoluteAuthorityPathSchema).max(256),
  })).min(2).max(512),
}).strict();

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function hasC0OrC1Control(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function validRelativeManifestPath(path: string): boolean {
  if (path === ".") return true;
  if (
    path.length === 0 ||
    Buffer.byteLength(path, "utf8") > 4_096 ||
    path !== path.normalize("NFC") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    hasC0OrC1Control(path)
  ) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const dataDirectoryEntrySchema = z.object({
  path: z.string().refine(validRelativeManifestPath, "invalid portable manifest path"),
  type: z.literal("directory"),
  mode: z.enum(["0555", "0755"]),
}).strict();

const dataRegularEntrySchema = z.object({
  path: z.string().refine(validRelativeManifestPath, "invalid portable manifest path"),
  type: z.literal("regular"),
  mode: z.enum(["0444", "0644"]),
  sizeBytes: safeCountSchema.max(T2A_GERMAN_G2P_MAX_TREE_BYTES),
  sha256: sha256Schema,
}).strict();

export const t2aGermanG2pDataEntrySchema = z.discriminatedUnion("type", [
  dataDirectoryEntrySchema,
  dataRegularEntrySchema,
]);

export const t2aGermanG2pDataManifestSchema = z.object({
  schemaVersion: z.literal(T2A_GERMAN_G2P_DATA_MANIFEST_SCHEMA_VERSION),
  canonicalization: canonicalizationSchema,
  digestAlgorithm: digestAlgorithmSchema,
  rootLogicalName: z.literal("espeak-ng-data"),
  pathEncoding: z.literal("utf8-nfc-posix-relative.v1"),
  entryOrder: z.literal("utf8-byte-lexicographic.v1"),
  entries: z.array(t2aGermanG2pDataEntrySchema).min(1).max(10_000),
  summary: z.object({
    directoryCount: safeCountSchema,
    regularFileCount: safeCountSchema,
    totalRegularFileBytes: safeCountSchema.max(T2A_GERMAN_G2P_MAX_TREE_BYTES),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const paths = manifest.entries.map(({ path }) => path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", path: ["entries"], message: "manifest paths must be unique" });
  }
  if (paths.some((path, index) => index > 0 && compareUtf8(paths[index - 1]!, path) >= 0)) {
    context.addIssue({ code: "custom", path: ["entries"], message: "manifest entries must use UTF-8 byte ordering" });
  }
  if (manifest.entries[0]?.path !== "." || manifest.entries[0]?.type !== "directory") {
    context.addIssue({ code: "custom", path: ["entries", 0], message: "manifest root directory is missing" });
  }
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  manifest.entries.forEach((entry, index) => {
    if (entry.path === ".") return;
    const separator = entry.path.lastIndexOf("/");
    const parent = separator < 0 ? "." : entry.path.slice(0, separator);
    if (byPath.get(parent)?.type !== "directory") {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "path"],
        message: "manifest entry parent must be a declared directory",
      });
    }
  });
  const directories = manifest.entries.filter(({ type }) => type === "directory").length;
  const files = manifest.entries.filter(
    (entry): entry is z.infer<typeof dataRegularEntrySchema> => entry.type === "regular",
  );
  const bytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  if (
    manifest.summary.directoryCount !== directories ||
    manifest.summary.regularFileCount !== files.length ||
    manifest.summary.totalRegularFileBytes !== bytes
  ) {
    context.addIssue({ code: "custom", path: ["summary"], message: "manifest summary contradicts its entries" });
  }
});

const runtimeFileSchema = z.object({
  logicalName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u),
  mode: safeModeSchema,
  sizeBytes: safeCountSchema,
  sha256: sha256Schema,
}).strict();

const invocationSchema = z.object({
  executableBinding: z.literal("held-o_nofollow-proc-fd.v1"),
  arguments: z.tuple([
    z.literal("-q"),
    z.literal("-b"),
    z.literal("1"),
    z.literal("-v"),
    z.literal("de"),
    z.literal("--stdin"),
    z.literal("--ipa=1"),
    z.literal("--sep=z"),
    z.literal(`--path=${T2A_GERMAN_G2P_DATA_PARENT}`),
  ]),
  environment: z.object({
    LANG: z.literal("C"),
    LC_ALL: z.literal("C"),
    PATH: z.literal("/usr/bin:/bin"),
    TZ: z.literal("UTC"),
  }).strict(),
  stdin: z.literal("normalized-target-utf8-no-added-newline.v1"),
  stdout: z.literal("espeak-ipa1-zwnj-strict-utf8.v1"),
  timeoutMilliseconds: z.literal(T2A_GERMAN_G2P_TIMEOUT_MILLISECONDS),
  maximumStdoutBytes: z.literal(T2A_GERMAN_G2P_MAX_OUTPUT_BYTES),
  maximumStderrBytes: z.literal(T2A_GERMAN_G2P_MAX_STDERR_BYTES),
}).strict();

export const T2A_GERMAN_G2P_INVOCATION = Object.freeze({
  executableBinding: "held-o_nofollow-proc-fd.v1",
  arguments: [...T2A_GERMAN_G2P_ESPEAK_ARGS],
  environment: { ...T2A_GERMAN_G2P_ENVIRONMENT },
  stdin: "normalized-target-utf8-no-added-newline.v1",
  stdout: "espeak-ipa1-zwnj-strict-utf8.v1",
  timeoutMilliseconds: T2A_GERMAN_G2P_TIMEOUT_MILLISECONDS,
  maximumStdoutBytes: T2A_GERMAN_G2P_MAX_OUTPUT_BYTES,
  maximumStderrBytes: T2A_GERMAN_G2P_MAX_STDERR_BYTES,
});

export const t2aGermanG2pRuntimeManifestSchema = z.object({
  schemaVersion: z.literal(T2A_GERMAN_G2P_RUNTIME_MANIFEST_SCHEMA_VERSION),
  canonicalization: canonicalizationSchema,
  digestAlgorithm: digestAlgorithmSchema,
  platform: z.object({
    operatingSystem: z.literal("linux"),
    architecture: z.literal("arm64"),
    elfMachine: z.literal(183),
  }).strict(),
  package: z.object({
    source: z.literal("ubuntu-noble"),
    name: z.literal("espeak-ng"),
    version: z.literal("1.51+dfsg-12build1"),
    architecture: z.literal("arm64"),
  }).strict(),
  executable: runtimeFileSchema.extend({
    logicalName: z.literal("espeak-ng"),
    sha256: z.literal(T2A_GERMAN_G2P_ESPEAK_BINARY_SHA256),
  }),
  versionProbe: z.object({
    arguments: z.tuple([z.literal("--version")]),
    exitCode: z.literal(0),
    stdoutSha256: sha256Schema,
    stderrSha256: z.literal(sha256(Buffer.alloc(0))),
  }).strict(),
  elfClosureSha256: z.literal(T2A_GERMAN_G2P_ELF_CLOSURE_SHA256),
  loaderPolicySha256: z.literal(T2A_GERMAN_G2P_LOADER_POLICY_SHA256),
  elfClosure: elfClosureDocumentSchema,
  loaderPolicy: loaderPolicyDocumentSchema,
  espeakDataManifestSha256: z.literal(T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256),
  ipaVocabularySha256: z.literal(T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256),
  normalizationPolicySha256: z.literal(T2A_GERMAN_G2P_NORMALIZATION_POLICY_SHA256),
  localeFiles: z.tuple([
    runtimeFileSchema.extend({ logicalName: z.literal("C.utf8-LC_CTYPE") }),
    runtimeFileSchema.extend({ logicalName: z.literal("locale-alias") }),
    runtimeFileSchema.extend({ logicalName: z.literal("locale-archive") }),
  ]),
  licenseFiles: z.tuple([
    runtimeFileSchema.extend({ logicalName: z.literal("espeak-ng-debian-copyright") }),
    runtimeFileSchema.extend({ logicalName: z.literal("gnu-gpl-3-license") }),
  ]),
  invocation: invocationSchema,
}).strict().superRefine((manifest, context) => {
  if (canonicalJson(manifest.invocation) !== canonicalJson(T2A_GERMAN_G2P_INVOCATION)) {
    context.addIssue({ code: "custom", path: ["invocation"], message: "runtime invocation differs from the frozen policy" });
  }
  const pins = [
    manifest.executable.sha256,
    manifest.elfClosureSha256,
    manifest.loaderPolicySha256,
    manifest.espeakDataManifestSha256,
    manifest.ipaVocabularySha256,
    manifest.normalizationPolicySha256,
  ];
  if (new Set(pins).size !== pins.length) {
    context.addIssue({ code: "custom", path: ["elfClosureSha256"], message: "runtime component pins must be distinct" });
  }
  if (sha256(canonicalJson(manifest.elfClosure)) !== manifest.elfClosureSha256) {
    context.addIssue({ code: "custom", path: ["elfClosure"], message: "ELF closure differs from its reviewed digest" });
  }
  if (sha256(canonicalJson(manifest.loaderPolicy)) !== manifest.loaderPolicySha256) {
    context.addIssue({ code: "custom", path: ["loaderPolicy"], message: "loader policy differs from its reviewed digest" });
  }
  const loaderSubset = {
    ldconfig: manifest.loaderPolicy.ldconfig,
    cache: manifest.loaderPolicy.cache,
    outputSha256: manifest.loaderPolicy.outputSha256,
    preload: manifest.loaderPolicy.preload,
  };
  if (canonicalJson(manifest.elfClosure.loaderPolicy) !== canonicalJson(loaderSubset)) {
    context.addIssue({ code: "custom", path: ["elfClosure", "loaderPolicy"], message: "ELF closure and loader policy are not mutually bound" });
  }
  const objectPaths = manifest.elfClosure.objects.map(({ path }) => path);
  if (
    manifest.elfClosure.executable !== T2A_GERMAN_G2P_ESPEAK_PATH ||
    new Set(objectPaths).size !== objectPaths.length ||
    objectPaths.some((path, index) => index > 0 && objectPaths[index - 1]!.localeCompare(path) >= 0) ||
    !objectPaths.includes(manifest.elfClosure.executable) ||
    !objectPaths.includes(manifest.elfClosure.interpreter) ||
    manifest.elfClosure.objects.some(({ needed }) => needed.some((path) => !objectPaths.includes(path)))
  ) {
    context.addIssue({ code: "custom", path: ["elfClosure", "objects"], message: "ELF closure graph is incomplete or non-canonical" });
  }
});

export const t2aGermanG2pTokenSchema = z.string().min(1).refine(
  (token) => [...token].length <= 32,
  "IPA token exceeds the code-point limit",
).refine(
  (token) => ![...token].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff);
  }),
  "IPA token contains a control or whitespace character",
).refine(
  (token) => token === token.normalize("NFC"),
  "IPA token must be NFC",
).refine(
  (token) => ![...token].some((character) => isDefaultIgnorableCodePoint(character.codePointAt(0)!)),
  "IPA token contains a default-ignorable code point",
);

export const t2aGermanG2pRequestSchema = z.object({
  schemaVersion: z.literal(T2A_GERMAN_G2P_REQUEST_SCHEMA_VERSION),
  targetText: z.string().min(1),
  targetTextSha256: sha256Schema,
  g2pRunnerSha256: z.literal(T2A_GERMAN_G2P_RUNNER_SHA256),
  espeakBinarySha256: z.literal(T2A_GERMAN_G2P_ESPEAK_BINARY_SHA256),
  espeakDataManifestSha256: z.literal(T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256),
  espeakRuntimeManifestSha256: z.literal(T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256),
  ipaVocabularySha256: z.literal(T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256),
  normalizationPolicySha256: z.literal(T2A_GERMAN_G2P_NORMALIZATION_POLICY_SHA256),
  dataManifestCanonicalJsonBase64: z.string().min(1).max(1024 * 1024),
  runtimeManifestCanonicalJsonBase64: z.string().min(1).max(256 * 1024),
}).strict();

export const t2aGermanG2pResultSchema = z.object({
  schemaVersion: z.literal(T2A_GERMAN_G2P_RESULT_SCHEMA_VERSION),
  status: z.literal("generated"),
  locale: z.literal("de-DE"),
  targetTextSha256: sha256Schema,
  normalizedTargetTextSha256: sha256Schema,
  g2pRunnerSha256: z.literal(T2A_GERMAN_G2P_RUNNER_SHA256),
  espeakBinarySha256: z.literal(T2A_GERMAN_G2P_ESPEAK_BINARY_SHA256),
  espeakDataManifestSha256: z.literal(T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256),
  espeakRuntimeManifestSha256: z.literal(T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256),
  ipaVocabularySha256: z.literal(T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256),
  normalizationPolicySha256: z.literal(T2A_GERMAN_G2P_NORMALIZATION_POLICY_SHA256),
  espeakStdoutSha256: sha256Schema,
  tokenization: z.literal("espeak-reference-ipa-token-sequence.v1"),
  referenceIpaTokens: z.array(t2aGermanG2pTokenSchema).min(1).max(T2A_GERMAN_G2P_MAX_TOKENS),
}).strict();

export type T2aGermanG2pDataManifest = z.infer<typeof t2aGermanG2pDataManifestSchema>;
export type T2aGermanG2pRuntimeManifest = z.infer<typeof t2aGermanG2pRuntimeManifestSchema>;
export type T2aGermanG2pRequest = z.infer<typeof t2aGermanG2pRequestSchema>;
export type T2aGermanG2pResult = z.infer<typeof t2aGermanG2pResultSchema>;

function sameRevision(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function modeString(stats: BigIntStats): z.infer<typeof safeModeSchema> {
  const value = Number(stats.mode & 0o7777n).toString(8).padStart(4, "0");
  return safeModeSchema.parse(value);
}

function assertSafeOwner(stats: BigIntStats, path: string, requireRootOwnership: boolean): void {
  if (requireRootOwnership && (stats.uid !== 0n || stats.gid !== 0n)) {
    throw new Error(`eSpeak data entry is not root-owned: ${path}`);
  }
}

export type T2aGermanG2pCaptureHooks = Readonly<{
  afterEntryRead?: (absolutePath: string) => void;
}>;

export function captureT2aGermanG2pDataManifest(
  root: string = T2A_GERMAN_G2P_DATA_ROOT,
  options: Readonly<{
    requireRootOwnership?: boolean;
    hooks?: T2aGermanG2pCaptureHooks;
  }> = {},
): T2aGermanG2pDataManifest {
  const canonicalRoot = resolve(root);
  if (!isAbsolute(root) || canonicalRoot !== root || realpathSync(root) !== root) {
    throw new Error("eSpeak data root must be one canonical absolute directory");
  }
  const requireRootOwnership = options.requireRootOwnership ?? true;
  const entries: Array<z.infer<typeof t2aGermanG2pDataEntrySchema>> = [];
  let totalRegularFileBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const walk = (absolutePath: string): void => {
    if (entries.length >= 10_000) {
      throw new Error("eSpeak data tree exceeds its fixed entry bound");
    }
    const before = lstatSync(absolutePath, { bigint: true });
    assertSafeOwner(before, absolutePath, requireRootOwnership);
    const portablePath = relative(canonicalRoot, absolutePath).split(sep).join("/") || ".";
    if (!validRelativeManifestPath(portablePath)) {
      throw new Error(`eSpeak data entry has a non-portable path: ${portablePath}`);
    }
    if (before.isSymbolicLink()) throw new Error(`eSpeak data symlink is forbidden: ${portablePath}`);
    if (before.isDirectory()) {
      const mode = modeString(before);
      if (mode !== "0555" && mode !== "0755") {
        throw new Error(`eSpeak data directory mode is unsafe: ${portablePath}`);
      }
      entries.push({ path: portablePath, type: "directory", mode });
      const rawNames = readdirSync(absolutePath, { encoding: "buffer" })
        .map((name) => Buffer.from(name))
        .sort(Buffer.compare);
      const names = rawNames.map((name) => decoder.decode(name));
      if (new Set(names.map((name) => name.normalize("NFC"))).size !== names.length) {
        throw new Error(`eSpeak data directory contains NFC-colliding names: ${portablePath}`);
      }
      for (const name of names) {
        if (name !== name.normalize("NFC") || name === "." || name === ".." || name.includes("/")) {
          throw new Error(`eSpeak data entry name is not canonical NFC: ${name}`);
        }
        walk(join(absolutePath, name));
      }
      options.hooks?.afterEntryRead?.(absolutePath);
      const after = lstatSync(absolutePath, { bigint: true });
      if (!sameRevision(before, after)) {
        throw new Error(`eSpeak data directory changed during capture: ${portablePath}`);
      }
      return;
    }
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error(`eSpeak data entry is not a single-link regular file: ${portablePath}`);
    }
    if (
      before.size > BigInt(T2A_GERMAN_G2P_MAX_TREE_BYTES) ||
      BigInt(totalRegularFileBytes) + before.size > BigInt(T2A_GERMAN_G2P_MAX_TREE_BYTES)
    ) throw new Error(`eSpeak data tree exceeds its fixed byte bound: ${portablePath}`);
    const mode = modeString(before);
    if (mode !== "0444" && mode !== "0644") {
      throw new Error(`eSpeak data file mode is unsafe: ${portablePath}`);
    }
    const descriptor = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const heldBefore = fstatSync(descriptor, { bigint: true });
      if (!sameRevision(before, heldBefore)) {
        throw new Error(`eSpeak data file was replaced before capture: ${portablePath}`);
      }
      const bytes = readFileSync(descriptor);
      if (BigInt(bytes.length) !== heldBefore.size) {
        throw new Error(`eSpeak data file read was not size-exact: ${portablePath}`);
      }
      options.hooks?.afterEntryRead?.(absolutePath);
      const heldAfter = fstatSync(descriptor, { bigint: true });
      const pathAfter = lstatSync(absolutePath, { bigint: true });
      if (!sameRevision(heldBefore, heldAfter) || !sameRevision(heldAfter, pathAfter)) {
        throw new Error(`eSpeak data file changed during capture: ${portablePath}`);
      }
      entries.push({
        path: portablePath,
        type: "regular",
        mode,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
      });
      totalRegularFileBytes += bytes.length;
    } finally {
      closeSync(descriptor);
    }
  };

  walk(canonicalRoot);
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  const files = entries.filter((entry): entry is z.infer<typeof dataRegularEntrySchema> =>
    entry.type === "regular");
  return t2aGermanG2pDataManifestSchema.parse({
    schemaVersion: T2A_GERMAN_G2P_DATA_MANIFEST_SCHEMA_VERSION,
    canonicalization: "ltx-studio-canonical-json.v1",
    digestAlgorithm: "sha256",
    rootLogicalName: "espeak-ng-data",
    pathEncoding: "utf8-nfc-posix-relative.v1",
    entryOrder: "utf8-byte-lexicographic.v1",
    entries,
    summary: {
      directoryCount: entries.length - files.length,
      regularFileCount: files.length,
      totalRegularFileBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    },
  });
}

export function t2aGermanG2pDataManifestSha256(rawManifest: unknown): string {
  return sha256(canonicalJson(t2aGermanG2pDataManifestSchema.parse(rawManifest)));
}

function capturedRuntimeFile(path: string, logicalName: string): z.infer<typeof runtimeFileSchema> {
  if (!isAbsolute(path) || realpathSync(path) !== path) {
    throw new Error(`G2P runtime file is not canonical: ${logicalName}`);
  }
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.uid !== 0n ||
    before.gid !== 0n
  ) throw new Error(`G2P runtime file is not a root-owned regular file: ${logicalName}`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const heldBefore = fstatSync(descriptor, { bigint: true });
    if (!sameRevision(before, heldBefore)) throw new Error(`G2P runtime file was replaced: ${logicalName}`);
    const bytes = readFileSync(descriptor);
    const heldAfter = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (!sameRevision(heldBefore, heldAfter) || !sameRevision(heldAfter, pathAfter)) {
      throw new Error(`G2P runtime file changed during capture: ${logicalName}`);
    }
    return runtimeFileSchema.parse({
      logicalName,
      mode: modeString(heldAfter),
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
    });
  } finally {
    closeSync(descriptor);
  }
}

export function captureT2aGermanG2pRuntimeManifest(
  dataManifest: T2aGermanG2pDataManifest = captureT2aGermanG2pDataManifest(),
): T2aGermanG2pRuntimeManifest {
  const parsedDataManifest = t2aGermanG2pDataManifestSchema.parse(dataManifest);
  const dataManifestSha256 = t2aGermanG2pDataManifestSha256(parsedDataManifest);
  if (dataManifestSha256 !== T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256) {
    throw new Error("Installed eSpeak data manifest differs from the reviewed pin");
  }
  if (process.platform !== "linux" || process.arch !== "arm64") {
    throw new Error("The reviewed G2P runtime is pinned to Linux arm64");
  }
  const loaderPolicy = captureLoaderResolutionPolicy();
  const elfClosure = captureElfDependencyClosure(T2A_GERMAN_G2P_ESPEAK_PATH, { loaderPolicy });
  const executable = capturedRuntimeFile(T2A_GERMAN_G2P_ESPEAK_PATH, "espeak-ng");
  const versionOptions: SpawnSyncOptionsWithBufferEncoding = {
    encoding: "buffer",
    env: { ...T2A_GERMAN_G2P_ENVIRONMENT },
    maxBuffer: 64 * 1024,
    timeout: T2A_GERMAN_G2P_TIMEOUT_MILLISECONDS,
  };
  const version = spawnSync(T2A_GERMAN_G2P_ESPEAK_PATH, ["--version"], versionOptions);
  if (version.error || version.signal !== null || version.status !== 0 || version.stderr.length !== 0 || version.stdout.length === 0) {
    throw new Error("Pinned eSpeak version probe failed");
  }
  const manifest = t2aGermanG2pRuntimeManifestSchema.parse({
    schemaVersion: T2A_GERMAN_G2P_RUNTIME_MANIFEST_SCHEMA_VERSION,
    canonicalization: "ltx-studio-canonical-json.v1",
    digestAlgorithm: "sha256",
    platform: { operatingSystem: "linux", architecture: "arm64", elfMachine: 183 },
    package: {
      source: "ubuntu-noble",
      name: "espeak-ng",
      version: "1.51+dfsg-12build1",
      architecture: "arm64",
    },
    executable,
    versionProbe: {
      arguments: ["--version"],
      exitCode: 0,
      stdoutSha256: sha256(version.stdout),
      stderrSha256: sha256(version.stderr),
    },
    elfClosureSha256: T2A_GERMAN_G2P_ELF_CLOSURE_SHA256,
    loaderPolicySha256: T2A_GERMAN_G2P_LOADER_POLICY_SHA256,
    elfClosure,
    loaderPolicy,
    espeakDataManifestSha256: dataManifestSha256,
    ipaVocabularySha256: T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256,
    normalizationPolicySha256: T2A_GERMAN_G2P_NORMALIZATION_POLICY_SHA256,
    localeFiles: [
      capturedRuntimeFile("/usr/lib/locale/C.utf8/LC_CTYPE", "C.utf8-LC_CTYPE"),
      capturedRuntimeFile("/etc/locale.alias", "locale-alias"),
      capturedRuntimeFile("/usr/lib/locale/locale-archive", "locale-archive"),
    ],
    licenseFiles: [
      capturedRuntimeFile(
        "/usr/share/doc/espeak-ng/copyright",
        "espeak-ng-debian-copyright",
      ),
      capturedRuntimeFile(
        "/usr/share/common-licenses/GPL-3",
        "gnu-gpl-3-license",
      ),
    ],
    invocation: T2A_GERMAN_G2P_INVOCATION,
  });
  if (manifest.executable.sha256 !== T2A_GERMAN_G2P_ESPEAK_BINARY_SHA256) {
    throw new Error("Installed eSpeak binary differs from the reviewed pin");
  }
  if (
    sha256(canonicalJson(loaderPolicy)) !== T2A_GERMAN_G2P_LOADER_POLICY_SHA256 ||
    sha256(canonicalJson(elfClosure)) !== T2A_GERMAN_G2P_ELF_CLOSURE_SHA256
  ) throw new Error("Installed ELF loader authority differs from the reviewed pins");
  return manifest;
}

export function t2aGermanG2pRuntimeManifestSha256(rawManifest: unknown): string {
  return sha256(canonicalJson(t2aGermanG2pRuntimeManifestSchema.parse(rawManifest)));
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function isDefaultIgnorableCodePoint(codePoint: number): boolean {
  return codePoint === 0x00ad ||
    codePoint === 0x034f ||
    codePoint === 0x061c ||
    (codePoint >= 0x115f && codePoint <= 0x1160) ||
    (codePoint >= 0x17b4 && codePoint <= 0x17b5) ||
    (codePoint >= 0x180b && codePoint <= 0x180f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0x3164 ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0xfeff ||
    codePoint === 0xffa0 ||
    (codePoint >= 0xfff0 && codePoint <= 0xfff8) ||
    (codePoint >= 0x1bca0 && codePoint <= 0x1bca3) ||
    (codePoint >= 0x1d173 && codePoint <= 0x1d17a) ||
    (codePoint >= 0xe0000 && codePoint <= 0xe0fff);
}

function isFrozenGermanSourceCodePoint(codePoint: number): boolean {
  return codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0x7e) ||
    (codePoint >= 0x00a0 && codePoint <= 0x036f) ||
    (codePoint >= 0x1e00 && codePoint <= 0x1eff) ||
    (codePoint >= 0x2000 && codePoint <= 0x22ff) ||
    (codePoint >= 0x2500 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2c60 && codePoint <= 0x2c7f) ||
    (codePoint >= 0xa720 && codePoint <= 0xa7ff) ||
    (codePoint >= 0xab30 && codePoint <= 0xab6f) ||
    (codePoint >= 0xfb00 && codePoint <= 0xfb06);
}

function hasForbiddenTargetCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      isDefaultIgnorableCodePoint(codePoint) ||
      !isFrozenGermanSourceCodePoint(codePoint);
  });
}

export function normalizeT2aGermanTargetText(rawText: string): Readonly<{
  normalizedText: string;
  targetTextSha256: string;
  normalizedTargetTextSha256: string;
}> {
  if (
    typeof rawText !== "string" ||
    Buffer.byteLength(rawText, "utf8") === 0 ||
    Buffer.byteLength(rawText, "utf8") > T2A_GERMAN_G2P_MAX_INPUT_BYTES ||
    containsUnpairedSurrogate(rawText) ||
    hasForbiddenTargetCharacter(rawText)
  ) throw new Error("German G2P target text violates the strict source-text policy");
  const normalizedText = rawText.replace(/\r\n?/gu, "\n").normalize("NFC");
  if (
    Buffer.byteLength(normalizedText, "utf8") === 0 ||
    Buffer.byteLength(normalizedText, "utf8") > T2A_GERMAN_G2P_MAX_INPUT_BYTES ||
    !/\S/u.test(normalizedText) ||
    containsUnpairedSurrogate(normalizedText) ||
    hasForbiddenTargetCharacter(normalizedText)
  ) throw new Error("German G2P target text normalizes to an invalid source");
  return Object.freeze({
    normalizedText,
    targetTextSha256: sha256(Buffer.from(rawText, "utf8")),
    normalizedTargetTextSha256: sha256(Buffer.from(normalizedText, "utf8")),
  });
}

export function parseT2aGermanG2pVocabulary(rawBytes: Uint8Array): ReadonlySet<string> {
  const bytes = Buffer.from(rawBytes);
  if (sha256(bytes) !== T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256) {
    throw new Error("German G2P vocabulary differs from the reviewed pin");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("German G2P vocabulary is not strict UTF-8 JSON");
  }
  if (raw === null || Array.isArray(raw) || typeof raw !== "object") {
    throw new Error("German G2P vocabulary must be an object");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length !== 392) throw new Error("German G2P vocabulary has the wrong size");
  const ids = new Set<number>();
  for (const [token, id] of entries) {
    if (!Number.isInteger(id) || (id as number) < 0 || (id as number) > 391 || ids.has(id as number)) {
      throw new Error("German G2P vocabulary IDs are not an exact bijection");
    }
    ids.add(id as number);
    if (token.length === 0) throw new Error("German G2P vocabulary contains an empty token");
  }
  for (const [token, id] of [["<pad>", 0], ["<s>", 1], ["</s>", 2], ["<unk>", 3]] as const) {
    if ((raw as Record<string, unknown>)[token] !== id) {
      throw new Error("German G2P vocabulary special-token authority differs");
    }
  }
  if ((raw as Record<string, unknown>)["??"] !== 85) {
    throw new Error("German G2P vocabulary no longer binds the legitimate double-question token");
  }
  return new Set(entries.filter(([, id]) => (id as number) >= 4).map(([token]) => token));
}

const languageSwitchMarker = /^\([a-z]{2,3}(?:-[a-z0-9]{2,8})*\)$/u;

export function referenceIpaTokensFromEspeakStdout(
  stdoutBytes: Uint8Array,
  allowedVocabulary: ReadonlySet<string>,
): readonly string[] {
  const bytes = Buffer.from(stdoutBytes);
  if (bytes.length === 0 || bytes.length > T2A_GERMAN_G2P_MAX_OUTPUT_BYTES) {
    throw new Error("eSpeak IPA stdout is empty or exceeds its fixed bound");
  }
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("eSpeak IPA stdout is not strict UTF-8");
  }
  const invalidDelimiterCodePoint = [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x08 ||
      codePoint === 0x09 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      codePoint === 0x0d ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f);
  });
  if (value !== value.normalize("NFC") || invalidDelimiterCodePoint) {
    throw new Error("eSpeak IPA stdout violates the frozen delimiter grammar");
  }
  const tokens: string[] = [];
  for (const rawToken of value.split(/[\u200c \n]+/u).filter(Boolean)) {
    if (languageSwitchMarker.test(rawToken)) continue;
    const token = rawToken.replace(/[ˈˌ]/gu, "");
    if (!t2aGermanG2pTokenSchema.safeParse(token).success || !allowedVocabulary.has(token)) {
      throw new Error(`eSpeak emitted an IPA token outside the pinned vocabulary: ${token}`);
    }
    tokens.push(token);
  }
  if (tokens.length === 0 || tokens.length > T2A_GERMAN_G2P_MAX_TOKENS) {
    throw new Error("eSpeak emitted an invalid number of reference IPA tokens");
  }
  return Object.freeze(tokens);
}

function parseCanonicalBase64<T>(
  encoded: string,
  schema: z.ZodType<T>,
  label: string,
): T {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== encoded) {
    throw new Error(`Invalid canonical base64 for ${label}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`Invalid canonical JSON for ${label}`);
  }
  const parsed = schema.safeParse(raw);
  let canonicalSource: string;
  try {
    canonicalSource = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Invalid strict UTF-8 for ${label}`);
  }
  if (!parsed.success || canonicalJson(parsed.data) !== canonicalSource) {
    throw new Error(`Non-canonical ${label}`);
  }
  return parsed.data;
}

export function buildT2aGermanG2pRequest(options: Readonly<{
  targetText: string;
  g2pRunnerSha256: string;
  dataManifest: T2aGermanG2pDataManifest;
  runtimeManifest: T2aGermanG2pRuntimeManifest;
}>): T2aGermanG2pRequest {
  if (options.g2pRunnerSha256 !== T2A_GERMAN_G2P_RUNNER_SHA256) {
    throw new Error("German G2P runner differs from the reviewed authority");
  }
  const normalized = normalizeT2aGermanTargetText(options.targetText);
  const dataManifest = t2aGermanG2pDataManifestSchema.parse(options.dataManifest);
  const runtimeManifest = t2aGermanG2pRuntimeManifestSchema.parse(options.runtimeManifest);
  const dataManifestCanonical = canonicalJson(dataManifest);
  const runtimeManifestCanonical = canonicalJson(runtimeManifest);
  const dataManifestSha256 = sha256(dataManifestCanonical);
  const runtimeManifestSha256 = sha256(runtimeManifestCanonical);
  if (
    dataManifestSha256 !== T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256 ||
    runtimeManifest.espeakDataManifestSha256 !== dataManifestSha256 ||
    runtimeManifestSha256 !== T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256
  ) throw new Error("German G2P data and runtime manifests are not mutually bound");
  return t2aGermanG2pRequestSchema.parse({
    schemaVersion: T2A_GERMAN_G2P_REQUEST_SCHEMA_VERSION,
    targetText: options.targetText,
    targetTextSha256: normalized.targetTextSha256,
    g2pRunnerSha256: options.g2pRunnerSha256,
    espeakBinarySha256: runtimeManifest.executable.sha256,
    espeakDataManifestSha256: dataManifestSha256,
    espeakRuntimeManifestSha256: runtimeManifestSha256,
    ipaVocabularySha256: runtimeManifest.ipaVocabularySha256,
    normalizationPolicySha256: runtimeManifest.normalizationPolicySha256,
    dataManifestCanonicalJsonBase64: Buffer.from(dataManifestCanonical, "utf8").toString("base64"),
    runtimeManifestCanonicalJsonBase64: Buffer.from(runtimeManifestCanonical, "utf8").toString("base64"),
  });
}

export function verifyT2aGermanG2pRequest(rawRequest: unknown): Readonly<{
  request: T2aGermanG2pRequest;
  normalizedText: string;
  normalizedTargetTextSha256: string;
  dataManifest: T2aGermanG2pDataManifest;
  runtimeManifest: T2aGermanG2pRuntimeManifest;
}> {
  const request = t2aGermanG2pRequestSchema.parse(rawRequest);
  const normalized = normalizeT2aGermanTargetText(request.targetText);
  if (normalized.targetTextSha256 !== request.targetTextSha256) {
    throw new Error("German G2P request target-text digest mismatch");
  }
  const dataManifest = parseCanonicalBase64(
    request.dataManifestCanonicalJsonBase64,
    t2aGermanG2pDataManifestSchema,
    "eSpeak data manifest",
  );
  const runtimeManifest = parseCanonicalBase64(
    request.runtimeManifestCanonicalJsonBase64,
    t2aGermanG2pRuntimeManifestSchema,
    "eSpeak runtime manifest",
  );
  if (
    t2aGermanG2pDataManifestSha256(dataManifest) !== request.espeakDataManifestSha256 ||
    t2aGermanG2pRuntimeManifestSha256(runtimeManifest) !== request.espeakRuntimeManifestSha256 ||
    runtimeManifest.executable.sha256 !== request.espeakBinarySha256 ||
    runtimeManifest.espeakDataManifestSha256 !== request.espeakDataManifestSha256 ||
    runtimeManifest.ipaVocabularySha256 !== request.ipaVocabularySha256 ||
    runtimeManifest.normalizationPolicySha256 !== request.normalizationPolicySha256
  ) throw new Error("German G2P request authority-manifest binding mismatch");
  return Object.freeze({
    request,
    normalizedText: normalized.normalizedText,
    normalizedTargetTextSha256: normalized.normalizedTargetTextSha256,
    dataManifest,
    runtimeManifest,
  });
}

export function parseT2aGermanG2pExecution(execution: Readonly<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  error?: Error;
}>, expectedRequest: T2aGermanG2pRequest): T2aGermanG2pResult {
  if (
    execution.error !== undefined ||
    execution.signal !== null ||
    execution.status !== 0 ||
    execution.stderr.length !== 0 ||
    execution.stdout.length === 0 ||
    execution.stdout.length > T2A_GERMAN_G2P_MAX_OUTPUT_BYTES
  ) throw new Error("German G2P runner did not complete as one bounded clean execution");
  const verifiedRequest = verifyT2aGermanG2pRequest(expectedRequest);
  let raw: unknown;
  let stdout: string;
  try {
    stdout = new TextDecoder("utf-8", { fatal: true }).decode(execution.stdout);
    raw = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("German G2P runner emitted invalid strict UTF-8 JSON");
  }
  const result = t2aGermanG2pResultSchema.parse(raw);
  if (canonicalJson(result) !== stdout) throw new Error("German G2P runner result is not canonical JSON");
  const normalized = normalizeT2aGermanTargetText(verifiedRequest.request.targetText);
  if (
    result.targetTextSha256 !== expectedRequest.targetTextSha256 ||
    result.normalizedTargetTextSha256 !== normalized.normalizedTargetTextSha256 ||
    result.g2pRunnerSha256 !== expectedRequest.g2pRunnerSha256 ||
    result.espeakBinarySha256 !== expectedRequest.espeakBinarySha256 ||
    result.espeakDataManifestSha256 !== expectedRequest.espeakDataManifestSha256 ||
    result.espeakRuntimeManifestSha256 !== expectedRequest.espeakRuntimeManifestSha256 ||
    result.ipaVocabularySha256 !== expectedRequest.ipaVocabularySha256 ||
    result.normalizationPolicySha256 !== expectedRequest.normalizationPolicySha256
  ) throw new Error("German G2P runner result differs from its authority request");
  const vocabulary = parseT2aGermanG2pVocabulary(readFileSync(T2A_GERMAN_G2P_VOCAB_PATH));
  if (result.referenceIpaTokens.some((token) => !vocabulary.has(token))) {
    throw new Error("German G2P runner result contains a token outside the pinned vocabulary");
  }
  return Object.freeze(result);
}

export function validatePinnedT2aGermanG2pResult(rawResult: unknown): T2aGermanG2pResult {
  const result = t2aGermanG2pResultSchema.parse(rawResult);
  const vocabulary = parseT2aGermanG2pVocabulary(readFileSync(T2A_GERMAN_G2P_VOCAB_PATH));
  if (result.referenceIpaTokens.some((token) => !vocabulary.has(token))) {
    throw new Error("German G2P result contains a token outside the pinned vocabulary");
  }
  return Object.freeze(result);
}

export function t2aGermanG2pResultCanonicalJson(rawResult: unknown): string {
  return canonicalJson(validatePinnedT2aGermanG2pResult(rawResult));
}
