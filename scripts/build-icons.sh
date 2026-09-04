#!/usr/bin/env bash
# Regenerates the Android launcher icons from app/icons-src/*.svg.
#
# Run after changing any of those SVGs:
#
#     bash scripts/build-icons.sh
#
# Two things about Android launcher icons that are easy to get wrong, and
# were both wrong here before this script existed:
#
#   * An adaptive icon's foreground is a 108dp canvas of which launchers
#     only ever show the central 72dp — the outer ring is reserved for
#     masking and parallax. A mark scaled against the full canvas
#     therefore appears roughly 1.5x larger than intended and can touch
#     or cross the mask edge. The crown is sized against the *visible*
#     72dp, which is why `fg.svg` scales smaller than `app-icon.svg`.
#   * The legacy densities are not the adaptive ones. Legacy icons are
#     48dp; the previous set had hdpi at 49x49 instead of 72x72, so those
#     devices upscaled a near-mdpi image.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/app/icons-src"
res="$root/app/src-tauri/gen/android/app/src/main/res"

command -v rsvg-convert >/dev/null || { echo "need rsvg-convert" >&2; exit 1; }
command -v magick >/dev/null || { echo "need imagemagick" >&2; exit 1; }

# density:legacy(48dp):adaptive(108dp)
for spec in mdpi:48:108 hdpi:72:162 xhdpi:96:216 xxhdpi:144:324 xxxhdpi:192:432; do
  density="${spec%%:*}"; rest="${spec#*:}"
  legacy="${rest%%:*}"; adaptive="${rest##*:}"
  dir="$res/mipmap-$density"
  mkdir -p "$dir"

  rsvg-convert -w "$adaptive" -h "$adaptive" "$src/fg.svg" -o "$dir/ic_launcher_foreground.png"
  rsvg-convert -w "$adaptive" -h "$adaptive" "$src/bg.svg" -o "$dir/ic_launcher_background.png"
  rsvg-convert -w "$legacy"   -h "$legacy"   "$src/app-icon.svg" -o "$dir/ic_launcher.png"

  # The round variant is the same art circle-cropped, for launchers that
  # ask for it rather than applying their own mask.
  magick "$dir/ic_launcher.png" \
    \( -size "${legacy}x${legacy}" xc:none -fill white \
       -draw "circle $((legacy/2)),$((legacy/2)) $((legacy/2)),0" \) \
    -alpha off -compose CopyOpacity -composite "$dir/ic_launcher_round.png"

  printf '%-8s legacy=%sx%s adaptive=%sx%s\n' "$density" "$legacy" "$legacy" "$adaptive" "$adaptive"
done

# Keep the record in step with the art, which had drifted apart before.
python3 - "$src" <<'PY'
import json, pathlib, re, sys
src = pathlib.Path(sys.argv[1])
scale = lambda f: float(re.search(r'scale\(([\d.]+)\)', (src / f).read_text()).group(1))
manifest = src / 'manifest.json'
data = json.loads(manifest.read_text())
data['android_fg_scale'] = round(scale('fg.svg') * 100)
data['default_scale'] = round(scale('app-icon.svg') * 100)
manifest.write_text(json.dumps(data, indent=2) + '\n')
PY

echo "done."
