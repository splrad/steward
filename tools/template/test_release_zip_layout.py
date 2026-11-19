"""Check declared physical boundaries using an ordinary ZIP and synthetic offsets."""
from copy import copy
import io
from pathlib import Path
import runpy
import unittest
import zipfile


class ZipLayoutTests(unittest.TestCase):
    def test_central_directory_must_start_at_the_end_of_the_last_record(self):
        check = runpy.run_path(str(Path(__file__).resolve().parents[2] / "scripts/inspect-python-release.py"))["check_zip_records"]
        source = io.BytesIO()
        with zipfile.ZipFile(source, "w") as writer:
            writer.writestr("items.txt", "alpha")
        with zipfile.ZipFile(source) as archive:
            check(source, archive.infolist(), archive.start_dir)
            for difference in (-1, 1):
                with self.subTest(difference=difference), self.assertRaises(ValueError):
                    check(source, archive.infolist(), archive.start_dir + difference)
            for field in ("CRC", "compress_size", "file_size"):
                with self.subTest(field=field), self.assertRaises(ValueError):
                    record = copy(archive.infolist()[0])
                    setattr(record, field, getattr(record, field) + 1)
                    check(source, [record], archive.start_dir)
