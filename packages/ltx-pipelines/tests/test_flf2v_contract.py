from ltx_pipelines.flf2v import _official_flf_stepper


def test_flf_steps_match_the_published_deterministic_template() -> None:
    stepper = _official_flf_stepper()

    assert stepper.eta == 0.0
    assert stepper.s_noise == 1.0
