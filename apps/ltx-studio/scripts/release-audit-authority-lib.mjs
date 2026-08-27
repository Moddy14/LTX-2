export function assertStaticRuntimeAuthority(runtimeTrust, context = "Release operation") {
  if (!runtimeTrust || typeof runtimeTrust !== "object"
    || runtimeTrust.schemaVersion !== "ltx-studio-runtime-trust-binding.v2"
    || !runtimeTrust.authorityIsolation
    || runtimeTrust.authorityIsolation.status !== "attested"
    || ![
      "separate-studio-identity-proc-fd-isolation",
      "external-signer-sealed-fd-broker",
    ].includes(runtimeTrust.authorityIsolation.mechanism)) {
    throw new Error(
      `${context} blocked: same-local-UID execution/publication authority is not authentic`,
    );
  }
}
