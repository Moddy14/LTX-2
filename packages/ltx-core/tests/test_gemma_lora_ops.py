from ltx_core.text_encoders.gemma import GEMMA_LORA_COMFY_KEY_OPS


def test_comfy_gemma_lora_keys_map_to_native_language_model() -> None:
    key = "text_encoders.transformer.model.layers.7.self_attn.q_proj.lora_down.weight"

    assert GEMMA_LORA_COMFY_KEY_OPS.apply_to_key(key) == (
        "model.model.language_model.layers.7.self_attn.q_proj.lora_A.weight"
    )


def test_comfy_gemma_lora_keys_map_to_native_vision_model() -> None:
    key = "text_encoders.transformer.vision_model.encoder.layers.2.mlp.fc2.lora_up.weight"
    mapped = GEMMA_LORA_COMFY_KEY_OPS.apply_to_key(key)

    assert mapped is not None
    assert mapped.startswith("model.model.vision_tower.")
    assert mapped.endswith("encoder.layers.2.mlp.fc2.lora_B.weight")


def test_unrelated_lora_key_is_filtered_out() -> None:
    assert GEMMA_LORA_COMFY_KEY_OPS.apply_to_key(
        "diffusion_model.transformer_blocks.0.attn1.to_q.lora_A.weight",
    ) is None
