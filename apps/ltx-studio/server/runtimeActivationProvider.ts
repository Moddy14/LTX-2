import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";

import {
  activationEnvelopeDigest,
  activationWriterTrustPolicySchema,
  runtimeActivationSnapshot,
  validateActivationJournal,
  verifyActivationEnvelopeSignature,
  verifyRuntimeRightsSnapshot,
  type RuntimeActivationSnapshot,
} from "../shared/activation.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import { activationAnchorHeadSchema } from "./activationJournal.js";
import type { RuntimeActivationProvider } from "./startEnforcer.js";
import { createHash } from "node:crypto";

const MAX_RUNTIME_CONTROL_BYTES = 16 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function readJsonNoFollow(path: string): { value: unknown; sha256: string } {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_RUNTIME_CONTROL_BYTES) {
      throw new Error(`Runtime control file has invalid type or size: ${path}`);
    }
    const bytes = readFileSync(descriptor);
    return {
      value: JSON.parse(bytes.toString("utf8")),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    closeSync(descriptor);
  }
}

function requireExpectedDigest(value: string, name: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${name} must be an exact SHA-256 digest`);
  return value;
}

export class FileRuntimeActivationProvider implements RuntimeActivationProvider {
  private readonly activationTrustPolicyDigest: string;
  private readonly rightsTrustPolicyDigest: string;

  constructor(private readonly options: {
    journalPath: string;
    anchorPath: string;
    activationTrustPolicyPath: string;
    activationTrustPolicyDigest: string;
    rightsSnapshotPath: string;
    rightsTrustPolicyPath: string;
    rightsTrustPolicyDigest: string;
    now?: () => Date;
  }) {
    this.activationTrustPolicyDigest = requireExpectedDigest(
      options.activationTrustPolicyDigest,
      "activationTrustPolicyDigest",
    );
    this.rightsTrustPolicyDigest = requireExpectedDigest(
      options.rightsTrustPolicyDigest,
      "rightsTrustPolicyDigest",
    );
  }

  read(): RuntimeActivationSnapshot {
    const now = this.options.now?.() ?? new Date();
    const activationTrust = readJsonNoFollow(this.options.activationTrustPolicyPath);
    const rightsTrust = readJsonNoFollow(this.options.rightsTrustPolicyPath);
    if (activationTrust.sha256 !== this.activationTrustPolicyDigest
      || rightsTrust.sha256 !== this.rightsTrustPolicyDigest) {
      throw new Error("Runtime trust policy digest mismatch");
    }
    const activationPolicy = activationWriterTrustPolicySchema.parse(activationTrust.value);
    const journal = validateActivationJournal(readJsonNoFollow(this.options.journalPath).value);
    for (const envelope of journal) {
      verifyActivationEnvelopeSignature(envelope, activationPolicy, now);
    }
    const head = journal.at(-1)!;
    const expectedAnchor = {
      generation: head.record.generation,
      sequence: head.record.sequence,
      headSha256: activationEnvelopeDigest(head),
    };
    const anchor = activationAnchorHeadSchema.parse(readJsonNoFollow(this.options.anchorPath).value);
    if (canonicalJson(anchor) !== canonicalJson(expectedAnchor)) {
      throw new Error("Activation journal and external highest-head anchor diverge");
    }
    const signedRights = readJsonNoFollow(this.options.rightsSnapshotPath).value as {
      document?: unknown;
      signature?: unknown;
    };
    if (!("document" in signedRights) || !("signature" in signedRights)) {
      throw new Error("Runtime rights snapshot envelope is incomplete");
    }
    verifyRuntimeRightsSnapshot({
      signed: { document: signedRights.document, signature: signedRights.signature },
      trustPolicy: rightsTrust.value,
      release: head.record.release,
      now,
    });
    return runtimeActivationSnapshot(journal, true);
  }
}
