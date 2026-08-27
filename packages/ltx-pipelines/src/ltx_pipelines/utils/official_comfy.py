from ltx_pipelines.utils.model_paths import ModelPaths


def resolve_official_comfy_cli_sampler(
    *,
    official_comfy_workflow: bool,
    requested_sampler: str | None,
    model_paths: ModelPaths,
    monolith_default: str,
    split_default: str,
) -> str:
    """Resolve an omitted official-workflow sampler from the model layout.

    The legacy monolith and LTX-2.5 split-pack workflows intentionally use
    different published samplers.  An explicit sampler is meaningful only
    together with the official-workflow switch; otherwise it is rejected
    instead of being silently ignored.
    """
    if requested_sampler is not None:
        if not official_comfy_workflow:
            raise SystemExit("--official-comfy-sampler requires --official-comfy-workflow")
        return requested_sampler
    if official_comfy_workflow and model_paths.mode == "split":
        return split_default
    return monolith_default
