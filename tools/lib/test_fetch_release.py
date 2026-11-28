"""fetch_release.py --tree: only regular files and folders under the one top folder are ever written."""

import io
import os
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_release as fr  # noqa: E402


def make_tar(entries):
    """entries: (name, kind, content) with kind file / dir / symlink / fifo."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, kind, content in entries:
            info = tarfile.TarInfo(name)
            if kind == "dir":
                info.type = tarfile.DIRTYPE
                tf.addfile(info)
            elif kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = content
                tf.addfile(info)
            elif kind == "fifo":
                info.type = tarfile.FIFOTYPE
                tf.addfile(info)
            else:
                data = content.encode()
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


GOOD = [
    ("t-1.0/", "dir", ""),
    ("t-1.0/.nuclei-ignore", "file", "tags: []\n"),
    ("t-1.0/http/", "dir", ""),
    ("t-1.0/http/a.yaml", "file", "id: a\n"),
    ("t-1.0/http/x/b.yaml", "file", "id: b\n"),
]


class TreeTest(unittest.TestCase):
    def extract(self, entries):
        with tempfile.TemporaryDirectory() as d:
            dest = os.path.join(d, "out")
            count = fr.extract_tree(make_tar(entries), "t-1.0", dest)
            files = sorted(str(p.relative_to(dest)).replace("\\", "/") for p in Path(dest).rglob("*") if p.is_file())
            return count, files

    def test_the_top_folder_contents_land_in_dest(self):
        count, files = self.extract(GOOD)
        self.assertEqual(count, 3)
        self.assertEqual(files, [".nuclei-ignore", "http/a.yaml", "http/x/b.yaml"])

    def test_unsafe_or_unexpected_entries_refuse_the_whole_archive(self):
        for bad in [
            ("t-1.0/../evil", "file", "x"),
            ("/etc/evil", "file", "x"),
            ("other/evil", "file", "x"),
            ("t-1.0/http/link", "symlink", "/etc/passwd"),
            ("t-1.0/http/fifo", "fifo", ""),
            ("t-1.0\\..\\evil", "file", "x"),
        ]:
            with self.subTest(bad=bad[0]), self.assertRaises(SystemExit):
                self.extract([*GOOD, bad])

    def test_an_archive_without_files_is_refused(self):
        with self.assertRaises(SystemExit):
            self.extract([("t-1.0/", "dir", "")])


if __name__ == "__main__":
    unittest.main()
