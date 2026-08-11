# LTX Studio

Local, loopback-only production UI for the native LTX-2 pipelines.

## Official LTX-2.3 workflow parity

The Studio mirrors all six workflows from the
[official ComfyUI LTX-2.3 guide](https://docs.comfy.org/tutorials/video/ltx/ltx-2-3).
It executes the native `ltx_pipelines` implementation instead of importing a ComfyUI graph:

| Official workflow | Studio mode | Native execution contract |
| --- | --- | --- |
| Text to Video (T2V) | Official Text / Image to Video without an image | Dev FP8, Comfy dynamic-rank distilled 1.1 at `0.5`, Gemma LoRA at `1.0`, fixed 8-step first stage and Euler x2 stage at `0.85, 0.725, 0.421875, 0.0` |
| Image to Video (I2V) | Official Text / Image to Video with the first-frame image | Same model and sampler contract as T2V, with first-stage image strength `0.7` and second-stage strength `1.0` |
| FLF2V | First / Last Frame | Distilled FP8, exactly two guides at frame `0` and the final frame, fixed 8-step single stage, no transformer LoRA or spatial upscaler |
| Image Audio to Video (IA2V) | Image + Audio to Video | T2V/I2V model and sampler contract plus native reference-audio conditioning |
| IC-LoRA Union Control | IC-LoRA Union Control | Distilled FP8, Union Control LoRA and Gemma LoRA at `1.0`, fixed 8-step single stage with Euler Ancestral RF, depth/MoGe, Canny, or prepared pose control, no spatial upscaler |
| ID-LoRA | ID-LoRA TalkVid | Dev FP8, Comfy dynamic-rank distilled 1.1 at `0.5`, TalkVid ID-LoRA at `1.0`, reference image at `0.7` in stage 1 and `1.0` in stage 2, reference audio, fixed 8-step first stage and 3-step x2 stage |

This parity claim is deliberately limited to the six workflows on that ComfyUI
guide page. At the audited `ComfyUI-LTXVideo` revision
`3b9c5cde4700917074823d45e25401d81049f8fc`, the repository linked from that
page also publishes dedicated LTX-2.3 examples for motion-track control, HDR
IC-LoRA, Ingredients, spatial inpainting, outpainting, generative pixel spatial
upscaling, text-to-audio, and a model-specific single-stage video-to-video
effect. All eight are exposed: `T2A` is a dedicated mode and the others are
explicit IC-LoRA profiles. Their command plans preserve the published
checkpoint, LoRA strengths, samplers, frozen-source-audio rules, masks, and
stage schedules. Model inventory validation remains fail-closed: a profile is
visible but cannot start until every public or gated asset is present and
SHA-256 verified. The model card's temporal x2 latent upscaler is not connected
because the official native repository still describes it as a component for
future pipeline implementations rather than a current pipeline.

As in the current official graphs, T2V, I2V, IA2V, and ID-LoRA use the user-selected
seed only for stage 1. Their x2 refinement uses a separate `RandomNoise` stream fixed
to seed `42`; the native implementations create an independent generator for that stage.
The Gemma abliterated LoRA is isolated to the optional prompt-generation pass; final
diffusion conditioning is encoded again with the unmodified Gemma model. The official
prompt pass uses seed `0`, a `2048`-token limit, temperature `0.7`, top-k `64`, top-p
`0.95`, min-p `0.05`, and repetition penalty `1.05`. The current T2V, I2V, and IA2V
graphs leave its image input disconnected, while IC-LoRA connects the reference image;
Studio mirrors that distinction.

The linked official LipDub model page publishes a separate ComfyUI workflow. New Studio LipDub requests mirror that
workflow with the BF16 dev checkpoint, distilled 1.1 LoRA at `0.5`, LipDub IC-LoRA at `1.0`, Euler/CFG `1.0`, the
published `8+3` sigma schedules, and independent stage seeds. Reference preparation preserves aspect ratio while
scaling to approximately the published `1920 x 1088` pixel area; a square reference therefore targets `1472 x 1472`.
Stored requests created before this integration are explicitly migrated to `Native Distilled (Legacy)` and remain
reproducible rather than silently changing model stacks.

ComfyUI and the native pipelines package the Gemma text encoder differently.
Studio uses the native full Gemma directory instead of ComfyUI's single
mixed-FP4 text-encoder file. T2V, I2V, IA2V, and ID-LoRA use the exact
documented Comfy dynamic-rank distilled LoRA; the native loader applies its
per-layer `alpha/rank` scaling. The additional Lightricks examples use the
native rank-384 LoRA named in those graphs. All checkpoints, LoRAs, MoGe, and
upscaler assets are checked against pinned sizes and SHA-256 digests before an
official workflow may start.

The current T2V, I2V, FLF2V, IA2V, and ID-LoRA Comfy templates expose
`1280 x 720`; Union Control already uses `1280 x 704`. Native pipelines require
dimensions divisible by 32 or 64, so all six Studio modes use the explicit
`1280 x 704` equivalent and never hide an implicit resize. New T2V, I2V, FLF2V,
Union-Control, and ID-LoRA requests use the documented `25` fps; IA2V uses
`24` fps. T2V, I2V, FLF2V, and Union Control default to five seconds, IA2V to
nine seconds, and ID-LoRA to ten seconds; each duration is snapped to the
required `8k+1` frame count. One selected frame rate remains authoritative from
conditioning through MP4 muxing, and stored jobs keep their original timing.
Width, height, duration, frame rate, and both stage seeds are persisted in
every Studio job.

The official templates run CFG at `1.0`; negative conditioning is therefore inactive. Studio does not show or send a
negative prompt for T2V, I2V, or IA2V. Prompt enhancement defaults to on for T2V and IA2V, off for I2V, FLF2V,
IC-LoRA, and ID-LoRA; it is always disabled when an exact dialogue must remain unchanged.

Lip-sync postprocessors are explicit comparison arms, never silent defaults. LongCat, LatentSync 1.6, MuseTalk
1.5, and LipForcing 14B are mutually exclusive and default to off. MuseTalk runs the pinned upstream 1.5 UNet and Whisper stack in an
offline CUDA container, uses the existing verified InsightFace 106-point alignment instead of the unsupported
ARM64 `mmcv`/DWPose package path, and restores the exact LTX frame count, frame rate, resolution, and selected audio.
Its 16-GiB postprocess allocation is obtained through the same durable Studio/Orchestrator job, including when an
identical verified LTX base is reused. LipForcing pins the official KAIST release, refuses arbitrary pickle globals
in every production checkpoint load, uses the same verified offline InsightFace assets and precomputed UMT5
conditioning, and reserves a conservative 52-GiB shared-memory floor. Its quality setting uses the full Wan VAE;
the official streaming TAEHV decoder remains an explicit faster test setting. Because upstream rounds output down
to complete autoregressive chunks, Studio deliberately generates one covering chunk and then restores the exact
LTX timeline instead of accepting truncated audio or slow motion. If a clean conditioning track is present,
LipForcing uses its exact configured source window for both mouth guidance and the refined intermediate output;
an optional music/final mix is still applied only after refinement. Without a separate conditioning track, the
original LTX audio remains authoritative.

Controlled experiments can register LipForcing as the only treatment change.
When the current editor settings came from an unchanged, provenance-verified
output, Studio adopts that exact file as the frozen baseline instead of
rendering the 22B LTX stage again. The protocol binds its job ID, inode,
revision time, size, and run-provenance fingerprint and rechecks them before
the candidate can start.

Every enabled audio-driven refiner now receives the actual mode-specific
speech conditioning: IA2V uses its selected bounded audio window, ID-LoRA uses
its reference-audio file, and LipDub extracts the track from its reference
video. The source is trimmed where applicable, padded to the exact LTX frame
duration, used for mouth conditioning, and becomes the output audio unless a
separate final mix is selected. Native dialogue generation without a supplied
speech track preserves its jointly generated audio. LatentSync and MuseTalk
mount the provenance-bound host runner adapters
read-only into their offline containers; LatentSync also verifies the pinned
upstream Git revision from the actual image before inference.

## Run

```bash
npm install
npm run build
npm start
```

Open `http://127.0.0.1:4318`. Development mode uses the Vite UI on
`http://127.0.0.1:4317` and the API on port `4318`:

```bash
npm run dev
```

Opening the UI performs only lightweight health and read-only Runtime API checks. A generation starts only after
schema and path validation, an output-space check, and native LTX admission. Runtime prompt enhancement
reuses the required Gemma encoder and does not reserve the Qwen lane. The runner uses an argument vector without a
shell and executes one job at a time. A job waiting on DGX resources stays in the Orchestrator queue and follows its
documented retry interval; path, runtime, schema, and output-space failures remain local and terminal. The runner only
signals the process group belonging to the job being cancelled. It does not stop, unload, or reclaim external
applications. Active Avatar, Qwen, and ComfyUI lanes are displayed without lifecycle controls.

Resource admission has one authority. Before queue submission, Studio checks only the non-orchestrated output
filesystem, so low RAM or swap cannot hide the job from the Orchestrator. After `accepted`, Studio immediately requests
the authoritative `accepted -> starting` transition. The Runtime API then evaluates its current memory, reservations,
queue winner, thermal state, protected workloads, and permitted reclaim policy. A retryable start fence leaves the
remote job unchanged and Studio polls at the returned interval; Studio never stops another service itself. A Studio
restart durably schedules
`cancelled` delivery for every remote lease that was still active. A queue submit without an authoritative HTTP
response is persisted before the request and reconciled by the stable `ltx-studio:<job-id>` requester key before any
resubmission, including after a restart.

The queue start fence treats only the documented `qwen_gate_active` conflict and bounded Runtime API transport failures
as retryable. After a failed `accepted -> starting` request, Studio reads the authoritative remote state before retrying:
an already `starting` or `running` job proceeds without a duplicate transition, `accepted` waits, and unrelated conflicts
remain terminal. This also contains the failure mode where the Runtime API closes a request without an HTTP response.
While Studio owns an active queue job, it sends an authenticated
`POST /dgx/jobs/<job-id>/heartbeat` at least every 60 seconds. Routine heartbeats update only
`runner_last_seen_at` and a descriptive runtime phase. Studio sets `progressed: true` only after the native pipeline
parser has observed a new Euler step; a durable checkpoint is reported by the following `pausing` transition with
its artifact and a new `current_step`. Failed heartbeat attempts retain a pending Euler progress claim for the next retry. The heartbeat loop is drained before
`paused` or a terminal transition so a late request cannot revive or mutate a released lease.

Cooperatively checkpointable LTX runs are durable segment waiters. Their submitted
`estimated_memory_gib` and `resource_profile.required_gib` are both floored at the measured 58 GiB waiter contract,
even when a resolution-based UI estimate is lower. Non-resumable modes and isolated postprocessors retain their own
measured estimates and do not inherit this floor.
On cancellation or service shutdown, Studio confirms that the complete detached process group is gone before it
releases the remote lease. The persisted proof records the Linux boot ID, process-group ID, and leader start ticks.
After a Studio crash, the replacement process never signals that old ID; it scans `/proc` conservatively and unlocks
the pending terminal delivery only after the recorded group is absent or the host boot ID has changed.

During generation, the runner measures the hottest plausible host sensor from sysfs every ten seconds. Three
consecutive readings at or above 90 C pause only the detached LTX process group with `SIGSTOP`. Five readings below
that run's pre-launch thermal baseline resume the same process with `SIGCONT`, preserving its in-memory Python and
CUDA state. Persistent sensor blindness also pauses fail-closed. This is an in-memory thermal pause, not a
disk checkpoint: a Studio restart, process crash, or host restart cannot resume that state. Every completed run logs
its host baseline, peak, and observed rise so an LTX-specific start threshold can be calibrated instead of copying a
threshold from another workload. Because the measurement is the maximum for the whole host, heat from concurrent
applications intentionally affects the guard.

Uploads, the reusable media library, outputs, and private job history are written below `<repository>/.ltx-studio/`.
Model paths and settings are retained in browser local storage. Model discovery is bounded to configured local roots.

The run monitor keeps queue, runtime, cancellation source, complete bounded logs, and structured thermal values visible
in the Studio. The generated-video picker scans every MP4 in the output directory. Successful Studio jobs receive an
atomic `.ltx-settings.json` provenance sidecar; selecting such a video can restore the full validated request with a
new collision-free output name. Externally created or later modified videos remain playable but never claim settings
that cannot be proven from matching provenance.

Persistent project histories live below `projects/` in the private data root.
Every mutation appends an owner-only canonical revision that binds its predecessor
hash. Shots retain every request revision, concrete continuity/retake source,
output provenance fingerprint, settings-sidecar digest, and exported-media digest.
The project API derives the actor from server configuration and hashes artifacts
itself; browser-supplied actors or digests are rejected. Project-launched jobs and
their v7 output sidecars retain the exact project, shot, project-revision, and
request-revision binding across restart. The Studio project UI is still under
development, so this backend contract does not yet constitute the complete P4
workflow.

## Runtime Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `LTX_STUDIO_PORT` | `4318` | Local API and production UI port |
| `LTX_STUDIO_PYTHON` | `.venv/bin/python`, then `~/comfyui-env/bin/python`, then `python3` | Python executable used for LTX pipelines; health requires the complete PyTorch/LTX runtime |
| `LTX_STUDIO_ADMISSION_PYTHON` | `python3` | Python executable providing `dgx_admission_client` |
| `LTX_STUDIO_MIN_AVAILABLE_GIB` | `48` | Conservative UI planning marker; does not override Orchestrator admission |
| `LTX_STUDIO_MIN_RESIDUAL_MEMORY_GIB` | `24` | Additional UI planning margin shown beside the estimate |
| `LTX_STUDIO_MIN_SWAP_FREE_GIB` | `4` | Legacy planning metadata retained in the config API; not a post-admission gate |
| `LTX_STUDIO_THERMAL_PAUSE_C` | `90` | Hardware-level host temperature that can trigger a thermal pause |
| `LTX_STUDIO_THERMAL_PAUSE_POLLS` | `3` | Consecutive hot readings required before pausing |
| `LTX_STUDIO_THERMAL_RESUME_POLLS` | `5` | Consecutive readings below the run baseline required before resuming |
| `LTX_STUDIO_THERMAL_UNREADABLE_POLLS` | `3` | Consecutive missing readings before pausing fail-closed |
| `LTX_STUDIO_THERMAL_POLL_INTERVAL_MS` | `10000` | Runtime thermal polling interval |
| `LTX_STUDIO_THERMAL_START_SAMPLES` | `5` | Samples used for the pre-launch host baseline |
| `LTX_STUDIO_THERMAL_START_SAMPLE_INTERVAL_MS` | `1000` | Delay between baseline samples |
| `LTX_STUDIO_DGX_HEARTBEAT_INTERVAL_MS` | `45000` (maximum `60000`) | Owner-liveness POST interval for active DGX queue jobs |
| `LTX_STUDIO_DATA_DIR` | `<repository>/.ltx-studio` | Private runtime data directory |
| `LTX_STUDIO_PROJECT_ACTOR_ID` | `local-uid-<uid>` | Server-controlled identifier written to append-only project revisions |
| `LTX_STUDIO_MODEL_ROOTS` | `/home/moddy/LTX-2.3-max` | Colon-separated, bounded model discovery roots |
| `LTX_STUDIO_LIPFORCING_IMAGE` | `ltx-studio-lipforcing:14b-cu131` | Pinned offline LipForcing 14B runtime image |
| `LTX_STUDIO_LIPFORCING_MODEL_ROOT` | `/home/moddy/models/lipforcing-14b` | Hash-verified LipForcing, Wan VAE, wav2vec2, text embedding, TAEHV, and manifest root |
| `LTX_STUDIO_PHONEME_VISEME_MANIFEST` | unset | v1 blocked/release-candidate, v2 MFA measurement-only, or v3 CTC/eSpeak measurement-only manifest for the owned CPU phoneme/viseme evaluator; every non-Product-GO state fails closed |
| `LTX_STUDIO_PHONEME_VISEME_MANIFEST_SHA256` | unset | Administrator-pinned SHA-256 of the complete measurement manifest |
| `LTX_STUDIO_PHONEME_VISEME_LEGAL_APPROVAL_SHA256` | unset | Administrator-pinned SHA-256 of the external commercial/biometric approval or bounded private-local operator authorization |
| `LTX_STUDIO_PHONEME_VISEME_PYTHON` | unset | Absolute Python path inside a dedicated root-owned evaluator venv; the GPU/LTX venv is not accepted unless separately admin-sealed |
| `LTX_STUDIO_PHONEME_VISEME_RUNNER` | unset | Absolute path to an admin-installed, root-owned phoneme/viseme runner; the writable worktree copy is never executable evidence |
| `LTX_STUDIO_PHONEME_VISEME_RUNNER_SHA256` | unset | Administrator-pinned SHA-256 of the installed phoneme/viseme runner |
| `DGX_RUNTIME_API_BASE_URL` | `http://127.0.0.1:8878` | Authenticated read-only runtime status endpoint |
| `DGX_RUNTIME_API_TOKEN_FILE` | `~/.config/openclaw/dgx-runtime-api.token` | Private Runtime API token file |

Admission is required by default. `LTX_STUDIO_REQUIRE_ADMISSION=0` exists only for isolated development and test
environments; it should not be used for GPU work on the DGX.

The cooperative queue request never asks the orchestrator to reclaim the
protected `qwen36_mtp_lane`. LTX is admitted against the memory currently
available while Qwen remains resident; insufficient capacity stays
fail-closed and is retried through the normal queue contract.

The shipped `evaluators/phoneme-viseme/manifest.blocked.json` documents the default Legal Hold. It cannot produce a
measured result. A v2 manifest can enable the bounded CPU-only MFA/MediaPipe path; a v3 manifest can enable the
ARM64-compatible CTC/eSpeak/MediaPipe path for explicitly authorized private-local biometric measurement. Both paths
bind every component and evidence file by exact path, byte size, SHA-256, upstream revision, and reviewed processing
scope. Python, alignment, MediaPipe, OpenCV, NumPy, FFmpeg, and FFprobe versions are exact runtime gates. The server verifies
the complete artifact set in a background worker before exposing execution, and the measurement runner verifies it
again before and after measurement. A measurement runner remains disabled unless the complete manifest, its external legal
approval, and the installed runner are independently pinned through the three SHA-256 variables above. The evaluator
Python venv and installed runner must be root-owned, not group/other-writable, and accessible to the isolated user;
the complete venv tree is checked before readiness and again before each run. Symlinked artifacts and parent directories
are rejected. Manifest, component, model, mapping, and legal-evidence files must be world-readable for the isolated
DynamicUser and have every write bit removed; the alignment executable must additionally be world-executable. The separately
pinned installed runner is rehashed from its open descriptor and every bound input is revision-checked around each
measurement.

For the DGX installation, `deploy/ltx-studio-session.service` loads the current non-secret trust pins from the
root-owned `/opt/ltx-studio-phoneme-viseme/ltx-studio.env`. Update and reinstall that file whenever a sealed manifest
or runner changes; a hash mismatch intentionally disables measurement.

The v2 and v3 paths report only raw lag, bilabial closure, mouth opening/rounding, speech/pause motion, track, pose, blur,
and phone-coverage evidence. It returns `measurement-only` only when the manifest-bound evidence floors pass and
otherwise abstains as `insufficient`; MediaPipe is not an independent 15-class visual viseme classifier and therefore
cannot grant Product-GO, a 10/10, or a SOTA claim. A real Product-GO still requires
independent visual-viseme inference plus dataset freeze, legal approval, calibration, tune report, sealed holdout,
and external-comparator evidence. The older v1 release-candidate contract remains parsed but non-executable until
that separate classifier runner exists. Each measurement runs as a short-lived systemd `DynamicUser` with no Studio,
Docker, or other supplementary host groups. Its production readiness probe must first prove the isolated identity, a
distinct private network namespace, blocked AF_INET, a masked host `/run` including Docker/containerd and D-Bus
sockets, hidden host-home data, hidden GPU devices, and an explicitly re-exposed pinned runner. Every systemd source,
including the private `LoadCredential` request, resolves through a descriptor held open by Studio; replacing a parent
path cannot change the inode mounted by PID 1. The real unit receives an empty controlled environment, individual
read-only bindings for every verified evaluator artifact and the video, one lifecycle-bound writable runtime directory, explicit
memory/process/file/output limits, a hard runtime deadline, and cgroup-wide termination. Studio confirms an explicit
inactive, failed, or not-found unit state before deleting private temporary data; control-channel errors fail closed
and remain retryable.

The checkpoint-free motion proxy never produces a 10/10 or SOTA claim. The CPU analyzer also reports an uncalibrated, forward/backward
consistent dense-motion texture residual, luminance delta, and local deformation after removing the best global
affine head motion estimated from a wider stable face region outside the mouth core. Deformation uses only pixels
whose complete 3x3 flow neighborhood passed the consistency gate. Pair coverage and the p10 usable-pixel
coverage must both pass evidence floors. The spatial-p95/temporal-p95 values help compare mouth-edge, local
deformation, and flicker behavior between otherwise controlled runs, but remain neutral raw measurements until
speaker-, lighting-, and motion-stratified calibration exists.

Controlled experiments are immutable after freezing. The UI shows both arm values, seed, selected lip-refiner state, DGX queue
readiness, and phoneme/viseme evaluator readiness. A protocol comparison always orders the registered baseline before the
candidate, regardless of output selection order. An experiment that has never bound an arm may be marked superseded
without changing its frozen protocol hash and may point to an already frozen replacement; any attempted or bound run
prevents superseding it. Overall-insufficient analyses display neutral raw deltas instead of directional quality trends.

## Verify

```bash
npm run lint
npm test
npm run build
npm run test:e2e
```

The browser tests run against desktop and mobile Chromium viewports and do not submit a generation job.
