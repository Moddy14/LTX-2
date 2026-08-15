import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { z } from "zod";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  dataRecoveryJournalRecordDigest,
  dataRecoveryJournalRecordSchema,
  pendingDataRecoveryTransactions,
  validateDataRecoveryJournal,
  type DataRecoveryJournalRecord,
} from "../shared/dataRecoveryJournal.js";

export const dataRecoveryHeadSchema = z.object({
  sequence: z.number().int().nonnegative(),
  headSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type DataRecoveryHead = z.infer<typeof dataRecoveryHeadSchema>;

export type DataRecoveryHeadAnchor = {
  read(): DataRecoveryHead | null;
  commit(head: DataRecoveryHead): void;
};

export class DataRecoveryConflictError extends Error {}
export class DataRecoveryHoldError extends Error {}

function durableWrite(path: string, contents: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${path.split(sep).at(-1)}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, contents, "utf8");
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

export class DataRecoveryJournalStore {
  constructor(
    readonly path: string,
    private readonly anchor: DataRecoveryHeadAnchor,
    readonly writerId: string,
  ) {}

  readVerified(): DataRecoveryJournalRecord[] {
    if (!existsSync(this.path)) {
      if (this.anchor.read() !== null) {
        throw new DataRecoveryHoldError("Data recovery journal is missing while its external anchor exists");
      }
      return [];
    }
    let records: DataRecoveryJournalRecord[];
    try {
      records = validateDataRecoveryJournal(JSON.parse(readFileSync(this.path, "utf8")));
      if (records.some(({ writerId }) => writerId !== this.writerId)) {
        throw new Error("journal contains a record from an unexpected writer");
      }
    } catch (error) {
      throw new DataRecoveryHoldError(`Data recovery journal is invalid: ${String(error)}`);
    }
    if (records.length === 0) {
      if (this.anchor.read() !== null) throw new DataRecoveryHoldError("Empty data recovery journal has an external anchor");
      return records;
    }
    const last = records.at(-1)!;
    const expected = { sequence: last.sequence, headSha256: dataRecoveryJournalRecordDigest(last) };
    if (canonicalJson(this.anchor.read()) !== canonicalJson(expected)) {
      throw new DataRecoveryHoldError("Data recovery journal and external highest-head anchor diverge");
    }
    return records;
  }

  append(rawRecord: unknown, expectedHeadSha256: string | null): DataRecoveryHead {
    const lockPath = `${this.path}.lock`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    let lockDescriptor: number | undefined;
    try {
      try {
        lockDescriptor = openSync(lockPath, "wx", 0o600);
      } catch {
        throw new DataRecoveryConflictError("Data recovery journal single-writer lock is already held");
      }
      const records = this.readVerified();
      const currentHead = records.length === 0 ? null : dataRecoveryJournalRecordDigest(records.at(-1)!);
      if (currentHead !== expectedHeadSha256) {
        throw new DataRecoveryConflictError("Data recovery journal compare-and-swap head mismatch");
      }
      const record = dataRecoveryJournalRecordSchema.parse(rawRecord);
      if (record.writerId !== this.writerId) {
        throw new DataRecoveryHoldError("Data recovery record writer does not match the configured writer");
      }
      const next = validateDataRecoveryJournal([...records, record]);
      durableWrite(this.path, canonicalJson(next));
      const head = { sequence: record.sequence, headSha256: dataRecoveryJournalRecordDigest(record) };
      this.anchor.commit(head);
      if (canonicalJson(this.anchor.read()) !== canonicalJson(head)) {
        throw new DataRecoveryHoldError("Data recovery anchor did not acknowledge the committed head");
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

type DataRecoveryCrashPoint = "after_prepare" | "after_target";

type DataRecoveryCoordinatorOptions = {
  id?: () => string;
  now?: () => string;
  crash?: (point: DataRecoveryCrashPoint) => void;
};

function fileDigest(path: string): string | null {
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) throw new DataRecoveryHoldError("Data recovery target is a symbolic link");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizedTimestamp(): string {
  return new Date().toISOString().replace(".000Z", "Z");
}

export class DataRecoveryCoordinator {
  private readonly dataRoot: string;
  private readonly id: () => string;
  private readonly now: () => string;
  private readonly crash: (point: DataRecoveryCrashPoint) => void;

  constructor(
    dataRoot: string,
    private readonly journal: DataRecoveryJournalStore,
    private readonly writerId: string,
    options: DataRecoveryCoordinatorOptions = {},
  ) {
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    if (lstatSync(dataRoot).isSymbolicLink()) throw new DataRecoveryHoldError("Data recovery root may not be a symbolic link");
    this.dataRoot = realpathSync(dataRoot);
    if (writerId !== journal.writerId) {
      throw new DataRecoveryHoldError("Data recovery coordinator and journal writer identities differ");
    }
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? normalizedTimestamp;
    this.crash = options.crash ?? (() => undefined);
  }

  commitJson(options: {
    targetKind: DataRecoveryJournalRecord["targetKind"];
    targetRelativePath: string;
    value: unknown;
  }): { transactionId: string; afterSha256: string; journalHeadSha256: string } {
    return this.withTransactionLock(() => {
      const target = this.safeTarget(options.targetRelativePath);
      const payloadCanonicalJson = canonicalJson(options.value);
      const afterSha256 = createHash("sha256").update(payloadCanonicalJson).digest("hex");
      const transactionId = this.id();
      const beforeSha256 = fileDigest(target);
      const records = this.journal.readVerified();
      if (pendingDataRecoveryTransactions(records).length !== 0) {
        throw new DataRecoveryHoldError("A prepared data recovery transaction must be reconciled before another write");
      }
      const latestForTarget = [...records].reverse().find((record) =>
        record.phase === "committed" && record.targetRelativePath === options.targetRelativePath);
      if (latestForTarget && latestForTarget.afterSha256 !== beforeSha256) {
        throw new DataRecoveryHoldError("Data recovery target diverged from its latest committed digest");
      }
      const prepared = this.record({
        records,
        transactionId,
        phase: "prepared",
        targetKind: options.targetKind,
        targetRelativePath: options.targetRelativePath,
        beforeSha256,
        afterSha256,
        payloadCanonicalJson,
        preparedRecordSha256: null,
      });
      let head = this.journal.append(
        prepared,
        records.length === 0 ? null : dataRecoveryJournalRecordDigest(records.at(-1)!),
      );
      this.crash("after_prepare");
      durableWrite(target, payloadCanonicalJson);
      this.crash("after_target");
      const afterPrepare = this.journal.readVerified();
      const committed = this.record({
        records: afterPrepare,
        transactionId,
        phase: "committed",
        targetKind: options.targetKind,
        targetRelativePath: options.targetRelativePath,
        beforeSha256,
        afterSha256,
        payloadCanonicalJson: null,
        preparedRecordSha256: dataRecoveryJournalRecordDigest(prepared),
      });
      head = this.journal.append(committed, head.headSha256);
      return { transactionId, afterSha256, journalHeadSha256: head.headSha256 };
    });
  }

  recover(): { recoveredTransactions: string[] } {
    return this.withTransactionLock(() => {
      const recoveredTransactions: string[] = [];
      for (const prepared of pendingDataRecoveryTransactions(this.journal.readVerified())) {
        const target = this.safeTarget(prepared.targetRelativePath);
        const currentDigest = fileDigest(target);
        if (currentDigest === prepared.beforeSha256) {
          durableWrite(target, prepared.payloadCanonicalJson!);
        } else if (currentDigest !== prepared.afterSha256) {
          throw new DataRecoveryHoldError(`Data recovery target diverged for ${prepared.transactionId}`);
        }
        const records = this.journal.readVerified();
        const committed = this.record({
          records,
          transactionId: prepared.transactionId,
          phase: "committed",
          targetKind: prepared.targetKind,
          targetRelativePath: prepared.targetRelativePath,
          beforeSha256: prepared.beforeSha256,
          afterSha256: prepared.afterSha256,
          payloadCanonicalJson: null,
          preparedRecordSha256: dataRecoveryJournalRecordDigest(prepared),
        });
        this.journal.append(committed, dataRecoveryJournalRecordDigest(records.at(-1)!));
        recoveredTransactions.push(prepared.transactionId);
      }
      this.verifyCommittedTargets();
      return { recoveredTransactions };
    });
  }

  verifyCommittedTargets(): { targetCount: number } {
    const records = this.journal.readVerified();
    const latestByTarget = new Map<string, DataRecoveryJournalRecord>();
    for (const record of records) {
      if (record.phase === "committed") latestByTarget.set(record.targetRelativePath, record);
    }
    for (const record of latestByTarget.values()) {
      if (fileDigest(this.safeTarget(record.targetRelativePath)) !== record.afterSha256) {
        throw new DataRecoveryHoldError(`Committed data recovery target diverged: ${record.targetRelativePath}`);
      }
    }
    return { targetCount: latestByTarget.size };
  }

  private record(options: Omit<DataRecoveryJournalRecord, "schemaVersion" | "recordId" | "sequence"
    | "previousRecordSha256" | "recordedAt" | "writerId"> & { records: DataRecoveryJournalRecord[] }): DataRecoveryJournalRecord {
    const { records, ...record } = options;
    return dataRecoveryJournalRecordSchema.parse({
      schemaVersion: "ltx-studio-data-recovery-journal-record.v1",
      recordId: this.id(),
      sequence: records.length,
      previousRecordSha256: records.length === 0 ? null : dataRecoveryJournalRecordDigest(records.at(-1)!),
      ...record,
      recordedAt: this.now(),
      writerId: this.writerId,
    });
  }

  private safeTarget(targetRelativePath: string): string {
    const parsedPath = dataRecoveryJournalRecordSchema.shape.targetRelativePath.parse(targetRelativePath);
    const target = resolve(this.dataRoot, parsedPath);
    if (!target.startsWith(`${this.dataRoot}${sep}`)) throw new DataRecoveryHoldError("Data recovery target escaped its root");
    let cursor = this.dataRoot;
    for (const segment of dirname(parsedPath).split("/").filter((value) => value !== ".")) {
      cursor = join(cursor, segment);
      if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
      if (lstatSync(cursor).isSymbolicLink() || !lstatSync(cursor).isDirectory()) {
        throw new DataRecoveryHoldError("Data recovery target parent is not a real directory");
      }
    }
    return target;
  }

  private withTransactionLock<T>(operation: () => T): T {
    const lockPath = join(this.dataRoot, ".data-recovery-transaction.lock");
    let descriptor: number | undefined;
    try {
      try {
        descriptor = openSync(lockPath, "wx", 0o600);
      } catch {
        throw new DataRecoveryConflictError("Another data recovery transaction is active");
      }
      return operation();
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        if (existsSync(lockPath)) unlinkSync(lockPath);
      }
    }
  }
}
