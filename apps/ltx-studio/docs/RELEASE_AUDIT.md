# Release Evidence and Finalization

The release audit is deliberately split into two commands. Neither a passing
qualification report nor the evidence collector may publish Product-GO or a
SOTA claim.

## Root of trust

Both commands require `--trusted-policy-sha256`. This digest is supplied by
the operator or immutable service configuration; it must not be learned only
from the evidence directory. The referenced canonical
`ltx-studio-trusted-keys.v1` policy uses Ed25519 keys with time windows,
revocation state, and narrowly scoped roles. A release-authorizer key is not
allowed to hold the audit-finalizer role.

The evidence directory must be a real directory without group/world write
access. Every JSON input is canonical, bounded, non-symlinked, digest-bound,
and signed. The finalizer private key is external to the release and must be an
owner-only regular file with mode `0600`.

## Evidence collection

Run the copy of the command contained in the immutable release:

```bash
npm run audit:release -- \
  --release "$RELEASE_DIGEST" \
  --evidence-root /secure/ltx-release-evidence \
  --trusted-policy-sha256 "$TRUSTED_POLICY_SHA256"
```

`evidence-index.v1.json` binds the frozen preregistration, current rights
attestation, trust policy, and exactly one signed report for each of R0, R1,
the three R3 classes, D1, Q0, Q1, and Q2. Reports may confirm only gates owned
by their phase. Every applicable gate of every candidate surface entry must
be covered, Q2 must contain a result for every candidate claim, and every
non-empty frozen target claim must be `sota-qualified` against a bound external
anchor.

Success writes `release-evidence.v1.json` once with mode `0600` and
`ready_for_release_authorization=true`. It contains no `go` field.

## Finalization

After a separate release authorizer signs
`ltx-studio-release-authorization.v1`, run:

```bash
npm run audit:finalize -- \
  --release "$RELEASE_DIGEST" \
  --evidence-root /secure/ltx-release-evidence \
  --trusted-policy-sha256 "$TRUSTED_POLICY_SHA256" \
  --authorization release-authorization.v1.json \
  --authorization-signature release-authorization.v1.sig.json \
  --finalizer-key-id "$FINALIZER_KEY_ID" \
  --finalizer-private-key /secure/operator/audit-finalizer.pk8.pem
```

The authorization binds the release, preregistration, Q2 report, evidence
package, and rights-attestation digests. At the actual finalization instant,
the command re-verifies the release tree, rights validity, authorization
validity, trusted keys, revocation state, and key-role separation. Only then
does it write the signed `ltx-studio-release-audit.v1` envelope containing
`production_overall=go` and `sota_overall=go`. Every failure exits without
creating or replacing an audit file.
