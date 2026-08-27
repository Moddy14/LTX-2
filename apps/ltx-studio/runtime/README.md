# Native LTX release runtime

This project isolates the native renderer from `comfyui-env` and from user
site-packages. Its lock is part of the release input; production syncs must use
the local LTX packages as non-editable wheels.

```bash
uv lock --check --no-config --project apps/ltx-studio/runtime
uv sync --locked --no-dev --no-editable --compile-bytecode --no-config \
  --reinstall-package ltx-core --reinstall-package ltx-pipelines \
  --reinstall-package torch \
  --project apps/ltx-studio/runtime
apps/ltx-studio/runtime/.venv/bin/python -I \
  apps/ltx-studio/runtime/normalize_cusparselt_wheel.py
apps/ltx-studio/runtime/.venv/bin/python -I \
  apps/ltx-studio/runtime/normalize_torch_cudnn_requirement.py
uv pip check --python apps/ltx-studio/runtime/.venv/bin/python
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONNOUSERSITE=1 \
  apps/ltx-studio/runtime/.venv/bin/python -I \
  apps/ltx-studio/runtime/verify_runtime.py
```

The exact CUDA 13.2 Torch/Torchaudio AArch64 wheels and their SHA-256 hashes
are direct release inputs. `--no-config` prevents the outer upstream workspace's
development indexes from leaking into this isolated runtime lock. TorchAudio
2.11 is the upstream project's stable-ABI release explicitly declared compatible
with Torch 2.11 and later releases. The
runtime intentionally does not declare `chardet`; `verify_runtime.py` rejects
it and treats every `requests` import warning as an error.

The official v1.3 DiffVAE production path is also an active release dependency:
`natten==0.21.7+torch2130cu132` is bound to the CPython 3.12 Linux/AArch64
release wheel and its SHA-256, alongside the direct Torch 2.13 CUDA 13.2 pin.
It is not satisfied by the unused `ltx-core[natten]` optional-extra metadata.
Both `uv lock --check` and `verify_runtime.py` fail closed when this direct
dependency, its wheel binding, or the installed distribution is absent or
different.

Do not label `blackwell_dsl` as supported on DGX Spark without a separate,
reproducible qualification. The official local documentation limits that CuTe
DSL path to datacenter Blackwell B200; DGX Spark/GB10 is not covered by that
claim. This runtime therefore locks NATTEN for DiffVAE instead of asserting an
unverified `blackwell_dsl` capability.

NVIDIA publishes `nvidia-cusparselt-cu13==0.8.1` under an AArch64 wheel
filename but writes the non-standard `manylinux2014_sbsa` platform tag into
its internal `WHEEL` metadata. `uv pip check` correctly refuses that mismatch.
The checked-in normalizer is not a dependency waiver: it refuses every other
version or tag, verifies that `libcusparseLt.so.0` is an AArch64 ELF binary,
changes only that internal tag, and rebinds the result in the wheel `RECORD`.

Torch is deliberately reinstalled from its hash-bound release wheel before
normalization so an older normalized runtime cannot become an implicit upgrade
input. Torch 2.13's CUDA 13.2 wheel pins `nvidia-cudnn-cu13==9.20.0.48`, whose
AArch64 wheel omits the tensor-IR sublibrary. Official LTX v1.3 moves the
workspace to the matching non-yanked `9.24.0.43` wheel; an older override can
abort when torch first selects its cuDNN SDPA backend. The runtime-local
override therefore locks 9.24.0.43 as well. Its second normalizer accepts only
this exact Torch/cuDNN pair, updates the single known `Requires-Dist` line and
rebinds Torch `METADATA` in `RECORD`; the verifier checks version, line and
digest again before startup.
