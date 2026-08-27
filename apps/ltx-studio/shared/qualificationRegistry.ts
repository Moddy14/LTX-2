import { z } from "zod";

import {
  qualificationAuthorizationDigest,
  validateActivationJournal,
  verifySignedQualificationAuthorization,
  type ActivationJournalEnvelope,
  type QualificationAuthorization,
  type QualificationAuthorizerTrustPolicy,
  type QualificationRunTicket,
  type QualificationTicketState,
  type SignedQualificationAuthorization,
} from "./activation.js";
import { canonicalJson } from "./canonicalJson.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/);

export const qualificationTicketCheckpoints = [
  "queue_accept",
  "supervisor_arm",
  "writer_start",
  "runner_exec",
  "heartbeat",
  "segment_boundary",
  "output_release",
] as const;
export type QualificationTicketCheckpoint = (typeof qualificationTicketCheckpoints)[number];

export const qualificationTicketClaimSchema = z.object({
  authorizationDigest: sha256Schema,
  authorizationId: identifierSchema,
  authorizationNonce: z.string().regex(/^[a-f0-9]{32,128}$/),
  ticketId: identifierSchema,
  ticketNonce: z.string().regex(/^[a-f0-9]{32,128}$/),
  purposeId: identifierSchema,
  phaseId: identifierSchema,
  matrixDigest: sha256Schema,
  surfaceEntryId: identifierSchema,
  inputDigest: sha256Schema,
  seed: z.number().int().nonnegative(),
}).strict();

export type QualificationTicketClaim = z.infer<typeof qualificationTicketClaimSchema>;

export type QualificationTicketInspection = {
  allowed: boolean;
  reason: string;
  state: QualificationTicketState;
  checkpoint: QualificationTicketCheckpoint;
  authorizationDigest: string;
  authorizationId: string;
  ticketId: string;
  budget: QualificationRunTicket["budget"];
  completeBy: string;
};

type CatalogEntry = {
  authorization: QualificationAuthorization;
  digest: string;
  tickets: Map<string, QualificationRunTicket>;
};

type TicketJournalState = {
  authorizationDigest: string;
  state: Exclude<QualificationTicketState, "pending">;
};

const expectedState: Record<QualificationTicketCheckpoint, QualificationTicketState> = {
  queue_accept: "pending",
  supervisor_arm: "accepted",
  writer_start: "armed",
  runner_exec: "started",
  heartbeat: "started",
  segment_boundary: "started",
  output_release: "started",
};

function deny(
  claim: QualificationTicketClaim,
  checkpoint: QualificationTicketCheckpoint,
  state: QualificationTicketState,
  authorization: QualificationAuthorization,
  ticket: QualificationRunTicket,
  reason: string,
): QualificationTicketInspection {
  return {
    allowed: false,
    reason,
    state,
    checkpoint,
    authorizationDigest: claim.authorizationDigest,
    authorizationId: authorization.authorizationId,
    ticketId: ticket.ticketId,
    budget: ticket.budget,
    completeBy: authorization.completeBy,
  };
}

function validateRegistrationBinding(
  journal: ActivationJournalEnvelope[],
  authorization: QualificationAuthorization,
  digest: string,
): void {
  const head = journal.at(-1)!.record;
  const registrations = journal.filter(({ record }) =>
    record.operation === "register_qualification_authorization"
    && record.generation === head.generation
    && record.authorizationDigest === digest);
  if (registrations.length !== 1) {
    throw new Error(`Qualification authorization ${digest} is not registered exactly once`);
  }
  const registration = registrations[0].record;
  if (registration.generation !== authorization.generation
    || registration.generation !== head.generation
    || canonicalJson(registration.release) !== canonicalJson(authorization.release)
    || canonicalJson(registration.release) !== canonicalJson(head.release)) {
    throw new Error(`Qualification authorization ${digest} registration binding mismatch`);
  }
}

function buildCatalog(options: {
  journal: ActivationJournalEnvelope[];
  signedAuthorizations: readonly SignedQualificationAuthorization[] | readonly unknown[];
  trustPolicy: QualificationAuthorizerTrustPolicy | unknown;
  now: Date;
}): { authorizations: Map<string, CatalogEntry>; ticketStates: Map<string, TicketJournalState> } {
  const authorizations = new Map<string, CatalogEntry>();
  const ticketOwners = new Map<string, string>();
  for (const rawSigned of options.signedAuthorizations) {
    const signed = verifySignedQualificationAuthorization({
      signed: rawSigned,
      trustPolicy: options.trustPolicy,
      now: options.now,
      enforceAuthorizationWindow: false,
    });
    if (signed.document.schemaVersion !== "qualification-authorization.v3") {
      throw new Error("Qualification mode authorization cannot appear in the run authorization catalog");
    }
    const authorization = signed.document;
    const digest = qualificationAuthorizationDigest(authorization);
    if (authorizations.has(digest)) {
      throw new Error(`Qualification authorization ${digest} appears more than once in the catalog`);
    }
    validateRegistrationBinding(options.journal, authorization, digest);
    const tickets = new Map<string, QualificationRunTicket>();
    for (const ticket of authorization.runTickets) {
      const previousOwner = ticketOwners.get(ticket.ticketId);
      if (previousOwner) {
        throw new Error(`Qualification ticket ${ticket.ticketId} is ambiguous across ${previousOwner} and ${digest}`);
      }
      ticketOwners.set(ticket.ticketId, digest);
      tickets.set(ticket.ticketId, ticket);
    }
    authorizations.set(digest, { authorization, digest, tickets });
  }

  const registeredDigests = options.journal
    .filter(({ record }) => record.operation === "register_qualification_authorization"
      && record.generation === options.journal.at(-1)!.record.generation)
    .map(({ record }) => record.authorizationDigest!);
  for (const digest of registeredDigests) {
    if (!authorizations.has(digest)) {
      throw new Error(`Registered qualification authorization ${digest} is missing from the verified catalog`);
    }
  }

  const ticketStates = new Map<string, TicketJournalState>();
  for (const { record } of options.journal) {
    if (!record.ticketId || record.generation !== options.journal.at(-1)!.record.generation) continue;
    const entry = authorizations.get(record.authorizationDigest!);
    const ticket = entry?.tickets.get(record.ticketId);
    if (!entry || !ticket) {
      throw new Error(`Journal ticket ${record.ticketId} is not present in its signed authorization`);
    }
    const recordedAt = Date.parse(record.recordedAt);
    if (recordedAt < Date.parse(entry.authorization.notBefore)) {
      throw new Error(`Journal ticket ${record.ticketId} was used before notBefore`);
    }
    if (["accepted", "armed", "started"].includes(record.ticketState!)
      && recordedAt > Date.parse(entry.authorization.startBy)) {
      throw new Error(`Journal ticket ${record.ticketId} crossed startBy before runner start`);
    }
    if (record.ticketTerminal?.outcome === "completed"
      && recordedAt > Date.parse(entry.authorization.completeBy)) {
      throw new Error(`Journal ticket ${record.ticketId} completed after completeBy`);
    }
    ticketStates.set(record.ticketId, {
      authorizationDigest: entry.digest,
      state: record.ticketState as Exclude<QualificationTicketState, "pending">,
    });
  }
  return { authorizations, ticketStates };
}

export function inspectQualificationTicket(options: {
  journal: unknown;
  signedAuthorizations: readonly unknown[];
  trustPolicy: unknown;
  claim: unknown;
  checkpoint: QualificationTicketCheckpoint;
  now: Date;
}): QualificationTicketInspection {
  const journal = validateActivationJournal(options.journal);
  const head = journal.at(-1)!.record;
  if (head.state !== "qualification_only") {
    throw new Error("Qualification ticket inspection is unavailable outside qualification_only");
  }
  const claim = qualificationTicketClaimSchema.parse(options.claim);
  const catalog = buildCatalog({
    journal,
    signedAuthorizations: options.signedAuthorizations,
    trustPolicy: options.trustPolicy,
    now: options.now,
  });
  const entry = catalog.authorizations.get(claim.authorizationDigest);
  if (!entry) throw new Error("Qualification ticket authorization is absent from the verified catalog");
  const ticket = entry.tickets.get(claim.ticketId);
  if (!ticket) throw new Error("Qualification ticket is absent from the signed authorization");
  const state = catalog.ticketStates.get(ticket.ticketId)?.state ?? "pending";
  const expected = expectedState[options.checkpoint];
  if (state !== expected) {
    return deny(claim, options.checkpoint, state, entry.authorization, ticket,
      `Qualification ticket state ${state} cannot pass ${options.checkpoint}; expected ${expected}`);
  }

  const bindingMatches = claim.authorizationId === entry.authorization.authorizationId
    && claim.authorizationNonce === entry.authorization.nonce
    && claim.ticketNonce === ticket.nonce
    && claim.purposeId === entry.authorization.purposeId
    && claim.phaseId === entry.authorization.phaseId
    && claim.matrixDigest === entry.authorization.matrixDigest
    && claim.surfaceEntryId === ticket.surfaceEntryId
    && claim.inputDigest === ticket.inputDigest
    && claim.seed === ticket.seed;
  if (!bindingMatches) {
    return deny(claim, options.checkpoint, state, entry.authorization, ticket,
      "Qualification ticket claim does not match its signed authorization");
  }

  const nowMs = options.now.getTime();
  if (nowMs < Date.parse(entry.authorization.notBefore)) {
    return deny(claim, options.checkpoint, state, entry.authorization, ticket,
      "Qualification authorization is not active yet");
  }
  if (["queue_accept", "supervisor_arm", "writer_start", "runner_exec"].includes(options.checkpoint)
    && nowMs > Date.parse(entry.authorization.startBy)) {
    return deny(claim, options.checkpoint, state, entry.authorization, ticket,
      "Qualification ticket missed startBy");
  }
  if (nowMs > Date.parse(entry.authorization.completeBy)) {
    return deny(claim, options.checkpoint, state, entry.authorization, ticket,
      "Qualification ticket exceeded completeBy");
  }

  return {
    allowed: true,
    reason: `Qualification ticket is authorized for ${options.checkpoint}`,
    state,
    checkpoint: options.checkpoint,
    authorizationDigest: entry.digest,
    authorizationId: entry.authorization.authorizationId,
    ticketId: ticket.ticketId,
    budget: ticket.budget,
    completeBy: entry.authorization.completeBy,
  };
}
