import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const authorityIsolationSchema = z.discriminatedUnion("status", [
  z.object({
    schemaVersion: z.literal("ltx-studio-authority-isolation.v1"),
    status: z.literal("hold"),
    mechanism: z.literal("same-local-uid"),
    attestationSha256: z.null(),
    reasonCode: z.literal("same-uid-authority-not-authentic"),
  }).strict(),
  z.discriminatedUnion("mechanism", [
    z.object({
      schemaVersion: z.literal("ltx-studio-authority-isolation.v1"),
      status: z.literal("attested"),
      mechanism: z.literal("separate-studio-identity-proc-fd-isolation"),
      hostTcbAttestationSha256: sha256Schema,
      brokerAttestationSha256: z.null(),
      reasonCode: z.null(),
    }).strict(),
    z.object({
      schemaVersion: z.literal("ltx-studio-authority-isolation.v1"),
      status: z.literal("attested"),
      mechanism: z.literal("external-signer-sealed-fd-broker"),
      hostTcbAttestationSha256: sha256Schema,
      brokerAttestationSha256: sha256Schema,
      reasonCode: z.null(),
    }).strict(),
  ]),
]);

export type AuthorityIsolation = z.infer<typeof authorityIsolationSchema>;

/**
 * The parts of a production identity that live outside the immutable release
 * tree.  Keeping this as one strict object prevents an authorization from
 * accidentally binding only the in-release runtime seal while omitting the
 * host, service or build trust anchors.
 */
export const runtimeTrustBindingSchema = z.object({
  schemaVersion: z.literal("ltx-studio-runtime-trust-binding.v2"),
  hostTcbAttestationSha256: sha256Schema,
  hostTcbContractSha256: sha256Schema,
  servicePolicySha256: sha256Schema,
  buildTcbSha256: sha256Schema,
  authorityIsolation: authorityIsolationSchema,
  trustPolicyDigests: z.object({
    release: sha256Schema,
    activationWriter: sha256Schema,
    qualificationAuthorizer: sha256Schema,
    runtimeRights: sha256Schema,
    bootstrapAuthority: sha256Schema,
  }).strict(),
}).strict().superRefine((runtimeTrust, context) => {
  if (runtimeTrust.authorityIsolation.status === "attested"
    && runtimeTrust.authorityIsolation.hostTcbAttestationSha256
      !== runtimeTrust.hostTcbAttestationSha256) {
    context.addIssue({
      code: "custom",
      path: ["authorityIsolation", "hostTcbAttestationSha256"],
      message: "authority isolation must be attested by the exact pinned Host-TCB record",
    });
  }
});

export type RuntimeTrustBinding = z.infer<typeof runtimeTrustBindingSchema>;

export function assertRuntimeTrustAuthorizesRelease(
  value: unknown,
  context = "Release",
): RuntimeTrustBinding {
  const runtimeTrust = runtimeTrustBindingSchema.parse(value);
  if (runtimeTrust.authorityIsolation.status !== "attested") {
    throw new Error(
      `${context} blocked: same-local-UID execution/publication authority is not authentic; `
      + "a separately attested Studio identity with proc/fd isolation or an external signer/sealed-FD broker is required",
    );
  }
  return runtimeTrust;
}

export const runtimeIdentityBindingSchema = z.object({
  releaseDigest: sha256Schema,
  surfaceDigest: sha256Schema,
  runtimeInstallSealSha256: sha256Schema,
  runtimeTreeSha256: sha256Schema,
  runtimePolicySha256: sha256Schema,
  nodeExecutableSha256: sha256Schema,
  runtimeTrust: runtimeTrustBindingSchema,
}).strict();

export type RuntimeIdentityBinding = z.infer<typeof runtimeIdentityBindingSchema>;
