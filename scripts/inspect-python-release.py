"""Inspect Python distribution metadata without extracting or executing package files."""
from pathlib import Path
import json
import gzip
import io
import stat
import sys
import tarfile
import zipfile
import zlib
import tomllib
import re

from packaging.metadata import Metadata
from packaging.utils import canonicalize_name, parse_sdist_filename, parse_wheel_filename
from packaging.version import Version

MAX_ENTRIES = 4096
MAX_EXPANDED = 256 * 1024 * 1024
MAX_METADATA = 512 * 1024
MAX_ZIP_READ = 1024 * 1024


def require(condition):
    if not condition:
        raise ValueError("invalid distribution")


class BoundedZipReader(io.BufferedReader):
    """Bound central-directory allocation before ZipFile creates its entry list."""

    def read(self, size=-1):
        if size < 0:
            position = self.tell()
            size = self.seek(0, 2) - position
            self.seek(position)
        if size > MAX_ZIP_READ:
            raise ValueError("archive read budget exceeded")
        return super().read(size)


class ExpandedReader:
    """Count gzip output, including tar headers that tarfile consumes internally."""

    def __init__(self, source):
        self.source = source
        self.remaining = MAX_EXPANDED

    def read(self, size):
        require(size >= 0)
        data = self.source.read(min(size, self.remaining + 1))
        if len(data) > self.remaining:
            raise ValueError("archive read budget exceeded")
        self.remaining -= len(data)
        return data


def member_path(name, seen):
    # Keep archive entries portable and unambiguous even though nothing is extracted.
    require(isinstance(name, str) and name and "\\" not in name and ":" not in name)
    require(all(ord(c) >= 32 and ord(c) != 127 for c in name))
    parts = name.rstrip("/").split("/")
    require(all(part and part not in (".", "..") for part in parts))
    key = "/".join(parts).casefold()
    require(key not in seen)
    seen.add(key)
    return parts


def read_member(stream, size, retain=False):
    require(size >= 0 and size <= MAX_EXPANDED and (not retain or size <= MAX_METADATA))
    data = bytearray()
    consumed = 0
    while chunk := stream.read(min(65536, size - consumed + 1)):
        consumed += len(chunk)
        require(consumed <= size)
        if retain:
            data.extend(chunk)
    require(consumed == size)
    return bytes(data)


def inspect(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= 1024**3)
    seen = set()
    expanded = 0
    metadata = None
    if path.name.endswith(".whl"):
        name, version, _, _ = parse_wheel_filename(path.name)
        with BoundedZipReader(io.FileIO(path, "r")) as bounded, zipfile.ZipFile(bounded) as archive:
            entries = archive.infolist()
            require(0 < len(entries) <= MAX_ENTRIES)
            info_roots = set()
            files = set()
            for entry in entries:
                parts = member_path(entry.filename, seen)
                file_type = stat.S_IFMT(entry.external_attr >> 16)
                require(file_type in (0, stat.S_IFREG, stat.S_IFDIR) and not entry.flag_bits & 1)
                if parts[0].endswith(".dist-info"):
                    info_roots.add(parts[0])
                if entry.is_dir():
                    require(entry.file_size == 0 and file_type != stat.S_IFREG)
                    continue
                require(file_type != stat.S_IFDIR)
                expanded += entry.file_size
                require(expanded <= MAX_EXPANDED)
                files.add(entry.filename)
                is_metadata = len(parts) == 2 and parts[0].endswith(".dist-info") and parts[1] == "METADATA"
                with archive.open(entry) as stream:
                    data = read_member(stream, entry.file_size, is_metadata)
                if is_metadata:
                    require(metadata is None)
                    metadata = data
            require(len(info_roots) == 1)
            root = next(iter(info_roots))
            info_name, info_version = parse_sdist_filename(root[:-len(".dist-info")] + ".tar.gz")
            require((info_name, info_version) == (name, version))
            require(all(root + "/" + field in files for field in ("METADATA", "WHEEL", "RECORD")))
    elif path.name.endswith(".tar.gz"):
        name, version = parse_sdist_filename(path.name)
        root = path.name[:-len(".tar.gz")]
        files = set()
        # Bound the full decompressed stream before tarfile handles PAX/GNU
        # headers. Links and special files are never followed.
        with gzip.open(path, "rb") as compressed:
            bounded = ExpandedReader(compressed)
            archive = tarfile.open(fileobj=bounded, mode="r|")
            with archive:
                metadata = inspect_sdist_members(archive, root, seen, files)
            # Finish gzip validation, including padding, trailing streams and CRC.
            while bounded.read(65536):
                pass
        require(root + "/pyproject.toml" in files)
    else:
        raise ValueError("unsupported distribution")
    require(metadata is not None)
    parsed = Metadata.from_email(metadata, validate=True)
    require(canonicalize_name(parsed.name, validate=True) == name and parsed.version == version)
    # Preserve release-segment zeroes, while letting packaging normalize PEP 440.
    return str(parsed.version)


def inspect_sdist_members(archive, root, seen, files):
    metadata = None
    expanded = 0
    for count, entry in enumerate(archive, 1):
        require(count <= MAX_ENTRIES)
        parts = member_path(entry.name, seen)
        require(parts[0] == root and (entry.isfile() or entry.isdir()))
        if entry.isdir():
            require(entry.size == 0)
            continue
        expanded += entry.size
        require(expanded <= MAX_EXPANDED)
        files.add(entry.name)
        is_metadata = parts == [root, "PKG-INFO"]
        with archive.extractfile(entry) as stream:
            data = read_member(stream, entry.size, is_metadata)
        if is_metadata:
            require(metadata is None)
            metadata = data
    return metadata


def stage(path, destination):
    """Validate the finite distribution first, then use native archive extraction."""
    version = inspect(path)
    require(not destination.exists())
    # Extraction must be portable on the Windows evidence runner as well.
    def portable(names):
        for name in names:
            for part in name.rstrip('/').split('/'):
                require(not re.search(r'[<>"|?*]', part))
                require(not part.endswith(('.', ' ')))
                require(not re.match(r'^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)', part, re.I))
    if path.name.endswith('.whl'):
        with zipfile.ZipFile(path) as archive:
            portable(archive.namelist())
            destination.mkdir()
            archive.extractall(destination)
    else:
        with tarfile.open(path, 'r:gz') as archive:
            portable(member.name for member in archive)
            destination.mkdir()
            archive.extractall(destination, filter='data')
    return version


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "--stage":
            version = stage(Path(sys.argv[2]), Path(sys.argv[3]))
        elif len(sys.argv) == 4 and sys.argv[1] == "--source-version":
            data = Path(sys.argv[2]).read_bytes()
            require(len(data) <= MAX_METADATA)
            document = tomllib.loads(data.decode("utf-8"))
            if "project" in document:
                project = document["project"]
            else:
                tool = document.get("tool", {})
                require(isinstance(tool, dict))
                project = tool.get("poetry", {})
            require(isinstance(project, dict) and isinstance(project.get("version"), str))
            dynamic = project.get("dynamic", [])
            require(isinstance(dynamic, list) and all(isinstance(field, str) for field in dynamic))
            require("version" not in dynamic)
            version = Version(project["version"])
            require(version == Version(sys.argv[3]))
            version = str(version)
        else:
            require(len(sys.argv) == 2)
            version = inspect(Path(sys.argv[1]))
        print(json.dumps({"version": version}, separators=(",", ":")))
    except (ValueError, ExceptionGroup, EOFError, NotImplementedError, gzip.BadGzipFile, zlib.error, zipfile.BadZipFile, tarfile.TarError):
        print('{"error":"RN_NATIVE_INVALID_ASSET"}')
        sys.exit(2)
