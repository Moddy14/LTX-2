#!/usr/bin/env python3
"""Harden the exact pinned LipForcing inference tree for offline Studio use."""

from __future__ import annotations

from pathlib import Path


ROOT = Path("/workspace/LipForcing")


def replace_exact(path: Path, old: str, new: str, expected: int) -> None:
    source = path.read_text(encoding="utf8")
    count = source.count(old)
    if count != expected:
        raise RuntimeError(
            f"Refusing to patch unexpected LipForcing source {path}: "
            f"found {count} occurrences, expected {expected}."
        )
    path.write_text(source.replace(old, new), encoding="utf8")


def main() -> int:
    # Every file reachable from the production inference command contains
    # tensors/state dictionaries only. Refuse arbitrary pickle globals.
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        "weights_only=False",
        "weights_only=True",
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        'torch.load(args.ckpt_path, map_location="cpu", weights_only=True)',
        'torch.load(args.ckpt_path, map_location="cpu", weights_only=True, mmap=True)',
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        "model.load_state_dict(state_dict, strict=False)",
        "model.load_state_dict(state_dict, strict=False, assign=True)",
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        "model.load_state_dict(prefixed_sd, strict=False)",
        "model.load_state_dict(prefixed_sd, strict=False, assign=True)",
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        'constructor_merge_lora = (args.model_size == "1.3B")',
        "constructor_merge_lora = True",
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        "    model = CausalOmniAvatarWan(\n",
        '    with torch.device("meta"):\n        model = CausalOmniAvatarWan(\n',
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        """        use_dynamic_rope=args.use_dynamic_rope,
    )

    # Load Self-Forcing checkpoint on top
""",
        """        use_dynamic_rope=args.use_dynamic_rope,
        )

    # Load Self-Forcing checkpoint on top
""",
        1,
    )
    replace_exact(
        ROOT / "scripts" / "inference" / "_common.py",
        "weights_only=False",
        "weights_only=True",
        8,
    )

    # The upstream H200 path constructs random CPU weights, then retains the
    # loaded checkpoint tensors until after model.to(cuda). On GB10 unified
    # memory that makes the transfer briefly require several full 14B copies.
    # The production patch constructs on meta, assigns the released checkpoint
    # directly, and drops temporary references before the transfer.
    replace_exact(
        ROOT / "scripts" / "inference" / "_loader.py",
        """    model = model.to(device=device, dtype=dtype)
    model.eval()
""",
        """    del state_dict
    if "ckpt" in locals():
        del ckpt
    if "prefixed_sd" in locals():
        del prefixed_sd
    import gc
    gc.collect()

    model.reset_parameters()
    model = model.to(device=device, dtype=dtype)
    model.eval()
""",
        1,
    )

    # Bind InsightFace to the read-only, hash-verified Studio mount. The
    # container has no network, so a missing model is a hard error.
    replace_exact(
        ROOT / "scripts" / "inference" / "_common.py",
        'insightface_root=os.path.join(LIPFORCING_ROOT, "checkpoints", "auxiliary"),',
        'insightface_root=os.environ["LIPFORCING_INSIGHTFACE_ROOT"],',
        1,
    )
    replace_exact(
        ROOT / "OmniAvatar" / "utils" / "latentsync" / "face_detector.py",
        "self.app = FaceAnalysis(\n            allowed_modules=",
        'self.app = FaceAnalysis(\n            name="buffalo_l",\n            allowed_modules=',
        1,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
