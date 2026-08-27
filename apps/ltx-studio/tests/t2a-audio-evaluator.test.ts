import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  T2A_AUDIO_BASE_CONTRACTS_SHA256,
  T2A_AUDIO_QUALITY_SCHEMA_SHA256,
  T2A_AUDIO_SANDBOX_UNIT_PREFIX,
  T2A_AUDIO_WORKER_SHA256,
  T2A_DIALOGUE_EVALUATOR_SHA256,
  T2A_INDEPENDENT_IPA_MODEL_DIRECTORY,
  T2A_IPA_ADJUDICATOR_RUNNER_SHA256,
  T2A_SANDBOX_UNSET_ENVIRONMENT,
  T2aAudioEvaluatorCancelledError,
  T2aAudioEvaluatorTerminationError,
  assertMatchingT2aAudioEvaluatorBindings,
  buildT2aIndependentIpaSandboxArguments,
  buildT2aAudioSandboxArguments,
  buildT2aAudioSandboxPreflightArguments,
  buildT2aGermanG2pSandboxArguments,
  buildT2aIpaAdjudicatorSandboxArguments,
  monitorT2aAudioControlProcess,
  monitorT2aAudioSandboxProcess,
  recoverT2aAudioSandboxUnits,
  resolveDevelopmentT2aAudioEvaluatorAuthority,
  resolveT2aAudioEvaluatorBinding,
  resolveT2aAudioEvaluatorAuthority,
  t2aAudioSandboxForbiddenHostPaths,
  t2aAudioSandboxPaths,
  t2aAudioSandboxSensitiveNoExecHostPaths,
} from "../server/t2aAudioEvaluator.js";
import {
  T2A_GERMAN_G2P_DATA_ROOT,
  T2A_GERMAN_G2P_ESPEAK_PATH,
  T2A_GERMAN_G2P_VOCAB_PATH,
} from "../shared/t2aGermanG2p.js";
import {
  analysisPythonExecutable,
  appRoot,
  dataRoot,
  hostTcbExecutables,
  whisperModelPath,
} from "../server/config.js";
import {
  capturePinnedPathRevision,
  openPinnedPaths,
} from "../server/evaluatorBindings.js";
import {
  evaluatorRuntimeDirectory,
  evaluatorSandboxExecutableProperties,
  evaluatorSandboxInaccessibleProperties,
  evaluatorSandboxNoExecHostProperties,
  evaluatorSandboxProperties,
} from "../server/evaluatorSandbox.js";
import {
  T2A_AUDIO_QUALITY_SCHEMA_VERSION,
  T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
} from "../shared/t2aAudioQuality.js";

const roots: string[] = [];
const OWN_UUID = "123e4567-e89b-42d3-a456-426614174000";
const systemSandboxAvailable = existsSync("/run/systemd/system")
  && spawnSync(
    "/usr/bin/sudo",
    ["-n", "/usr/bin/systemctl", "--version"],
    { stdio: "ignore" },
  ).status === 0
  && spawnSync(
    analysisPythonExecutable,
    ["-I", "-c", "import torch,whisper"],
    { stdio: "ignore", timeout: 15_000 },
  ).status === 0;
const systemSandboxIt = systemSandboxAvailable ? it : it.skip;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function failedDocument(): string {
  return JSON.stringify({
    schemaVersion: T2A_AUDIO_QUALITY_SCHEMA_VERSION,
    mediaKind: "audio",
    analysisKind: "t2a-audio-qa",
    analysisStatus: "failed",
    error: { code: "internal-error", message: "synthetic evaluator failure" },
    ia2vEligibility: {
      schemaVersion: T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
      status: "blocked",
      blockers: ["analysis-failed"],
    },
  });
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function audioTarget() {
  const root = await mkdtemp(join(tmpdir(), "ltx-t2a-evaluator-"));
  roots.push(root);
  const audioSnapshotPath = join(root, "authority.wav");
  const transcriptSnapshotPath = join(root, "transcript.utf8");
  const content = Buffer.from("RIFF synthetic private authority WAV bytes");
  const transcriptText = "Hallo";
  const transcript = Buffer.from(
    `${JSON.stringify({ schemaVersion: "ltx-studio-private-transcript.v1", text: transcriptText })}\n`,
    "utf8",
  );
  await writeFile(audioSnapshotPath, content, { mode: 0o444 });
  await writeFile(transcriptSnapshotPath, transcript, { mode: 0o444 });
  await chmod(audioSnapshotPath, 0o444);
  await chmod(transcriptSnapshotPath, 0o444);
  return {
    audioSnapshotPath,
    transcriptSnapshotPath,
    audioSha256: createHash("sha256").update(content).digest("hex"),
    transcriptSnapshotSha256: createHash("sha256").update(transcript).digest("hex"),
    dialogueSha256: createHash("sha256").update(transcriptText).digest("hex"),
    peakCeilingDbfs: -3,
  };
}

function detachedNode(script: string) {
  return spawn(process.execPath, ["-e", script], {
    detached: true,
    env: { PATH: "/usr/bin:/bin" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  } as SpawnOptions);
}

function silentChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
    unref: () => undefined,
  }) as unknown as ChildProcess;
}

const stoppedControl = async () => ({ code: 0, stdout: "", stderr: "" });

describe("T2A server evaluator authority", () => {
  it("keeps the reviewed worker, dialogue and both source-contract pins exact", async () => {
    await expect(sha256(join(appRoot, "scripts", "analyze-t2a-audio.py")))
      .resolves.toBe(T2A_AUDIO_WORKER_SHA256);
    await expect(sha256(join(appRoot, "scripts", "dialogue_word_evaluator.py")))
      .resolves.toBe(T2A_DIALOGUE_EVALUATOR_SHA256);
    await expect(sha256(join(appRoot, "shared", "t2aAudioQuality.ts")))
      .resolves.toBe(T2A_AUDIO_QUALITY_SCHEMA_SHA256);
    await expect(sha256(join(appRoot, "shared", "t2aAudioBaseContracts.ts")))
      .resolves.toBe(T2A_AUDIO_BASE_CONTRACTS_SHA256);
  });

  it("fails closed outside a sealed runtime and rejects caller-selected authority paths", () => {
    expect(() => resolveT2aAudioEvaluatorAuthority()).toThrow(/versiegelten Server-Runtime/u);
    const injected = resolveT2aAudioEvaluatorAuthority as unknown as (value: unknown) => unknown;
    expect(() => injected({ pythonExecutable: "/bin/false" }))
      .toThrow(/keine aufrufergesteuerten Pfade/u);
    expect(() => resolveDevelopmentT2aAudioEvaluatorAuthority()).toThrow(/nicht explizit/u);
    const injectedDevelopment = resolveDevelopmentT2aAudioEvaluatorAuthority as unknown as (
      value: unknown,
    ) => unknown;
    expect(() => injectedDevelopment({ pythonExecutable: "/bin/false" }))
      .toThrow(/keine aufrufergesteuerten Pfade/u);
    const injectedCombined = resolveT2aAudioEvaluatorBinding as unknown as (
      value: unknown,
    ) => unknown;
    expect(() => injectedCombined({ independentIpaModel: "/tmp/caller-selected" }))
      .toThrow(/keine aufrufergesteuerten Authorities/u);
  });

  it("compares preflight and live combined fingerprint plus claim scope fail-closed", () => {
    const expected = {
      evaluatorFingerprint: "a".repeat(64),
      claimScope: "sealed-release" as const,
    };
    expect(() => assertMatchingT2aAudioEvaluatorBindings(expected, { ...expected }))
      .not.toThrow();
    expect(() => assertMatchingT2aAudioEvaluatorBindings(expected, {
      ...expected,
      evaluatorFingerprint: "b".repeat(64),
    })).toThrow(/Preflight-Authority/u);
    expect(() => assertMatchingT2aAudioEvaluatorBindings(expected, {
      ...expected,
      claimScope: "development",
    })).toThrow(/Preflight-Authority/u);
    expect(() => assertMatchingT2aAudioEvaluatorBindings(expected, {
      ...expected,
      evaluatorFingerprint: "not-a-digest",
    })).toThrow(/kein gueltiges kombiniertes/u);
  });

  it("binds server readiness and manager reads to the exact successful preflight binding", () => {
    const source = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
    const preflight = source.indexOf(
      "const preflightBinding = await preflightT2aAudioEvaluatorSandbox()",
    );
    const live = source.indexOf("const liveBinding = resolveT2aAudioEvaluatorBinding()", preflight);
    const match = source.indexOf(
      "assertMatchingT2aAudioEvaluatorBindings(preflightBinding, liveBinding)",
      live,
    );
    const ready = source.indexOf("t2aSandboxPreflightReady = true", match);
    expect(preflight).toBeGreaterThan(-1);
    expect(live).toBeGreaterThan(preflight);
    expect(match).toBeGreaterThan(live);
    expect(ready).toBeGreaterThan(match);
    expect(source).toContain("{ expectedEvaluatorBinding: t2aSandboxPreflightBinding }");
  });

  it("binds development authority to a fresh private process-session nonce", () => {
    const run = () => {
      const baseEnvironment = { ...process.env };
      delete baseEnvironment.VITEST_WORKER_ID;
      delete baseEnvironment.VITEST_POOL_ID;
      delete baseEnvironment.LTX_STUDIO_SEALED_RELEASE;
      const child = spawnSync(join(appRoot, "node_modules", ".bin", "tsx"), [
        "--eval",
        [
          "import { resolveConfiguredT2aAudioEvaluatorAuthority as resolveAuthority,",
          "verifyT2aAudioEvaluatorAuthorityPins as verifyAuthority }",
          "from './server/t2aAudioEvaluator.ts';",
          "const authority=resolveAuthority();",
          "verifyAuthority(authority);",
          "const zero='0'.repeat(64);",
          "const drifts=[",
          "{...authority,baseContractsSha256:zero},",
          "{...authority,baseContractsModuleSha256:zero},",
          "{...authority,paths:{...authority.paths,baseContractsModule:authority.paths.qualitySchemaModule}}];",
          "const driftRejected=drifts.map((candidate)=>{try{verifyAuthority(candidate);return false}catch{return true}});",
          "console.log(JSON.stringify({claimScope:authority.claimScope,",
          "fingerprint:authority.fingerprint,qualitySchemaModule:authority.paths.qualitySchemaModule,",
          "baseContractsModule:authority.paths.baseContractsModule,",
          "qualitySchemaSha256:authority.qualitySchemaSha256,",
          "baseContractsSha256:authority.baseContractsSha256,",
          "baseContractsModuleSha256:authority.baseContractsModuleSha256,",
          "baseContractsPinned:authority.pinnedPaths.some(({path})=>path===authority.paths.baseContractsModule),",
          "driftRejected,",
          "authorityKeys:Object.keys(authority)}));",
        ].join(" "),
      ], {
        cwd: appRoot,
        encoding: "utf8",
        env: {
          ...baseEnvironment,
          VITEST: "false",
          LTX_STUDIO_T2A_DEVELOPMENT_MEASUREMENT: "1",
          LTX_STUDIO_DATA_DIR: join(tmpdir(), "ltx-t2a-development-authority-test"),
        },
      });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stderr).toBe("");
      return JSON.parse(child.stdout.trim()) as {
        claimScope: string;
        fingerprint: string;
        qualitySchemaModule: string;
        baseContractsModule: string;
        qualitySchemaSha256: string;
        baseContractsSha256: string;
        baseContractsModuleSha256: string;
        baseContractsPinned: boolean;
        driftRejected: boolean[];
        authorityKeys: string[];
      };
    };
    const first = run();
    const second = run();
    expect(first).toMatchObject({
      claimScope: "development",
      qualitySchemaModule: join(appRoot, "shared", "t2aAudioQuality.ts"),
      baseContractsModule: join(appRoot, "shared", "t2aAudioBaseContracts.ts"),
      qualitySchemaSha256: T2A_AUDIO_QUALITY_SCHEMA_SHA256,
      baseContractsSha256: T2A_AUDIO_BASE_CONTRACTS_SHA256,
      baseContractsModuleSha256: T2A_AUDIO_BASE_CONTRACTS_SHA256,
      baseContractsPinned: true,
      driftRejected: [true, true, true],
    });
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(first.authorityKeys).not.toContain("developmentSessionNonce");
    expect(JSON.stringify(first)).not.toContain("developmentSessionNonce");
  });

  it("isolates recovery to the stable server-owned data-root namespace", async () => {
    const own = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${OWN_UUID}.service`;
    const foreign = `ltx-t2a-${"f".repeat(16)}-${OWN_UUID}.service`;
    const calls: string[][] = [];
    await recoverT2aAudioSandboxUnits(async (args) => {
      calls.push(args);
      if (args.includes("list-units")) {
        return { code: 0, stdout: `${own} loaded active running\n${foreign} loaded active running\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(calls[0]).toContain(`${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-*.service`);
    const stoppedUnits = calls
      .filter((args) => args.includes("stop"))
      .map((args) => args.at(-1));
    expect(stoppedUnits).toEqual([own]);
    expect(stoppedUnits).not.toContain(foreign);
  });

  it("recovers every owned phase unit left by a prior four-phase attempt", async () => {
    const units = [
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174002",
      "123e4567-e89b-42d3-a456-426614174003",
      "123e4567-e89b-42d3-a456-426614174004",
    ].map((id) => `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${id}.service`);
    const stopped: string[] = [];
    await recoverT2aAudioSandboxUnits(async (args) => {
      if (args.includes("list-units")) {
        return {
          code: 0,
          stdout: units.map((unit) => `${unit} loaded active running`).join("\n"),
          stderr: "",
        };
      }
      if (args.includes("stop")) stopped.push(args.at(-1) ?? "");
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(stopped).toEqual(units);
  });

  it("bounds every recovery control call by the shared absolute deadline", async () => {
    const own = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${OWN_UUID}.service`;
    const controlTimeouts: number[] = [];
    const startedAt = Date.now();
    await expect(recoverT2aAudioSandboxUnits(async (args, timeoutMs) => {
      if (timeoutMs === undefined) throw new Error("missing bounded control timeout");
      controlTimeouts.push(timeoutMs);
      if (args.includes("list-units")) {
        return { code: 0, stdout: `${own} loaded active running\n`, stderr: "" };
      }
      if (args.includes("show")) {
        return { code: 0, stdout: "LoadState=loaded\nActiveState=active\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "synthetic stop refusal" };
    }, startedAt + 30)).rejects.toThrow(/Gesamtzeitlimit|RuntimeMax/u);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(controlTimeouts.length).toBeGreaterThanOrEqual(2);
    expect(controlTimeouts.every((timeoutMs) => timeoutMs >= 1 && timeoutMs <= 30)).toBe(true);
  });

  it("builds PrivateNetwork argv with read-only runtime and no transcript or HOME", async () => {
    const target = await audioTarget();
    const unitName = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${OWN_UUID}`;
    const sandbox = t2aAudioSandboxPaths(unitName);
    const bind = (descriptor: number, destination: string) =>
      `--property=BindReadOnlyPaths=/proc/${process.pid}/fd/${descriptor}:${destination}`;
    const bindings = {
      worker: bind(71, sandbox.worker),
      dialogueEvaluator: bind(72, sandbox.dialogueEvaluator),
      audio: bind(73, sandbox.audio),
      transcript: bind(74, sandbox.transcript),
      ipaObservation: bind(75, sandbox.ipaObservation),
      ipaAdjudication: bind(76, sandbox.adjudicationResult),
      whisper: bind(77, sandbox.whisper),
      ffmpeg: bind(78, sandbox.ffmpeg),
      runtime: bind(79, sandbox.runtime),
    };
    const ipaObservationSha256 = "f".repeat(64);
    const ipaAdjudicationSha256 = "e".repeat(64);
    const args = buildT2aAudioSandboxArguments(
      unitName,
      target,
      bindings,
      ipaObservationSha256,
      ipaAdjudicationSha256,
      420_000,
      2_000,
    );
    expect(args).toContain("--property=PrivateNetwork=yes");
    expect(args).toContain("--property=RestrictAddressFamilies=AF_UNIX");
    expect(args).toContain("--property=MemoryMax=16G");
    expect(args).toContain("--property=MemorySwapMax=0");
    expect(args).toContain("--property=CPUQuota=200%");
    expect(args).toContain("--property=TasksMax=64");
    expect(args).toContain("--property=ProtectProc=invisible");
    expect(args).toContain("--property=ProcSubset=all");
    expect(args).not.toContain("--property=ProcSubset=pid");
    expect(args).toContain(bindings.runtime);
    expect(args).toContain(bindings.transcript);
    expect(args).toContain(bindings.ipaObservation);
    expect(args).toContain(bindings.ipaAdjudication);
    expect(args.filter((argument) => argument.startsWith("--property=NoExecPaths=")))
      .toEqual([
        ...t2aAudioSandboxSensitiveNoExecHostPaths()
          .map((path) => `--property=NoExecPaths=-${path}`),
        `--property=NoExecPaths=${sandbox.root}`,
      ]);
    expect(args).toContain("--property=ProtectProc=invisible");
    expect(args).toContain("--property=ProcSubset=all");
    expect(args.filter((argument) => argument.startsWith("--property=InaccessiblePaths=")))
      .toEqual(t2aAudioSandboxForbiddenHostPaths("quality")
        .map((path) => `--property=InaccessiblePaths=-${path}`));
    expect(t2aAudioSandboxForbiddenHostPaths("quality")).toEqual([
      appRoot,
      dataRoot,
      T2A_INDEPENDENT_IPA_MODEL_DIRECTORY,
      T2A_GERMAN_G2P_DATA_ROOT,
    ]);
    expect(args.filter((argument) => argument.startsWith("--property=ExecPaths=")))
      .toEqual([
        `--property=ExecPaths=${sandbox.python}`,
        `--property=ExecPaths=${sandbox.ffmpeg}`,
      ]);
    for (const executablePath of [sandbox.ffmpeg]) {
      expect(args.some((argument) => new RegExp(
        `^--property=BindReadOnlyPaths=/proc/${process.pid}/fd/[0-9]+:${executablePath}$`,
        "u",
      ).test(argument))).toBe(true);
    }
    expect(sandbox.python.startsWith(`${sandbox.runtime}/`)).toBe(true);
    expect(bindings.runtime.endsWith(`:${sandbox.runtime}`)).toBe(true);
    expect(args).not.toContain(`--property=ExecPaths=${sandbox.root}`);
    expect(args.slice(args.indexOf("/usr/bin/env"), args.indexOf("/usr/bin/env") + 3))
      .toEqual(["/usr/bin/env", "-i", "PATH=/usr/bin:/bin"]);
    expect(args.filter((argument) => argument === "--property=PassEnvironment="))
      .toEqual(["--property=PassEnvironment="]);
    expect(args.filter((argument) => argument.startsWith("--property=UnsetEnvironment=")))
      .toEqual([`--property=UnsetEnvironment=${T2A_SANDBOX_UNSET_ENVIRONMENT.join(" ")}`]);
    expect(args).toContain(sandbox.python);
    expect(args).not.toContain("Hallo");
    expect(args).not.toContain("--transcript");
    expect(args.slice(args.indexOf("--independent-ipa-observation"),
      args.indexOf("--independent-ipa-observation") + 2))
      .toEqual(["--independent-ipa-observation", sandbox.ipaObservation]);
    expect(args.slice(args.indexOf("--expected-independent-ipa-observation-sha256"),
      args.indexOf("--expected-independent-ipa-observation-sha256") + 2))
      .toEqual(["--expected-independent-ipa-observation-sha256", ipaObservationSha256]);
    expect(args.slice(args.indexOf("--expected-ipa-adjudication-result-sha256"),
      args.indexOf("--expected-ipa-adjudication-result-sha256") + 2))
      .toEqual(["--expected-ipa-adjudication-result-sha256", ipaAdjudicationSha256]);
    expect(args).not.toContain(sandbox.ipaRunner);
    expect(args).not.toContain(sandbox.ipaModel);
    expect(args.some((argument) => argument.startsWith("HOME="))).toBe(false);
    expect(args.filter((argument) => /LD_PRELOAD|PYTHONPATH|NODE_OPTIONS/u.test(argument)))
      .toEqual([`--property=UnsetEnvironment=${T2A_SANDBOX_UNSET_ENVIRONMENT.join(" ")}`]);
    expect(() => buildT2aAudioSandboxArguments(
      unitName,
      target,
      {
        ...bindings,
        ipaObservation: bind(80, sandbox.ipaRunner),
      },
      ipaObservationSha256,
      ipaAdjudicationSha256,
      420_000,
      2_000,
    )).toThrow(/exakt zielgebundene/u);
    expect(() => buildT2aAudioSandboxArguments(
      unitName,
      target,
      bindings,
      "not-a-sha256",
      ipaAdjudicationSha256,
      420_000,
      2_000,
    )).toThrow(/Phasendokument-Digest/u);
  });

  it("builds a target-independent IPA phase with only audio authority and exact resources", async () => {
    const target = await audioTarget();
    const targetWithPrivateText = {
      ...target,
      transcriptSnapshotPath: "/private/TRANSCRIPT-SECRET-MARKER",
      dialogueSha256: "DIALOGUE-SECRET-MARKER",
    };
    const runnerSha256 = "b".repeat(64);
    const unitName = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${OWN_UUID}`;
    const sandbox = t2aAudioSandboxPaths(unitName);
    const bind = (descriptor: number, destination: string) =>
      `--property=BindReadOnlyPaths=/proc/${process.pid}/fd/${descriptor}:${destination}`;
    const bindings = {
      worker: bind(81, sandbox.worker),
      ipaRunner: bind(82, sandbox.ipaRunner),
      audio: bind(83, sandbox.audio),
      ipaModel: bind(84, sandbox.ipaModel),
      ffmpeg: bind(85, sandbox.ffmpeg),
      runtime: bind(86, sandbox.runtime),
    };
    const args = buildT2aIndependentIpaSandboxArguments(
      unitName,
      targetWithPrivateText,
      bindings,
      runnerSha256,
      180_000,
      2_000,
    );

    expect(args.filter((argument) => argument.startsWith("--property=BindReadOnlyPaths=")))
      .toEqual(Object.values(bindings));
    expect(args.filter((argument) => /--property=(?:MemoryMax|MemorySwapMax|CPUQuota|TasksMax)=/u
      .test(argument))).toEqual([
      "--property=MemoryMax=8G",
      "--property=MemorySwapMax=0",
      "--property=CPUQuota=200%",
      "--property=TasksMax=64",
    ]);
    expect(args).toContain("--property=PrivateNetwork=yes");
    expect(args).toContain("--property=RestrictAddressFamilies=AF_UNIX");
    expect(args).toContain("--property=NoNewPrivileges=yes");
    expect(args.filter((argument) => argument.startsWith("--property=NoExecPaths=")))
      .toEqual([
        ...t2aAudioSandboxSensitiveNoExecHostPaths()
          .map((path) => `--property=NoExecPaths=-${path}`),
        `--property=NoExecPaths=${sandbox.root}`,
      ]);
    expect(args.filter((argument) => argument.startsWith("--property=ExecPaths=")))
      .toEqual([
        `--property=ExecPaths=${sandbox.python}`,
        `--property=ExecPaths=${sandbox.ffmpeg}`,
      ]);
    for (const executablePath of [sandbox.ffmpeg]) {
      expect(args.some((argument) => new RegExp(
        `^--property=BindReadOnlyPaths=/proc/${process.pid}/fd/[0-9]+:${executablePath}$`,
        "u",
      ).test(argument))).toBe(true);
    }
    expect(sandbox.python.startsWith(`${sandbox.runtime}/`)).toBe(true);
    expect(bindings.runtime.endsWith(`:${sandbox.runtime}`)).toBe(true);
    expect(args.filter((argument) => argument.startsWith("--property=InaccessiblePaths=")))
      .toEqual(t2aAudioSandboxForbiddenHostPaths("independent-ipa")
        .map((path) => `--property=InaccessiblePaths=-${path}`));
    expect(t2aAudioSandboxForbiddenHostPaths("independent-ipa")).toEqual([
      appRoot,
      dataRoot,
      whisperModelPath,
    ]);
    expect(args).toContain("/usr/bin/env");
    expect(args).toContain("HF_DATASETS_OFFLINE=1");
    expect(args.slice(args.indexOf(sandbox.python), args.indexOf(sandbox.python) + 2))
      .toEqual([sandbox.python, "-I"]);
    expect(args).toContain("independent-ipa-observation");
    expect(args.slice(args.indexOf("--expected-audio-sha256"),
      args.indexOf("--expected-audio-sha256") + 2))
      .toEqual(["--expected-audio-sha256", target.audioSha256]);
    expect(args.slice(args.indexOf("--expected-independent-ipa-runner-sha256"),
      args.indexOf("--expected-independent-ipa-runner-sha256") + 2))
      .toEqual(["--expected-independent-ipa-runner-sha256", runnerSha256]);
    expect(args).not.toContain(sandbox.dialogueEvaluator);
    expect(args).not.toContain(sandbox.transcript);
    expect(args).not.toContain(sandbox.whisper);
    expect(JSON.stringify(args)).not.toMatch(
      /transcript|dialogue|TRANSCRIPT-SECRET-MARKER|DIALOGUE-SECRET-MARKER/iu,
    );
    expect(() => buildT2aIndependentIpaSandboxArguments(
      unitName,
      target,
      { ...bindings, audio: bind(87, sandbox.transcript) },
      runnerSha256,
      180_000,
      2_000,
    )).toThrow(/exakt zielgebundene/u);
    expect(() => buildT2aIndependentIpaSandboxArguments(
      unitName,
      target,
      {
        ...bindings,
        audio: `--property=BindReadOnlyPaths=${target.audioSnapshotPath}:${sandbox.audio}`,
      },
      runnerSha256,
      180_000,
      2_000,
    )).toThrow(/Authority-FD/u);
  });

  it("separates private German G2P from target-free IPA and cleartext-free adjudication", () => {
    const bind = (descriptor: number, destination: string) =>
      `--property=BindReadOnlyPaths=/proc/${process.pid}/fd/${descriptor}:${destination}`;
    const g2pUnit = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${OWN_UUID}`;
    const g2pSandbox = t2aAudioSandboxPaths(g2pUnit);
    const g2pBindings = {
      g2pRunner: bind(101, g2pSandbox.g2pRunner),
      g2pRequest: bind(102, g2pSandbox.g2pRequest),
      espeak: bind(103, T2A_GERMAN_G2P_ESPEAK_PATH),
      espeakData: bind(104, T2A_GERMAN_G2P_DATA_ROOT),
      ipaVocabulary: bind(105, T2A_GERMAN_G2P_VOCAB_PATH),
      runtime: bind(106, g2pSandbox.runtime),
    };
    const requestSha256 = "1".repeat(64);
    const g2pArgs = buildT2aGermanG2pSandboxArguments(
      g2pUnit,
      g2pBindings,
      requestSha256,
      30_000,
      2_000,
    );
    expect(g2pArgs.filter((argument) => argument.startsWith("--property=BindReadOnlyPaths=")))
      .toEqual(Object.values(g2pBindings));
    expect(g2pArgs).toContain("--property=MemoryMax=1G");
    expect(g2pArgs).toContain("--property=ProcSubset=pid");
    expect(g2pArgs.filter((argument) => argument.startsWith("--property=ExecPaths=")))
      .toEqual([`--property=ExecPaths=${g2pSandbox.python}`]);
    expect(g2pArgs).not.toContain(g2pSandbox.audio);
    expect(g2pArgs).not.toContain(g2pSandbox.transcript);
    expect(g2pArgs).not.toContain(g2pSandbox.ipaObservation);
    expect(g2pArgs).not.toContain(g2pSandbox.whisper);
    expect(g2pArgs).toContain(requestSha256);

    const adjudicatorUnit = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${randomUUID()}`;
    const adjudicatorSandbox = t2aAudioSandboxPaths(adjudicatorUnit);
    const adjudicatorBindings = {
      adjudicatorRunner: bind(111, adjudicatorSandbox.adjudicatorRunner),
      adjudicatorRequest: bind(112, adjudicatorSandbox.adjudicatorRequest),
      ipaVocabulary: bind(113, T2A_GERMAN_G2P_VOCAB_PATH),
      runtime: bind(114, adjudicatorSandbox.runtime),
    };
    const expected = {
      requestSha256: "2".repeat(64),
      phaseSha256: "3".repeat(64),
      referenceSha256: "4".repeat(64),
      g2pResultSha256: "5".repeat(64),
      runnerSha256: T2A_IPA_ADJUDICATOR_RUNNER_SHA256,
    };
    const adjudicatorArgs = buildT2aIpaAdjudicatorSandboxArguments(
      adjudicatorUnit,
      adjudicatorBindings,
      expected,
      15_000,
      2_000,
    );
    expect(adjudicatorArgs.filter((argument) =>
      argument.startsWith("--property=BindReadOnlyPaths=")))
      .toEqual(Object.values(adjudicatorBindings));
    expect(adjudicatorArgs).toContain("--property=MemoryMax=1G");
    expect(adjudicatorArgs).not.toContain(adjudicatorSandbox.audio);
    expect(adjudicatorArgs).not.toContain(adjudicatorSandbox.transcript);
    expect(adjudicatorArgs).not.toContain(adjudicatorSandbox.whisper);
    expect(adjudicatorArgs).not.toContain(adjudicatorSandbox.g2pRequest);
    expect(adjudicatorArgs.slice(adjudicatorArgs.indexOf("--expected-phase-sha256"),
      adjudicatorArgs.indexOf("--expected-phase-sha256") + 2))
      .toEqual(["--expected-phase-sha256", expected.phaseSha256]);
    expect(JSON.stringify(adjudicatorArgs)).not.toMatch(/Hallo|Zieltext|targetText/iu);
    expect(() => buildT2aIpaAdjudicatorSandboxArguments(
      adjudicatorUnit,
      adjudicatorBindings,
      { ...expected, runnerSha256: "6".repeat(64) },
      15_000,
      2_000,
    )).toThrow(/Server-Authority/u);
  });

  it("rejects broad, duplicate or escaping executable sandbox exceptions", () => {
    const unitName = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${OWN_UUID}`;
    const sandbox = t2aAudioSandboxPaths(unitName);
    expect(evaluatorSandboxExecutableProperties(unitName, [sandbox.python, sandbox.ffmpeg])).toEqual([
      `--property=NoExecPaths=${sandbox.root}`,
      `--property=ExecPaths=${sandbox.python}`,
      `--property=ExecPaths=${sandbox.ffmpeg}`,
    ]);
    expect(() => evaluatorSandboxExecutableProperties(unitName, [])).toThrow(/nicht leere/u);
    expect(() => evaluatorSandboxExecutableProperties(
      unitName,
      [sandbox.ffmpeg, sandbox.ffmpeg],
    )).toThrow(/eindeutige/u);
    expect(() => evaluatorSandboxExecutableProperties(unitName, [sandbox.root]))
      .toThrow(/nicht verlassen/u);
    expect(() => evaluatorSandboxExecutableProperties(unitName, ["/usr/bin/ffmpeg"]))
      .toThrow(/nicht verlassen/u);
    expect(() => evaluatorSandboxExecutableProperties(unitName, [`${sandbox.root}/bad path`]))
      .toThrow(/nicht verlassen/u);
    expect(evaluatorSandboxInaccessibleProperties(unitName, [appRoot, dataRoot])).toEqual([
      `--property=InaccessiblePaths=-${appRoot}`,
      `--property=InaccessiblePaths=-${dataRoot}`,
    ]);
    expect(() => evaluatorSandboxInaccessibleProperties(unitName, []))
      .toThrow(/nicht leere/u);
    expect(() => evaluatorSandboxInaccessibleProperties(unitName, [appRoot, appRoot]))
      .toThrow(/eindeutige/u);
    expect(() => evaluatorSandboxInaccessibleProperties(unitName, ["/"]))
      .toThrow(/getrennt/u);
    expect(() => evaluatorSandboxInaccessibleProperties(unitName, [sandbox.worker]))
      .toThrow(/getrennt/u);
    expect(() => evaluatorSandboxInaccessibleProperties(unitName, ["relative/path"]))
      .toThrow(/absolut/u);
    expect(evaluatorSandboxNoExecHostProperties(unitName, ["/home", "/tmp"])).toEqual([
      "--property=NoExecPaths=-/home",
      "--property=NoExecPaths=-/tmp",
    ]);
    expect(() => evaluatorSandboxNoExecHostProperties(unitName, [sandbox.root]))
      .toThrow(/getrennt/u);
  });

  systemSandboxIt("executes FD-bound runtime targets while masking sensitive host sources", () => {
    const unitName = `ltx-t2a-policy-probe-${randomUUID()}`;
    const sandboxRoot = evaluatorRuntimeDirectory(unitName);
    const sandboxRuntime = join(sandboxRoot, "runtime");
    const sandboxPython = join(sandboxRuntime, "bin", "python");
    const sandboxFfmpeg = join(sandboxRoot, "ffmpeg");
    const sandboxHostname = join(sandboxRoot, "allowed-hostname");
    const runtimeRoot = dirname(dirname(analysisPythonExecutable));
    const revisions = [
      capturePinnedPathRevision(runtimeRoot, "directory"),
      capturePinnedPathRevision(hostTcbExecutables.ffmpeg, "file"),
      capturePinnedPathRevision("/etc/hostname", "file"),
    ];
    const pinned = openPinnedPaths(revisions);
    const probeCode = [
      "import json,os,subprocess,sys,torch,whisper",
      "def denied_read(path):",
      " try:",
      "  open(path,'rb').read(1)",
      "  return False",
      " except OSError:",
      "  return True",
      "def denied_exec(path):",
      " try:",
      "  subprocess.run([path],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False,timeout=3)",
      "  return False",
      " except OSError:",
      "  return True",
      "ff=subprocess.run([sys.argv[2],'-nostdin','-hide_banner','-version'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,check=False,timeout=5)",
      "dangerous=sys.argv[7:]",
      "print(json.dumps({'torch':bool(torch.backends.cpu.get_cpu_capability()),'whisper':hasattr(whisper,'load_model'),'hostAppDenied':denied_read(sys.argv[3]),'hostFileDenied':denied_read('/etc/hostname'),'boundFile':open(sys.argv[1],'rb').read(1).decode(),'boundFfmpeg':ff.returncode==0 and ff.stdout.startswith('ffmpeg version '),'ffmpegReturn':ff.returncode,'ffmpegError':ff.stderr[-300:],'hostFfmpegDenied':denied_exec(sys.argv[4]),'hostWorkerDenied':denied_exec(sys.argv[5]),'dangerousEnvironmentAbsent':all(name not in os.environ for name in dangerous)}))",
    ].join("\n");
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync("/usr/bin/sudo", [
        "-n",
        "/usr/bin/systemd-run",
        "--system",
        "--quiet",
        "--wait",
        "--pipe",
        "--collect",
        "--service-type=exec",
        `--unit=${unitName}`,
        `--working-directory=${sandboxRoot}`,
        ...evaluatorSandboxProperties(unitName, { cpuTopologyRequired: true }),
        ...evaluatorSandboxInaccessibleProperties(unitName, [
          appRoot,
          "/etc/hostname",
          hostTcbExecutables.ffmpeg,
        ]),
        ...evaluatorSandboxNoExecHostProperties(
          unitName,
          t2aAudioSandboxSensitiveNoExecHostPaths(),
        ),
        ...evaluatorSandboxExecutableProperties(unitName, [sandboxPython, sandboxFfmpeg]),
        "--property=PassEnvironment=",
        `--property=UnsetEnvironment=${T2A_SANDBOX_UNSET_ENVIRONMENT.join(" ")}`,
        "--setenv=LD_PRELOAD=/definitely-forbidden/hostile.so",
        "--setenv=PYTHONPATH=/definitely-forbidden/python",
        "--property=MemoryMax=2G",
        "--property=MemorySwapMax=0",
        "--property=TasksMax=64",
        "--property=RuntimeMaxSec=20s",
        pinned.bindReadOnlyProperty(runtimeRoot, sandboxRuntime),
        pinned.bindReadOnlyProperty(hostTcbExecutables.ffmpeg, sandboxFfmpeg),
        pinned.bindReadOnlyProperty("/etc/hostname", sandboxHostname),
        hostTcbExecutables.env,
        "-i",
        "PATH=/usr/bin:/bin",
        "LANG=C.UTF-8",
        "LC_ALL=C.UTF-8",
        "CUDA_VISIBLE_DEVICES=",
        "HF_HUB_OFFLINE=1",
        "TRANSFORMERS_OFFLINE=1",
        "PYTHONNOUSERSITE=1",
        "PYTHONSAFEPATH=1",
        "PYTHONDONTWRITEBYTECODE=1",
        "OMP_NUM_THREADS=2",
        "OPENBLAS_NUM_THREADS=2",
        sandboxPython,
        "-I",
        "-c",
        probeCode,
        sandboxHostname,
        sandboxFfmpeg,
        join(appRoot, "package.json"),
        hostTcbExecutables.ffmpeg,
        join(appRoot, "scripts", "analyze-t2a-audio.py"),
        "--",
        ...T2A_SANDBOX_UNSET_ENVIRONMENT,
      ], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        env: { PATH: "/usr/bin:/bin" },
      });
      pinned.verifyUnchanged();
    } finally {
      pinned.close();
      spawnSync(
        "/usr/bin/sudo",
        ["-n", "/usr/bin/systemctl", "stop", `${unitName}.service`],
        { stdio: "ignore", timeout: 5_000, env: { PATH: "/usr/bin:/bin" } },
      );
    }
    expect(result.status, result.stderr?.toString()).toBe(0);
    expect(JSON.parse(result.stdout?.toString().trim() ?? "")).toEqual({
      torch: true,
      whisper: true,
      hostAppDenied: true,
      hostFileDenied: true,
      boundFile: expect.any(String),
      boundFfmpeg: true,
      ffmpegReturn: 0,
      ffmpegError: "",
      hostFfmpegDenied: true,
      hostWorkerDenied: true,
      dangerousEnvironmentAbsent: true,
    });
  }, 40_000);

  it("preflights the same narrow executable destination from a process-pinned fd", () => {
    const unitName = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${OWN_UUID}`;
    const sandbox = t2aAudioSandboxPaths(unitName);
    const bindings = {
      ffmpeg: `--property=BindReadOnlyPaths=/proc/${process.pid}/fd/77:${sandbox.ffmpeg}`,
      runtime: `--property=BindReadOnlyPaths=/proc/${process.pid}/fd/78:${sandbox.runtime}`,
    };
    const args = buildT2aAudioSandboxPreflightArguments(unitName, bindings, 15_000, 2_000);
    expect(args).toContain(bindings.ffmpeg);
    expect(args).toContain(bindings.runtime);
    expect(args.filter((argument) => argument.startsWith("--property=NoExecPaths=")))
      .toEqual([
        ...t2aAudioSandboxSensitiveNoExecHostPaths()
          .map((path) => `--property=NoExecPaths=-${path}`),
        `--property=NoExecPaths=${sandbox.root}`,
      ]);
    expect(args.filter((argument) => argument.startsWith("--property=ExecPaths=")))
      .toEqual([
        `--property=ExecPaths=${sandbox.python}`,
        `--property=ExecPaths=${sandbox.ffmpeg}`,
      ]);
    expect(args).toContain(sandbox.python);
    expect(args).toContain("/usr/bin/env");
    expect(args).toContain("PYTHONSAFEPATH=1");
    expect(args).toContain("-I");
    expect(args.at(-1)).toBe(sandbox.ffmpeg);
    expect(JSON.stringify(args)).toContain("torch.backends.cpu.get_cpu_capability()");
    expect(JSON.stringify(args)).toContain("import subprocess,sys,torch,whisper");
    expect(JSON.stringify(args)).not.toMatch(/analyze-t2a|whisper-small\.pt|transcript/u);
    expect(() => buildT2aAudioSandboxPreflightArguments(
      unitName,
      {
        ...bindings,
        ffmpeg: `--property=BindReadOnlyPaths=/usr/bin/ffmpeg:${sandbox.ffmpeg}`,
      },
    )).toThrow(/Authority-FD/u);
    expect(() => buildT2aAudioSandboxPreflightArguments(
      unitName,
      {
        ...bindings,
        runtime: `--property=BindReadOnlyPaths=/proc/${process.pid}/fd/78:${sandbox.worker}`,
      },
    )).toThrow(/Authority-FD/u);
  });

  it("closes the pre-registration AbortSignal race with confirmed termination", async () => {
    const child = detachedNode("setInterval(()=>{},1000)");
    const controller = new AbortController();
    controller.abort();
    await expect(monitorT2aAudioSandboxProcess(
      child,
      `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${OWN_UUID}`,
      {
        timeoutMs: 5_000,
        resultDeadline: Date.now() + 5_000,
        terminationGraceMs: 100,
        runtimeTerminalDeadline: Date.now() + 1_000,
        signal: controller.signal,
        controlCommand: stoppedControl,
      },
    )).rejects.toBeInstanceOf(T2aAudioEvaluatorCancelledError);
  });

  it("rejects valid JSON produced only after the absolute result deadline", async () => {
    const child = detachedNode([
      `const payload=${JSON.stringify(`${failedDocument()}\n`)}`,
      "process.on('SIGTERM',()=>{process.stdout.write(payload);process.exit(2)})",
      "setInterval(()=>{},1000)",
    ].join(";"));
    await expect(monitorT2aAudioSandboxProcess(
      child,
      `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${OWN_UUID}`,
      {
        timeoutMs: 5_000,
        resultDeadline: Date.now() + 20,
        terminationGraceMs: 500,
        runtimeTerminalDeadline: Date.now() + 1_000,
        controlCommand: stoppedControl,
      },
    )).rejects.toThrow(/ueberschritt/u);
  });

  it("settles after timeout even when the child never emits close or error", async () => {
    const startedAt = Date.now();
    await expect(monitorT2aAudioSandboxProcess(
      silentChild(),
      `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${OWN_UUID}`,
      {
        timeoutMs: 10,
        resultDeadline: Date.now() + 10,
        terminationGraceMs: 10,
        runtimeTerminalDeadline: Date.now() + 1_000,
        controlCommand: stoppedControl,
      },
    )).rejects.toThrow(/ueberschritt/u);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("settles after abort even when the child never emits close or error", async () => {
    const controller = new AbortController();
    const monitored = monitorT2aAudioSandboxProcess(
      silentChild(),
      `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${OWN_UUID}`,
      {
        timeoutMs: 5_000,
        resultDeadline: Date.now() + 5_000,
        terminationGraceMs: 10,
        runtimeTerminalDeadline: Date.now() + 1_000,
        signal: controller.signal,
        controlCommand: stoppedControl,
      },
    );
    controller.abort();
    await expect(monitored).rejects.toBeInstanceOf(T2aAudioEvaluatorCancelledError);
  });

  it("bounds a systemd control child that never emits close or error", async () => {
    const startedAt = Date.now();
    await expect(monitorT2aAudioControlProcess(silentChild(), 10)).resolves.toMatchObject({
      code: null,
      stderr: expect.stringContaining("ueberschritt ihr Zeitlimit"),
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("requires terminal unit proof after an unexpected child close", async () => {
    const child = silentChild();
    const monitored = monitorT2aAudioSandboxProcess(
      child,
      `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${OWN_UUID}`,
      {
        timeoutMs: 5_000,
        resultDeadline: Date.now() + 5_000,
        terminationGraceMs: 10,
        runtimeTerminalDeadline: Date.now() + 100,
        controlCommand: async (args) => args.includes("show")
          ? { code: 0, stdout: "LoadState=loaded\nActiveState=active\n", stderr: "" }
          : { code: 1, stdout: "", stderr: "stop denied" },
      },
    );
    child.emit("close", 1, null);
    await expect(monitored).rejects.toBeInstanceOf(T2aAudioEvaluatorTerminationError);
  });

  it("propagates stop failure and never leaves an unhandled rejection", async () => {
    const child = detachedNode("process.on('SIGTERM',()=>process.exit(2));setInterval(()=>{},1000)");
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await expect(monitorT2aAudioSandboxProcess(
        child,
        `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${OWN_UUID}`,
        {
          timeoutMs: 20,
          resultDeadline: Date.now() + 20,
          terminationGraceMs: 50,
          runtimeTerminalDeadline: Date.now() + 100,
          controlCommand: async (args) => args.includes("show")
            ? { code: 0, stdout: "LoadState=loaded\nActiveState=active\n", stderr: "" }
            : { code: 1, stdout: "", stderr: "stop denied" },
        },
      )).rejects.toThrow(/sicher beendet|RuntimeMax/u);
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("accepts an absent unit as terminal instead of waiting until RuntimeMax", async () => {
    const child = detachedNode("setInterval(()=>{},1000)");
    const controller = new AbortController();
    const monitored = monitorT2aAudioSandboxProcess(
      child,
      `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${OWN_UUID}`,
      {
        timeoutMs: 5_000,
        resultDeadline: Date.now() + 5_000,
        terminationGraceMs: 50,
        runtimeTerminalDeadline: Date.now() + 5_000,
        signal: controller.signal,
        controlCommand: async (args) => args.includes("show")
          ? { code: 0, stdout: "LoadState=not-found\nActiveState=inactive\n", stderr: "" }
          : { code: 1, stdout: "", stderr: "Unit not found" },
      },
    );
    controller.abort();
    await expect(monitored).rejects.toBeInstanceOf(T2aAudioEvaluatorCancelledError);
  });
});
