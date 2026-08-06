# LatentSync 1.6 refiner

This image pins the official ByteDance LatentSync source at commit
`a229c3948406bc2cf6eaf4873e662e70c6a04746`. The model files are downloaded
from `ByteDance/LatentSync-1.6`; the VAE is downloaded from
`stabilityai/sd-vae-ft-mse`. Large model files remain outside Git.

The refiner uses LatentSync's documented InsightFace alignment path with the
official `buffalo_l` SCRFD detector and 106-point landmark model. Only these
two ONNX files are extracted from the official v0.7 model package. InsightFace
model weights are restricted to non-commercial research use; review and obtain
the appropriate model license before any commercial use.

LatentSync is trained for 25 fps. The adapter therefore computes an exact
25-fps working frame count, runs inference on that internal timeline, and then
restores the LTX source frame rate, frame count, resolution, and original audio
stream. A refinement must not change the duration or audio timing of the base
render.

Install and verify the pinned artifacts:

```bash
/home/moddy/comfyui-env/bin/python install_models.py
```

Build the CUDA 13.1 image used by LTX Studio:

```bash
docker build --pull=false -t ltx-studio-latentsync:1.6-cu131 .
```

GPU execution must be started through an admitted LTX Studio queue job. The
adapter never performs admission or resource reclaim by itself.
