from contextlib import contextmanager
from pathlib import Path
import sys
import types

import pytest

sys.modules.setdefault("OpenImageIO", types.ModuleType("OpenImageIO"))

from ltx_pipelines.utils import blocks


def test_i2v_system_prompt_has_one_mode_specific_preamble() -> None:
    prompt_path = (
        Path(__file__).parents[2]
        / "ltx-core/src/ltx_core/text_encoders/gemma/encoders/prompts/gemma3_i2v_system_prompt.txt"
    )
    prompt = prompt_path.read_text(encoding="utf-8")
    first_line = prompt.splitlines()[0]

    assert prompt.count("You are a Creative Assistant") == 1
    assert "image-to-video" in first_line
    assert "text-to-video model" not in first_line


def test_gemma_enhancement_reuses_text_encoder_for_encoding(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[str] = []

    class FakeTextEncoder:
        def enhance_t2v(self, prompt: str, seed: int, **_options: object) -> str:
            events.append(f"enhance:{prompt}:{seed}")
            return f"enhanced {prompt}"

        def encode(self, prompts: list[str]) -> list[tuple[tuple[str, ...], str]]:
            results = []
            for prompt in prompts:
                events.append(f"encode:{prompt}")
                results.append(((prompt,), "mask"))
            return results

    class FakeEmbeddingsProcessor:
        def process_hidden_states(self, hidden_states: tuple[str, ...], mask: str) -> tuple[tuple[str, ...], str]:
            return hidden_states, mask

    @contextmanager
    def fake_context(model: object):
        yield model

    encoder = object.__new__(blocks.PromptEncoder)
    encoder._text_encoder_path = "gemma"
    encoder._embeddings_paths = ("checkpoint",)
    encoder._alloc_trim_strategy = None
    shared_builder = object()
    encoder._text_encoder_builder = shared_builder
    encoder._enhancer_text_encoder_builder = shared_builder
    encoder._encode_model_type = "gemma3"
    encoder._prompt_enhancer_gemma_root = None
    encoder._text_encoder_ctx = lambda: fake_context(FakeTextEncoder())
    encoder._build_embeddings_processor = lambda: FakeEmbeddingsProcessor()

    def fake_gpu_model(model: object, alloc_trim_strategy: object | None = None):
        return fake_context(model)

    monkeypatch.setattr(blocks, "gpu_model", fake_gpu_model)

    blocks.PromptEncoder.__call__(
        encoder,
        ["prompt"],
        enhance_first_prompt=True,
        enhance_prompt_seed=17,
    )

    assert events == ["enhance:prompt:17", "encode:enhanced prompt"]


def test_official_comfy_enhancement_uses_lora_encoder_only_for_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[tuple[str, object]] = []

    class FakeEnhancementEncoder:
        def enhance_t2v(self, prompt: str, **options: object) -> str:
            events.append(("enhance", (prompt, options)))
            return f"enhanced {prompt}"

        def encode(self, _prompts: list[str]) -> object:
            raise AssertionError("The LoRA enhancement encoder must not encode diffusion conditioning.")

    class FakeEncodingEncoder:
        def enhance_t2v(self, _prompt: str, **_options: object) -> str:
            raise AssertionError("The base encoder must not perform official prompt enhancement.")

        def encode(self, prompts: list[str]) -> list[tuple[tuple[str, ...], str]]:
            events.append(("encode", prompts))
            return [((prompt,), "mask") for prompt in prompts]

    class FakeEmbeddingsProcessor:
        def process_hidden_states(self, hidden_states: tuple[str, ...], mask: str) -> tuple[tuple[str, ...], str]:
            return hidden_states, mask

    @contextmanager
    def fake_context(model: object):
        yield model

    encoder = object.__new__(blocks.PromptEncoder)
    encoder._text_encoder_path = "gemma"
    encoder._embeddings_paths = ("checkpoint",)
    encoder._alloc_trim_strategy = None
    encoder._text_encoder_builder = object()
    encoder._enhancer_text_encoder_builder = object()
    encoder._encode_model_type = "gemma3"
    encoder._prompt_enhancer_gemma_root = None
    encoder._build_enhancer_text_encoder = lambda: FakeEnhancementEncoder()
    encoder._text_encoder_ctx = lambda: fake_context(FakeEncodingEncoder())
    encoder._build_embeddings_processor = lambda: FakeEmbeddingsProcessor()

    def fake_gpu_model(model: object, alloc_trim_strategy: object | None = None):
        return fake_context(model)

    monkeypatch.setattr(blocks, "gpu_model", fake_gpu_model)

    blocks.PromptEncoder.__call__(
        encoder,
        ["prompt"],
        enhance_first_prompt=True,
        enhance_prompt_image=None,
        enhance_prompt_seed=99,
    )

    assert events == [
        (
            "enhance",
            (
                "prompt",
                {
                    "seed": 99,
                    "static_cache": False,
                },
            ),
        ),
        ("encode", ["enhanced prompt"]),
    ]
