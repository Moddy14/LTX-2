from pathlib import Path
from unittest.mock import Mock

import pytest

from ltx_core.text_encoders.gemma.encoders import base_encoder


def test_module_ops_load_tokenizer_and_processor(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(base_encoder.GemmaAssets, "load", Mock(return_value=Mock()))

    operations = base_encoder.module_ops_from_gemma_root(str(tmp_path))

    assert [operation.name for operation in operations] == ["TokenizerLoad", "ProcessorLoad"]


def test_module_ops_propagate_asset_lookup_errors(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(base_encoder.GemmaAssets, "load", Mock(side_effect=PermissionError("Gemma root is unreadable")))

    with pytest.raises(PermissionError, match="Gemma root is unreadable"):
        base_encoder.module_ops_from_gemma_root(str(tmp_path))


def test_prompt_enhancement_requires_processor() -> None:
    encoder = base_encoder.LTXGemmaTextEncoder()

    with pytest.raises(RuntimeError, match="preprocessor_config.json was not found"):
        encoder.enhance_t2v("A sunrise over the mountains", system_prompt="Enhance this prompt")
