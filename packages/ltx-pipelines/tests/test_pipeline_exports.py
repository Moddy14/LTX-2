from ltx_pipelines import DubItPipeline, FLF2VPipeline, LipDubPipeline


def test_lipdub_export_remains_a_dubit_compatibility_alias() -> None:
    assert LipDubPipeline is DubItPipeline


def test_flf2v_export_remains_available() -> None:
    assert FLF2VPipeline.__name__ == "FLF2VPipeline"
