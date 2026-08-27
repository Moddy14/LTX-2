import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  hermeticBuildEnvironment,
  materializeGitTree,
  parseGitTreeInventory,
  preflightBuildTcbPolicy,
} from "../scripts/build-tcb-lib.mjs";
import { canonicalJson } from "../shared/canonicalJson.js";

const roots: string[] = [];
const blobOid = (bytes: Buffer) => createHash("sha1")
  .update(`blob ${bytes.length}\0`)
  .update(bytes)
  .digest("hex");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Build-TCB materialization", () => {
  it("materializes only verified Git-object bytes and preserves exact modes", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-build-tcb-"));
    roots.push(root);
    const repository = join(root, "repo");
    const destination = join(root, "materialized");
    mkdirSync(repository);
    const git = join(root, "git");
    writeFileSync(git, "fixture git\n", { mode: 0o755 });
    chmodSync(git, 0o755);
    const blobs = [
      { mode: "100644", path: "dir/data.txt", bytes: Buffer.from("sealed\n") },
      { mode: "100755", path: "run.sh", bytes: Buffer.from("#!/bin/sh\n") },
      { mode: "120000", path: "data-link", bytes: Buffer.from("dir/data.txt") },
    ].map((entry) => ({ ...entry, oid: blobOid(entry.bytes) }));
    const tree = "f".repeat(40);
    const execute = ((_executable: string, args: string[]) => {
      if (args[0] === "rev-parse") return `${tree}\n`;
      if (args[0] === "ls-tree") {
        return Buffer.from(blobs.map(({ mode, oid, path }) => `${mode} blob ${oid}\t${path}\0`).join(""));
      }
      if (args[0] === "cat-file") return blobs.find(({ oid }) => oid === args[2])!.bytes;
      throw new Error(`unexpected fake Git call: ${args.join(" ")}`);
    }) as never;
    const result = materializeGitTree(repository, destination, {
      gitCommit: "e".repeat(40),
      expectedGitTree: tree,
      gitExecutable: git,
      execute,
    });
    expect(result.gitTree).toBe(tree);
    expect(readFileSync(join(destination, "dir", "data.txt"), "utf8")).toBe("sealed\n");
    expect(readlinkSync(join(destination, "data-link"))).toBe("dir/data.txt");
  });

  it("rejects path traversal and unsupported Git object modes before writing", () => {
    const oid = "a".repeat(40);
    expect(() => parseGitTreeInventory(`100644 blob ${oid}\t../escape\0`)).toThrow(/unsafe/i);
    expect(() => parseGitTreeInventory(`160000 commit ${oid}\tsubmodule\0`)).toThrow(/unsupported/i);
  });

  it("constructs a closed build environment without user or loader overlays", () => {
    const environment = hermeticBuildEnvironment({
      sourceDateEpoch: "1787654321",
      nodeBinDirectory: "/opt/build-node/bin",
      npmCacheDirectory: "/var/tmp/ltx-build-cache",
    });
    expect(environment).toEqual({
      PATH: "/opt/build-node/bin",
      LC_ALL: "C",
      LANG: "C",
      TZ: "UTC",
      SOURCE_DATE_EPOCH: "1787654321",
      npm_config_audit: "false",
      npm_config_cache: "/var/tmp/ltx-build-cache",
      npm_config_fund: "false",
      npm_config_globalconfig: "/dev/null",
      npm_config_ignore_scripts: "true",
      npm_config_update_notifier: "false",
      npm_config_userconfig: "/dev/null",
    });
    expect(environment).not.toHaveProperty("HOME");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
    expect(environment).not.toHaveProperty("LD_PRELOAD");
  });

  it.skipIf(process.getuid?.() === 0)("rejects a consistently pinned build executable owned by the invoking UID", () => {
    const root = mkdtempSync(join(homedir(), ".ltx-build-tcb-policy-test-"));
    roots.push(root);
    const executable = join(root, "candidate-node");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(executable, 0o755);
    const executableSha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
    const policy = {
      schemaVersion: "ltx-studio-build-tcb-policy.v1",
      status: "authorized",
      buildTcbSchema: "ltx-studio-build-tcb.v1",
      gitCommit: "1".repeat(40),
      gitTree: "2".repeat(40),
      materializedTreeSha256: "3".repeat(64),
      nodeModulesTreeSha256: "4".repeat(64),
      sourceDateEpoch: "1787654321",
      versions: { git: "git", node: "node", npm: "npm", python: "python", uv: "uv" },
      releaseInputs: {
        longcatRoot: "/opt/longcat",
        dockerImages: { latentsync: "one", lipforcing: "two", musetalk: "three" },
      },
      executables: Object.fromEntries(["git", "node", "python", "uv"].map((name) => [
        name, { path: executable, sha256: executableSha256 },
      ])),
      npm: { cliPath: executable, packageTreeSha256: "5".repeat(64) },
      licenses: Object.fromEntries(["git", "node", "npm", "python", "uv"].map((name) => [
        name, { path: executable, sha256: executableSha256 },
      ])),
    };
    const policySha256 = createHash("sha256").update(canonicalJson(policy)).digest("hex");
    expect(() => preflightBuildTcbPolicy(policy, policySha256)).toThrow(/not root-owned/i);
  });
});
