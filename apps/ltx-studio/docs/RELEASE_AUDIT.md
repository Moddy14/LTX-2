# Release Evidence, Qualification Resolution, and Promotion

The production contract is a staged, fail-closed chain:

1. verify the installed release and externally attested RuntimeTrust;
2. validate the signed Security Audit as evidence;
3. resolve the immutable manifest HOLD with separately signed Qualification v2 artifacts;
4. collect Release Evidence v3;
5. consume an independently signed Release Authorization v4;
6. create a separately signed Final Audit v4; and
7. prepare, but do not execute, a production-promotion request.

No passing phase report, CLI exit status, or locally created fixture is Product-GO.
The manifest is never rewritten. Legacy v1 evidence and v3 authorization files
are not accepted by the current v3/v4 commands and cannot be promoted through
this chain.

## Trust boundaries and current HOLD

Every non-static command first verifies the immutable release root, runtime
seal, full runtime tree, Host-TCB and externally supplied RuntimeTrust v2. It
then requires an attested authority-isolation mechanism:

- `separate-studio-identity-proc-fd-isolation`; or
- `external-signer-sealed-fd-broker` with the exact broker attestation digest.

`same-local-uid` is always HOLD. The authority decision is made before a
release-contained dynamic module or an evidence/control artifact is read. A
caller-supplied bag of runtime digests is never release authority. RuntimeTrust
binds the exact runtime seal, tree, policy, Node executable, Host-TCB,
Build-TCB, service policy and independently pinned trust policies.

The external evidence directory must be a real, non-symlinked directory with
no group/world write permission. JSON is canonical, bounded and read through
no-follow, path-confined file operations. Detached signatures are Ed25519 and
are checked against current, unrevoked, role-specific keys with exclusive
expiry (`now < expiresAt` and `now < key.notAfter`).

The release trust policy separates the evidence-producer,
release-authorizer and audit-finalizer roles. Qualification Resolution uses a
second policy pinned by RuntimeTrust and exactly three distinct keys and key
materials:

- `build-authority-attestor`;
- `authority-isolation-attestor`; and
- `qualification-resolver`.

The repository provides the verifier and CLI chain, not the real external
authorities or their production attestations. In particular, the external
finalizer trust domain and privileged ActivationWriter/bootstrap consumer are
not supplied by candidate code. Until those external components and all real
release-bound evidence exist, the operational result remains **HOLD** even
when development fixtures pass.

Candidate-owned scripts must never be invoked through `sudo`. Installation,
Host-TCB attestation, final signing, journal append/signing, and anchor mutation
belong to separately provisioned authorities described in
`ROOT_BOOTSTRAP_TRUST_CEREMONY.md`. `install-release.mjs` is not a promotion
entrypoint and the promotion-preparation command performs no system mutation.

## Immutable manifest HOLD and Qualification Resolution v2

The v4 manifest keeps its original `qualification.releaseDecision: "hold"`
and its exact blocker list. A signed
`ltx-studio-qualification-resolution.v2` may discharge only the statically
allowlisted blocker/evidence matrix. It binds:

- the exact release digest and release-surface digest;
- the hash of the unchanged manifest qualification object;
- the full RuntimeTrust object and Qualification-policy digest;
- separately signed Build-Authority and Authority-Isolation attestations; and
- the exact digests of already verifier-accepted Rights, Security, R3, D1,
  Q0, Q1, and Q2 evidence.

The Build-Authority attestation binds the exact RuntimeTrust Build-TCB and
attests a dedicated external build authority, a read-only source mount, a
separate build UID, and exclusion of transient source/tool swaps. The
Authority-Isolation attestation binds the exact Host-TCB and, for broker mode,
the exact broker attestation digest and mechanism.

Resolution entries and their evidence kinds are complete, sorted, unique and
strictly typed. Missing, duplicate, extra, cross-release, cross-surface,
cross-RuntimeTrust, foreign-host, foreign-broker, foreign-Build-TCB, stale,
future-dated, expired, revoked, role-overlapping, or re-signed swapped evidence
is rejected. Unknown blockers and `longcat-runtime-worktree-dirty` are not
dischargeable. A missing resolution remains exactly HOLD; no synthetic PASS is
generated.

## Canonical artifacts

The operator supplies `evidence-index.v3.json`. There is no implicit v1
fallback. Its strict references cover:

- the RuntimeTrust-bound release trust policy;
- preregistration and current rights attestation;
- the signed Security Audit and every referenced raw scanner artifact;
- exactly one report for each required qualification kind;
- the RuntimeTrust-bound Qualification trust policy;
- signed Build-Authority and Authority-Isolation attestations; and
- the signed Qualification Resolution v2.

The current generated files are:

| Stage | Default artifact |
| --- | --- |
| Index | `evidence-index.v3.json` |
| Collection | `release-evidence.v3.json` |
| External authorization | `release-authorization.v4.json` and `.sig.json` |
| Finalization | `release-audit.v4.json` |
| Promotion preparation | canonical stdout only; no mutation |

All file references and their detached-signature files are digest-bound by the
index. Collection writes once with mode `0600`; an existing output is never
replaced.

## Operator sequence

Use the scripts from the installed, verified release. `--release-root`
defaults to `/opt/ltx-studio/releases/$RELEASE_DIGEST`. Every example passes
`--index` explicitly to make the v3 contract visible even though v3 is also
the only default.

### 1. Read-only preflight

```bash
npm --silent run audit:preflight -- \
  --release "$RELEASE_DIGEST" \
  --release-root "/opt/ltx-studio/releases/$RELEASE_DIGEST" \
  --evidence-root /secure/ltx-release-evidence \
  --index evidence-index.v3.json \
  --trusted-policy-sha256 "$TRUSTED_POLICY_SHA256"
```

Only `--release` is syntactically required. Omitted external inputs are
reported as `missing`, never fabricated. The canonical
`ltx-studio-release-audit-preflight.v1` result distinguishes
`readyForEvidenceCollection` from `readyForFinalization`. It is read-only and
does not sign or write evidence. Exit status is `0` only when all finalization
inputs are present, `2` while HOLD/blockers remain, and `64` for invalid CLI
syntax.

Preflight authorizes RuntimeTrust immediately after loading the installed
release and before any candidate dynamic import, surface read, or evidence
read. On same-UID/HOLD, none of those later operations is reached.

### 2. Validate Security evidence without claiming GO

The immutable manifest HOLD creates a deliberate staging case: Security
evidence must be verified before its digest can be referenced by Qualification
Resolution. Use the explicit staged mode:

```bash
npm --silent run audit:security -- \
  --mode staged-evidence \
  --release "$RELEASE_DIGEST" \
  --release-root "/opt/ltx-studio/releases/$RELEASE_DIGEST" \
  --evidence-root /secure/ltx-release-evidence \
  --index evidence-index.v3.json \
  --trusted-policy-sha256 "$TRUSTED_POLICY_SHA256"
```

A valid result says only:

```json
{"go":false,"mode":"staged-evidence","verdict":"evidence-valid"}
```

It must never be described as pass, ready, GO, or release authority. The
default `--mode product-go` retains the stricter Product-GO Security contract
and therefore rejects an unresolved manifest HOLD. Both modes re-read and
verify the signed Security Audit, its raw OSV/npm inputs, component coverage,
scanner/rules identities, RuntimeTrust binding, freshness, and exclusive
expiry. Provider errors or incomplete scan responses are rejected.

### 3. Collect Release Evidence v3

After the signed Qualification v2 artifacts and every referenced evidence file
are present:

```bash
npm --silent run audit:release -- \
  --release "$RELEASE_DIGEST" \
  --release-root "/opt/ltx-studio/releases/$RELEASE_DIGEST" \
  --evidence-root /secure/ltx-release-evidence \
  --index evidence-index.v3.json \
  --trusted-policy-sha256 "$TRUSTED_POLICY_SHA256" \
  --output release-evidence.v3.json
```

The collector re-verifies every signature, current validity window, role
separation, raw Security artifact, blocker/evidence mapping, release/surface/
RuntimeTrust/Host/Build/Broker binding, Rights evidence, phase coverage and Q2
claim result. Success writes `ltx-studio-release-evidence.v3` with an empty
blocker list and `ready_for_release_authorization: true`. That field authorizes
only the next external signing step; the document intentionally has no GO
field.

### 4. Obtain Release Authorization v4 externally

There is intentionally no candidate command that creates the authorization.
An independent `release-authorizer` signs strict
`ltx-studio-release-authorization.v4`. It binds the activation generation,
release and surface, all four runtime-identity digests, full RuntimeTrust,
manifest qualification hash, Qualification policy/attestation/resolution
digests, preregistration, Q2 report, Release Evidence, Rights, Security Audit,
sorted released surface IDs, and an exclusive validity window.

The authorizer key must be current, unrevoked, and distinct in ID and key
material from evidence producers, the Qualification resolver/attestors, and
the finalizer.

### 5. Finalize v4

```bash
npm --silent run audit:finalize -- \
  --release "$RELEASE_DIGEST" \
  --release-root "/opt/ltx-studio/releases/$RELEASE_DIGEST" \
  --evidence-root /secure/ltx-release-evidence \
  --index evidence-index.v3.json \
  --trusted-policy-sha256 "$TRUSTED_POLICY_SHA256" \
  --evidence release-evidence.v3.json \
  --authorization release-authorization.v4.json \
  --authorization-signature release-authorization.v4.sig.json \
  --finalizer-key-id "$FINALIZER_KEY_ID" \
  --finalizer-private-key /secure/operator/audit-finalizer.pk8.pem \
  --output release-audit.v4.json
```

The private key must be an owner-only regular file with mode `0600`. The
finalizer revalidates RuntimeTrust, Security raw evidence, Rights, the complete
Qualification Resolution chain, Authorization v4, freshness, revocation and
role separation at finalization time. It writes the Final Audit v4 once or
writes nothing. A successful development invocation does not replace the
missing separately pinned external finalizer trust domain.

### 6. Prepare production promotion (read-only HOLD)

```bash
npm --silent run audit:promotion -- \
  --release "$RELEASE_DIGEST" \
  --release-root "/opt/ltx-studio/releases/$RELEASE_DIGEST" \
  --evidence-root /secure/ltx-release-evidence \
  --index evidence-index.v3.json \
  --trusted-policy-sha256 "$TRUSTED_POLICY_SHA256" \
  --evidence release-evidence.v3.json \
  --authorization release-authorization.v4.json \
  --authorization-signature release-authorization.v4.sig.json \
  --audit release-audit.v4.json \
  --activation-control-root /secure/ltx-activation-control
```

This command derives candidate surface IDs only from the verified manifest
surface. It revalidates the full promotion bundle, current signed
`qualification_only` activation journal, every journal signature, the exact
external head anchor, RuntimeTrust-pinned activation policy, RuntimeTrust-
pinned Rights policy, and the current signed Runtime-Rights snapshot.

It never calls `validateReleasePromotion`, because that verifier requires an
already consumed promotion record and belongs after mutation. It never appends,
signs, anchors, installs, enables, or starts anything. Even a verified result
uses:

```json
{
  "schemaVersion":"ltx-studio-promotion-authorization-request.v1",
  "status":"hold-external-activation-writer-required",
  "mutationPerformed":false
}
```

and exits with status `2`. This is an informational, pre-mutation request, not
an authorization and not GO.

The separately attested ActivationWriter/bootstrap consumer must independently
reverify the bundle and current control state, perform an expected-head CAS,
append/sign the production record, atomically advance the external anchor, and
reread and validate the resulting journal before any production mutation.
Because that privileged trust-domain consumer is not implemented here, real
promotion remains HOLD.
