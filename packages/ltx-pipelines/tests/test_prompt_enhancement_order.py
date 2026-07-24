from contextlib import contextmanager
import sys
import types

import pytest

sys.modules.setdefault("OpenImageIO", types.ModuleType("OpenImageIO"))

from ltx_pipelines.utils import blocks


def test_gemma_enhancement_reuses_text_encoder_for_encoding(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[str] = []

    class FakeTextEncoder:
        def enhance_t2v(self, prompt: str, seed: int) -> str:
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
    encoder._gemma_root = "gemma"
    encoder._checkpoint_path = "checkpoint"
    encoder._alloc_trim_strategy = None
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
