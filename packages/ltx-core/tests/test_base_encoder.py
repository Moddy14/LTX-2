from pathlib import Path

import pytest

from ltx_core.text_encoders.gemma.encoders import base_encoder


def test_module_ops_allow_text_only_gemma_root(tmp_path: Path) -> None:
    (tmp_path / "tokenizer.model").touch()

    operations = base_encoder.module_ops_from_gemma_root(str(tmp_path))

    assert [operation.name for operation in operations] == ["TokenizerLoad"]


def test_module_ops_propagate_processor_lookup_errors(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tokenizer_path = tmp_path / "tokenizer.model"

    def find_file(_root: str, pattern: str) -> Path:
        if pattern == "tokenizer.model":
            return tokenizer_path
        raise PermissionError("processor root is unreadable")

    monkeypatch.setattr(base_encoder, "find_matching_file", find_file)

    with pytest.raises(PermissionError, match="processor root is unreadable"):
        base_encoder.module_ops_from_gemma_root(str(tmp_path))


def test_prompt_enhancement_requires_processor() -> None:
    encoder = base_encoder.GemmaTextEncoder()

    with pytest.raises(RuntimeError, match="preprocessor_config.json was not found"):
        encoder.enhance_t2v("A sunrise over the mountains")
