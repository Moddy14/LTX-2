# Q1 Anchor Landscape — Primary-source record

Cutoff: 2026-08-11. This record covers open, locally executable video models
that are plausible external anchors for LTX Studio's native-dialog and
audio-driven portrait claims. It is evidence for candidate inclusion, not a
legal approval or a quality result.

## Search and pinning method

The search used the official organization repositories, their linked model
cards and the exact Git/Hugging Face revisions below. Repository HEADs were
resolved with `git ls-remote`; model revisions and declared license tags were
read from the Hugging Face model API. License and model-card bytes were fetched
at the pinned revisions and hashed as raw bytes. A permissive code or weight
license does not settle training-data, biometric-input, consent or commercial
deployment rights; those remain subject to the signed rights policy.

## Candidates

### LongCat-Video-Avatar 1.5

- Code: `meituan-longcat/LongCat-Video`, revision
  `6b3f4b8582a8bc3f20f795735f5383716c4ba794`.
- Weights: `meituan-longcat/LongCat-Video-Avatar-1.5`, revision
  `92016c71d5d318d0f5d84e4db30015a571484ab6`.
- The official runner accepts audio plus text and optionally an image; it is a
  plausible driving-audio/portrait arm. It is not an exact reference-video plus
  target-text redubbing arm, and its audio requirement prevents use as a
  text-only native-dialog comparator.
- The pinned repository says code contributions and model weights are MIT.
  Code license SHA-256:
  `dfdbf36556065706ef8b26e5866acb85209b6465af0395578d38b63470e0bed0`.
  Pinned weight-card SHA-256:
  `d4b5dc706d13a511cc1aac623f75c10ac1dff902ffd915a411e398218b675cb4`.
- Primary sources: [official repository](https://github.com/meituan-longcat/LongCat-Video/tree/6b3f4b8582a8bc3f20f795735f5383716c4ba794),
  [official weights](https://huggingface.co/meituan-longcat/LongCat-Video-Avatar-1.5/tree/92016c71d5d318d0f5d84e4db30015a571484ab6).

### Wan2.2-S2V-14B

- Code: `Wan-Video/Wan2.2`, revision
  `42bf4cfaa384bc21833865abc2f9e6c0e67233dc`.
- Weights: `Wan-AI/Wan2.2-S2V-14B`, revision
  `dab4e9c55bbe4c8c4d03db1c2c98c7f0ac9c454b`.
- The official S2V command accepts the same portrait image, driving audio and
  optional prompt required by the audio-driven claim, at 480p or 720p. The
  official single-GPU path requires at least 80 GB VRAM. It is not an exact
  text-only native-dialog or reference-video-redubbing arm.
- The official repository and model card declare Apache-2.0. Code license
  SHA-256:
  `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`.
  Pinned weight-card SHA-256:
  `b8361d366abbf2b0d211a20ecb0e721e6879a63f2c3bb66dd4bfc153ed870530`.
- Primary sources: [official repository](https://github.com/Wan-Video/Wan2.2/tree/42bf4cfaa384bc21833865abc2f9e6c0e67233dc),
  [official weights](https://huggingface.co/Wan-AI/Wan2.2-S2V-14B/tree/dab4e9c55bbe4c8c4d03db1c2c98c7f0ac9c454b).

### MOVA-360p

- Code: `OpenMOSS/MOVA`, revision
  `9b39667838a7c7ff2c367f5c5189d35c422878bd`.
- Weights: `OpenMOSS-Team/MOVA-360p`, revision
  `eab4aa91d6d5eb515e259a0c8533c90062b117a5`.
- MOVA jointly generates video and audio from a first-frame image and prompt.
  It is therefore a plausible native `image-to-video` dialog arm, but not a
  fair text-only, driving-audio or reference-video-redubbing arm.
- The official repository and model card declare Apache-2.0. Code license
  SHA-256:
  `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`.
  Pinned weight-card SHA-256:
  `facf3856a51fdb8fdb096946af952a63254eb3078eb49a7fcdd178ae67575a89`.
- Primary sources: [official repository](https://github.com/OpenMOSS/MOVA/tree/9b39667838a7c7ff2c367f5c5189d35c422878bd),
  [official weights](https://huggingface.co/OpenMOSS-Team/MOVA-360p/tree/eab4aa91d6d5eb515e259a0c8533c90062b117a5).

## Claim consequences

- `audio-driven-video.image-audio-to-video`: LongCat and Wan are input-contract
  candidates; MOVA is incompatible because it does not consume the fixed
  driving-audio track.
- `native-generation.image-to-video`: MOVA is an input-contract candidate;
  LongCat Avatar and Wan S2V require driving audio.
- `native-generation.text-to-video`: none of these three is an exact arm under
  the current text-only input contract.
- Both `reference-video-redubbing.*` claims have no exact external arm in this
  landscape. They remain `local-only` unless a later cutoff-dated search adds a
  rights-clear model with the same reference-video plus target-text contract.

No candidate is yet execution-authorized by this record. Resource profiles,
reproducible local starts, complete rights attestations and technical-minimum
pilots remain mandatory before a matrix arm can become `included`.
