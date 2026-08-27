import { runReleaseEvidenceCollection } from "./audit-release-lib.mjs";
import { runReleaseSecurityVerification } from "./audit-release-security-lib.mjs";
import { runReleaseAuditFinalization } from "./finalize-release-audit-lib.mjs";
import { prepareReleasePromotion } from "./prepare-release-promotion-lib.mjs";

const COMMON = {
  "--release": "expectedReleaseDigest",
  "--release-root": "releaseRoot",
  "--evidence-root": "evidenceRoot",
  "--index": "indexPath",
  "--trusted-policy-sha256": "trustedPolicySha256",
};

const COMMANDS = {
  evidence: {
    options: {
      ...COMMON,
      "--output": "outputPath",
    },
    required: ["expectedReleaseDigest", "evidenceRoot", "trustedPolicySha256"],
  },
  security: {
    options: {
      ...COMMON,
      "--mode": "mode",
    },
    required: ["expectedReleaseDigest", "evidenceRoot", "trustedPolicySha256"],
  },
  finalize: {
    options: {
      ...COMMON,
      "--evidence": "evidencePath",
      "--authorization": "authorizationPath",
      "--authorization-signature": "authorizationSignaturePath",
      "--finalizer-key-id": "finalizerKeyId",
      "--finalizer-private-key": "finalizerPrivateKeyPath",
      "--output": "outputPath",
    },
    required: [
      "expectedReleaseDigest",
      "evidenceRoot",
      "trustedPolicySha256",
      "finalizerKeyId",
      "finalizerPrivateKeyPath",
    ],
  },
  promotion: {
    options: {
      ...COMMON,
      "--evidence": "evidencePath",
      "--authorization": "authorizationPath",
      "--authorization-signature": "authorizationSignaturePath",
      "--audit": "auditPath",
      "--activation-control-root": "activationControlRoot",
      "--activation-journal": "activationJournalPath",
      "--activation-anchor": "activationAnchorPath",
      "--activation-trust-policy": "activationTrustPolicyPath",
      "--runtime-rights-snapshot": "runtimeRightsSnapshotPath",
      "--runtime-rights-trust-policy": "runtimeRightsTrustPolicyPath",
    },
    required: [
      "expectedReleaseDigest",
      "evidenceRoot",
      "trustedPolicySha256",
      "activationControlRoot",
    ],
  },
};

class ReleaseAuditCliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseAuditCliUsageError";
    this.code = "release-audit-cli-invalid";
  }
}

export function parseReleaseAuditCommandArguments(command, argv) {
  const specification = COMMANDS[command];
  if (!specification) throw new ReleaseAuditCliUsageError(`Unknown release command: ${command}`);
  if (!Array.isArray(argv) || argv.length % 2 !== 0) {
    throw new ReleaseAuditCliUsageError("Every release CLI option requires exactly one value");
  }
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const property = specification.options[flag];
    if (!property) throw new ReleaseAuditCliUsageError(`Unsupported ${command} option: ${flag}`);
    if (property in parsed) throw new ReleaseAuditCliUsageError(`Duplicate ${command} option: ${flag}`);
    if (!value || value.startsWith("--")) {
      throw new ReleaseAuditCliUsageError(`${flag} requires a value`);
    }
    parsed[property] = value;
  }
  for (const property of specification.required) {
    if (!parsed[property]) {
      const flag = Object.entries(specification.options)
        .find(([, candidate]) => candidate === property)?.[0] ?? property;
      throw new ReleaseAuditCliUsageError(`${flag} requires a value`);
    }
  }
  if (command === "security") {
    parsed.mode ??= "product-go";
    if (!["product-go", "staged-evidence"].includes(parsed.mode)) {
      throw new ReleaseAuditCliUsageError("--mode must be product-go or staged-evidence");
    }
  }
  return parsed;
}

function failure(command, error, argv) {
  const invalidInvocation = error instanceof ReleaseAuditCliUsageError
    || (error && typeof error === "object" && "code" in error
      && ["release-audit-cli-invalid", "security-audit-cli-invalid"].includes(error.code));
  const message = error instanceof Error ? error.message : String(error);
  if (command === "security") {
    const modeIndex = argv.indexOf("--mode");
    const mode = modeIndex >= 0 && argv[modeIndex + 1] && !argv[modeIndex + 1].startsWith("--")
      ? argv[modeIndex + 1]
      : "product-go";
    return {
      document: {
        schemaVersion: "ltx-studio-security-audit-verification.v1",
        mode,
        verdict: invalidInvocation ? "invalid-invocation" : "blocked",
        go: false,
        code: invalidInvocation
          ? "security-audit-cli-invalid"
          : "security-audit-verification-failed",
        error: message,
      },
      exitCode: invalidInvocation ? 64 : 2,
    };
  }
  if (command === "promotion") {
    return {
      document: {
        schemaVersion: "ltx-studio-promotion-authorization-request.v1",
        status: invalidInvocation ? "invalid-invocation" : "blocked",
        mutationPerformed: false,
        error: message,
      },
      exitCode: invalidInvocation ? 64 : 2,
    };
  }
  return {
    document: {
      schemaVersion: "ltx-studio-release-cli-result.v1",
      command,
      verdict: invalidInvocation ? "invalid-invocation" : "hold",
      go: false,
      error: message,
    },
    exitCode: invalidInvocation ? 64 : 2,
  };
}

export async function executeReleaseAuditCommand(command, argv, dependencies = {}) {
  try {
    const options = parseReleaseAuditCommandArguments(command, argv);
    if (command === "evidence") {
      return {
        document: await runReleaseEvidenceCollection(options, dependencies),
        exitCode: 0,
      };
    }
    if (command === "security") {
      return {
        document: await runReleaseSecurityVerification(options, dependencies),
        exitCode: 0,
      };
    }
    if (command === "finalize") {
      return {
        document: await runReleaseAuditFinalization(options, dependencies),
        exitCode: 0,
      };
    }
    const document = await prepareReleasePromotion(options, dependencies);
    return { document, exitCode: 2 };
  } catch (error) {
    return failure(command, error, argv);
  }
}
