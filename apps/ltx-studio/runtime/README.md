# Native LTX release runtime

This project isolates the native renderer from `comfyui-env` and from user
site-packages. Its lock is part of the release input; production syncs must use
the local LTX packages as non-editable wheels.

```bash
uv lock --check --project apps/ltx-studio/runtime
uv sync --locked --no-dev --no-editable --compile-bytecode \
  --project apps/ltx-studio/runtime
apps/ltx-studio/runtime/.venv/bin/python -I \
  apps/ltx-studio/runtime/normalize_cusparselt_wheel.py
uv pip check --python apps/ltx-studio/runtime/.venv/bin/python
PYTHONNOUSERSITE=1 apps/ltx-studio/runtime/.venv/bin/python -I \
  apps/ltx-studio/runtime/verify_runtime.py
```

The CUDA 13.0 index and exact Torch/Torchaudio versions are explicit. The
runtime intentionally does not declare `chardet`; `verify_runtime.py` rejects
it and treats every `requests` import warning as an error.

NVIDIA publishes `nvidia-cusparselt-cu13==0.8.0` under an AArch64 wheel
filename but writes the non-standard `manylinux2014_sbsa` platform tag into
its internal `WHEEL` metadata. `uv pip check` correctly refuses that mismatch.
The checked-in normalizer is not a dependency waiver: it refuses every other
version or tag, verifies that `libcusparseLt.so.0` is an AArch64 ELF binary,
changes only that internal tag, and rebinds the result in the wheel `RECORD`.
