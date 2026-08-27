import pytest
import torch

from ltx_core.loader.fuse_loras import apply_loras
from ltx_core.loader.primitives import LoraStateDictWithStrength, StateDict


def _state_dict(values: dict[str, torch.Tensor]) -> StateDict:
    return StateDict(
        sd=values,
        device=torch.device("cpu"),
        size=sum(value.nelement() * value.element_size() for value in values.values()),
        dtype={value.dtype for value in values.values()},
    )


def test_comfy_lora_alpha_scales_each_dynamic_rank(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    model = _state_dict({"layer.weight": torch.zeros((2, 2), dtype=torch.bfloat16)})
    lora = _state_dict(
        {
            "layer.lora_A.weight": torch.ones((2, 2), dtype=torch.bfloat16),
            "layer.lora_B.weight": torch.ones((2, 2), dtype=torch.bfloat16),
            "layer.alpha": torch.tensor(1, dtype=torch.bfloat16),
        }
    )

    fused = apply_loras(model, [LoraStateDictWithStrength(lora, 1.0)])

    assert torch.equal(fused.sd["layer.weight"], torch.ones((2, 2), dtype=torch.bfloat16))


def test_lora_without_alpha_keeps_legacy_strength_semantics(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    model = _state_dict({"layer.weight": torch.zeros((2, 2), dtype=torch.bfloat16)})
    lora = _state_dict(
        {
            "layer.lora_A.weight": torch.ones((2, 2), dtype=torch.bfloat16),
            "layer.lora_B.weight": torch.ones((2, 2), dtype=torch.bfloat16),
        }
    )

    fused = apply_loras(model, [LoraStateDictWithStrength(lora, 0.5)])

    assert torch.equal(fused.sd["layer.weight"], torch.ones((2, 2), dtype=torch.bfloat16))
