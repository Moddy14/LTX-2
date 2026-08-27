/* Root must never import or execute a release candidate to attest that candidate. */
if (process.getuid?.() === 0 || process.geteuid?.() === 0) {
  throw new Error("Refusing privileged candidate code: invoke the externally pinned /usr/libexec/ltx-studio root bootstrap directly");
}

const {
  readExternalBootstrapExpectedPinSha256,
  verifyExternalBootstrapAuthority,
} = await import("./bootstrap-authority-lib.mjs");
const expectedPinSha256 = readExternalBootstrapExpectedPinSha256();
let authority;
try {
  authority = verifyExternalBootstrapAuthority({ expectedPinSha256 });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "ltx-studio-candidate-bootstrap-delegation.v1",
    operation: "attest",
    authoritySha256: authority.authoritySha256,
    externalExecutable: "/usr/libexec/ltx-studio/root-bootstrap-v1.mjs",
    status: "hold-external-admin-trust-ceremony-required",
    instruction: "An administrator must invoke the fixed external bootstrap; this candidate never runs sudo or privileged attestation code.",
  })}\n`);
} finally {
  authority?.close();
}
process.exitCode = 2;
