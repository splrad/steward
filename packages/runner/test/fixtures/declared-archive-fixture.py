"""Produce small, inert local fixtures for the declared archive checks."""
import io
import sys
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
    "ambiguous.zip": [("DATA.csv", b"a"), ("data.csv", b"b")],
    "bad-font.zip": [("font.ttf", b"ordinary text")],
}.items():
    with zipfile.ZipFile(root / name, "w") as archive:
        for member, data in entries:
            archive.writestr(member, data)
(root / "broken.tar.gz").write_bytes((root / "cli.tar.gz").read_bytes()[:-7])
