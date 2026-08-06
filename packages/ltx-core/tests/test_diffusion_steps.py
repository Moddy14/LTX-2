import torch

from ltx_core.components.diffusion_steps import (
    EulerAncestralRFDiffusionStep,
    EulerCfgPpDiffusionStep,
    EulerDiffusionStep,
)


def test_euler_ancestral_rf_matches_comfy_formula() -> None:
    sample = torch.tensor([0.25, -0.5], dtype=torch.float32)
    denoised = torch.tensor([0.75, 0.125], dtype=torch.float32)
    noise = torch.tensor([-0.2, 0.4], dtype=torch.float32)
    sigmas = torch.tensor([1.0, 0.725, 0.0], dtype=torch.float32)

    actual = EulerAncestralRFDiffusionStep().step(
        sample,
        denoised,
        sigmas,
        0,
        noise=noise,
    )

    sigma = sigmas[0]
    sigma_next = sigmas[1]
    downstep_ratio = 1 + (sigma_next / sigma - 1)
    sigma_down = sigma_next * downstep_ratio
    alpha_next = 1 - sigma_next
    alpha_down = 1 - sigma_down
    renoise = (
        sigma_next**2 - sigma_down**2 * alpha_next**2 / alpha_down**2
    ).sqrt()
    ratio = sigma_down / sigma
    expected = (alpha_next / alpha_down) * (
        ratio * sample + (1 - ratio) * denoised
    ) + noise * renoise

    torch.testing.assert_close(actual, expected)


def test_euler_ancestral_rf_eta_zero_matches_deterministic_euler() -> None:
    sample = torch.tensor([0.25, -0.5], dtype=torch.float32)
    denoised = torch.tensor([0.75, 0.125], dtype=torch.float32)
    sigmas = torch.tensor([1.0, 0.725, 0.0], dtype=torch.float32)

    ancestral = EulerAncestralRFDiffusionStep(eta=0).step(
        sample,
        denoised,
        sigmas,
        0,
    )
    deterministic = EulerDiffusionStep().step(sample, denoised, sigmas, 0)

    torch.testing.assert_close(ancestral, deterministic)


def test_euler_ancestral_rf_final_step_returns_denoised_sample() -> None:
    sample = torch.tensor([0.25], dtype=torch.float32)
    denoised = torch.tensor([0.75], dtype=torch.float32)
    sigmas = torch.tensor([0.725, 0.0], dtype=torch.float32)

    actual = EulerAncestralRFDiffusionStep().step(
        sample,
        denoised,
        sigmas,
        0,
    )

    torch.testing.assert_close(actual, denoised)


def test_euler_cfg_pp_defaults_match_comfy_ancestral_formula() -> None:
    sample = torch.tensor([0.25, -0.5], dtype=torch.float32)
    denoised = torch.tensor([0.75, 0.125], dtype=torch.float32)
    uncond = torch.tensor([0.1, -0.2], dtype=torch.float32)
    noise = torch.tensor([-0.2, 0.4], dtype=torch.float32)
    sigmas = torch.tensor([0.9875, 0.725, 0.0], dtype=torch.float32)

    stepper = EulerCfgPpDiffusionStep()
    actual = stepper.step(
        sample,
        denoised,
        sigmas,
        0,
        uncond_denoised=uncond,
        noise=noise,
    )

    sigma_s = sigmas[0]
    sigma_t = sigmas[1]
    alpha_s = 1 - sigma_s
    alpha_t = 1 - sigma_t
    derivative = (sample - alpha_s * uncond) / sigma_s
    sigma_from = sigma_s / alpha_s
    sigma_to = sigma_t / alpha_t
    sigma_up = min(
        sigma_to,
        (sigma_to**2 * (sigma_from**2 - sigma_to**2) / sigma_from**2).sqrt(),
    )
    sigma_down = (sigma_to**2 - sigma_up**2).sqrt() * alpha_t
    expected = (
        alpha_t * denoised
        + sigma_down * derivative
        + alpha_t * noise * sigma_up
    )

    assert stepper.eta == 1.0
    assert stepper.s_noise == 1.0
    torch.testing.assert_close(actual, expected)
