"""Check declared physical boundaries using an ordinary ZIP and synthetic offsets."""
from copy import copy
import io
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch
import zipfile


PARSER = runpy.run_path(str(Path(__file__).resolve().parents[2] / "scripts/inspect-python-release.py"))


class ZipLayoutTests(unittest.TestCase):
    def test_central_directory_must_start_at_the_end_of_the_last_record(self):
        check = PARSER["check_zip_records"]
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

    def test_directory_consumes_exactly_the_declared_extent(self):
        check = PARSER["check_zip_directory"]
        source = io.BytesIO()
        with zipfile.ZipFile(source, "w") as writer:
            info = zipfile.ZipInfo("items.txt")
            info.comment = b"per-file note"
            writer.writestr(info, "alpha")
        footer_offset = len(source.getvalue()) - 22
        footer = source.getvalue()[footer_offset:]
        with zipfile.ZipFile(source) as archive:
            check(source, archive, footer, footer_offset)
            with self.assertRaises(ValueError):
                check(source, archive, footer, footer_offset + 1)
            archive.infolist()[0].comment = b"short"
            with self.assertRaises(ValueError):
                check(source, archive, footer, footer_offset)

    def test_zip64_end_records(self):
        source = io.BytesIO()
        with patch.object(zipfile, "ZIP64_LIMIT", 32), zipfile.ZipFile(source, "w") as writer:
            writer.writestr("items.txt", "a" * 64)
        footer_offset = len(source.getvalue()) - 22
        with zipfile.ZipFile(source) as archive:
            PARSER["check_zip_directory"](source, archive, source.getvalue()[footer_offset:], footer_offset)

    def test_directory_local_name_must_match_the_central_name(self):
        source = io.BytesIO()
        with zipfile.ZipFile(source, "w") as writer:
            writer.writestr("资料/", b"")
        with zipfile.ZipFile(source) as archive:
            self.assertEqual([entry.filename for entry, _ in PARSER["zip_members"](archive)], ["资料/"])
            record = archive.infolist()[0]
            record.filename = record.orig_filename = "other/"
            with self.assertRaises(zipfile.BadZipFile):
                list(PARSER["zip_members"](archive))
