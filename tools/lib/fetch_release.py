"""
Image build helper (used by the Dockerfiles, never at run time): download a release archive, refuse it unless its
sha256 matches the pinned one, and extract one program from it.

    python fetch_release.py <url> <sha256> <member name in the archive> <destination path>
"""

import hashlib
import io
import os
import sys
import tarfile
import urllib.request
import zipfile


def main(url, sha256, member, dest):
    with urllib.request.urlopen(url, timeout=120) as resp:  # noqa: S310 (pinned https URLs from the Dockerfile)
        data = resp.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != sha256.lower():
        sys.exit(f"checksum mismatch for {url}\n  expected {sha256}\n  got      {digest}")

    if url.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            names = [n for n in zf.namelist() if os.path.basename(n) == member]
            if len(names) != 1:
                sys.exit(f"{member} not found (once) in {url}: {zf.namelist()}")
            content = zf.read(names[0])
    elif url.endswith((".tgz", ".tar.gz")):
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
            files = [m for m in tf.getmembers() if m.isfile() and os.path.basename(m.name) == member]
            if len(files) != 1:
                sys.exit(f"{member} not found (once) in {url}: {tf.getnames()}")
            content = tf.extractfile(files[0]).read()
    else:
        sys.exit(f"unknown archive type: {url}")

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as fh:
        fh.write(content)
    os.chmod(dest, 0o755)
    print(f"ok {member} ({len(content)} bytes) sha256 of archive {digest}")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        sys.exit(__doc__.strip())
    main(*sys.argv[1:])
