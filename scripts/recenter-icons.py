"""Keep the Kaigen brush ring geometrically centered in every Windows icon."""

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / "public" / "kaigen-icon.png"
ICONS = ROOT / "src-tauri" / "icons"


def bright_bounds(image: Image.Image, threshold: int = 80) -> tuple[int, int, int, int]:
    rgb = image.convert("RGB")
    pixels = rgb.load()
    xs: list[int] = []
    ys: list[int] = []
    for y in range(rgb.height):
        for x in range(rgb.width):
            red, green, blue = pixels[x, y]
            if (red + green + blue) / 3 > threshold and max(red, green, blue) - min(red, green, blue) < 80:
                xs.append(x)
                ys.append(y)
    if not xs:
        raise RuntimeError("The Kaigen ring could not be located")
    return min(xs), min(ys), max(xs), max(ys)


def recenter_master() -> Image.Image:
    image = Image.open(MASTER).convert("RGB")
    _, top, _, bottom = bright_bounds(image)
    ring_center = (top + bottom) / 2
    shift_y = round((image.height - 1) / 2 - ring_center)
    if shift_y:
        corrected = Image.new("RGB", image.size)
        if shift_y > 0:
            top_row = image.crop((0, 0, image.width, 1)).resize((image.width, shift_y))
            corrected.paste(top_row, (0, 0))
            corrected.paste(image.crop((0, 0, image.width, image.height - shift_y)), (0, shift_y))
        else:
            amount = -shift_y
            corrected.paste(image.crop((0, amount, image.width, image.height)), (0, 0))
            bottom_row = image.crop((0, image.height - 1, image.width, image.height)).resize((image.width, amount))
            corrected.paste(bottom_row, (0, image.height - amount))
        image = corrected
        image.save(MASTER, format="PNG", optimize=True)
    return image


def save_png(master: Image.Image, path: Path, size: tuple[int, int]) -> None:
    # Tauri's macOS context generator requires an explicit RGBA color type.
    # An opaque alpha channel preserves the existing artwork pixel-for-pixel.
    master.resize(size, Image.Resampling.LANCZOS).convert("RGBA").save(
        path, format="PNG", optimize=True
    )


def main() -> None:
    master = recenter_master()
    png_sizes = {
        "32x32.png": (32, 32),
        "64x64.png": (64, 64),
        "128x128.png": (128, 128),
        "128x128@2x.png": (256, 256),
        "icon.png": (512, 512),
        "Square30x30Logo.png": (30, 30),
        "Square44x44Logo.png": (44, 44),
        "Square71x71Logo.png": (71, 71),
        "Square89x89Logo.png": (89, 89),
        "Square107x107Logo.png": (107, 107),
        "Square142x142Logo.png": (142, 142),
        "Square150x150Logo.png": (150, 150),
        "Square284x284Logo.png": (284, 284),
        "Square310x310Logo.png": (310, 310),
        "StoreLogo.png": (50, 50),
    }
    for filename, size in png_sizes.items():
        save_png(master, ICONS / filename, size)
    master.save(
        ICONS / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    main()
