import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  activationEnvelopeDigest,
  activationJournalEnvelopeSchema,
  type ActivationJournalEnvelope,
  type RuntimeActivationSnapshot,
} from "../shared/activation.js";
import { qualificationTicketClaimSchema } from "../shared/qualificationRegistry.js";
import { canonicalJson } from "../shared/canonicalJson.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const timestampSchema = z.string().datetime({ offset: false, precision: 0 });

export const qualificationBrokerActions = ["accept", "arm", "start", "terminalize"] as const;
export type QualificationBrokerAction = (typeof qualificationBrokerActions)[number];

const brokerTerminalSchema = z.object({
  outcome: z.enum(["completed", "failed", "cancelled", "expired", "revoked", "killed"]),
  outputDigest: sha256Schema.nullable(),
  reason: z.string().min(1).max(1000),
}).strict().superRefine((terminal, context) => {
  if ((terminal.outcome === "completed") !== (terminal.outputDigest !== null)) {
    context.addIssue({
      code: "custom",
      path: ["outputDigest"],
      message: "only completed qualification tickets may bind a released output digest",
    });
  }
});

export const qualificationBrokerRequestSchema = z.object({
  schemaVersion: z.literal("ltx-studio-qualification-broker-request.v1"),
  requestId: z.uuid(),
  action: z.enum(qualificationBrokerActions),
  requestedAt: timestampSchema,
  expectedGeneration: z.number().int().positive(),
  expectedHeadSha256: sha256Schema,
  expectedReleaseDigest: sha256Schema,
  expectedSurfaceDigest: sha256Schema,
  claim: qualificationTicketClaimSchema,
  terminal: brokerTerminalSchema.nullable(),
}).strict().superRefine((request, context) => {
  if ((request.action === "terminalize") !== (request.terminal !== null)) {
    context.addIssue({
      code: "custom",
      path: ["terminal"],
      message: "terminal details are required only for terminalize",
    });
  }
});

const qualificationBrokerCommittedReceiptSchema = z.object({
  schemaVersion: z.literal("ltx-studio-qualification-broker-receipt.v1"),
  requestId: z.uuid(),
  action: z.enum(qualificationBrokerActions),
  committed: z.literal(true),
  code: z.literal("committed"),
  reason: z.string().min(1).max(1000),
  envelope: activationJournalEnvelopeSchema,
}).strict();

const qualificationBrokerDeniedReceiptSchema = z.object({
  schemaVersion: z.literal("ltx-studio-qualification-broker-receipt.v1"),
  requestId: z.uuid(),
  action: z.enum(qualificationBrokerActions),
  committed: z.literal(false),
  code: z.enum([
    "conflict",
    "invalid_authorization",
    "invalid_ticket",
    "deadline",
    "budget",
    "rights_hold",
    "state_hold",
    "supervisor_hold",
    "internal_hold",
  ]),
  reason: z.string().min(1).max(1000),
  envelope: z.null(),
}).strict();

export const qualificationBrokerReceiptSchema = z.discriminatedUnion("committed", [
  qualificationBrokerCommittedReceiptSchema,
  qualificationBrokerDeniedReceiptSchema,
]);

export type QualificationBrokerRequest = z.infer<typeof qualificationBrokerRequestSchema>;
export type QualificationBrokerReceipt = z.infer<typeof qualificationBrokerReceiptSchema>;
export type QualificationBrokerCommittedReceipt = z.infer<typeof qualificationBrokerCommittedReceiptSchema>;

export type QualificationBrokerTransport = {
  exchange(request: QualificationBrokerRequest): Promise<unknown>;
};

export type UnixQualificationBrokerTransportOptions = {
  socketPath: string;
  expectedUid: number;
  expectedGid: number;
  expectedMode: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

type SocketIdentity = { dev: number; ino: number };

export class UnixQualificationBrokerTransport implements QualificationBrokerTransport {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: UnixQualificationBrokerTransportOptions) {
    if (!isAbsolute(options.socketPath)) throw new Error("Qualification broker socket path must be absolute");
    if (![options.expectedUid, options.expectedGid, options.expectedMode].every(Number.isInteger)) {
      throw new Error("Qualification broker socket identity must use integer UID, GID, and mode");
    }
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    if (this.timeoutMs < 50 || this.timeoutMs > 30_000
      || this.maxResponseBytes < 1024 || this.maxResponseBytes > 4 * 1024 * 1024) {
      throw new Error("Qualification broker transport bounds are invalid");
    }
  }

  private validateSocket(): SocketIdentity {
    const stats = lstatSync(this.options.socketPath);
    if (!stats.isSocket()
      || stats.uid !== this.options.expectedUid
      || stats.gid !== this.options.expectedGid
      || (stats.mode & 0o777) !== this.options.expectedMode) {
      throw new Error("Qualification broker socket type, owner, group, or mode mismatch");
    }
    return { dev: stats.dev, ino: stats.ino };
  }

  exchange(request: QualificationBrokerRequest): Promise<unknown> {
    const before = this.validateSocket();
    const payload = `${canonicalJson(qualificationBrokerRequestSchema.parse(request))}\n`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let response = Buffer.alloc(0);
      const socket = createConnection({ path: this.options.socketPath });
      const finish = (error: Error | null, value?: unknown) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      socket.setTimeout(this.timeoutMs);
      socket.once("connect", () => {
        try {
          const after = this.validateSocket();
          if (before.dev !== after.dev || before.ino !== after.ino) {
            throw new Error("Qualification broker socket changed during connect");
          }
          socket.write(payload);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("data", (chunk: Buffer) => {
        response = Buffer.concat([response, chunk]);
        if (response.length > this.maxResponseBytes) {
          finish(new Error("Qualification broker response exceeded its byte limit"));
        }
      });
      socket.once("timeout", () => finish(new Error("Qualification broker request timed out")));
      socket.once("end", () => {
        const newline = response.indexOf(0x0a);
        if (newline < 0) {
          finish(new Error("Qualification broker closed before a complete response"));
          return;
        }
        if (newline !== response.length - 1) {
          finish(new Error("Qualification broker returned more than one response frame"));
          return;
        }
        try {
          finish(null, JSON.parse(response.subarray(0, newline).toString("utf8")));
        } catch (error) {
          finish(new Error(`Qualification broker returned invalid JSON: ${String(error)}`));
        }
      });
      socket.once("error", (error) => finish(error));
    });
  }
}

export type QualificationActivationReader = {
  read(): RuntimeActivationSnapshot;
};

export type QualificationEnvelopeVerifier = (envelope: ActivationJournalEnvelope) => void;

export class QualificationBrokerDeniedError extends Error {
  constructor(
    readonly code: Exclude<QualificationBrokerReceipt, { committed: true }>["code"],
    message: string,
  ) {
    super(message);
  }
}

const operationByAction = {
  accept: "accept_run_ticket",
  arm: "arm_run_ticket",
  start: "start_run_ticket",
  terminalize: "terminalize_run_ticket",
} as const;

const ticketStateByAction = {
  accept: "accepted",
  arm: "armed",
  start: "started",
  terminalize: "terminal",
} as const;

function assertPreflight(snapshot: RuntimeActivationSnapshot, request: QualificationBrokerRequest): void {
  if (snapshot.state !== "qualification_only" || !snapshot.rightsCurrent) {
    throw new Error("Qualification broker is unavailable outside a rights-current qualification_only state");
  }
  if (snapshot.generation !== request.expectedGeneration
    || snapshot.activationHeadSha256 !== request.expectedHeadSha256
    || snapshot.releaseDigest !== request.expectedReleaseDigest
    || snapshot.surfaceDigest !== request.expectedSurfaceDigest) {
    throw new Error("Qualification broker request has a stale activation binding");
  }
}

function assertCommittedEnvelope(
  request: QualificationBrokerRequest,
  receipt: QualificationBrokerCommittedReceipt,
): void {
  const record = receipt.envelope.record;
  if (record.recordId !== request.requestId
    || record.operation !== operationByAction[request.action]
    || record.ticketState !== ticketStateByAction[request.action]
    || record.ticketId !== request.claim.ticketId
    || record.authorizationDigest !== request.claim.authorizationDigest) {
    throw new Error("Qualification broker receipt ticket transition binding mismatch");
  }
  if (record.previousRecordSha256 !== request.expectedHeadSha256
    || record.generation !== request.expectedGeneration
    || record.release.releaseDigest !== request.expectedReleaseDigest
    || record.release.surfaceDigest !== request.expectedSurfaceDigest
    || record.state !== "qualification_only") {
    throw new Error("Qualification broker receipt activation binding mismatch");
  }
  if (request.action === "terminalize") {
    if (canonicalJson(record.ticketTerminal) !== canonicalJson(request.terminal)) {
      throw new Error("Qualification broker receipt terminal result mismatch");
    }
  } else if (record.ticketTerminal !== null) {
    throw new Error("Qualification broker receipt unexpectedly terminalized a ticket");
  }
}

export class QualificationBrokerClient {
  constructor(
    private readonly transport: QualificationBrokerTransport,
    private readonly activation: QualificationActivationReader,
    private readonly verifyEnvelope: QualificationEnvelopeVerifier,
  ) {}

  async transition(rawRequest: unknown): Promise<QualificationBrokerCommittedReceipt> {
    const request = qualificationBrokerRequestSchema.parse(rawRequest);
    assertPreflight(this.activation.read(), request);

    const receipt = qualificationBrokerReceiptSchema.parse(await this.transport.exchange(request));
    if (receipt.requestId !== request.requestId || receipt.action !== request.action) {
      throw new Error("Qualification broker response request binding mismatch");
    }
    if (!receipt.committed) {
      throw new QualificationBrokerDeniedError(receipt.code, receipt.reason);
    }
    this.verifyEnvelope(receipt.envelope);
    assertCommittedEnvelope(request, receipt);

    const committedHead = activationEnvelopeDigest(receipt.envelope);
    const snapshot = this.activation.read();
    if (snapshot.state !== "qualification_only"
      || !snapshot.rightsCurrent
      || snapshot.generation !== request.expectedGeneration
      || snapshot.releaseDigest !== request.expectedReleaseDigest
      || snapshot.surfaceDigest !== request.expectedSurfaceDigest
      || snapshot.activationHeadSha256 !== committedHead) {
      throw new Error("Qualification broker commit is not the verified anchored runtime head");
    }
    return receipt;
  }
}
