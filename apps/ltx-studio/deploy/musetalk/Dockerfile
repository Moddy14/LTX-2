FROM longcat-video-avatar-dgx:cu131-ngc25.12

ARG MUSETALK_COMMIT=0a89dec45a0192b824e3cf4daf96c239440c5ed8

RUN python -m pip install --no-cache-dir \
    ffmpeg-python==0.2.0 \
    insightface==0.7.3 \
    omegaconf==2.3.0 \
    wcwidth==0.2.14

RUN git clone https://github.com/TMElyralab/MuseTalk.git /workspace/MuseTalk \
    && git -C /workspace/MuseTalk checkout "${MUSETALK_COMMIT}" \
    && test "$(git -C /workspace/MuseTalk rev-parse HEAD)" = "${MUSETALK_COMMIT}" \
    && ln -s /models/musetalk /workspace/MuseTalk/models

COPY preprocessing_insightface.py /workspace/MuseTalk/musetalk/utils/preprocessing.py
COPY patch_verified_legacy_weights.py /opt/ltx-studio/patch-verified-legacy-weights.py
RUN python /opt/ltx-studio/patch-verified-legacy-weights.py \
    && rm /opt/ltx-studio/patch-verified-legacy-weights.py
COPY container_runner.py /opt/ltx-studio/musetalk-runner.py

LABEL org.opencontainers.image.source="https://github.com/TMElyralab/MuseTalk" \
      org.opencontainers.image.revision="${MUSETALK_COMMIT}" \
      com.moddy.ltx-studio.component="musetalk-1.5"

WORKDIR /workspace/MuseTalk
ENV PYTHONPATH=/workspace/MuseTalk
ENTRYPOINT ["python", "/opt/ltx-studio/musetalk-runner.py"]
