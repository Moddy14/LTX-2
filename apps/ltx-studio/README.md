# LTX Studio

Local, loopback-only production UI for the native LTX-2 pipelines.

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
schema and path validation, request-specific RAM and disk gates, and native LTX admission. Runtime prompt enhancement
reuses the required Gemma encoder and does not reserve the Qwen lane. The runner uses an argument vector without a
shell and executes one job at a time. A job blocked only by RAM, swap, or output-space gates stays queued and is
checked again every ten seconds; path, runtime, and schema failures remain terminal. The runner only
signals the process group belonging to the job being cancelled. It does not stop, unload, or reclaim external
applications. Active Avatar, Qwen, and ComfyUI lanes are displayed without lifecycle controls.

Resource admission is deliberately two-phase. Before queue submission, Studio checks the non-orchestrated output
filesystem only, so low RAM or swap cannot hide the job from the Orchestrator and prevent its owned Qwen pressure
policy from running. After the Orchestrator accepts the job, Studio still waits fail-closed for the full RAM, swap,
and output-space gate. It does not transition the remote job to `starting` and does not spawn Python until every
local start requirement passes. The accepted wait remains visible and can be cancelled through the normal Studio
job action. Studio polls the authoritative remote job while it waits and releases/re-submits an accepted lease after
20 minutes, safely below the Orchestrator's 30-minute accepted-job reaper. A Studio restart durably schedules
`cancelled` delivery for every remote lease that was still active. A queue submit without an authoritative HTTP
response is persisted before the request and reconciled by the stable `ltx-studio:<job-id>` requester key before any
resubmission, including after a restart.

The queue start fence treats only the documented `qwen_gate_active` conflict and bounded Runtime API transport failures
as retryable. After a failed `accepted -> starting` request, Studio reads the authoritative remote state before retrying:
an already `starting` or `running` job proceeds without a duplicate transition, `accepted` waits, and unrelated conflicts
remain terminal. This also contains the failure mode where the Runtime API closes a request without an HTTP response.
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

## Runtime Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `LTX_STUDIO_PORT` | `4318` | Local API and production UI port |
| `LTX_STUDIO_PYTHON` | `.venv/bin/python`, then `~/comfyui-env/bin/python`, then `python3` | Python executable used for LTX pipelines; health requires the complete PyTorch/LTX runtime |
| `LTX_STUDIO_ADMISSION_PYTHON` | `python3` | Python executable providing `dgx_admission_client` |
| `LTX_STUDIO_MIN_AVAILABLE_GIB` | `48` | Local fail-closed start threshold |
| `LTX_STUDIO_MIN_RESIDUAL_MEMORY_GIB` | `24` | RAM that must remain available after the job estimate |
| `LTX_STUDIO_MIN_SWAP_FREE_GIB` | `4` | Minimum free swap required before a job may start |
| `LTX_STUDIO_THERMAL_PAUSE_C` | `90` | Hardware-level host temperature that can trigger a thermal pause |
| `LTX_STUDIO_THERMAL_PAUSE_POLLS` | `3` | Consecutive hot readings required before pausing |
| `LTX_STUDIO_THERMAL_RESUME_POLLS` | `5` | Consecutive readings below the run baseline required before resuming |
| `LTX_STUDIO_THERMAL_UNREADABLE_POLLS` | `3` | Consecutive missing readings before pausing fail-closed |
| `LTX_STUDIO_THERMAL_POLL_INTERVAL_MS` | `10000` | Runtime thermal polling interval |
| `LTX_STUDIO_THERMAL_START_SAMPLES` | `5` | Samples used for the pre-launch host baseline |
| `LTX_STUDIO_THERMAL_START_SAMPLE_INTERVAL_MS` | `1000` | Delay between baseline samples |
| `LTX_STUDIO_DATA_DIR` | `<repository>/.ltx-studio` | Private runtime data directory |
| `LTX_STUDIO_MODEL_ROOTS` | `/home/moddy/LTX-2.3-max` | Colon-separated, bounded model discovery roots |
| `LTX_STUDIO_PHONEME_VISEME_MANIFEST` | unset | v1 blocked/release-candidate or v2 measurement-only manifest for the owned CPU phoneme/viseme evaluator; every non-Product-GO state fails closed |
| `LTX_STUDIO_PHONEME_VISEME_MANIFEST_SHA256` | unset | Administrator-pinned SHA-256 of the complete v2 measurement manifest |
| `LTX_STUDIO_PHONEME_VISEME_LEGAL_APPROVAL_SHA256` | unset | Administrator-pinned SHA-256 of the external commercial/biometric approval evidence |
| `LTX_STUDIO_PHONEME_VISEME_PYTHON` | unset | Absolute Python path inside a dedicated root-owned evaluator venv; the GPU/LTX venv is not accepted unless separately admin-sealed |
| `LTX_STUDIO_PHONEME_VISEME_RUNNER` | unset | Absolute path to an admin-installed, root-owned MFA/MediaPipe runner; the writable worktree copy is never executable evidence |
| `LTX_STUDIO_PHONEME_VISEME_RUNNER_SHA256` | unset | Administrator-pinned SHA-256 of the installed MFA/MediaPipe runner |
| `DGX_RUNTIME_API_BASE_URL` | `http://127.0.0.1:8878` | Authenticated read-only runtime status endpoint |
| `DGX_RUNTIME_API_TOKEN_FILE` | `~/.config/openclaw/dgx-runtime-api.token` | Private Runtime API token file |

Admission is required by default. `LTX_STUDIO_REQUIRE_ADMISSION=0` exists only for isolated development and test
environments; it should not be used for GPU work on the DGX.

The shipped `evaluators/phoneme-viseme/manifest.blocked.json` documents the current Legal Hold. It cannot produce a
measured result. A v2 manifest can enable the bounded CPU-only MFA/MediaPipe runner after every component and legal
evidence file has been bound by exact path, byte size, SHA-256, upstream revision, and reviewed commercial/biometric
scope. Python, MFA, MediaPipe, OpenCV, NumPy, FFmpeg, and FFprobe versions are exact runtime gates. The server verifies
the complete artifact set in a background worker before exposing execution, and the measurement runner verifies it
again before and after measurement. A v2 runner remains disabled unless the complete manifest, its external legal
approval, and the installed runner are independently pinned through the three SHA-256 variables above. The evaluator
Python venv and installed runner must be root-owned, not group/other-writable, and accessible to the isolated user;
the complete venv tree is checked before readiness and again before each run. Symlinked artifacts and parent directories
are rejected. V2 manifest, component, model, mapping, and legal-evidence files must be world-readable for the isolated
DynamicUser and have every write bit removed; the MFA executable must additionally be world-executable. The separately
pinned installed runner is rehashed from its open descriptor and every bound input is revision-checked around each
measurement.

That v2 path reports only raw lag, bilabial closure, mouth opening/rounding, speech/pause motion, track, pose, blur,
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

Controlled experiments are immutable after freezing. The UI shows both arm values, seed, LongCat state, local start
gates, and phoneme/viseme evaluator readiness. A protocol comparison always orders the registered baseline before the
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
