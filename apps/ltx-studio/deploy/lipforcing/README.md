# LipForcing 14B Studio runtime

This image pins the official LipForcing code to
`fc864771eb347ca3ccaaef9c0b583ff6ccc9f184` and runs it offline. The build
changes only the production inference path:

- all reachable tensor checkpoints use `torch.load(..., weights_only=True)`;
- the released 14B checkpoint is memory-mapped and assigned directly into the
  model structure created on PyTorch's `meta` device. Non-persistent RoPE and
  scheduler state is then rebuilt, and every temporary checkpoint reference is
  released before the CUDA transfer. This avoids simultaneous random-model,
  checkpoint, populated-model and GPU copies on the DGX Spark's unified
  CPU/GPU memory;
- InsightFace is bound to the Studio's hash-verified `buffalo_l` mount;
- the container has no network;
- the official 25 fps output is restored to the exact LTX frame count, frame
  rate and resolution before publication;
- when Studio has a clean conditioning track, the exact configured source
  window is padded to the LTX duration and remains the refined video's audio.
  Without one, the original LTX audio is preserved. A selected final mix is
  applied only after refinement.

The quality mode uses the official Wan VAE decoder. The faster TAEHV decoder is
available as an explicit alternative. Both remain experimental and disabled by
default in the Studio until a controlled result beats the native baseline.

Build the code image:

```bash
docker build \
  -t ltx-studio-lipforcing:14b-cu131 \
  apps/ltx-studio/deploy/lipforcing
```

The model installer downloads only pinned revisions and verifies exact sizes
and SHA-256 hashes. It also downloads UMT5-XXL temporarily:

```bash
/home/moddy/comfyui-env/bin/python \
  apps/ltx-studio/deploy/lipforcing/install_models.py
```

Create the fixed prompt embedding on CPU inside the pinned image:

```bash
docker run --rm --network none --user "$(id -u):$(id -g)" \
  -v /home/moddy/models/lipforcing-14b:/models/lipforcing \
  --entrypoint python ltx-studio-lipforcing:14b-cu131 \
  /opt/ltx-studio/prepare-lipforcing-text-embedding.py \
  --text-encoder \
  /models/lipforcing/bootstrap/Wan2.1-T2V-14B/models_t5_umt5-xxl-enc-bf16.pth \
  --output /models/lipforcing/text_emb.pt \
  --provenance /models/lipforcing/text-embedding-provenance.json
```

Then finalize the manifest and remove the 11 GB bootstrap encoder:

```bash
/home/moddy/comfyui-env/bin/python \
  apps/ltx-studio/deploy/lipforcing/install_models.py \
  --finalize --delete-bootstrap
```

Model preparation consumes substantial unified memory and must be scheduled
through the current DGX orchestrator contract when performed on the DGX.
