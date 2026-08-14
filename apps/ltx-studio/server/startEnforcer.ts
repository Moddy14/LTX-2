export const jobStartSources = ["direct", "project", "experiment", "rerun", "restored"] as const;

export type JobStartSource = (typeof jobStartSources)[number];

export type JobStartContext = {
  requestSha256: string;
  source: JobStartSource;
};

export type JobStartDecision = {
  allowed: boolean;
  mode: "development" | "blocked";
  reason: string;
  schemaVersion: "ltx-studio-bootstrap-start-enforcer.v1";
};

export type JobStartEnforcer = {
  decide(context: JobStartContext): JobStartDecision;
};

const DEVELOPMENT_REASON = "Unversiegelter Entwicklungsmodus; Release-Autorisierung ist nicht anwendbar.";
const BLOCKED_REASON = "Versiegelter Release ist fail-closed: Es ist noch kein signierter Activation-State aktiv.";

export function bootstrapJobStartEnforcer(sealedRelease: boolean): JobStartEnforcer {
  return {
    decide: () => ({
      allowed: !sealedRelease,
      mode: sealedRelease ? "blocked" : "development",
      reason: sealedRelease ? BLOCKED_REASON : DEVELOPMENT_REASON,
      schemaVersion: "ltx-studio-bootstrap-start-enforcer.v1",
    }),
  };
}
