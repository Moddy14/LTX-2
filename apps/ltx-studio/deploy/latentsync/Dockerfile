FROM longcat-video-avatar-dgx:cu131-ngc25.12

ARG LATENTSYNC_COMMIT=a229c3948406bc2cf6eaf4873e662e70c6a04746

RUN python -m pip install --no-cache-dir \
    ffmpeg-python==0.2.0 \
    insightface==0.7.3 \
    kornia==0.8.0 \
    omegaconf==2.3.0

RUN git clone https://github.com/bytedance/LatentSync.git /workspace/LatentSync \
    && git -C /workspace/LatentSync checkout "${LATENTSYNC_COMMIT}" \
    && test "$(git -C /workspace/LatentSync rev-parse HEAD)" = "${LATENTSYNC_COMMIT}"

COPY face_detector_insightface.py /workspace/LatentSync/latentsync/utils/face_detector.py
COPY patch_arm64_decord.py /opt/ltx-studio/patch-arm64-decord.py
RUN python /opt/ltx-studio/patch-arm64-decord.py \
    && rm /opt/ltx-studio/patch-arm64-decord.py
COPY timeline.py /opt/ltx-studio/timeline.py
COPY runner.py /opt/ltx-studio/latentsync-runner.py

LABEL org.opencontainers.image.source="https://github.com/bytedance/LatentSync" \
      org.opencontainers.image.revision="${LATENTSYNC_COMMIT}" \
      com.moddy.ltx-studio.component="latentsync-1.6"

WORKDIR /workspace/LatentSync
ENV PYTHONPATH=/workspace/LatentSync
ENTRYPOINT ["python", "/opt/ltx-studio/latentsync-runner.py"]
