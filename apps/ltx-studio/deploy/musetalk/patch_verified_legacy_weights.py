#!/usr/bin/env python3
"""Allow only the hash-verified upstream face-parser legacy checkpoints."""

from pathlib import Path


root = Path("/workspace/MuseTalk/musetalk/utils/face_parsing")
replacements = {
    root / "resnet.py": [
        (
            "torch.load(model_path) #modelzoo.load_url(resnet18_url)",
            "torch.load(model_path, weights_only=False) # hash-verified upstream legacy archive",
        ),
    ],
    root / "__init__.py": [
        (
            "torch.load(model_pth))",
            "torch.load(model_pth, weights_only=False))",
        ),
        (
            "torch.load(model_pth, map_location=torch.device('cpu')))",
            "torch.load(model_pth, map_location=torch.device('cpu'), weights_only=False))",
        ),
    ],
}

for path, edits in replacements.items():
    source = path.read_text(encoding="utf8")
    for before, after in edits:
        if source.count(before) != 1:
            raise RuntimeError(f"Unexpected upstream source while patching {path}: {before!r}")
        source = source.replace(before, after)
    path.write_text(source, encoding="utf8")
