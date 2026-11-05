"""Produce bounded malformed copies of a known fixture for inspector tests."""
from pathlib import Path
import io
import gzip
import json
import runpy
import stat
import struct
import sys
import tarfile
import zipfile

config = json.loads(Path(sys.argv[1]).read_text())
source, output, mode = Path(config["source"]), Path(config["output"]), config["mode"]

if mode in ("pax-budget", "zip-directory-budget"):
    helper = runpy.run_path(config["helper"])
    inspect = helper["inspect"]
    if mode == "pax-budget":
        inspect.__globals__["MAX_EXPANDED"] = 32768
        with tarfile.open(output, "w:gz", pax_headers={"comment": "x" * 65536}) as archive:
            archive.addfile(tarfile.TarInfo(source.name[:-7] + "/file"))
    else:
        inspect.__globals__["MAX_ZIP_READ"] = 65557
        with zipfile.ZipFile(output, "w") as archive:
            for index in range(2000):
                archive.writestr(f"extra/{index}.py", "")
    try:
        inspect(output)
    except ValueError as error:
        assert str(error) == "archive read budget exceeded", str(error)
        print("bounded")
        sys.exit(0)
    raise AssertionError("archive exceeded the configured reader budget")

if mode == "gzip-crc":
    data = bytearray(gzip.compress(gzip.decompress(source.read_bytes()) + bytes(65536)))
    data[-8] ^= 1
    output.write_bytes(data)
    sys.exit(0)


def content(name, value):
    if name.endswith(("/METADATA", "/PKG-INFO")):
        if mode == "name": return value.replace(b"Name: splrad-uv-fixture", b"Name: another-package")
        if mode == "version": return value.replace(b"Version: 1.2.3", b"Version: 9.9.9")
        if mode == "duplicate-version": return value.replace(b"Version: 1.2.3", b"Version: 1.2.3\nVersion: 9.9.9")
        if mode == "normalized": return value.replace(b"Name: splrad-uv-fixture", b"Name: SPLRAD_UV_Fixture").replace(b"1.2.4rc1", b"1.2.4RC1")
        if mode == "metadata-limit": return value + b"x" * (512 * 1024)
    return value


if source.suffix == ".whl":
    with zipfile.ZipFile(source) as before, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as after:
        for info in before.infolist():
            value = before.read(info)
            if mode == "missing-metadata" and info.filename.endswith("/METADATA"): continue
            after.writestr(info, content(info.filename, value))
            if mode == "duplicate-path" and info.filename.endswith("/METADATA"): after.writestr(info, value)
        if mode == "traversal": after.writestr("../outside.py", "raise RuntimeError('must not run')")
        if mode == "absolute": after.writestr("/outside.py", "raise RuntimeError('must not run')")
        if mode == "symlink":
            info = zipfile.ZipInfo("link.py");info.create_system=3;info.external_attr=(stat.S_IFLNK | 0o777) << 16
            after.writestr(info, "../../outside.py")
        if mode == "entry-limit":
            for index in range(4097): after.writestr(f"extra/{index}.py", "")
        if mode == "no-execution": after.writestr("untrusted.py", "raise RuntimeError('must not run')")
        if mode == "windows-normalization":
            after.writestr("pkg/a?.py", "first byte stream")
            after.writestr("pkg/a_.py", "different byte stream")
    if mode == "expanded-limit":
        data=bytearray(output.read_bytes());index=data.index(b"PK\x01\x02")
        struct.pack_into("<I",data,index+24,256*1024*1024+1);output.write_bytes(data)
    if mode == "unsupported-compression":
        data=bytearray(output.read_bytes());index=data.index(b"PK\x01\x02")
        struct.pack_into("<H",data,index+10,99)
        struct.pack_into("<H",data,data.index(b"PK\x03\x04")+8,99);output.write_bytes(data)
else:
    with tarfile.open(source,"r:gz") as before, tarfile.open(output,"w:gz") as after:
        root=source.name[:-7]
        for info in before:
            value=before.extractfile(info).read() if info.isfile() else b""
            if mode=="missing-metadata" and info.name.endswith("/PKG-INFO"): continue
            value=content(info.name,value);info.size=len(value)
            after.addfile(info,io.BytesIO(value))
            if mode=="duplicate-path" and info.name.endswith("/PKG-INFO"):after.addfile(info,io.BytesIO(value))
        if mode in ("traversal","absolute","symlink","no-execution"):
            path="../outside.py" if mode=="traversal" else "/outside.py" if mode=="absolute" else root+"/untrusted.py"
            info=tarfile.TarInfo(path)
            value=b"raise RuntimeError('must not run')"
            if mode=="symlink":info.type=tarfile.SYMTYPE;info.linkname="../../outside.py";value=b""
            info.size=len(value);after.addfile(info,io.BytesIO(value))
        if mode == "windows-normalization":
            for name, value in [("pkg/a?.py", b"first byte stream"), ("pkg/a_.py", b"different byte stream")]:
                info=tarfile.TarInfo(root+"/"+name);info.size=len(value);after.addfile(info,io.BytesIO(value))
