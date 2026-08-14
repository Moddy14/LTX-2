from unittest.mock import Mock, patch

from ltx_core.text_encoders.gemma.tokenizer import LTXVGemmaTokenizer


def test_gemma_tokenizer_uses_sentencepiece_backend() -> None:
    tokenizer = Mock()
    tokenizer.pad_token = "<pad>"
    tokenizer.eos_token = "<eos>"

    with patch(
        "ltx_core.text_encoders.gemma.tokenizer.AutoTokenizer.from_pretrained",
        return_value=tokenizer,
    ) as load:
        wrapped = LTXVGemmaTokenizer("/models/gemma", max_length=1024)

    load.assert_called_once_with(
        "/models/gemma",
        local_files_only=True,
        model_max_length=1024,
        trust_remote_code=False,
        use_fast=False,
    )
    assert wrapped.tokenizer is tokenizer
