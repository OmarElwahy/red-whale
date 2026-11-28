"""
What gau and katana (tools/urls/) share: the static extensions neither reports, and how a URL is spelled.

Standard library only. Each run.py puts tools/urls/ on sys.path and imports this module.
"""

from urllib.parse import urlsplit

# Images, fonts, audio and video: never a finding, and katana never requests them (gau --blacklist, katana -ef).
# CSS, JavaScript and PDF are NOT in the list: they can name endpoints or hold content worth reading.
STATIC_EXTENSIONS = (
    "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "bmp", "tif", "tiff", "avif",
    "woff", "woff2", "ttf", "otf", "eot",
    "mp3", "mp4", "m4a", "m4v", "avi", "mov", "mkv", "webm", "wav", "ogg", "flac",
)
STATIC_ARG = ",".join(STATIC_EXTENSIONS)

DEFAULT_PORTS = {"http": 80, "https": 443}


def canonical_url(value):
    """(url, host) as the server stores the URL (WHATWG href: lowercase scheme and host, no default port, at least
    "/" as the path, no fragment), or None for anything that isn't an http(s) URL with a host.

    The host is returned without the port, for "is this the target's host?". Values that pass here can still break
    the contract (a space, a '%' in the host): the caller checks with validate_output.check_value.
    """
    try:
        parts = urlsplit(str(value).strip())
        scheme = parts.scheme.lower()
        host = (parts.hostname or "").rstrip(".")
        port = parts.port  # raises ValueError for a port that isn't a number or is out of range
    except ValueError:
        return None
    if scheme not in DEFAULT_PORTS or not host or parts.username is not None or parts.password is not None:
        return None
    if ":" in host:  # IPv6 literal: keep its brackets
        netloc_host = f"[{host}]"
    else:
        netloc_host = host
    netloc = netloc_host if port is None or port == DEFAULT_PORTS[scheme] else f"{netloc_host}:{port}"
    query = f"?{parts.query}" if parts.query else ""
    return f"{scheme}://{netloc}{parts.path or '/'}{query}", host
