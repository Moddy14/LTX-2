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

`configs/av_eval/design-pilot.v2.json` is the current machine-readable
pre-acquisition contract for effect sizes, VBench gates, precision targets,
power, and quoted strata. Its `candidate_surface` binding enumerates exactly
the 24 unique claims selected by `targetStatus=candidate` plus the
`vbench-i2v` gate, and the validator requires the complete 24-by-6 matrix of
144 claim/dimension gates. It intentionally remains `draft`: empirical design-effect,
repeatability, clinically/perceptually meaningful deltas, per-endpoint
alternatives/CI widths, and quota counts are `null`. The official VBench-I2V
Git revision and canonical source contract are already pinned;
`vbench-runtime-check` verifies the official remote, exact 40-character
revision, 17 relevant file hashes, supported custom-input dimensions, and the
dimension-level invocation before D1 may use a checkout. The entire Git tree
must also have zero tracked or untracked changes, so an uninventoried imported
module cannot override the pinned commit. This source check is not an
installed-runtime or checkpoint fingerprint. Empirical gates must come
from the leakage-disjoint design pilot; filling them from calibration or
holdout results is forbidden.

`design-pilot.v1.json` is retained byte-for-byte as the legacy frozen90
contract: it still means 15 claims, 90 gates, a 193-hypothesis planning family,
and a `ltx-sota-power-report.v1` output. It is not reinterpreted as 144 gates.
Current D1, pilot, Q0, F0 and Q2 consumers require the v2 report and reject
both a v1 report and a relabelled 15/90/193 payload. Existing frozen90 evidence
therefore remains auditable under its original scope but cannot qualify the
expanded Candidate-Surface.

```bash
uv run python scripts/av_eval.py design-check \
  --design configs/av_eval/design-pilot.v2.json \
  --surface ../../apps/ltx-studio/release/candidate-release-surface.v1.json
```

The v2 design producer derives and compares both the full-surface digest and
the complete candidate-plus-`vbench-i2v` projection from that supplied Studio
document. A stored syntactically valid digest, a partial surface, or an
unregistered claim projection is rejected before a D0a report is emitted.

```bash
uv run python scripts/av_eval.py vbench-runtime-check \
  --config configs/av_eval/vbench-i2v-source.v1.json \
  --checkout /path/to/official/VBench
```

`configs/av_eval/vbench-i2v-runtime.v1.json` is the separate installed-runtime
contract. It pins the source-contract digest, Python binary and version, full
normalized distribution inventory, dependency lock, offline-network policy,
the exact import surface and eight required local artifacts: both CLIP
checkpoints, LAION aesthetic head, AMT-S, RAFT-Things, MUSIQ-SPAQ, DINO weights
and the complete local DINO source tree. Files, directories and the runtime
root may not be symlinked or group/world writable; no unexpected file is
accepted. The isolated import smoke hides GPUs, sets the official VBench cache
root and offline flags, then revalidates the complete source and artifact trees
to reject downloads, bytecode or any other mutation.

```bash
uv run python scripts/av_eval.py vbench-environment-check \
  --runtime-config configs/av_eval/vbench-i2v-runtime.v1.json \
  --source-config configs/av_eval/vbench-i2v-source.v1.json \
  --checkout /sealed/vbench/source \
  --runtime-root /sealed/vbench/cache \
  --python /sealed/vbench/venv/bin/python
```

The checked-in runtime stays `draft` and returns `hold`; hashes are never
invented from the shared trainer environment. Only the emitted
`runtime_digest` may fill the calibration catalog's `vbench-runtime`
fingerprint and the D1 observation binding. `complete-d1` additionally requires
the complete verified runtime report, recomputes its fingerprint and binds the
report digest in the final 188-gate D1 report. Matching arbitrary hash strings
in the catalog and observation file are therefore insufficient.

The checked-in draft exits with code 2 and a deterministic `hold` report that
lists every missing input. A `frozen` document rejects any missing delta,
basis-evidence digest, VBench gate, power input, or stratum quota. A complete
document computes independent-unit and clip requirements with family-wise
alpha 0.05, conservative per-endpoint planning alpha, at least 90% power, the
pilot design effect, and the larger of the calculated requirement or 30 adult
identities. Delta-, VBench-, quota-, and complete-design hashes are emitted
separately so downstream D1/Q0/Q1/F0/Q2 evidence can bind them without changing
the gates after results are visible.

## D1 calibration gates

`configs/av_eval/calibration-gates.v2.json` is the current complete
machine-readable gate inventory for calibration. It includes 44 fixed AV,
phoneme/viseme, identity, artifact, ASR, sharpness, calibration and abstention
decisions plus 144 claim-specific VBench measurements from D0a: six dimensions
for every one of the 24 unique VBench-applicable visual Candidate-Surface
claims. The nine post-frozen90 LTX-2.5 claims are now structurally registered,
but all 54 of their absolute minima, relative deltas and basis-evidence digests
remain null. They therefore remain an explicit HOLD until a new disjoint pilot
and review freeze real values; no legacy threshold or sample size is copied.
Names,
numbers and negations have separate 99%-accuracy gates and separate D0a power
endpoints; they may never be hidden in one aggregate. Plan-fixed thresholds are
immutable in the validator. The still-unknown relative sharpness floor and the
new Worst-Stratum Brier/ECE floors remain nullable until independent basis
evidence freezes them. Evaluator fingerprints, D0a/preregistration/VBench bindings and a
basis-evidence hash for every gate remain null in the checked-in draft.

```bash
uv run python scripts/av_eval.py calibration-check \
  --catalog configs/av_eval/calibration-gates.v2.json
```

The draft therefore exits 2 with `hold`. `frozen` rejects missing or extra
metrics, changed plan thresholds, absent evaluator fingerprints, absent basis
evidence, or an unbound upstream catalog. Its output is the exact 188-ID set
that the tune/holdout report validator must cover; a VBench or critical-token
omission cannot be hidden behind the other D1 metrics.

The D0a v2 power report counts each of the 144 VBench gates as two planned
hypotheses (absolute and anchor-relative) and every other registered power
endpoint as one. With 13 non-VBench endpoints this is a 301-hypothesis planning
family, so the conservative planning alpha is `0.05 / 301`, not `0.05 / 19`.
The six VBench power profiles must exactly cover the registered dimensions;
their effect and variability inputs are the conservative worst case across
all claim-specific gates in that dimension. The report exposes the 24-claim,
144-gate and 301-hypothesis counts plus the Candidate-Surface binding digest,
so a downstream freeze cannot silently reuse a pre-expansion sample size.
Because the expanded pilot has not happened, `required_independent_units` and
`required_clips` remain null; no real N is claimed by the checked-in draft.

Every executable D1 scorer binds the same dataset, preregistration, release
candidate and strata-plan digests in both its input and output. This prevents
calibration or output-quality evidence from a previous candidate or a
different quota definition from being reused after an invalidating change.

The `asr-score` command is the executable measurement path for the seven ASR
gate values. Its input contains already case-folded tokens from the pinned
normalizer, human reference-token annotations, leakage-component IDs and the
predeclared WER/critical-token strata. It computes word edits with a
deterministic alignment and 10,000 fixed-seed bootstrap replicates over whole
leakage components. Names, numbers and negations are evaluated separately;
every declared decision stratum needs at least two independent components and
a real denominator.

```bash
uv run python scripts/av_eval.py asr-score \
  --observations /secure/calibration/asr-observations.v1.json
```

The output binds dataset, preregistration, ASR model, normalizer and strata
plan digests. Unnormalized tokens, missing critical annotations, uncovered
strata, pseudoreplicated clips or a changed bootstrap contract reject the
complete measurement.

## Q2 sealed-holdout qualification

`q2-score` is the fail-closed bridge from the frozen evaluator evidence to the
only `q2-holdout` report accepted by the Studio release audit. It verifies the
Studio-canonical F0 candidate, frozen preregistration and independent
evaluation authorization; the trusted-key policy itself must match the F0
digest. The owner-only consumption directory must contain canonical,
write-once `started.json` and `consumed.json` records for the exact
authorization, transaction, nonce and writer, with consumption and report
generation completed before `complete_by`.

For every candidate surface entry the command revalidates a holdout
measurement report against exactly that entry's applicable gates in the
F0-bound D1 catalog. Text-to-audio therefore needs no visual report, while
claim-specific VBench metrics can never be borrowed from another claim. The
F0-bound D0a power report supplies the minimum independent-unit count for every
objective, MOS and relative comparator result. The command reruns the frozen
paired comparator rule with 10,000 leakage-component bootstrap replicates and
global Holm control; ITT failures, unpaired cells, underpowered evidence,
anchor drift or baseline-matrix drift stop the report. Blind MOS is likewise
surface-entry-specific and covers lip sync, identity/mouth naturalness, and
audio quality. All absolute scores require a Holm-corrected lower confidence
bound of at least 9/10; the registered lip-sync and identity/mouth margins must
also pass. Audio quality is an explicit powered endpoint and comparator family,
not an alias for ASR word accuracy.

```bash
uv run python scripts/av_eval.py q2-score \
  --results /sealed/q2/results.json \
  --candidate /sealed/f0/candidate.json \
  --candidate-signature /sealed/f0/candidate.sig.json \
  --preregistration /sealed/f0/preregistration.json \
  --preregistration-signature /sealed/f0/preregistration.sig.json \
  --evaluation-authorization /sealed/f0/evaluation-authorization.json \
  --evaluation-signature /sealed/f0/evaluation-authorization.sig.json \
  --trust-policy /sealed/f0/trusted-keys.json \
  --surface /sealed/f0/candidate-release-surface.json \
  --d1-report /sealed/f0/d1-complete.json \
  --design-report /sealed/f0/d0a-power-report.json \
  --calibration-catalog /sealed/f0/calibration-gates.json \
  --comparator-gates /sealed/f0/comparator-gates.json \
  --comparator-matrix /sealed/f0/comparator-matrix.json \
  --landscape /sealed/f0/anchor-landscape.json \
  --consumption-root /sealed/q2/consumption
```

The command emits a Studio `ltx-studio-qualification-report.v1` only when all
candidate gates pass. Every frozen target claim is `sota-qualified` and binds
the exact external anchor artifact digest; non-target candidates can only be
`local-only`. It never emits production authorization and never opens or
decrypts holdout media itself.

`artifact-score` provides the corresponding D1 path for annotated mouth/skin
events and motion-compensated skin-ring residuals. FAR, FRR and the proportion
of frames under the 0.04 residual limit use 10,000 leakage-component bootstrap
replicates. Overall and Worst-Stratum FAR/FRR are distinct gates; all five
required artifact kinds must be registered FRR strata. Overall residual p95 is
limited to 0.04 and the worst motion/light stratum to 0.06 by the calibration
catalog.

`identity-score` measures the five SFace identity gates from genuine and
impostor similarities at an already frozen threshold. Dataset,
preregistration, SFace model, preprocessing, threshold policy and the fixed
reference gallery are digest-bound. Resampling is by probe leakage component,
and the shared strata-plan digest plus every registered pose, lighting and
Fitzpatrick stratum must independently support both FAR and FRR decisions. TAR
is the exact confidence-bound complement of FRR, not a separately tunable
result.

The offset path is v2 and fail-closed. `offset-calibrate` accepts controls only
when they are derived from a hash-verified dataset freeze and its frozen
`tune` split. Each case ID binds the source sample, replicate, fps, grid point
and explicit correspondence label. Every independent transitive component
must contribute a balanced grid of seven signed offsets at 24, 25 and 30 fps
for both correspondence labels, with exactly one preregistered replicate per
cell. The D0a power report supplies a non-null
`required_independent_units`; fewer tune, calibration or output components are
rejected. Fit and calibration partitions must be disjoint across speaker,
face identity, recording session, source asset, source collection and the
transitive component.

The fit is deterministic isotonic PAVA with equal total weight per transitive
component. Its raw-score threshold, FAR/FRR targets and basis evidence are a
separate frozen operating-point artifact and digest. `offset-observations-build`
then applies that exact model only to the manifest-verified `calibration`
split; generated outputs must come from the separately frozen `test` split.
Fit, calibration and output are pairwise disjoint across voice speaker, face
identity, recording session, source asset, source collection and the complete
transitive leakage component. `offset-score` emits 16 decisions: offset error/within-frame accuracy,
overall and Worst-Stratum correspondence FAR/FRR, Brier, ten-bin ECE,
Worst-Stratum Brier/ECE/within-frame evidence, ID/OOD abstention and output
offset p95. ECE and Brier are explicitly conditional on non-abstained cases;
false in-domain abstention and OOD abstention recall remain separate gates, so
an abstention can neither become probability zero nor disappear. FAR/FRR and
abstention bounds use independent transitive components for Clopper-Pearson,
not the much larger case count. Worst-stratum bounds use one simultaneous
global-component resample for every registered stratum and its max/min
bootstrap distribution, plus Bonferroni-adjusted component-exact
intervals; even zero observed errors retain a positive upper bound. Freeze,
manifest, tune/calibration/test split manifests, the deterministic D0a design
report, evaluator, calibrator, operating point, abstention policy, release and
the exact D0a strata quota plan are digest-bound.

An observation JSON is not a scoring credential. Every scoring invocation
must re-supply the frozen deck and calibrator plus the externally reviewed
dataset-freeze and preregistration digests. The scorer reruns governance,
recomputes the exact D0a report, deterministically refits PAVA, and derives
every probability and the threshold before computing statistics. The offset
CLI additionally refuses symlinks, non-regular files, non-finite JSON and any
input above 256 MiB or 128 structural nesting levels; case, component, stratum
and knot counts are bounded.

The checked-in `preregistration.v2.json` still names the older v1 isotonic
method and remains a draft. It is therefore intentionally unusable for this
path: a reviewed preregistration must first freeze
`speaker-disjoint-component-weighted-isotonic.v2`, then the dataset must be
refrozen so the preregistration snapshot and split manifests receive new
content hashes. Rehashing only the offset deck cannot bypass this HOLD.

```bash
uv run python scripts/av_eval.py offset-calibrate --deck /sealed/d1/offset-fit.v2.json \
  --expected-dataset-digest <externally-reviewed-freeze-sha256> \
  --trusted-preregistration-digest <externally-reviewed-preregistration-sha256> \
  > /sealed/d1/offset-calibrator.v2.json
uv run python scripts/av_eval.py offset-observations-build \
  --deck /sealed/d1/offset-fit.v2.json \
  --calibrator /sealed/d1/offset-calibrator.v2.json \
  --observation-deck /sealed/d1/offset-evaluation.v2.json \
  --expected-dataset-digest <externally-reviewed-freeze-sha256> \
  --trusted-preregistration-digest <externally-reviewed-preregistration-sha256> \
  > /sealed/d1/offset-observations.v2.json
uv run python scripts/av_eval.py offset-score \
  --observations /sealed/d1/offset-observations.v2.json \
  --deck /sealed/d1/offset-fit.v2.json \
  --calibrator /sealed/d1/offset-calibrator.v2.json \
  --expected-dataset-digest <externally-reviewed-freeze-sha256> \
  --trusted-preregistration-digest <externally-reviewed-preregistration-sha256>
```

`content-score` measures the P/B/M content controls without reducing them to
raw frame accuracy. The fixed bilabial-closure/open/rounded/other labels use
macro F1, while annotated boundary changes use a separate transition F1.
Every leakage component in every registered stratum must contain every frame
class plus positive and negative transition controls. Overall and worst-stratum
estimates and lower confidence bounds remain distinct gates.

`sharpness-score` removes the old resolution-dependent raw-value ambiguity.
It accepts only Laplacian variance measured after the fingerprinted alignment
policy has produced a fixed 256×256 grayscale-linear face crop with area
interpolation. Each leakage component contributes its median; the reported
statistic is the p10 across component medians, and the gate uses the lower
bootstrap bound of the worst registered stratum. Its numerical threshold
remains a D1 calibration output with mandatory basis evidence.

`fixed-d1` then assembles exactly one report from each of the six local
scorers. It requires one shared dataset, preregistration, release, strata plan
and bootstrap contract; verifies every evaluator fingerprint against the
ready calibration catalog; rejects missing or extra source metrics; and
recomputes each of the 44 fixed decisions from its registered estimate or
confidence bound. The remaining 144 gates are intentionally not synthesized:
they require the pinned official VBench runtime and Holm-corrected evidence.
The fixed report also propagates the complete offset-v2 design, split,
calibrator, evaluator, abstention-policy, exact bootstrap, uncertainty and grid
contract. `complete-d1` recomputes the supplied frozen D0a report, rebinds the
offset evaluator to the calibration catalog and rejects any changed unit
requirement, quota digest or offset semantics instead of trusting the fixed
report.

`vbench-score` supplies those 144 remaining measurements: six dimensions for
each of the 24 registered visual candidate claims. It validates the
frozen D0a catalog, official repository commit and config, runtime,
comparator-matrix and release bindings. Candidate and anchor scores are paired
within leakage components. Every claim/dimension must clear both its absolute
minimum and its registered noninferiority/superiority margin. The resulting 288
hypotheses share one Holm family; each effect retains its raw interval,
adjusted p-value, rank-specific alpha and one-sided Holm lower bound. A metric
passes only when both corrected lower bounds are positive.

Finally, `complete-d1` revalidates both source reports against the same frozen
D0a design and calibration catalog, verifies all 288 Holm ranks and the pinned
VBench runtime, and emits one sorted 188-gate report. It recomputes every local
estimate/bound decision and both corrected VBench subtests. Mixed releases,
changed strata, duplicate ranks, missing metrics or copied pass labels reject
the complete evidence instead of degrading to a warning.

## D0 readiness package

`configs/av_eval/product-readiness.v1.json` is the fail-closed D0 inventory
that must become complete before the candidate may enter the final freeze. It
binds the dataset, rights, D0a, tune, ACL, access-log and key-policy evidence;
all model, runner, prompt, rating and baseline artifacts; and three distinct
keys for evaluation authorization, blind scoring and release authorization.
It additionally requires an independent scorer UID/GID, a sorted development
UID deny-list, a sealed ACL, a verified but untouched genesis access log, a
current unrevoked rights attestation and a passing tune report.
For any non-empty SOTA target set, F0 also binds the static Studio rights
catalog and requires explicit, non-blocked coverage for the official VBench
evaluator code and weights. A release attestation cannot override a cataloged
noncommercial AMT or IQA-PyTorch/MUSIQ dependency; separate commercial rights
or a newly preregistered benchmark-compatible evaluator are required first.

```bash
uv run python scripts/av_eval.py readiness-check \
  --package configs/av_eval/product-readiness.v1.json
```

The checked-in package is deliberately `draft`, so this command exits 2 and
reports every missing digest or operational fact. `ready-to-freeze` is accepted
only with the exact evidence and artifact inventories, distinct role keys and
no blocker. The resulting hashes are commitments for F0; the report grants no
evaluation or release authority and cannot open the holdout.

## Q0 cross-shot protocol

`configs/av_eval/cross-shot-protocol.v1.json` freezes the paired three-arm
comparison before any render result is visible. The no-reference, manual
sharp scene-reference and automatic scene-reference arms must use identical
dialogue, timeline, duration, normalization, seeds and render revision; only
the reference strategy may differ. Both published LipDub claims,
`native-distilled` and `official-comfy-hq`, are explicit protocol dimensions
and cannot be collapsed into an umbrella result. The identity count is checked
against the complete D0a power report and can never fall below 30, with at
least two shots per identity. The reported render count multiplies identities,
shots, seeds, arms and both claims, so capacity planning cannot silently omit a
dimension.

All three directed comparisons are frozen as well: manual versus no reference,
automatic versus no reference, and automatic versus manual. Each uses the
same registered endpoint family; a result consumer may not drop the manual
comparator or select a more favorable baseline after seeing quality values.

```bash
uv run python scripts/av_eval.py cross-shot-check \
  --protocol configs/av_eval/cross-shot-protocol.v1.json \
  --design-report /secure/design/power-report.v1.json
```

The protocol requires positive Holm-corrected identity superiority plus every
registered noninferiority and absolute quality gate. All ASR critical types,
AV offset, P/B/M, artifact/stability, sharpness, identity, MOS and six VBench
dimensions remain mandatory. Automatic selection stays disabled until it is
noninferior to manual selection; an unclear result is an abstention, never an
implicit win.

`cross-shot-score` consumes the complete claim × identity × shot × seed × arm
factorial. It rejects missing or duplicate cells, enforces exact measurement
coverage, treats render failures by intention-to-treat, clusters paired
differences by leakage component and controls all 36 claim/comparison/endpoint
hypotheses as one Holm family. Automatic reference selection requires passing
both automatic comparisons; otherwise a passing manual-versus-none result
remains the winner, and unresolved claims abstain.

## Q1 comparator matrix

`anchor-landscape.v1.json` records every external candidate found by the
cutoff-dated primary-source search. `comparator-matrix.v1.json` then considers
every one of those candidates separately for native dialog generation,
driving-audio portrait animation and both exact LipDub claims. Inputs,
normalization, prompts, seeds, failure/ITT policy, inclusion criteria and
applicable gates are digest commitments.

The current cutoff record is
`apps/ltx-studio/docs/ANCHOR_LANDSCAPE_2026-08-11.md`. It pins official Git and
Hugging Face revisions plus separate code- and weight-license evidence. The
landscape remains `draft` because the LongCat/Wan resource profiles and
reproducible local starts are not yet measured; repository licenses alone do not clear
training-data or biometric-use rights. The landscape also freezes each
candidate's sorted `compatible_claim_ids`. Under the current exact input
contracts, only LongCat and Wan match
`audio-driven-video.image-audio-to-video`; MOVA matches none because it
generates its own audio instead of consuming the fixed driving track, and none
of the three implements exact-dialogue native generation or exact
reference-video redubbing.

`comparator-resource-check` turns the live resource boundary into a
digest-bound report:

```bash
uv run python scripts/av_eval.py comparator-resource-check \
  --profile /sealed/q1/longcat-resource-profile.json \
  --landscape configs/av_eval/anchor-landscape.v1.json
```

The profile contains exactly three attempted cold runs. Every row must be
offline, single-GPU, orchestrator-admitted, playable and provenance-verified,
with zero foreign-service actions and no orphan. Code/weight revisions,
hardware inventory, launch manifest, normalized input, runner, raw telemetry,
outputs and the measurement policy are digest-bound. Peak VRAM, remaining
headroom, wall time and maximum temperature are evaluated against limits fixed
in the profile. Failed attempts remain in the ITT decision. A compatible arm
needs a passing profile digest before inclusion; `not-applicable` is accepted
only when the frozen compatible-claim set is empty.

```bash
uv run python scripts/av_eval.py comparator-check \
  --matrix configs/av_eval/comparator-matrix.v1.json \
  --landscape configs/av_eval/anchor-landscape.v1.json
```

An included external arm must be input-compatible, rights-clear, technically
functional and code/weight-identical to the landscape. An exclusion needs a
machine-consistent reason limited to rights, input contract, reproducibility,
resource fit or the preregistered technical minimum. The protocol requires
`quality_evidence_seen=false`, so a poor pilot score cannot remove a strong
opponent. Matrix compatibility must exactly match the frozen landscape; it
cannot hide LongCat/Wan from the driving-audio claim or invent MOVA as a fair
arm. A matrix with only `local-only` claims may be production-useful, but its
`sota_status` remains `hold`.

F0 also binds every pre-Q2 technical attestation to a detailed producer
report. A bare signed `pass` is insufficient: R0 must prove all four scheduler
actions plus distinct running/paused transport-failure behavior and restart
reconciliation; R3 canaries must exactly cover the candidate surface; the
pause/resume report must contain exactly 20 cycles across early, middle, and
late boundaries with no equivalence failure or orphan; and the soak report
must contain exactly 50 jobs with zero loss, orphan, duplication, unbound
output, foreign-service action, or recovery-SLO breach. The report digests are
part of the signed F0 candidate and must equal each Studio qualification
report's `producerDigest`.

`technical-score` is the executable bridge from live rows to those artifacts:

```bash
uv run python scripts/av_eval.py technical-score \
  --observations /secure/evidence/technical-observations.v1.json \
  --surface ../../apps/ltx-studio/release/candidate-release-surface.v1.json
```

It accepts one cold, playable, provenance-bound canary per candidate entry,
exactly 20 sorted pause/resume cycles, and exactly 50 sorted soak rows. The
observation envelope binds the SHA-256 of the technical runner into every
detailed report, so the later signed qualification cannot outlive its code.
The cycles must cover every cooperative request mode and all early/middle/late
boundary classes. Bitwise comparisons require equal output hashes; a
non-bitwise result requires a preregistered equivalence-rule digest. Soak rows
must cover the full candidate surface, match their registered terminal or
recovered state, meet their per-row recovery SLO, and contain no lost,
orphaned, duplicate, unbound, or foreign-service behavior. The command emits
the four detailed reports plus unsigned Studio qualification documents; the
independent qualification attestor signs those documents only after this
validation succeeds.

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
direction, decision value (`estimate`, `ci-lower` or `ci-upper`) and threshold
of every sorted metric. The caller must supply the complete gate map from the
frozen threshold catalog. A report cannot silently substitute a confidence
bound for an estimate or vice versa; missing, changed or unexpected gates
reject the report, so an empty or partial pass cannot be used as evidence.

The Product-HOLD remains correct until an operator provisions a separate
blind-scorer UID/GID, owner-only `0700` holdout and log roots, an externally
anchored trusted-key policy, current rights evidence, and a real independent
runner using these interfaces. A development UID may never own the sealed
root. The former numeric holdout checks remain defense in depth, not an active
certification path.

The operational part is executable and read-only once those resources exist:

```bash
uv run python scripts/av_eval.py operational-readiness-check \
  --package configs/av_eval/product-readiness.v1.json \
  --holdout-root /secure/holdout \
  --access-log-root /secure/holdout-audit \
  --access-log /secure/holdout-audit/access.jsonl \
  --trust-policy /secure/policies/product-trusted-keys.v1.json \
  > /secure/evidence/operational-readiness.v1.json
```

It re-inspects both roots, their independent UID/GID and `0700` modes, rejects
extended ACLs and symlinks, verifies the owner-only audit file and its full
signature chain, requires the log to remain at genesis, and validates current,
distinct, single-role Ed25519 keys. The output contains the canonical documents
and hashes for `sealed-acl-report`, `empty-access-log-report`, and
`trusted-key-policy`; it does not fabricate the other six D0 evidence items.
After those three hashes have been copied into the readiness inventory, the
final check must bind the saved bundle and repeat the live inspection:

```bash
uv run python scripts/av_eval.py readiness-check \
  --package configs/av_eval/product-readiness.v1.json \
  --operational-evidence /secure/evidence/operational-readiness.v1.json \
  --holdout-root /secure/holdout \
  --access-log-root /secure/holdout-audit \
  --access-log /secure/holdout-audit/access.jsonl \
  --trust-policy /secure/policies/product-trusted-keys.v1.json
```

`ready-to-freeze` rejects a missing, older-than-five-minutes, future-dated or
hash-unbound bundle. It also fails when the repeated live inspection finds a
different root, owner, ACL, log state, role binding or trust policy. A draft
package can still report its blockers without access to the sealed roots.

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
