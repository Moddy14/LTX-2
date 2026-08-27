from __future__ import annotations

import hashlib
import json
from pathlib import Path

_BINDING_PATH = Path(__file__).with_name("fixtures") / "a2vid_runtime_patch_binding.v1.json.txt"
_REPOSITORY_ROOT = Path(__file__).resolve().parents[3]

# SHA256 over UTF-8 JSON with recursive lexicographic key ordering, compact
# separators, and ensure_ascii=True. The payload contains only ASCII strings,
# making this byte contract straightforward to reproduce in TypeScript.
_EXPECTED_CANONICAL_BINDING_SHA256 = "4aa2315d36b99869bd5b12160c6fab367ab0112afb95b31ff57d24b37fb45733"


def _canonical_json(payload: object) -> bytes:
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8")


def test_a2vid_runtime_patch_binding_is_canonical_and_matches_all_runtime_sources() -> None:
    payload = json.loads(_BINDING_PATH.read_text(encoding="utf-8"))

    assert payload["schemaVersion"] == "ltx-studio-native-runtime-patch-binding.v1"
    assert payload["patchId"] == (
        "ltx-studio-ltx-pipelines-v1.3-a2v-split-official-comfy-fp32-frozen-audio.v1"
    )
    assert hashlib.sha256(_canonical_json(payload)).hexdigest() == _EXPECTED_CANONICAL_BINDING_SHA256

    sources = payload["sources"]
    assert [source["role"] for source in sources] == [
        "a2v-entrypoint",
        "fp32-state-construction-and-bf16-model-boundaries",
        "fp32-trajectory-and-bf16-transformer-input",
    ]
    for source in sources:
        source_bytes = (_REPOSITORY_ROOT / source["path"]).read_bytes()
        assert hashlib.sha256(source_bytes).hexdigest() == source["sha256"]
