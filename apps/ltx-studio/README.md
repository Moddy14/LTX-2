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
| `LTX_STUDIO_PHONEME_VISEME_MANIFEST` | unset | Blocked or release-candidate manifest for the owned CPU phoneme/viseme evaluator; every non-measured state fails closed |
| `DGX_RUNTIME_API_BASE_URL` | `http://127.0.0.1:8878` | Authenticated read-only runtime status endpoint |
| `DGX_RUNTIME_API_TOKEN_FILE` | `~/.config/openclaw/dgx-runtime-api.token` | Private Runtime API token file |

Admission is required by default. `LTX_STUDIO_REQUIRE_ADMISSION=0` exists only for isolated development and test
environments; it should not be used for GPU work on the DGX.

The shipped `evaluators/phoneme-viseme/manifest.blocked.json` documents the current Legal Hold. It cannot produce a
measured result. This build parses a structurally complete `release-candidate` manifest, but deliberately does not
hash multi-gigabyte model files on the Node event loop and never treats manifest text as Product-GO. The UI reports
`Runner fehlt`, and the result remains blocked until a bounded evaluator worker independently verifies model,
mapping, dataset-freeze, legal-approval, tune, and sealed-holdout attestations before inference. The checkpoint-free
motion proxy never produces a 10/10 or SOTA claim.

## Verify

```bash
npm run lint
npm test
npm run build
npm run test:e2e
```

The browser tests run against desktop and mobile Chromium viewports and do not submit a generation job.
