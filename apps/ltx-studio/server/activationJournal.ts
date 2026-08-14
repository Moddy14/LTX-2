import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  activationEnvelopeDigest,
  activationJournalEnvelopeSchema,
  validateActivationJournal,
  type ActivationJournalEnvelope,
} from "../shared/activation.js";
import { canonicalJson } from "../shared/canonicalJson.js";

import { z } from "zod";

export type ActivationAnchorHead = {
  generation: number;
  sequence: number;
  headSha256: string;
};

export const activationAnchorHeadSchema = z.object({
  generation: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  headSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type ActivationHeadAnchor = {
  read(): ActivationAnchorHead | null;
  commit(head: ActivationAnchorHead): void;
};

export type ActivationEnvelopeVerifier = (envelope: ActivationJournalEnvelope) => void;

export class ActivationJournalConflictError extends Error {}
export class ActivationJournalHoldError extends Error {}

function durableWrite(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, canonicalJson(value));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directoryDescriptor = openSync(directory, "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

export class ActivationJournalStore {
  constructor(
    private readonly path: string,
    private readonly anchor: ActivationHeadAnchor,
    private readonly verifyEnvelope: ActivationEnvelopeVerifier,
  ) {}

  readVerified(): ActivationJournalEnvelope[] {
    if (!existsSync(this.path)) {
      if (this.anchor.read() !== null) {
        throw new ActivationJournalHoldError("Activation journal is missing while its external anchor exists");
      }
      return [];
    }
    let envelopes: ActivationJournalEnvelope[];
    try {
      envelopes = validateActivationJournal(JSON.parse(readFileSync(this.path, "utf8")));
      for (const envelope of envelopes) this.verifyEnvelope(envelope);
    } catch (error) {
      throw new ActivationJournalHoldError(`Activation journal is invalid: ${String(error)}`);
    }
    const last = envelopes.at(-1)!;
    const expected = {
      generation: last.record.generation,
      sequence: last.record.sequence,
      headSha256: activationEnvelopeDigest(last),
    };
    const anchored = this.anchor.read();
    if (!anchored || canonicalJson(anchored) !== canonicalJson(expected)) {
      throw new ActivationJournalHoldError("Activation journal and external highest-head anchor diverge");
    }
    return envelopes;
  }

  append(rawEnvelope: unknown, expectedHeadSha256: string | null): ActivationAnchorHead {
    const lockPath = `${this.path}.lock`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    let lockDescriptor: number | undefined;
    try {
      try {
        lockDescriptor = openSync(lockPath, "wx", 0o600);
      } catch {
        throw new ActivationJournalConflictError("Activation journal single-writer lock is already held");
      }
      const current = this.readVerified();
      const currentHead = current.length === 0 ? null : activationEnvelopeDigest(current.at(-1)!);
      if (currentHead !== expectedHeadSha256) {
        throw new ActivationJournalConflictError("Activation journal compare-and-swap head mismatch");
      }
      const envelope = activationJournalEnvelopeSchema.parse(rawEnvelope);
      const next = validateActivationJournal([...current, envelope]);
      this.verifyEnvelope(envelope);
      durableWrite(this.path, next);
      const head = {
        generation: envelope.record.generation,
        sequence: envelope.record.sequence,
        headSha256: activationEnvelopeDigest(envelope),
      };
      this.anchor.commit(head);
      if (canonicalJson(this.anchor.read()) !== canonicalJson(head)) {
        throw new ActivationJournalHoldError("Activation journal anchor did not acknowledge the committed head");
      }
      return head;
    } finally {
      if (lockDescriptor !== undefined) {
        closeSync(lockDescriptor);
        if (existsSync(lockPath)) unlinkSync(lockPath);
      }
    }
  }
}
