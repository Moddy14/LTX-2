import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  ActivationJournalConflictError,
  ActivationJournalHoldError,
  ActivationJournalStore,
  type ActivationAnchorHead,
  type ActivationHeadAnchor,
} from "../server/activationJournal.js";
import {
  activationEnvelopeDigest,
  activationRecordDigest,
  type ActivationJournalEnvelope,
  type ActivationJournalRecord,
} from "../shared/activation.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import { runtimeTrustFixture } from "./runtime-trust-fixture.js";

const roots: string[] = [];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

class MemoryAnchor implements ActivationHeadAnchor {
  head: ActivationAnchorHead | null = null;
  failCommit = false;

  read(): ActivationAnchorHead | null {
    return this.head ? structuredClone(this.head) : null;
  }

  commit(head: ActivationAnchorHead): void {
    if (this.failCommit) throw new Error("synthetic external anchor outage");
    this.head = structuredClone(head);
  }
}

function envelope(overrides: Partial<ActivationJournalRecord> = {}): ActivationJournalEnvelope {
  const record: ActivationJournalRecord = {
    schemaVersion: "ltx-studio-activation-journal-record.v3",
    recordId: "00000000-0000-4000-8000-000000000011",
    sequence: 0,
    generation: 1,
    previousRecordSha256: null,
    previousState: null,
    state: "blocked",
    operation: "bootstrap_generation",
    release: {
      releaseDigest: sha("release"),
      surfaceDigest: sha("surface"),
      runtimeInstallSealSha256: sha("runtime-seal"),
      runtimeTreeSha256: sha("runtime-tree"),
      runtimePolicySha256: sha("runtime-policy"),
      nodeExecutableSha256: sha("node-executable"),
      runtimeTrust: runtimeTrustFixture,
      rights: {
        policyEvidenceDigest: sha("rights"),
        attestationSeriesId: "rights-series-001",
        minimumSnapshotVersion: 1,
      },
    },
    releasedSurfaceEntryIds: [],
    authorizationDigest: null,
    auditEnvelopeDigest: null,
    evidenceDigest: null,
    ticketId: null,
    ticketState: null,
    ticketTerminal: null,
    supersedePreflight: null,
    recordedAt: "2026-08-15T00:00:00Z",
    writerKeyId: "activation-writer-001",
    ...overrides,
  };
  return {
    record,
    signature: {
      schemaVersion: "ltx-studio-detached-signature.v1",
      algorithm: "ed25519",
      role: "activation-journal-writer",
      keyId: record.writerKeyId,
      payloadSha256: activationRecordDigest(record),
      signatureBase64: "structural-test-signature",
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ path: string; anchor: MemoryAnchor; store: ActivationJournalStore }> {
  const root = await mkdtemp(join(tmpdir(), "ltx-activation-"));
  roots.push(root);
  const path = join(root, "state", "activation-journal.json");
  const anchor = new MemoryAnchor();
  return { path, anchor, store: new ActivationJournalStore(path, anchor, () => undefined) };
}

describe("durable activation journal", () => {
  it("commits a canonical record and matching external highest-head anchor", async () => {
    const { path, anchor, store } = await fixture();
    const first = envelope();

    expect(store.append(first, null)).toEqual({
      generation: 1,
      sequence: 0,
      headSha256: activationEnvelopeDigest(first),
    });
    expect(store.readVerified()).toEqual([first]);
    expect(await readFile(path, "utf8")).toBe(canonicalJson([first]));
    expect(anchor.read()?.headSha256).toBe(activationEnvelopeDigest(first));
  });

  it("rejects stale compare-and-swap writers", async () => {
    const { store } = await fixture();
    const first = envelope();
    store.append(first, null);

    expect(() => store.append(first, null)).toThrow(ActivationJournalConflictError);
  });

  it("holds on a valid prefix restore behind the external anchor", async () => {
    const { path, store } = await fixture();
    const first = envelope();
    store.append(first, null);
    const second = envelope({
      recordId: "00000000-0000-4000-8000-000000000012",
      sequence: 1,
      previousRecordSha256: activationEnvelopeDigest(first),
      previousState: "blocked",
      state: "qualification_only",
      operation: "activate_qualification_mode",
      authorizationDigest: sha("mode-authorization"),
      recordedAt: "2026-08-15T00:01:00Z",
    });
    store.append(second, activationEnvelopeDigest(first));

    await writeFile(path, canonicalJson([first]));
    expect(() => store.readVerified()).toThrow(ActivationJournalHoldError);
  });

  it("holds after a crash boundary between journal fsync and anchor commit", async () => {
    const { anchor, store } = await fixture();
    const first = envelope();
    anchor.failCommit = true;

    expect(() => store.append(first, null)).toThrow(/anchor outage/);
    anchor.failCommit = false;
    expect(() => store.readVerified()).toThrow(ActivationJournalHoldError);
  });

  it("rejects append while the single-writer lock exists", async () => {
    const { path, store } = await fixture();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(`${path}.lock`, "held");

    expect(() => store.append(envelope(), null)).toThrow(ActivationJournalConflictError);
    expect(await readFile(`${path}.lock`, "utf8")).toBe("held");
  });
});
