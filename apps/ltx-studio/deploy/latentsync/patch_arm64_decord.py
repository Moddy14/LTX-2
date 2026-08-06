#!/usr/bin/env python3
"""Replace LatentSync's inference-only Decord calls for ARM64.

The official inference pipeline already asks for OpenCV video decoding. Decord
is imported only for a WAV read and as the default of one image-processor
helper, but it has no Python 3.12 ARM64 wheel. Keep the official math and
pipeline untouched while using SoundFile/OpenCV for those two I/O operations.
"""

from pathlib import Path


path = Path("/workspace/LatentSync/latentsync/utils/util.py")
source = path.read_text()
replacements = (
    (
        "from decord import AudioReader, VideoReader\n",
        "import soundfile as sf\n",
    ),
    (
        "def read_video(video_path: str, change_fps=True, use_decord=True):",
        "def read_video(video_path: str, change_fps=True, use_decord=False):",
    ),
    (
        "def read_video_decord(video_path: str):\n"
        "    vr = VideoReader(video_path)\n"
        "    video_frames = vr[:].asnumpy()\n"
        "    vr.seek(0)\n"
        "    return video_frames\n",
        "def read_video_decord(video_path: str):\n"
        "    return read_video_cv2(video_path)\n",
    ),
    (
        "    ar = AudioReader(audio_path, sample_rate=audio_sample_rate, mono=True)\n"
        "\n"
        "    # To access the audio samples\n"
        "    audio_samples = torch.from_numpy(ar[:].asnumpy())\n"
        "    audio_samples = audio_samples.squeeze(0)\n"
        "\n"
        "    return audio_samples\n",
        "    audio_samples, sample_rate = sf.read(audio_path, dtype=\"float32\", always_2d=False)\n"
        "    if sample_rate != audio_sample_rate:\n"
        "        raise ValueError(f\"Audio sample rate must be {audio_sample_rate}, got {sample_rate}.\")\n"
        "    if audio_samples.ndim == 2:\n"
        "        audio_samples = audio_samples.mean(axis=1)\n"
        "    return torch.from_numpy(audio_samples)\n",
    ),
)

for old, new in replacements:
    if source.count(old) != 1:
        raise RuntimeError(f"Pinned LatentSync source no longer matches ARM64 patch: {old[:80]!r}")
    source = source.replace(old, new)

path.write_text(source)
