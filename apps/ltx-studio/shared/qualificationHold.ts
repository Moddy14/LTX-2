import { isLegacyDfrRequest, type GenerationRequest } from "./pipelines.js";

export const DFR_QUALIFICATION_HOLD_CODE = "dfr-v1.3-qualification-hold" as const;
export const DFR_LEGACY_EXECUTION_HOLD_CODE = "dfr-pre-v1.3-read-only" as const;
export const DFR_QUALIFICATION_HOLD_REASON =
  "DFR v1.3 bleibt im Qualification-HOLD, bis Peak-Speicher, Cold-Canary, "
  + "Dauerhaltbarkeit und disjunkter Qualitäts-Holdout unabhängig verifiziert sind. "
  + "Der Request darf weder lokal noch über die DGX-Queue gestartet werden.";

export type QualificationHold = Readonly<{
  code: typeof DFR_QUALIFICATION_HOLD_CODE | typeof DFR_LEGACY_EXECUTION_HOLD_CODE;
  mode: "dfr";
  reason: string;
}>;

const DFR_QUALIFICATION_HOLD: QualificationHold = Object.freeze({
  code: DFR_QUALIFICATION_HOLD_CODE,
  mode: "dfr",
  reason: DFR_QUALIFICATION_HOLD_REASON,
});

const DFR_LEGACY_EXECUTION_HOLD: QualificationHold = Object.freeze({
  code: DFR_LEGACY_EXECUTION_HOLD_CODE,
  mode: "dfr",
  reason: "Historischer DFR-Altbestand vor v1.3.0 ist unveränderlich lesbar, aber nicht ausführbar. "
    + "Für einen neuen Lauf muss DFR ausdrücklich mit dem aktuellen Vertrag neu konfiguriert werden.",
});

/**
 * Pure, request-derived product-start policy.
 *
 * Deliberately no request boolean can clear this hold. A future release must
 * replace the policy only after independently verified, server-owned
 * qualification evidence exists; user input and model-file presence are not
 * qualification authority.
 */
export function qualificationHoldForRequest(
  request: Pick<GenerationRequest, "mode" | "legacyExecution">,
): QualificationHold | null {
  if (request.mode !== "dfr") return null;
  return isLegacyDfrRequest(request) ? DFR_LEGACY_EXECUTION_HOLD : DFR_QUALIFICATION_HOLD;
}
