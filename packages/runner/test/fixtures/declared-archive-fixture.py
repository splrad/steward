"""Produce small, inert local fixtures for the declared archive checks."""
import gzip
import io
import sys
import sqlite3
import struct
import tarfile
import zipapp
import zipfile
import zlib
from pathlib import Path

root = Path(sys.argv[1])
with tarfile.open(root / "cli.tar.gz", "w:gz") as archive:
    data = b"#!/bin/sh\nexit 0\n"
    entry = tarfile.TarInfo("bin/cli")
    entry.size = len(data)
    archive.addfile(entry, io.BytesIO(data))
    archive.addfile(tarfile.TarInfo("pkg/__init__.py"), io.BytesIO())
for name, entries in {
    "stations.zip": [("data.csv", b"id,name\n1,test\n"), ("VERSION", b"1.2.3\n"), ("pkg/__init__.py", b"")],
    "large.zip": [("data.txt", b"x" * (2 * 1024**2))],
    "ambiguous.zip": [("DATA.csv", b"a"), ("data.csv", b"b")],
    "bad-font.zip": [("font.ttf", b"ordinary text")],
}.items():
    with zipfile.ZipFile(root / name, "w") as archive:
        for member, data in entries:
            archive.writestr(member, data)
with zipfile.ZipFile(root / "vendor.zip", "w") as archive:
    archive.write(Path(__file__).with_name("native-release") / "fixture.dll", "vendor/fixture.dll")
    archive.writestr("VERSION", "2.0.0\n")

with zipfile.ZipFile(root / "application.msix", "w") as archive:
    archive.writestr("AppxManifest.xml", '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">'
                                       '<Identity Name="SPLRAD.Fixture" Publisher="CN=Example" Version="1.2.3.0" /></Package>')
    archive.writestr("[Content_Types].xml", "<Types/>")
    archive.writestr("AppxBlockMap.xml", "<BlockMap/>")


bundle = io.BytesIO()
with zipfile.ZipFile(bundle, "w") as archive:
    archive.write(root / "application.msix", "application.msix")
    archive.writestr("AppxMetadata/AppxBundleManifest.xml",
                     '<Bundle xmlns="http://schemas.microsoft.com/appx/2013/bundle" SchemaVersion="1.0">'
                     '<Identity Name="SPLRAD.Fixture" Publisher="CN=Example" Version="1.2.3.0" />'
                     '<Packages><Package Type="application" FileName="application.msix" Version="1.2.3.0" '
                     'Size="1" Offset="0" /></Packages></Bundle>')
    archive.writestr("[Content_Types].xml", "<Types/>")
    archive.writestr("AppxBlockMap.xml", "<BlockMap/>")
entries = bundle.getvalue()[:-22]
_, _, on_disk, total, size, offset = struct.unpack_from("<4H2I", bundle.getvalue(), len(entries) + 4)
locator = struct.pack("<4sIQI", b"PK\x06\x07", 0, len(entries), 1)
sentinel_footer = struct.pack("<4s4H2IH", b"PK\x05\x06", *([0xffff] * 4), 0xffffffff, 0xffffffff, 0)
for name, disk in (("application.msixbundle", 0), ("split.appxbundle", 1)):
    record = struct.pack("<4sQ2H2I4Q", b"PK\x06\x06", 44, 45, 45, disk, disk, on_disk, total, size, offset)
    (root / name).write_bytes(entries + record + locator + sentinel_footer)
(root / "missing-zip64.appxbundle").write_bytes(entries + sentinel_footer)
(root / "historical-zip64.zip").write_bytes((root / "application.msixbundle").read_bytes())


class LegacyPath(zipfile.ZipInfo):
    def _encodeFilenameFlags(self):
        return self.filename.encode("cp437"), self.flag_bits


for name, alias in (("unicode-font.zip", "中文/font.shx"), ("unicode-traversal.zip", "../font.shx")):
    path = "catalogue/font.shx"
    entry = LegacyPath(path)
    data = struct.pack("<BI", 1, zlib.crc32(path.encode("ascii"))) + alias.encode("utf-8")
    entry.extra = struct.pack("<HH", 0x7075, len(data)) + data
    with zipfile.ZipFile(root / name, "w") as archive:
        archive.writestr(entry, b"AutoCAD-86 shapes 1.0")

class StreamingOutput(io.BytesIO):
    def seek(self, *args):
        raise io.UnsupportedOperation("streaming writer")


for zip64 in (False, True):
    output = StreamingOutput()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        with archive.open("items.txt", "w", force_zip64=zip64) as member:
            member.write(b"alpha")
    (root / ("stream64.zip" if zip64 else "stream.zip")).write_bytes(output.getvalue())

with zipfile.ZipFile(root / "seekable64.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
    with archive.open("items.txt", "w", force_zip64=True) as member:
        member.write(b"alpha")

# A standard Python zipapp has an interpreter line before its ZIP members.
app = root / "example-app"
app.mkdir()
(app / "__main__.py").write_text("pass\n", encoding="utf-8")
zipapp.create_archive(app, root / "application.zip", interpreter="/usr/bin/env python3")

tar_bytes = gzip.decompress((root / "cli.tar.gz").read_bytes())
for name, offset in [("buffered-tail", 2048), ("later-tail", len(tar_bytes))]:
    payload = bytearray(tar_bytes + bytes(512))
    payload[offset] = 1
    (root / (name + ".tar.gz")).write_bytes(gzip.compress(payload))
(root / "broken.tar.gz").write_bytes((root / "cli.tar.gz").read_bytes()[:-7])

database = root / "stations.db"
with sqlite3.connect(database) as connection:
    connection.execute("CREATE TABLE stations (name TEXT)")
    connection.execute("INSERT INTO stations VALUES ('Lumut')")
connection.close()
with zipfile.ZipFile(root / "database.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.write(database, "data/stations.db")

with zipfile.ZipFile(root / "comment.zip", "w") as archive:
    archive.writestr("content", "data")
    archive.comment = b"product comment"
commented = (root / "comment.zip").read_bytes()
(root / "extra.zip").write_bytes(commented + b"unexpected trailing bytes")
(root / "short-comment.zip").write_bytes(commented[:-1])
