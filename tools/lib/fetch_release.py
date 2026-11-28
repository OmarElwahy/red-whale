"""
Image build helper (used by the Dockerfiles, never at run time): download a release archive, refuse it unless its
sha256 matches the pinned one, and extract one program from it, or (--tree) a whole data tree such as a template set.

    python fetch_release.py <url> <sha256> <member name in the archive> <destination path>
    python fetch_release.py --tree <url> <sha256> <top folder in the archive> <destination folder>

--tree takes a .tar.gz whose entries all sit under one top folder (a GitHub source archive), and writes that folder's
contents to the destination. It refuses the whole archive if any entry is outside that folder, has an absolute path or
"..", or is anything but a regular file or a folder (no links, devices or FIFOs). Files are written 0644, folders 0755.
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


def _download(url, sha256):
    with urllib.request.urlopen(url, timeout=300) as resp:  # noqa: S310 (pinned https URLs from the Dockerfile)
        data = resp.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != sha256.lower():
        sys.exit(f"checksum mismatch for {url}\n  expected {sha256}\n  got      {digest}")
    return data, digest


def tree_members(tf, top):
    """The archive's (member, path under top) pairs; exits on anything unsafe or unexpected."""
    prefix = top.rstrip("/") + "/"
    out = []
    for m in tf.getmembers():
        name = m.name
        parts = name.split("/")
        if name.startswith("/") or "\\" in name or ".." in parts:
            sys.exit(f"unsafe path in archive: {name!r}")
        if not (m.isfile() or m.isdir()):
            sys.exit(f"not a regular file or folder in archive: {name!r}")
        if name.rstrip("/") == top.rstrip("/"):
            continue
        if not name.startswith(prefix):
            sys.exit(f"entry outside {top!r} in archive: {name!r}")
        rel = name[len(prefix):].rstrip("/")
        if rel:
            out.append((m, rel))
    return out


def extract_tree(data, top, dest):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
        members = tree_members(tf, top)
        if not any(m.isfile() for m, _ in members):
            sys.exit(f"no files under {top!r}")
        os.makedirs(dest, exist_ok=True)
        count = 0
        for m, rel in members:
            path = os.path.join(dest, *rel.split("/"))
            if m.isdir():
                os.makedirs(path, exist_ok=True)
                os.chmod(path, 0o755)
                continue
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as fh:
                fh.write(tf.extractfile(m).read())
            os.chmod(path, 0o644)
            count += 1
    return count


def main_tree(url, sha256, top, dest):
    if not url.endswith((".tgz", ".tar.gz")):
        sys.exit(f"--tree takes a .tar.gz: {url}")
    data, digest = _download(url, sha256)
    count = extract_tree(data, top, dest)
    print(f"ok {count} files from {top} to {dest} sha256 of archive {digest}")


if __name__ == "__main__":
    if len(sys.argv) == 6 and sys.argv[1] == "--tree":
        main_tree(*sys.argv[2:])
    elif len(sys.argv) == 5:
        main(*sys.argv[1:])
    else:
        sys.exit(__doc__.strip())
