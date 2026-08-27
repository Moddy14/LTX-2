import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  captureLipForcingImageIdentity,
  createLipForcingImageIdentityOperations,
  LIPFORCING_IMAGE_ARTIFACT_PATHS,
  LIPFORCING_IMAGE_PATCH_SET_ID,
  LIPFORCING_IMAGE_SOURCE_REVISION,
  lipForcingImageIdentity,
  readCopiedRegularArtifact,
  verifyLipForcingImageIdentity,
  type DockerCommandOptions,
  type DockerCommandResult,
  type DockerImageIdentityFileSystem,
  type DockerImageInspection,
  type LipForcingHostArtifacts,
  type LipForcingImageIdentityOperations,
} from "../server/dockerImageIdentity.js";

const IMAGE_A = `sha256:${"a".repeat(64)}`;
const IMAGE_B = `sha256:${"b".repeat(64)}`;
const REPO_DIGEST_A = `registry.example.test/ltx/lipforcing@sha256:${"c".repeat(64)}`;
const REPO_DIGEST_B = `registry.example.test/ltx/lipforcing@sha256:${"d".repeat(64)}`;
const CONTAINER_ID = "e".repeat(64);
const FIXED_RANDOM_ID = "11111111-2222-4333-8444-555555555555";
const IMAGE_LABELS = {
  "org.opencontainers.image.revision": LIPFORCING_IMAGE_SOURCE_REVISION,
  "com.moddy.ltx-studio.lipforcing.patchset": LIPFORCING_IMAGE_PATCH_SET_ID,
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const mux = Buffer.from("def mux_video_with_audio():\n    return 'strict'\n");
  const runner = Buffer.from("# verified container runner\n");
  const loader = Buffer.from("# patched loader\n");
  const common = Buffer.from("# patched common\n");
  const faceDetector = Buffer.from("# patched face detector\n");
  const license = Buffer.from("Apache License 2.0 fixture\n");
  const runtimePatchProvenance = Buffer.from(JSON.stringify({
    schemaVersion: "ltx-studio-lipforcing-runtime-patch.v1",
    patchSetId: LIPFORCING_IMAGE_PATCH_SET_ID,
    upstream: {
      repository: "https://github.com/cvlab-kaist/LipForcing",
      commit: LIPFORCING_IMAGE_SOURCE_REVISION,
      license: {
        path: "LICENSE",
        sha256: sha256(license),
        spdx: "Apache-2.0",
      },
    },
    patchedFiles: [
      { path: "scripts/inference/_loader.py", patchedSha256: sha256(loader) },
      { path: "scripts/inference/_common.py", patchedSha256: sha256(common) },
      {
        path: "OmniAvatar/utils/latentsync/face_detector.py",
        patchedSha256: sha256(faceDetector),
      },
    ],
    localArtifacts: [
      {
        path: "raw_output_mux.py",
        sha256: sha256(mux),
        role: "paired-premux-export-and-legacy-audio-mux",
      },
      {
        path: "lipforcing-runner.py",
        sha256: sha256(runner),
        role: "verified-offline-container-entrypoint",
      },
    ],
  }));
  const copied = new Map<string, Buffer>([
    [LIPFORCING_IMAGE_ARTIFACT_PATHS[0], mux],
    [LIPFORCING_IMAGE_ARTIFACT_PATHS[1], runtimePatchProvenance],
    [LIPFORCING_IMAGE_ARTIFACT_PATHS[2], loader],
    [LIPFORCING_IMAGE_ARTIFACT_PATHS[3], common],
    [LIPFORCING_IMAGE_ARTIFACT_PATHS[4], faceDetector],
    [LIPFORCING_IMAGE_ARTIFACT_PATHS[5], license],
    [LIPFORCING_IMAGE_ARTIFACT_PATHS[6], runner],
  ]);
  return {
    copied,
    host: {
      rawOutputMux: mux,
      containerRunner: runner,
      runtimePatchProvenance,
    } satisfies LipForcingHostArtifacts,
  };
}

function inspection(
  id = IMAGE_A,
  repoDigests: string[] = [REPO_DIGEST_A],
  labels: Record<string, string> = IMAGE_LABELS,
): DockerImageInspection {
  return { id, repoDigests, labels };
}

function cloneCopied(source: Map<string, Buffer>): Map<string, Buffer> {
  return new Map([...source].map(([path, bytes]) => [path, Buffer.from(bytes)]));
}

function logicalOperations(
  inspect: LipForcingImageIdentityOperations["inspect"],
  copied: Map<string, Buffer>,
): LipForcingImageIdentityOperations {
  return {
    inspect,
    copyArtifacts: () => cloneCopied(copied),
  };
}

type CommandCall = {
  executable: string;
  args: string[];
  options: DockerCommandOptions;
};

function inspectOutput(id: string, repoDigests: string[] = [REPO_DIGEST_A]): string {
  return `${JSON.stringify(id)}\t${JSON.stringify(repoDigests)}\t${JSON.stringify(IMAGE_LABELS)}\n`;
}

function success(stdout = ""): DockerCommandResult {
  return { status: 0, stdout, stderr: "" };
}

function realTrackingFileSystem(removed: string[]): DockerImageIdentityFileSystem {
  return {
    makeTemporaryDirectory: (prefix) => mkdtempSync(prefix),
    chmod: (path, mode) => chmodSync(path, mode),
    open: (path, flags) => openSync(path, flags),
    stat: (descriptor) => fstatSync(descriptor),
    read: (descriptor) => readFileSync(descriptor),
    close: (descriptor) => closeSync(descriptor),
    removeTree: (path) => {
      removed.push(path);
      rmSync(path, { recursive: true, force: true });
    },
  };
}

describe("immutable LipForcing Docker image identity", () => {
  it("freezes a mutable development tag to its image ID and ignores later tag retargeting", () => {
    const { copied, host } = fixture();
    let mutableTagTarget = IMAGE_A;
    const inspected: string[] = [];
    const operations = logicalOperations((reference) => {
      inspected.push(reference);
      if (reference === "ltx-studio-lipforcing:14b-cu131") {
        return inspection(mutableTagTarget, [REPO_DIGEST_A, REPO_DIGEST_B]);
      }
      if (reference === IMAGE_A) return inspection(IMAGE_A, [REPO_DIGEST_A]);
      throw new Error(`unexpected image reference: ${reference}`);
    }, copied);

    const evidence = captureLipForcingImageIdentity(
      "ltx-studio-lipforcing:14b-cu131",
      operations,
      host,
    );
    mutableTagTarget = IMAGE_B;

    expect(evidence.executionReference).toBe(IMAGE_A);
    expect(evidence.imageId).toBe(IMAGE_A);
    expect(evidence.repoDigest).toBeNull();
    expect(verifyLipForcingImageIdentity(evidence, operations, host)).toBeNull();
    expect(inspected).toEqual(["ltx-studio-lipforcing:14b-cu131", IMAGE_A]);
    expect(lipForcingImageIdentity([evidence])).toEqual(evidence);
  });

  it("keeps an explicitly selected sealed RepoDigest as execution authority", () => {
    const { copied, host } = fixture();
    const operations = logicalOperations(() => inspection(IMAGE_A, [REPO_DIGEST_A, REPO_DIGEST_B]), copied);
    const evidence = captureLipForcingImageIdentity(REPO_DIGEST_A, operations, host);

    expect(evidence.repoDigest).toBe(REPO_DIGEST_A);
    expect(evidence.executionReference).toBe(REPO_DIGEST_A);
    expect(evidence.imageId).toBe(IMAGE_A);
    expect(verifyLipForcingImageIdentity(evidence, operations, host)).toBeNull();
  });

  it("rejects a sealed RepoDigest that is not attached to the inspected image", () => {
    const { copied, host } = fixture();
    const operations = logicalOperations(() => inspection(IMAGE_A, [REPO_DIGEST_B]), copied);
    expect(() => captureLipForcingImageIdentity(REPO_DIGEST_A, operations, host))
      .toThrow(/RepoDigest gehört nicht/);
  });

  it.each([
    "",
    "-evil-image",
    "repo\n--help",
    "repo\u0000tag",
    "UPPERCASE/repository:tag",
    "repository::tag",
    `repository:${"x".repeat(129)}`,
    "a".repeat(513),
  ])("rejects an unsafe requested reference before invoking Docker: %j", (reference) => {
    let inspected = false;
    const operations = logicalOperations(() => {
      inspected = true;
      return inspection();
    }, fixture().copied);
    expect(() => captureLipForcingImageIdentity(reference, operations, fixture().host))
      .toThrow(/Referenz.*ungültig/);
    expect(inspected).toBe(false);
  });

  it("rejects a mutable execution reference before invoking the command runner", () => {
    let invoked = false;
    const operations = createLipForcingImageIdentityOperations({
      commandRunner: () => {
        invoked = true;
        return success();
      },
    });
    expect(() => operations.copyArtifacts(
      "lipforcing:mutable",
      IMAGE_A,
      LIPFORCING_IMAGE_ARTIFACT_PATHS,
    )).toThrow(/nicht unveränderlich/);
    expect(invoked).toBe(false);
  });

  it("rejects an image-ID request that resolves to another image", () => {
    const { copied, host } = fixture();
    const operations = logicalOperations(() => inspection(IMAGE_B), copied);
    expect(() => captureLipForcingImageIdentity(IMAGE_A, operations, host))
      .toThrow(/Image-ID löst auf eine andere/);
  });

  it("does not trust matching labels when helper or manifest bytes drift", () => {
    const { copied, host } = fixture();
    for (const path of LIPFORCING_IMAGE_ARTIFACT_PATHS.slice(0, 2)) {
      const tampered = cloneCopied(copied);
      tampered.set(path, Buffer.concat([tampered.get(path)!, Buffer.from("tampered")]));
      const operations = logicalOperations(() => inspection(), tampered);
      expect(() => captureLipForcingImageIdentity("lipforcing:test", operations, host))
        .toThrow(/bytegenau/);
    }
  });

  it.each(LIPFORCING_IMAGE_ARTIFACT_PATHS.slice(2))(
    "checks the actual in-image bytes declared for %s",
    (path) => {
      const { copied, host } = fixture();
      copied.set(path, Buffer.concat([copied.get(path)!, Buffer.from("tampered")]));
      const operations = logicalOperations(() => inspection(), copied);
      expect(() => captureLipForcingImageIdentity("lipforcing:test", operations, host))
        .toThrow(/Patch-Ergebnis|Lizenzprovenienz|LipForcing-Runner/);
    },
  );

  it("validates source-revision and patchset labels before copying image bytes", () => {
    const { copied, host } = fixture();
    let copiedArtifacts = false;
    const operations: LipForcingImageIdentityOperations = {
      inspect: () => inspection(IMAGE_A, [REPO_DIGEST_A], {
        ...IMAGE_LABELS,
        "com.moddy.ltx-studio.lipforcing.patchset": "copied-but-untrusted",
      }),
      copyArtifacts: () => {
        copiedArtifacts = true;
        return cloneCopied(copied);
      },
    };
    expect(() => captureLipForcingImageIdentity("lipforcing:test", operations, host))
      .toThrow(/Pin und Patchset/);
    expect(copiedArtifacts).toBe(false);
  });

  it("uses only fixed Docker commands, creates a stopped no-network container, and cleans it up", () => {
    const { copied, host } = fixture();
    const temporaryBase = mkdtempSync(join(tmpdir(), "ltx-docker-identity-test-"));
    const calls: CommandCall[] = [];
    const removed: string[] = [];
    try {
      const operations = createLipForcingImageIdentityOperations({
        temporaryDirectory: () => temporaryBase,
        randomId: () => FIXED_RANDOM_ID,
        fileSystem: realTrackingFileSystem(removed),
        commandRunner: (executable, args, options) => {
          const call = { executable, args: [...args], options };
          calls.push(call);
          if (args[0] === "image" && args[1] === "inspect") return success(inspectOutput(IMAGE_A));
          if (args[0] === "create") return success(`${CONTAINER_ID}\n`);
          if (args[0] === "container" && args[1] === "inspect") return success(`${IMAGE_A}\n`);
          if (args[0] === "cp") {
            const source = args[1];
            const sourcePath = source.slice(source.indexOf(":") + 1);
            writeFileSync(args[2], copied.get(sourcePath)!);
            return success();
          }
          if (args[0] === "container" && args[1] === "rm") return success();
          return { status: 1, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
        },
      });

      const evidence = captureLipForcingImageIdentity("lipforcing:test", operations, host);
      expect(evidence.executionReference).toBe(IMAGE_A);

      const create = calls.find((call) => call.args[0] === "create")!;
      expect(create.args).toEqual([
        "create",
        "--pull", "never",
        "--network", "none",
        "--name", `ltx-lipforcing-evidence-${FIXED_RANDOM_ID}`,
        "--entrypoint", "/bin/false",
        IMAGE_A,
      ]);
      expect(calls.some((call) => call.args[0] === "run" || call.args.includes("--gpus"))).toBe(false);
      expect(calls.at(-1)?.args).toEqual([
        "container", "rm", "--force", "--", `ltx-lipforcing-evidence-${FIXED_RANDOM_ID}`,
      ]);
      expect(calls.every((call) => call.executable === "/usr/bin/docker")).toBe(true);
      expect(calls.every((call) => call.options.shell === false)).toBe(true);
      expect(calls.every((call) => Object.keys(call.options.env).sort().join(",") === "LC_ALL,PATH")).toBe(true);
      expect(removed).toHaveLength(1);
      expect(existsSync(removed[0])).toBe(false);
      expect(readdirSync(temporaryBase)).toEqual([]);
    } finally {
      rmSync(temporaryBase, { recursive: true, force: true });
    }
  });

  it("rejects a container image-ID mismatch and still removes container and temporary files", () => {
    const { host } = fixture();
    const temporaryBase = mkdtempSync(join(tmpdir(), "ltx-docker-identity-mismatch-"));
    const calls: string[][] = [];
    const removed: string[] = [];
    try {
      const operations = createLipForcingImageIdentityOperations({
        temporaryDirectory: () => temporaryBase,
        randomId: () => FIXED_RANDOM_ID,
        fileSystem: realTrackingFileSystem(removed),
        commandRunner: (_executable, args) => {
          calls.push([...args]);
          if (args[0] === "image") return success(inspectOutput(IMAGE_A));
          if (args[0] === "create") return success(CONTAINER_ID);
          if (args[0] === "container" && args[1] === "inspect") return success(IMAGE_B);
          if (args[0] === "container" && args[1] === "rm") return success();
          return { status: 1, stdout: "", stderr: "unexpected" };
        },
      });

      expect(() => captureLipForcingImageIdentity("lipforcing:test", operations, host))
        .toThrow(/andere Image-ID/);
      expect(calls.some((args) => args[0] === "container" && args[1] === "rm")).toBe(true);
      expect(calls.some((args) => args[0] === "cp")).toBe(false);
      expect(removed).toHaveLength(1);
      expect(existsSync(removed[0])).toBe(false);
    } finally {
      rmSync(temporaryBase, { recursive: true, force: true });
    }
  });

  it("removes the predetermined container after an ambiguous successful create timeout", () => {
    const { host } = fixture();
    const temporaryBase = mkdtempSync(join(tmpdir(), "ltx-docker-identity-create-timeout-"));
    const calls: string[][] = [];
    const removed: string[] = [];
    try {
      const operations = createLipForcingImageIdentityOperations({
        temporaryDirectory: () => temporaryBase,
        randomId: () => FIXED_RANDOM_ID,
        fileSystem: realTrackingFileSystem(removed),
        commandRunner: (_executable, args) => {
          calls.push([...args]);
          if (args[0] === "image") return success(inspectOutput(IMAGE_A));
          if (args[0] === "create") {
            return {
              status: 0,
              stdout: CONTAINER_ID,
              stderr: "",
              error: Object.assign(new Error("ambiguous create timeout"), { code: "ETIMEDOUT" }),
            };
          }
          if (args[0] === "container" && args[1] === "rm") return success();
          return { status: 1, stdout: "", stderr: "unexpected" };
        },
      });

      expect(() => captureLipForcingImageIdentity("lipforcing:test", operations, host))
        .toThrow(/ambiguous create timeout/);
      expect(calls.some((args) => args[0] === "container" && args[1] === "rm")).toBe(true);
      expect(calls.some((args) => args[0] === "cp")).toBe(false);
      expect(removed).toHaveLength(1);
      expect(existsSync(removed[0])).toBe(false);
    } finally {
      rmSync(temporaryBase, { recursive: true, force: true });
    }
  });

  it("preserves both the primary verification error and a cleanup error", () => {
    const { host } = fixture();
    const temporaryBase = mkdtempSync(join(tmpdir(), "ltx-docker-identity-cleanup-"));
    try {
      const operations = createLipForcingImageIdentityOperations({
        temporaryDirectory: () => temporaryBase,
        randomId: () => FIXED_RANDOM_ID,
        commandRunner: (_executable, args) => {
          if (args[0] === "image") return success(inspectOutput(IMAGE_A));
          if (args[0] === "create") return success(CONTAINER_ID);
          if (args[0] === "container" && args[1] === "inspect") return success(IMAGE_B);
          if (args[0] === "container" && args[1] === "rm") {
            return { status: 1, stdout: "", stderr: "forced cleanup failure" };
          }
          return { status: 1, stdout: "", stderr: "unexpected" };
        },
      });

      let thrown: unknown;
      try {
        captureLipForcingImageIdentity("lipforcing:test", operations, host);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AggregateError);
      const errors = (thrown as AggregateError).errors.map(String).join("\n");
      expect(errors).toMatch(/andere Image-ID/);
      expect(errors).toMatch(/forced cleanup failure/);
    } finally {
      rmSync(temporaryBase, { recursive: true, force: true });
    }
  });

  it("opens copied artifacts O_NOFOLLOW and rejects symlinks, hardlinks, and oversized files", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-docker-artifact-files-"));
    try {
      const regular = join(root, "regular");
      const symbolic = join(root, "symbolic");
      const hardlink = join(root, "hardlink");
      const oversized = join(root, "oversized");
      writeFileSync(regular, "trusted bytes");
      symlinkSync(regular, symbolic);
      linkSync(regular, hardlink);
      writeFileSync(oversized, "x");
      truncateSync(oversized, 1024 * 1024 + 1);

      expect(() => readCopiedRegularArtifact(symbolic)).toThrow();
      expect(() => readCopiedRegularArtifact(regular)).toThrow(/keine einzelne reguläre Datei/);
      expect(() => readCopiedRegularArtifact(hardlink)).toThrow(/keine einzelne reguläre Datei/);
      expect(() => readCopiedRegularArtifact(oversized)).toThrow(/keine einzelne reguläre Datei/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
