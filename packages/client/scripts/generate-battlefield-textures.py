from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


CLIENT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = CLIENT_ROOT / "public" / "assets" / "textures" / "battlefield"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def clamp(value: float) -> int:
    return max(0, min(255, round(value)))


def value_noise(size: int, seed: int, cells: int) -> Image.Image:
    rng = random.Random(seed)
    grid_size = cells + 1
    values = [[rng.randrange(256) for _ in range(grid_size)] for _ in range(grid_size)]
    image = Image.new("L", (size, size))
    pixels = image.load()
    scale = cells / size

    for y in range(size):
        gy = y * scale
        y0 = int(gy)
        fy = gy - y0
        sy = fy * fy * (3 - 2 * fy)
        for x in range(size):
            gx = x * scale
            x0 = int(gx)
            fx = gx - x0
            sx = fx * fx * (3 - 2 * fx)
            top = values[y0][x0] * (1 - sx) + values[y0][x0 + 1] * sx
            bottom = values[y0 + 1][x0] * (1 - sx) + values[y0 + 1][x0 + 1] * sx
            pixels[x, y] = clamp(top * (1 - sy) + bottom * sy)
    return image


def layered_noise(size: int, seed: int) -> Image.Image:
    layers = [
        (value_noise(size, seed + 3, 6), 0.5),
        (value_noise(size, seed + 17, 18), 0.3),
        (value_noise(size, seed + 31, 54), 0.2),
    ]
    result = Image.new("L", (size, size), 0)
    pixels = result.load()
    source_pixels = [(image.load(), weight) for image, weight in layers]
    for y in range(size):
        for x in range(size):
            pixels[x, y] = clamp(sum(source[x, y] * weight for source, weight in source_pixels))
    return result


def normal_from_height(height: Image.Image, strength: float = 2.5) -> Image.Image:
    source = height.load()
    width, height_px = height.size
    normal = Image.new("RGB", height.size)
    pixels = normal.load()
    for y in range(height_px):
        y0 = (y - 1) % height_px
        y1 = (y + 1) % height_px
        for x in range(width):
            x0 = (x - 1) % width
            x1 = (x + 1) % width
            dx = (source[x1, y] - source[x0, y]) / 255 * strength
            dy = (source[x, y1] - source[x, y0]) / 255 * strength
            length = math.sqrt(dx * dx + dy * dy + 1)
            pixels[x, y] = (
                clamp(((-dx / length) * 0.5 + 0.5) * 255),
                clamp(((dy / length) * 0.5 + 0.5) * 255),
                clamp((1 / length * 0.5 + 0.5) * 255),
            )
    return normal


def add_scratches(image: Image.Image, seed: int, count: int, color: tuple[int, int, int]) -> None:
    rng = random.Random(seed)
    draw = ImageDraw.Draw(image, "RGBA")
    width, height = image.size
    for _ in range(count):
        x = rng.randrange(width)
        y = rng.randrange(height)
        length = rng.randrange(max(5, width // 80), max(9, width // 16))
        angle = rng.uniform(-0.35, 0.35)
        draw.line(
            (x, y, x + math.cos(angle) * length, y + math.sin(angle) * length),
            fill=(*color, rng.randrange(35, 105)),
            width=rng.choice((1, 1, 2)),
        )


def save_surface(
    name: str,
    base: tuple[int, int, int],
    seed: int,
    *,
    size: int = 512,
    contrast: float = 0.2,
    roughness: int = 190,
    camo: bool = False,
    panels: bool = False,
) -> None:
    noise = layered_noise(size, seed)
    source = noise.load()
    albedo = Image.new("RGB", (size, size))
    pixels = albedo.load()

    for y in range(size):
        for x in range(size):
            n = (source[x, y] - 128) / 128
            color = [channel * (1 + n * contrast) for channel in base]
            if camo:
                field = math.sin(x * 0.031 + source[x, y] * 0.018) + math.cos(y * 0.027 - source[x, y] * 0.013)
                if field > 1.05:
                    color = [channel * 0.58 for channel in color]
                elif field < -1.05:
                    color = [min(255, channel * 1.35 + 10) for channel in color]
            pixels[x, y] = tuple(clamp(channel) for channel in color)

    if panels:
        draw = ImageDraw.Draw(albedo, "RGBA")
        step = size // 4
        for coordinate in range(step, size, step):
            draw.line((coordinate, 0, coordinate, size), fill=(8, 12, 12, 90), width=3)
            draw.line((0, coordinate, size, coordinate), fill=(8, 12, 12, 90), width=3)
        for y in range(step // 2, size, step):
            for x in range(step // 2, size, step):
                radius = max(2, size // 180)
                draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(210, 218, 210, 120))

    add_scratches(albedo, seed + 101, max(30, size // 5), (225, 225, 210))
    albedo.save(OUTPUT_DIR / f"{name}_albedo.png", optimize=True)

    height_map = noise.filter(ImageFilter.GaussianBlur(radius=0.8))
    if panels:
        height_draw = ImageDraw.Draw(height_map)
        step = size // 4
        for coordinate in range(step, size, step):
            height_draw.line((coordinate, 0, coordinate, size), fill=60, width=3)
            height_draw.line((0, coordinate, size, coordinate), fill=60, width=3)
    normal_from_height(height_map, 2.8 if panels else 1.8).save(
        OUTPUT_DIR / f"{name}_normal.png", optimize=True
    )

    rough = Image.new("L", (size, size))
    rough_pixels = rough.load()
    for y in range(size):
        for x in range(size):
            rough_pixels[x, y] = clamp(roughness + (source[x, y] - 128) * 0.22)
    rough.save(OUTPUT_DIR / f"{name}_roughness.png", optimize=True)


save_surface("team_armor", (205, 205, 198), 11, contrast=0.28, roughness=146, camo=True, panels=True)
save_surface("fabric", (76, 88, 72), 23, contrast=0.34, roughness=224, camo=True)
save_surface("dark_metal", (54, 61, 62), 37, contrast=0.38, roughness=126, panels=True)
save_surface("industrial", (108, 116, 111), 43, contrast=0.32, roughness=164, panels=True)
save_surface("concrete", (92, 96, 91), 59, contrast=0.5, roughness=226)
save_surface("terrain", (55, 82, 54), 71, size=1024, contrast=0.6, roughness=232, camo=True)
save_surface("road", (83, 76, 61), 83, size=1024, contrast=0.65, roughness=238)

print(f"Battlefield textures written to {OUTPUT_DIR}")
