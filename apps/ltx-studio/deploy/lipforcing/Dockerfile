FROM longcat-video-avatar-dgx:cu131-ngc25.12

ARG LIPFORCING_COMMIT=fc864771eb347ca3ccaaef9c0b583ff6ccc9f184

RUN python -m pip install --no-cache-dir \
    transformers==4.49.0 \
    peft==0.17.1 \
    omegaconf==2.3.0 \
    hydra-core==1.3.2 \
    insightface==0.7.3 \
    kornia==0.8.0 \
    ftfy==6.2.0 \
    python_speech_features==0.6

RUN git clone --filter=blob:none https://github.com/cvlab-kaist/LipForcing.git /workspace/LipForcing \
    && git -C /workspace/LipForcing checkout "${LIPFORCING_COMMIT}" \
    && test "$(git -C /workspace/LipForcing rev-parse HEAD)" = "${LIPFORCING_COMMIT}" \
    && python -m pip install --no-deps -e /workspace/LipForcing

COPY patch_verified_runtime.py /opt/ltx-studio/patch-verified-runtime.py
RUN python /opt/ltx-studio/patch-verified-runtime.py \
    && rm /opt/ltx-studio/patch-verified-runtime.py

COPY container_runner.py /opt/ltx-studio/lipforcing-runner.py
COPY prepare_text_embedding.py /opt/ltx-studio/prepare-lipforcing-text-embedding.py

LABEL org.opencontainers.image.source="https://github.com/cvlab-kaist/LipForcing" \
      org.opencontainers.image.revision="${LIPFORCING_COMMIT}" \
      com.moddy.ltx-studio.component="lipforcing-14b"

WORKDIR /workspace/LipForcing
ENV PYTHONPATH=/workspace/LipForcing:/workspace/LipForcing/scripts/inference \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    TOKENIZERS_PARALLELISM=false \
    NO_ALBUMENTATIONS_UPDATE=1 \
    ORT_DISABLE_THREAD_AFFINITY=1 \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
ENTRYPOINT ["python", "/opt/ltx-studio/lipforcing-runner.py"]
