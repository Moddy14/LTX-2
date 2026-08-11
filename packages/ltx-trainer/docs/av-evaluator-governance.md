# AV Evaluator Dataset Governance

The owned phoneme/viseme evaluator must not train on media whose rights,
identity boundaries, or relationship to the sealed holdout are ambiguous.
`ltx_trainer.av_eval.freeze_dataset` is the fail-closed development boundary
between source material and evaluator training. It is not yet a Product-GO
authority.

## Inputs

The freeze command accepts four versioned inputs:

- a JSONL sample manifest using `ltx-av-eval-sample.v1`;
- a JSONL rights ledger using `ltx-av-eval-rights.v1`;
- the Studio viseme map `ltx-studio-viseme-mapping.v1`;
- a preregistration using `ltx-av-eval-preregistration.v2`.

Every sample binds the original media plus actual decoded-audio, mouth-frame,
and perceptual-fingerprint artifacts by SHA-256, a human-verified phoneme
timeline, all source/identity grouping keys, and its rights bundle. The v2
preprocessor contract is executable rather than extension-based:

- the pinned DGX `/usr/bin/ffprobe` must decode exactly one video and one audio
  stream with the declared duration, exact frame count, and a CFR-consistent
  timestamp delta for every video frame;
- the pinned DGX `/usr/bin/ffmpeg` must reproduce byte-for-byte the submitted
  mono PCM16/16 kHz WAV payload from that source;
- mouth input is a single `frames.npy` tensor in NPZ, with shape
  `[duration * fps, 96, 96, 3]` and `uint8` RGB values;
- the perceptual fingerprint is a finite, L2-normalized little-endian float32
  vector with exactly 256 elements.

The hashes of both media binaries and the preprocessor version are bound into
the freeze. A timeline binds the decoded WAV hash and annotation-guideline
version, must be independently annotated, verified, and adjudicated by three
different IDs, use only known German/English phones, contain plausible speech
intervals, and cover the complete 2-to-5-second sample without gaps or
overlap. In-domain samples must record measured maximum yaw, mouth visibility,
speaker count, music presence, and cut count; the freeze rejects evidence
outside the registered claim domain. These labels remain development evidence,
not a Product-GO attestation. Product remains hard-blocked until the independent
signed measurement and blind-scoring path exists.

Every rights bundle must explicitly allow training, feature extraction,
face/voice biometric processing, derived weights, commercial use, and
redistribution. Adult status, legal approval, evidence hash, validity,
revocation, DPIA/DPA, and processor records are mandatory. Missing, expired,
revoked, symlinked, or modified evidence rejects the complete freeze.

## Leakage Boundary

The splitter forms transitive components across:

- voice speaker and face identity;
- source asset, collection, and recording session;
- utterance and derivative group;
- rights source and rights bundle;
- exact media, decoded-audio, mouth-frame, and perceptual-feature hashes;
- mandatory perceptual duplicate and parent-sample links.

A component is assigned as a whole. In-domain and OOD samples may not share a
component. OOD samples are isolated in `ood-test`; they never enter training.
The assignment is deterministic for the cryptographically preregistered split
seed and independent of manifest row order. The reviewed preregistration's
canonical SHA-256 is compiled into the governance module; a caller-supplied
lookalike document is rejected before seed comparison. The actual seed is not
stored in Git or accepted as a CLI argument. The CLI reads it from an
owner-only, non-symlink file with mode `0600`.

## Product Freeze

The checked-in preregistration remains `draft`. It already binds the five
leakage-disjoint roles `train`, `tune`, `design-pilot`, `calibration`, and
`test`, plus three generation seeds, model family, selection metric,
calibration method, FAR/FRR operating point, MOS gates, and the native LTX,
LongCat, and Wan2.2-S2V comparator arms. Model recipe, initial weights,
training/evaluation runner, search space, prompt set, rating protocol, and
baseline matrix remain null until concrete artifacts exist. `frozen` rejects
every missing hash or unpinned comparator revision.

Dataset freeze, holdout evaluation, and product release are separate
authorities. After F0, an independent role may issue a detached Ed25519
`evaluation_authorization` bound to the exact release, preregistration,
holdout, Q2 runner, transaction, nonce, and start/completion window. The Q2
runner persists owner-only, write-once `started -> consumed` records before
and at first holdout disclosure. Only after Q2 may a distinct release role
issue a `release_authorization` bound to the Q2 report and release evidence.
Neither authorization is embedded in, or allowed to change, the frozen
preregistration.

The draft keeps `target_sota_claim_ids` empty. F0 must replace it with a
sorted, non-empty set before `status=frozen`; removing a target after that
requires a new preregistration and a disjoint holdout. This prevents an empty
claim set from satisfying the SOTA gate vacuously.

## D0a design pilot

`configs/av_eval/design-pilot.v1.json` is the machine-readable pre-acquisition
contract for effect sizes, VBench gates, precision targets, power, and quoted
strata. It intentionally remains `draft`: empirical design-effect,
repeatability, clinically/perceptually meaningful deltas, VBench commit and
configuration, per-endpoint alternatives/CI widths, and quota counts are
`null`. They must come from the leakage-disjoint design pilot; filling them
from calibration or holdout results is forbidden.

```bash
uv run python scripts/av_eval.py design-check \
  --design configs/av_eval/design-pilot.v1.json
```

The checked-in draft exits with code 2 and a deterministic `hold` report that
lists every missing input. A `frozen` document rejects any missing delta,
basis-evidence digest, VBench gate, power input, or stratum quota. A complete
document computes independent-unit and clip requirements with family-wise
alpha 0.05, conservative per-endpoint planning alpha, at least 90% power, the
pilot design effect, and the larger of the calculated requirement or 30 adult
identities. Delta-, VBench-, quota-, and complete-design hashes are emitted
separately so downstream D1/Q0/Q1/F0/Q2 evidence can bind them without changing
the gates after results are visible.

`profile=product` is currently hard-blocked before dataset access. The
detached-signature verifier, monotonic consumption records, sealed-directory
inspector, signed hash-chained access ledger, and machine-validated
tune/holdout report schema now exist. Access events accept only a current
`holdout-scorer` key, bind the authorization, holdout, transaction, actor UID,
action and timestamp, and are appended under an exclusive lock with `fsync`.
Every later read revalidates canonical JSON, sequence, signatures, event IDs,
and the complete SHA-256 chain. Measurement reports bind dataset,
preregistration, release (holdout only), D0a design, runner, evaluator,
thresholds and strata; their overall verdict is recomputed from the registered
direction and confidence bound of every sorted metric.

The Product-HOLD remains correct until an operator provisions a separate
blind-scorer UID/GID, owner-only `0700` holdout and log roots, an externally
anchored trusted-key policy, current rights evidence, and a real independent
runner using these interfaces. A development UID may never own the sealed
root. The former numeric holdout checks remain defense in depth, not an active
certification path.

## Command

Run from `packages/ltx-trainer` in its managed environment:

```bash
uv run python scripts/av_eval.py freeze \
  --manifest /secure/dataset/manifest.jsonl \
  --rights /secure/dataset/rights.jsonl \
  --mapping ../../apps/ltx-studio/evaluators/phoneme-viseme/viseme-mapping.v1.json \
  --preregistration configs/av_eval/preregistration.v2.json \
  --output-root /secure/freezes \
  --split-seed-file ~/.config/ltx-studio/av-eval-split-seed \
  --profile development
```

The output directory is content-addressed by normalized validated records,
rights, mapping, the sealed preregistration, split-seed commitment,
assignments, snapshots, artifact hashes, pinned media tools, and governance
code. Source-root paths and wall-clock time do not enter the ID, so identical
bytes at another root produce the same freeze.

Every media, derived, timeline, and rights-evidence byte is copied into
`objects/sha256/<prefix>/<digest>` before the staging directory is atomically
renamed. Snapshots and split documents point only at these CAS objects.
Reusing a freeze re-hashes all CAS objects and verifies every split and
snapshot. Training code opens one reusable `open_frozen_dataset()` session per
run. Session construction validates the content-addressed core, every snapshot,
the complete split assignment, CAS paths, and current rights attestation once;
`session.load_split()` binds the loaded members exactly to `core.assignments`.
Each `session.open_artifact()` still verifies the requested object hash on the
same open descriptor before yielding it. The one-shot `load_frozen_split()` and
`open_frozen_artifact()` wrappers remain for diagnostics, not per-sample
training loops.

Rights validity is evaluated only against current UTC system time. The ledger
and every evidence hash are revalidated before attestation; the ledger is read
once more for concurrent changes, temporal validity is checked at completion,
and that completion instant becomes the attestation time. It is not
part of the stable dataset ID: every successful validation writes a separate,
immutable rights attestation under
`attestations/<freeze-id>/<attestation-id>.json`. The public artifact loader
requires an attestation no older than five minutes, so training must begin
through a fresh successful governance check; a current revocation prevents a
new attestation. Filesystem modes are a local accident guard, not an
authorization boundary. The sealed test root still requires separate OS ACLs,
access logging, and backup policy.
