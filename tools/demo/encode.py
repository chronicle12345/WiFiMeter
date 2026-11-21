"""Encode screenshots with one palette so static UI colors stay stable."""
import json
import sys
from pathlib import Path
from PIL import Image

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
frames = [Image.open(frame["path"]).convert("RGB") for frame in manifest["frames"]]
samples = frames[::max(1, len(frames) // 8)]
palette_source = Image.new("RGB", (frames[0].width, frames[0].height * len(samples)))
for index, frame in enumerate(samples):
    palette_source.paste(frame, (0, frame.height * index))
palette = palette_source.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
indexed[0].save(manifest["output"], save_all=True, append_images=indexed[1:],
                duration=[frame["duration"] for frame in manifest["frames"]],
                loop=0, optimize=True, disposal=1)
print(f'{Path(manifest["output"]).name}: {Path(manifest["output"]).stat().st_size:,} bytes')
