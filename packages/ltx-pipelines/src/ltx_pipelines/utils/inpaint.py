from __future__ import annotations

import math

import torch
import torch.nn.functional as F
from kornia.geometry.transform.pyramid import (
    PyrUp,
    build_laplacian_pyramid,
    build_pyramid,
    find_next_powerof_two,
    is_powerof_two,
    pad,
)

# Official #66FF00 training color expressed in the [-1, 1] range that
# video_preprocess delivers to every caller of green_screen_inpaint.
_GREEN = (2 * 102 / 255 - 1, 1.0, -1.0)
_MASK_LOW_RES_LONG_SIDE = 64


def resize_video(video: torch.Tensor, height: int, width: int, mode: str = "bilinear") -> torch.Tensor:
    """Resize ``B,C,F,H,W`` video tensors spatially without changing time."""
    batch, channels, frames, _, _ = video.shape
    flat = video.permute(0, 2, 1, 3, 4).reshape(batch * frames, channels, *video.shape[-2:])
    kwargs = {} if mode == "nearest" else {"align_corners": False}
    resized = F.interpolate(flat, size=(height, width), mode=mode, **kwargs)
    return resized.reshape(batch, frames, channels, height, width).permute(0, 2, 1, 3, 4)


def dilate_video_mask(mask: torch.Tensor, spatial_radius: int) -> torch.Tensor:
    """Spatially dilate a ``B,1,F,H,W`` mask and return a binary mask."""
    if spatial_radius <= 0:
        return (mask > 0.5).to(mask.dtype)
    batch, channels, frames, height, width = mask.shape
    flat = mask.permute(0, 2, 1, 3, 4).reshape(batch * frames, channels, height, width)
    dilated = F.max_pool2d(
        flat,
        kernel_size=spatial_radius * 2 + 1,
        stride=1,
        padding=spatial_radius,
    )
    return (dilated > 0.5).to(mask.dtype).reshape(
        batch,
        frames,
        channels,
        height,
        width,
    ).permute(0, 2, 1, 3, 4)


def green_screen_inpaint(video: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """Replace white-mask regions with the official ``#66FF00`` training color.

    ``video`` must be in the ``[-1, 1]`` range produced by ``video_preprocess``.
    """
    if mask.shape[2] == 1 and video.shape[2] > 1:
        mask = mask.expand(-1, -1, video.shape[2], -1, -1)
    frames = min(video.shape[2], mask.shape[2])
    video = video[:, :, :frames]
    mask = mask[:, :, :frames]
    green = torch.tensor(_GREEN, dtype=video.dtype, device=video.device).view(1, 3, 1, 1, 1)
    return video * (1 - mask) + green * mask


def _pad_to_powers_of_two(image: torch.Tensor) -> tuple[torch.Tensor, tuple[int, int]]:
    height, width = image.shape[-2:]
    pad_right = 0 if is_powerof_two(width) else find_next_powerof_two(width) - width
    pad_bottom = 0 if is_powerof_two(height) else find_next_powerof_two(height) - height
    if pad_right or pad_bottom:
        image = pad(image, (0, pad_right, 0, pad_bottom), "reflect")
    return image, (pad_right, pad_bottom)


def _gaussian_pyramid(images: torch.Tensor, max_level: int) -> list[torch.Tensor]:
    images, _ = _pad_to_powers_of_two(images)
    return build_pyramid(images, max_level, "reflect", False)


def _dilate_blend_mask(mask: torch.Tensor, spatial_radius: int) -> torch.Tensor:
    if spatial_radius <= 0:
        return mask
    height, width = mask.shape[-2:]
    scale = _MASK_LOW_RES_LONG_SIDE / max(height, width)
    low_size = (max(1, round(height * scale)), max(1, round(width * scale)))
    low = F.interpolate(mask.float(), size=low_size, mode="bilinear", align_corners=False)
    low = F.max_pool2d(
        low,
        kernel_size=spatial_radius * 2 + 1,
        stride=1,
        padding=spatial_radius,
    )
    return F.interpolate(low, size=(height, width), mode="bilinear", align_corners=False)


def laplacian_pyramid_blend(
    generated: torch.Tensor,
    preserved: torch.Tensor,
    mask: torch.Tensor,
    *,
    mask_low_res_dilation: int,
    max_level: int = 7,
) -> torch.Tensor:
    """Blend ``F,C,H,W`` videos; white mask selects the generated video."""
    frames = min(generated.shape[0], preserved.shape[0], mask.shape[0])
    generated = generated[:frames]
    preserved = preserved[:frames]
    mask = mask[:frames]
    if generated.shape != preserved.shape:
        raise ValueError(f"Blend inputs must match, got {generated.shape} and {preserved.shape}")
    if mask.ndim == 3:
        mask = mask.unsqueeze(1)
    if generated.shape[-2:] != mask.shape[-2:]:
        raise ValueError("Blend mask must match the video resolution")

    original_height, original_width = generated.shape[-2:]
    padded_generated, padding = _pad_to_powers_of_two(generated)
    padded_preserved, _ = _pad_to_powers_of_two(preserved)
    if any(padding):
        mask = F.pad(mask, (0, padding[0], 0, padding[1]), mode="reflect")
    mask = _dilate_blend_mask(mask, mask_low_res_dilation)
    max_level = min(max_level, int(math.log2(min(padded_generated.shape[-2:]))))

    generated_pyramid = build_laplacian_pyramid(padded_generated, max_level=max_level)
    preserved_pyramid = build_laplacian_pyramid(padded_preserved, max_level=max_level)
    mask_pyramid = _gaussian_pyramid(mask, max_level)
    output = (
        generated_pyramid[-1] * mask_pyramid[-1]
        + preserved_pyramid[-1] * (1 - mask_pyramid[-1])
    )
    pyr_up = PyrUp()
    for index in range(len(generated_pyramid) - 2, -1, -1):
        residual = (
            generated_pyramid[index] * mask_pyramid[index]
            + preserved_pyramid[index] * (1 - mask_pyramid[index])
        )
        output = pyr_up(output) + residual
    return output[..., :original_height, :original_width].clamp(0, 1)
