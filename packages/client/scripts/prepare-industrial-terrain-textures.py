from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


TARGET_SIZE = 2048
EDGE_BLEND = 176


def feather_opposite_edges(pixels: np.ndarray, band: int) -> np.ndarray:
    result = pixels.astype(np.float32, copy=True)

    for offset in range(band):
        progress = offset / max(1, band - 1)
        keep = 0.5 - 0.5 * np.cos(np.pi * progress)
        left = result[:, offset].copy()
        right = result[:, -1 - offset].copy()
        average = (left + right) * 0.5
        result[:, offset] = average * (1 - keep) + left * keep
        result[:, -1 - offset] = average * (1 - keep) + right * keep

    for offset in range(band):
        progress = offset / max(1, band - 1)
        keep = 0.5 - 0.5 * np.cos(np.pi * progress)
        top = result[offset].copy()
        bottom = result[-1 - offset].copy()
        average = (top + bottom) * 0.5
        result[offset] = average * (1 - keep) + top * keep
        result[-1 - offset] = average * (1 - keep) + bottom * keep

    return np.clip(result, 0, 255).astype(np.uint8)


def make_normal_map(albedo: Image.Image) -> Image.Image:
    height = albedo.convert("L").filter(ImageFilter.GaussianBlur(radius=1.35))
    height_pixels = np.asarray(height, dtype=np.float32) / 255
    gradient_x = np.roll(height_pixels, -1, axis=1) - np.roll(height_pixels, 1, axis=1)
    gradient_y = np.roll(height_pixels, -1, axis=0) - np.roll(height_pixels, 1, axis=0)

    normal_x = -gradient_x * 9.5
    normal_y = gradient_y * 9.5
    normal_z = np.ones_like(height_pixels)
    length = np.sqrt(normal_x * normal_x + normal_y * normal_y + normal_z * normal_z)
    normal = np.stack(
        (
            normal_x / length * 0.5 + 0.5,
            normal_y / length * 0.5 + 0.5,
            normal_z / length * 0.5 + 0.5,
        ),
        axis=-1,
    )
    normal = feather_opposite_edges(
        np.clip(normal * 255, 0, 255).astype(np.uint8),
        EDGE_BLEND,
    ).astype(np.float32) / 255 * 2 - 1
    normal_length = np.linalg.norm(normal, axis=-1, keepdims=True)
    normal /= np.maximum(normal_length, 1e-6)
    return Image.fromarray(np.clip((normal * 0.5 + 0.5) * 255, 0, 255).astype(np.uint8), "RGB")


def make_roughness_map(albedo: Image.Image) -> Image.Image:
    luminance = np.asarray(albedo.convert("L"), dtype=np.float32)
    roughness = 218 + (luminance - luminance.mean()) * 0.18
    return Image.fromarray(np.clip(roughness, 178, 242).astype(np.uint8), "L")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Prepare seamless albedo, normal, and roughness maps for the industrial battlefield terrain."
    )
    parser.add_argument("source", type=Path, help="Generated top-down terrain image")
    parser.add_argument("output_dir", type=Path, help="Battlefield texture output directory")
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    source = Image.open(args.source).convert("RGB")
    source = source.resize((TARGET_SIZE, TARGET_SIZE), Image.Resampling.LANCZOS)

    graded = np.asarray(source, dtype=np.float32) / 255
    graded = np.power(graded, 0.86) * 255
    albedo = Image.fromarray(
        feather_opposite_edges(np.clip(graded, 0, 255).astype(np.uint8), EDGE_BLEND),
        "RGB",
    )
    normal = make_normal_map(albedo)
    roughness = make_roughness_map(albedo)

    albedo.save(args.output_dir / "terrain_industrial_albedo.jpg", quality=94, optimize=True)
    normal.save(args.output_dir / "terrain_industrial_normal.jpg", quality=94, optimize=True)
    roughness.save(args.output_dir / "terrain_industrial_roughness.jpg", quality=94, optimize=True)


if __name__ == "__main__":
    main()
