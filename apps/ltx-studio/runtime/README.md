# Native LTX release runtime

This project isolates the native renderer from `comfyui-env` and from user
site-packages. Its lock is part of the release input; production syncs must use
the local LTX packages as non-editable wheels.

```bash
uv lock --check --no-config --project apps/ltx-studio/runtime
uv sync --locked --no-dev --no-editable --compile-bytecode --no-config \
  --project apps/ltx-studio/runtime
apps/ltx-studio/runtime/.venv/bin/python -I \
  apps/ltx-studio/runtime/normalize_cusparselt_wheel.py
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

NVIDIA publishes `nvidia-cusparselt-cu13==0.8.1` under an AArch64 wheel
filename but writes the non-standard `manylinux2014_sbsa` platform tag into
its internal `WHEEL` metadata. `uv pip check` correctly refuses that mismatch.
The checked-in normalizer is not a dependency waiver: it refuses every other
version or tag, verifies that `libcusparseLt.so.0` is an AArch64 ELF binary,
changes only that internal tag, and rebinds the result in the wheel `RECORD`.
