"""Produce small, inert local fixtures for the declared archive checks."""
import gzip
import io
import sys
import sqlite3
import tarfile
import zipapp
import zipfile
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
