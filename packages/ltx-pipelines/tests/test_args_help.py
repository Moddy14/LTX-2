import sys
import types

sys.modules.setdefault("OpenImageIO", types.ModuleType("OpenImageIO"))

from ltx_pipelines.utils.args import default_1_stage_arg_parser


def test_cli_help_formats_guidance_modulo_expression() -> None:
    help_text = default_1_stage_arg_parser().format_help()
    normalized_help = " ".join(help_text.split())

    assert "step_index % (N + 1) == 0" in normalized_help
    assert "--enhance-prompt" in help_text
    assert "same Gemma text encoder" in normalized_help
