# MuseTalk 1.5 DGX runtime

This optional LTX Studio postprocessor uses the pinned upstream MuseTalk 1.5
UNet and audio stack. It replaces upstream DWPose preprocessing with the
already verified offline InsightFace 106-point alignment because the official
MMPose configuration requires compiled `mmcv` CUDA operators that are not
available for this ARM64 runtime.

Build:

```bash
docker build \
  -t ltx-studio-musetalk:1.5-cu131 \
  apps/ltx-studio/deploy/musetalk
```

Install the exact pinned model set after the DGX freshness gate is healthy:

```bash
/home/moddy/comfyui-env/bin/python \
  apps/ltx-studio/deploy/musetalk/install_models.py
```

Runtime models are mounted read-only from
`/home/moddy/models/musetalk-1.5`; InsightFace is mounted from
`/home/moddy/models/latentsync/insightface`. The container has no network
access during generation. GPU execution is started only by the Studio worker
after its durable DGX queue allocation has reached `running`.
