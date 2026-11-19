"""Produce small, inert local fixtures for the declared archive checks."""
import gzip
import io
import sys
import sqlite3
import tarfile
import zipfile
from pathlib import Path

root = Path(sys.argv[1])
with tarfile.open(root / "cli.tar.gz", "w:gz") as archive:
    data = b"#!/bin/sh\nexit 0\n"
    entry = tarfile.TarInfo("bin/cli")
    entry.size = len(data)
    archive.addfile(entry, io.BytesIO(data))
for name, entries in {
    "stations.zip": [("data.csv", b"id,name\n1,test\n"), ("VERSION", b"1.2.3\n")],
    "large.zip": [("data.txt", b"x" * (2 * 1024**2))],
    "ambiguous.zip": [("DATA.csv", b"a"), ("data.csv", b"b")],
    "bad-font.zip": [("font.ttf", b"ordinary text")],
}.items():
    with zipfile.ZipFile(root / name, "w") as archive:
        for member, data in entries:
            archive.writestr(member, data)
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
