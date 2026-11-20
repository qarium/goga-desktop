"""Compose a README tour from actual renderer captures. Requires Python 3.9+ and Pillow 10.1+."""
import argparse
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
# The app is shown at its actual aspect ratio; captions are outside its bounds.
W, H = 1088, 804
VIEW = (16, 78, 1072, 738)
BG, SURFACE, TEXT, SUBTLE, TEAL = "#0b111e", "#243349", "#f1f6fb", "#bdcbda", "#23d5bd"


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def font(size, bold, custom):
    if custom:
        return ImageFont.truetype(custom, size)
    for name in (["DejaVuSans-Bold.ttf", "Arial Bold.ttf", "arialbd.ttf"] if bold
                 else ["DejaVuSans.ttf", "Arial.ttf", "arial.ttf"]):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def fit_text(draw, text, max_width, max_lines, initial, minimum, bold, custom):
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Each caption needs nonempty text")
    for size in range(initial, minimum - 1, -1):
        face = font(size, bold, custom)
        lines = []
        for paragraph in text.splitlines():
            words = paragraph.split()
            current = ""
            for word in words:
                trial = (current + " " + word).lstrip()
                if current and draw.textlength(trial, font=face) > max_width:
                    lines.append(current)
                    current = word
                else:
                    current = trial
            lines.append(current)
        if len(lines) <= max_lines and all(draw.textlength(line, font=face) <= max_width for line in lines):
            return face, lines
    raise ValueError(f"Caption will not fit in {max_lines} line(s): {text!r}. Shorten it or add a line break.")


def make_frame(scene, copy, photo, progress, count, faces, zoom):
    title, caption = copy["scenes"][scene["id"]]
    regular, bold = faces
    frame = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(frame)
    face, lines = fit_text(d, copy["eyebrow"], W - 154, 1, 12, 10, True, bold)
    d.text((17, 11), lines[0], fill=TEAL, font=face, anchor="lt")
    face, lines = fit_text(d, title, W - 112, 1, 30, 20, True, bold)
    d.text((16, 34), lines[0], fill=TEXT, font=face, anchor="lt")
    d.text((W - 16, 47), f"{progress:02d} / {count:02d}", fill=SUBTLE, font=font(15, False, regular), anchor="rm")

    # Normalized x, y, width (height uses the same fraction at the capture aspect ratio).
    x, y, scale = scene["view"]
    if not (0 < scale <= 1 and 0 <= x <= 1-scale+1e-8 and 0 <= y <= 1-scale+1e-8):
        raise ValueError(f"Invalid crop in {scene['id']}")
    # A few shots start slightly wider, then settle. Avoid long moving sequences or looping.
    factor = 1.0 - (0.14 if scale < 0.85 else 0.0) * (1.0 - zoom)
    box = (x*factor*photo.width, y*factor*photo.height,
           (1-(1-x-scale)*factor)*photo.width, (1-(1-y-scale)*factor)*photo.height)
    left, top, right, bottom = VIEW
    pane = photo.resize((right-left, bottom-top), Image.Resampling.LANCZOS, box=box)
    frame.paste(pane, (left, top))
    d.rectangle((left-1, top-1, right, bottom), outline=SURFACE)
    face, lines = fit_text(d, caption, W-32, 2, 19, 16, False, regular)
    for i, line in enumerate(lines):
        d.text((16, 753+i*23), line, fill=SUBTLE, font=face, anchor="lt")
    return frame


def render(args):
    scenario = load(args.scenario)
    if scenario.get("version") != 1:
        raise ValueError("Unsupported scenario version")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", args.locale):
        raise ValueError("Invalid caption locale")
    copy = load(args.captions or HERE / "captions" / f"{args.locale}.json")
    scenes = scenario["scenes"]
    ids = [s["id"] for s in scenes]
    if not ids or len(set(ids)) != len(ids) or any(not re.fullmatch(r"[a-z0-9-]+", k) for k in ids):
        raise ValueError("Missing, duplicate or invalid scene IDs in scenario")
    if set(ids) != set(copy["scenes"]):
        raise ValueError("Scene IDs in the caption pack must match the scenario")
    if any(not isinstance(line, list) or len(line) != 2 for line in copy["scenes"].values()):
        raise ValueError("Each scene needs a [title, caption] pair")
    if tuple(scenario["viewport"]) != (1440, 900):
        raise ValueError("This layout expects a 1440 x 900 viewport")
    args.output.mkdir(parents=True, exist_ok=True)
    frames, times, stills = [], [], []
    for i, scene in enumerate(scenes, 1):
        source = args.frames / f"{scene['id']}.png"
        if not source.is_file():
            raise ValueError(f"Missing capture {source.name}; capture every scene before rendering")
        with Image.open(source) as image:
            if image.size != tuple(scenario["viewport"]):
                raise ValueError(f"{source.name}: expected {scenario['viewport']}, got {image.size}")
            photo = image.convert("RGB")
        zooms = [0, 0.22, 0.58, 0.86, 1] if scene["id"] in ("group", "launch-menu", "refinement") else [1]
        for j, zoom in enumerate(zooms):
            frame = make_frame(scene, copy, photo, i, len(scenes), (args.font, args.bold_font), zoom)
            frames.append(frame)
            times.append(scene["holdMs"] if j == len(zooms)-1 else (520 if j == 0 else 100))
        stills.append(frames[-1])

    atlas = Image.new("RGB", (272, 201*len(stills)))
    for i, still in enumerate(stills):
        atlas.paste(still.resize((272, 201), Image.Resampling.LANCZOS), (0, i*201))
    palette = atlas.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
    indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
    # Fresh canvases: no source comments, file names, EXIF or other metadata. No loop extension.
    gif = args.output / "desktop-tour.gif"
    indexed[0].save(gif, save_all=True, append_images=indexed[1:], duration=times, disposal=1, optimize=True)
    stills[0].save(args.output / "desktop-tour-poster.png", optimize=True)
    if args.contact_sheet:
        sheet = Image.new("RGB", (816, 302*((len(stills)+1)//2)), BG)
        for i, still in enumerate(stills):
            sheet.paste(still.resize((408, 302), Image.Resampling.LANCZOS), (408*(i%2), 302*(i//2)))
        sheet.save(args.contact_sheet)
    print(f"{len(scenes)} scenes, {sum(times)/1000:.1f}s, {gif.stat().st_size:,} bytes; caption locale: {args.locale}")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--frames", type=Path, required=True, help="Directory with one <scene-id>.png per capture")
    p.add_argument("--output", type=Path, required=True, help="Destination for the README GIF and still poster")
    p.add_argument("--scenario", type=Path, default=HERE / "scenario.json")
    p.add_argument("--locale", default="en", help="Caption locale, independent of the captured UI language")
    p.add_argument("--captions", type=Path, help="Override the JSON caption-pack path")
    p.add_argument("--font", help="Optional TrueType font file for captions in another script")
    p.add_argument("--bold-font", help="Optional TrueType font file for headings")
    p.add_argument("--contact-sheet", type=Path, help="Optional PNG for reviewing every scene before publication")
    try:
        render(p.parse_args())
    except (OSError, ValueError, KeyError) as error:
        p.exit(1, f"Cannot render README tour: {error}\n")
