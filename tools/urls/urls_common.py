"""
What gau and katana (tools/urls/) share: the static extensions neither reports, and how a URL is spelled.

Standard library only. Each run.py puts tools/urls/ on sys.path and imports this module. canonical_url lives in
tools/lib/redwhale_tool.py (nuclei uses it too) and is re-exported here.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from redwhale_tool import DEFAULT_PORTS, canonical_url  # noqa: E402,F401

# Images, fonts, audio and video: never a finding, and katana never requests them (gau --blacklist, katana -ef).
# CSS, JavaScript and PDF are NOT in the list: they can name endpoints or hold content worth reading.
STATIC_EXTENSIONS = (
    "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "bmp", "tif", "tiff", "avif",
    "woff", "woff2", "ttf", "otf", "eot",
    "mp3", "mp4", "m4a", "m4v", "avi", "mov", "mkv", "webm", "wav", "ogg", "flac",
)
STATIC_ARG = ",".join(STATIC_EXTENSIONS)

