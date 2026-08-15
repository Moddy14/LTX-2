import { createHash } from "node:crypto";
import { posix } from "node:path";

import { z } from "zod";

import { canonicalJson } from "./canonicalJson.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/);
const timestampSchema = z.string().datetime({ offset: false, precision: 0 });
const relativeTargetSchema = z.string().min(1).max(512).refine((value) =>
  !value.startsWith("/")
  && !value.includes("\\")
  && value !== "."
  && value !== ".."
  && !value.startsWith("../")
  && posix.normalize(value) === value,
"journal targets must be normalized relative POSIX paths");

export const dataRecoveryTargetKinds = ["project", "job", "provenance"] as const;

export const dataRecoveryJournalRecordSchema = z.object({
  schemaVersion: z.literal("ltx-studio-data-recovery-journal-record.v1"),
  recordId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  previousRecordSha256: sha256Schema.nullable(),
  transactionId: z.uuid(),
  phase: z.enum(["prepared", "committed"]),
  targetKind: z.enum(dataRecoveryTargetKinds),
  targetRelativePath: relativeTargetSchema,
  beforeSha256: sha256Schema.nullable(),
  afterSha256: sha256Schema,
  payloadCanonicalJson: z.string().min(3).nullable(),
  preparedRecordSha256: sha256Schema.nullable(),
  recordedAt: timestampSchema,
  writerId: identifierSchema,
}).strict().superRefine((record, context) => {
  if ((record.sequence === 0) !== (record.previousRecordSha256 === null)) {
    context.addIssue({ code: "custom", path: ["previousRecordSha256"], message: "only sequence zero may omit the previous hash" });
  }
  if ((record.phase === "prepared") !== (record.payloadCanonicalJson !== null)
    || (record.phase === "committed") !== (record.preparedRecordSha256 !== null)) {
    context.addIssue({ code: "custom", path: ["phase"], message: "journal phase fields are inconsistent" });
  }
  if (record.payloadCanonicalJson !== null) {
    try {
      const parsed: unknown = JSON.parse(record.payloadCanonicalJson);
      if (canonicalJson(parsed) !== record.payloadCanonicalJson) throw new Error("non-canonical");
      const payloadDigest = createHash("sha256").update(record.payloadCanonicalJson).digest("hex");
      if (payloadDigest !== record.afterSha256) throw new Error("digest mismatch");
    } catch {
      context.addIssue({ code: "custom", path: ["payloadCanonicalJson"], message: "prepared payload must be canonical JSON matching afterSha256" });
    }
  }
});

export type DataRecoveryJournalRecord = z.infer<typeof dataRecoveryJournalRecordSchema>;

export function dataRecoveryJournalRecordDigest(record: DataRecoveryJournalRecord): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}

export function validateDataRecoveryJournal(raw: unknown): DataRecoveryJournalRecord[] {
  const records = z.array(dataRecoveryJournalRecordSchema).parse(raw);
  const recordIds = new Set<string>();
  const transactions = new Map<string, DataRecoveryJournalRecord>();
  for (const [index, record] of records.entries()) {
    if (recordIds.has(record.recordId)) throw new Error(`Data recovery record ${index} reused its record id`);
    recordIds.add(record.recordId);
    const previous = records[index - 1];
    if (record.sequence !== index
      || record.previousRecordSha256 !== (previous ? dataRecoveryJournalRecordDigest(previous) : null)
      || (previous && Date.parse(record.recordedAt) < Date.parse(previous.recordedAt))) {
      throw new Error(`Data recovery record ${index} chain mismatch`);
    }
    const prepared = transactions.get(record.transactionId);
    if (record.phase === "prepared") {
      if (prepared) throw new Error(`Data recovery transaction ${record.transactionId} was prepared twice`);
      transactions.set(record.transactionId, record);
      continue;
    }
    if (!prepared
      || prepared.phase !== "prepared"
      || record.preparedRecordSha256 !== dataRecoveryJournalRecordDigest(prepared)
      || record.targetKind !== prepared.targetKind
      || record.targetRelativePath !== prepared.targetRelativePath
      || record.beforeSha256 !== prepared.beforeSha256
      || record.afterSha256 !== prepared.afterSha256) {
      throw new Error(`Data recovery transaction ${record.transactionId} commit binding mismatch`);
    }
    transactions.set(record.transactionId, record);
  }
  return records;
}

export function pendingDataRecoveryTransactions(records: readonly DataRecoveryJournalRecord[]): DataRecoveryJournalRecord[] {
  const heads = new Map<string, DataRecoveryJournalRecord>();
  for (const record of records) heads.set(record.transactionId, record);
  return [...heads.values()].filter(({ phase }) => phase === "prepared");
}
