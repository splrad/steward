"""Inspect release formats and embedded versions without executing package files."""
from pathlib import Path
from contextlib import contextmanager, nullcontext
import json
import gzip
import io
import stat
import struct
import sys
import tarfile
from xml.etree import ElementTree
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
MAX_RELEASE_TEXT = 16 * 1024 * 1024
MAX_PE_RESOURCE = 32 * 1024 * 1024


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


def zip_local_sizes(extra, expanded, compressed):
    # ZIP64 replaces sentinel values in uncompressed-then-compressed order.
    sizes = [expanded, compressed]
    offset = 0
    while offset < len(extra):
        require(offset + 4 <= len(extra))
        tag, length = struct.unpack_from("<HH", extra, offset)
        offset += 4
        require(offset + length <= len(extra))
        if tag == 1:
            values = extra[offset:offset + length]
            for index, size in enumerate(sizes):
                if size == 0xffffffff:
                    require(len(values) >= 8)
                    sizes[index] = int.from_bytes(values[:8], "little")
                    values = values[8:]
        offset += length
    require(0xffffffff not in sizes)
    return sizes


def zip_unicode_path(name, flags, extra):
    unicode_name = None
    offset = 0
    while offset + 4 <= len(extra):
        tag, size = struct.unpack_from("<HH", extra, offset)
        offset += 4
        require(offset + size <= len(extra))
        if tag == 0x7075:
            data = extra[offset:offset + size]
            require(unicode_name is None and size > 5 and data[0] == 1)
            original = name.encode("utf-8" if flags & 0x800 else "cp437")
            require(zlib.crc32(original) == int.from_bytes(data[1:5], "little"))
            unicode_name = data[5:].decode("utf-8")
            require(name.endswith("/") == unicode_name.endswith("/"))
        offset += size
    return unicode_name


def check_zip_records(source, entries, central_start, workflow_paths):
    """Account for each physical local header, compressed payload and descriptor."""
    require(0 < len(entries) <= MAX_ENTRIES)
    ordered = sorted(entries, key=lambda item: item.header_offset)
    require(ordered[0].header_offset == 0)
    for index, entry in enumerate(ordered):
        boundary = ordered[index + 1].header_offset if index + 1 < len(ordered) else central_start
        source.seek(entry.header_offset)
        header = source.read(30)
        require(len(header) == 30 and header[:4] == b"PK\x03\x04")
        flags, method = struct.unpack_from("<HH", header, 6)
        require(flags == entry.flag_bits and method == entry.compress_type)
        name_size, extra_size = struct.unpack_from("<HH", header, 26)
        crc, compressed, expanded = struct.unpack_from("<III", header, 14)
        source.seek(name_size, io.SEEK_CUR)
        extra = source.read(extra_size)
        if workflow_paths:
            local_name = zip_unicode_path(entry.orig_filename, flags, extra)
            require(local_name is None or local_name == zip_unicode_path(entry.orig_filename, flags, entry.extra))
        require(len(extra) == extra_size)
        expanded, compressed = zip_local_sizes(extra, expanded, compressed)
        for local, central in ((crc, entry.CRC), (compressed, entry.compress_size), (expanded, entry.file_size)):
            require(local == central or (flags & 8 and local == 0))
        payload_end = source.tell() + entry.compress_size
        if not flags & 8:
            require(payload_end == boundary)
            continue
        # Streaming writers use a descriptor, with optional signature and
        # 32- or 64-bit sizes. Only its exact fields may follow the payload.
        size = boundary - payload_end
        require(size in (12, 16, 20, 24))
        source.seek(payload_end)
        descriptor = source.read(size)
        require(len(descriptor) == size)
        if size in (16, 24):
            require(descriptor[:4] == b"PK\x07\x08")
            descriptor = descriptor[4:]
        fields = struct.unpack("<III" if len(descriptor) == 12 else "<IQQ", descriptor)
        require(fields == (entry.CRC, entry.compress_size, entry.file_size))


def check_zip_directory(source, archive, footer, footer_offset, workflow_paths):
    """Match decoded entries to their exact on-disk extent and end records."""
    disk, directory_disk, disk_count, count, size, start = struct.unpack_from("<4H2I", footer, 4)
    source.seek(archive.start_dir)
    entries = archive.infolist()
    for entry in entries:
        header = source.read(46)
        require(len(header) == 46 and header[:4] == b"PK\x01\x02")
        name_len, extra_len, comment_len = struct.unpack_from("<3H", header, 28)
        require(extra_len == len(entry.extra) and comment_len == len(entry.comment))
        source.seek(name_len + extra_len + comment_len, io.SEEK_CUR)
        require(source.tell() <= footer_offset)
    end = source.tell()
    actual_size = end - archive.start_dir
    expected = (len(entries), len(entries), actual_size, archive.start_dir)
    legacy = (disk_count, count, size, start)
    if end == footer_offset:
        require(disk == directory_disk == 0 and legacy == expected)
        return
    # A ZIP64 end record and locator may follow the directory even in a
    # small archive. Compare both generations of addresses and counts.
    record = source.read(56)
    require(len(record) == 56 and record[:4] == b"PK\x06\x06")
    record_size = struct.unpack_from("<Q", record, 4)[0]
    require(record_size >= 44 and end + 12 + record_size + 20 == footer_offset)
    require(struct.unpack_from("<II", record, 16) == (0, 0))
    # Windows packaging tools write sentinel disk numbers in the legacy footer.
    disk_numbers = (0, 0xffff) if workflow_paths else (0,)
    require(disk in disk_numbers and directory_disk in disk_numbers)
    require(struct.unpack_from("<4Q", record, 24) == expected)
    require(all(value in (actual, sentinel) for value, actual, sentinel
                in zip(legacy, expected, (0xffff, 0xffff, 0xffffffff, 0xffffffff))))
    source.seek(footer_offset - 20)
    require(source.read(20) == struct.pack("<4sIQI", b"PK\x06\x07", 0, end, 1))


@contextmanager
def release_zip(path, workflow_paths=False):
    with BoundedZipReader(io.FileIO(path, "r")) as bounded, zipfile.ZipFile(bounded) as archive:
        check_zip_records(bounded, archive.infolist(), archive.start_dir, workflow_paths)
        # A ZIP ends with its 22-byte EOCD followed by exactly its declared
        # comment. ZipFile itself tolerates both extra bytes and short comments.
        end = bounded.seek(0, io.SEEK_END)
        offset = end - 22 - len(archive.comment)
        require(offset >= 0)
        bounded.seek(offset)
        footer = bounded.read(22)
        require(footer[:4] == b"PK\x05\x06" and int.from_bytes(footer[20:22], "little") == len(archive.comment))
        require(bounded.read(len(archive.comment)) == archive.comment)
        check_zip_directory(bounded, archive, footer, offset, workflow_paths)
        yield archive


def zip_members(archive, workflow_paths=False):
    # ZipFile.open compares the local and central names, including for
    # directories that do not need to be extracted into staging.
    original_paths = set()
    for entry in archive.infolist():
        require(not entry.flag_bits & 1)
        if workflow_paths:
            member_path(entry.orig_filename, original_paths)
            name = zip_unicode_path(entry.orig_filename, entry.flag_bits, entry.extra) or entry.orig_filename
            require(entry.filename in (entry.orig_filename, name))
        else:
            require(entry.orig_filename == entry.filename)
            name = entry.filename
        with archive.open(entry) as stream:
            if entry.is_dir():
                require(entry.file_size == 0 and not stream.read(1))
            yield entry, stream, name


class ExpandedReader:
    """Count gzip output, including tar headers that tarfile consumes internally."""

    def __init__(self, source):
        self.source = source
        self.remaining = MAX_EXPANDED
        self.total = 0
        self.last_nonzero_end = 0

    def read(self, size):
        require(size >= 0)
        data = self.source.read(min(size, self.remaining + 1))
        if len(data) > self.remaining:
            raise ValueError("archive read budget exceeded")
        self.remaining -= len(data)
        used = len(data.rstrip(b"\0"))
        if used:
            self.last_nonzero_end = self.total + used
        self.total += len(data)
        return data

    def finish_tar(self, end_of_members):
        # tarfile may already have read past the first end block into its own
        # buffer. Account for those bytes as well as any unread gzip data.
        while self.read(65536):
            pass
        require(self.last_nonzero_end <= end_of_members)
        require(self.total >= end_of_members + 2 * tarfile.BLOCKSIZE and self.total % tarfile.BLOCKSIZE == 0)


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


def read_member(stream, size, retain=False, max_retained=MAX_METADATA, output=None):
    require(size >= 0 and size <= MAX_EXPANDED and (not retain or size <= max_retained))
    data = bytearray()
    consumed = 0
    while chunk := stream.read(min(65536, size - consumed + 1)):
        consumed += len(chunk)
        require(consumed <= size)
        if output is not None:
            output.write(chunk)
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
        with release_zip(path) as archive:
            info_roots = set()
            files = set()
            for entry, stream, member in zip_members(archive):
                parts = member_path(member, seen)
                file_type = stat.S_IFMT(entry.external_attr >> 16)
                require(file_type in (0, stat.S_IFREG, stat.S_IFDIR))
                if parts[0].endswith(".dist-info"):
                    info_roots.add(parts[0])
                if entry.is_dir():
                    require(file_type != stat.S_IFREG)
                    continue
                require(file_type != stat.S_IFDIR)
                expanded += entry.file_size
                require(expanded <= MAX_EXPANDED)
                files.add(entry.filename)
                is_metadata = len(parts) == 2 and parts[0].endswith(".dist-info") and parts[1] == "METADATA"
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
            bounded.finish_tar(archive.offset)
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


def executable_elf(data):
    require(data[:4] == b"\x7fELF" and data[4:5] in (b"\x01", b"\x02"))
    require(data[5:6] in (b"\x01", b"\x02") and data[6:7] == b"\x01")
    wide = data[4] == 2
    endian = "<" if data[5] == 1 else ">"
    header = struct.Struct(endian + ("HHIQQQIHHHHHH" if wide else "HHIIIIIHHHHHH"))
    require(len(data) >= 16 + header.size)
    kind, machine, version, _, offset, _, _, size, stride, count, *_ = header.unpack_from(data, 16)
    program = struct.Struct(endian + ("IIQQQQQQ" if wide else "IIIIIIII"))
    require(kind in (2, 3) and machine and version == 1 and size == 16 + header.size)
    require(offset >= size and stride == program.size and count and offset + count * stride <= len(data))
    executable = False
    for index in range(count):
        fields = program.unpack_from(data, offset + index * stride)
        segment, flags, start, length = (fields[0], fields[1], fields[2], fields[5]) if wide else (fields[0], fields[6], fields[1], fields[4])
        if segment == 1:
            require(start + length <= len(data))
            executable |= bool(flags & 1 and length)
    require(executable)


def font_file(suffix, data):
    return (suffix == ".ttf" and data[:4] in (b"\x00\x01\x00\x00", b"true", b"ttcf")
            or suffix == ".otf" and data.startswith(b"OTTO")
            or suffix == ".shx" and re.match(rb"^AutoCAD-86 (shapes|unifont|bigfont)", data[:64]))


def inspect_declared(path, contract, destination=None, inspect_member=None, workflow_paths=False):
    """Read every member of the declared container. Never restore filesystem metadata."""
    adapter = contract["inspection"]
    members = {item["path"]: item["format"] for item in contract.get("members", [])}
    seen, found, spelling, directories = set(), set(), {}, set()
    expanded = 0
    if destination:
        destination.mkdir()

    def consume(name, directory, size, stream):
        nonlocal expanded
        parts = member_path(name, seen)
        require(len(seen) <= MAX_ENTRIES and len(name) <= 240)
        for index, part in enumerate(parts, 1):
            require(not re.search(r'[<>"|?*]', part) and not part.endswith((".", " ")))
            require(not re.match(r'^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)', part, re.I))
            prefix = "/".join(parts[:index])
            require(spelling.setdefault(prefix.casefold(), prefix) == prefix)
            if index < len(parts) or directory:
                require(prefix not in found)
                directories.add(prefix)
        if directory:
            require(size == 0)
            return
        require(name not in directories and 0 <= size <= 32 * 1024**2)
        expanded += size
        require(expanded <= MAX_EXPANDED)
        fmt = members.get(name)
        if destination:
            target = destination.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
        check_member = inspect_member(name) if inspect_member else None
        with (target.open("xb") if destination else nullcontext()) as output:
            data = read_member(stream, size, retain=fmt is not None or adapter == "font-zip" or check_member is not None,
                               max_retained=32 * 1024**2, output=output)
        suffix = Path(name).suffix.lower()
        if adapter == "font-zip":
            require(font_file(suffix, data))
        if check_member is not None:
            check_member(data)
        if fmt is not None:
            if fmt == "elf":
                executable_elf(data)
            elif fmt in ("text", "version"):
                content = data.decode("utf-8")
                require(all(c.isprintable() or c in "\r\n\t" for c in content))
                if fmt == "version":
                    require(content.strip() == contract["version"])
            else:
                raise ValueError("unexpected member")
        found.add(name)

    if adapter in ("zip", "dll-zip", "font-zip"):
        with release_zip(path, workflow_paths) as archive:
            for entry, stream, name in zip_members(archive, workflow_paths):
                directory = entry.is_dir()
                require(stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFDIR if directory else stat.S_IFREG))
                consume(name, directory, entry.file_size, stream)
    else:
        require(adapter == "tar-gzip")
        with gzip.open(path, "rb") as compressed:
            bounded = ExpandedReader(compressed)
            with tarfile.open(fileobj=bounded, mode="r|") as archive:
                for entry in archive:
                    require(entry.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE) and not entry.sparse)
                    if entry.isdir():
                        consume(entry.name, True, entry.size, None)
                    else:
                        with archive.extractfile(entry) as stream:
                            consume(entry.name, False, entry.size, stream)
            bounded.finish_tar(archive.offset)
    require(found and (not members or members.keys() <= found))
    return contract["version"]


class DeliveryVersionError(ValueError):
    pass


class UnsupportedDeliveryFormat(ValueError):
    pass


def require_delivery_version(actual, expected):
    if actual != expected:
        raise DeliveryVersionError("delivery version mismatch")


def inspect_pe(suffix, version=None, **source):
    # Version resources work for Windows native apphosts as well as managed DLLs.
    # Parse only the resource directory using the locked, portable reader.
    from pefile import DIRECTORY_ENTRY, PE, PEFormatError

    index = DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_RESOURCE"]
    try:
        with PE(fast_load=True, **source) as pe:
            require(0 < pe.FILE_HEADER.NumberOfSections <= 96)
            require(pe.is_dll() if suffix == ".dll" else pe.is_exe() and not pe.is_dll())
            if version is None:
                return
            public = version.partition("+")[0]
            numbers = re.fullmatch(r"([0-9]+)\.([0-9]+)\.([0-9]+)(?:-[0-9A-Za-z.-]+)?", public)
            require(numbers)
            numeric = ".".join(numbers.groups())
            fixed = tuple(map(int, numbers.groups())) + (0,)
            require(len(pe.OPTIONAL_HEADER.DATA_DIRECTORY) > index)
            resources = pe.OPTIONAL_HEADER.DATA_DIRECTORY[index]
            require(0 < resources.Size <= MAX_PE_RESOURCE and resources.VirtualAddress > 0)
            pe.parse_data_directories(directories=[index])
            entries = getattr(pe, "VS_FIXEDFILEINFO", [])
            strings = [table.entries for block in getattr(pe, "FileInfo", []) for group in block
                       if group.Key == b"StringFileInfo" for table in group.StringTable]
            require(entries and strings)
            for entry in entries:
                require(entry.Signature == 0xfeef04bd)
                for high, low in ((entry.FileVersionMS, entry.FileVersionLS),
                                  (entry.ProductVersionMS, entry.ProductVersionLS)):
                    require_delivery_version((high >> 16, high & 0xffff, low >> 16, low & 0xffff), fixed)
            for table in strings:
                name = table.get(b"FileVersion", b"").decode("utf-8")
                product = table.get(b"ProductVersion", b"").decode("utf-8").partition("+")[0]
                if name == numeric + ".0":
                    name = numeric
                if product == numeric + ".0":
                    product = numeric
                require_delivery_version(name, numeric)
                require_delivery_version(product, public)
    except PEFormatError as error:
        raise ValueError("invalid PE") from error


def delivery_text(data, limit=MAX_RELEASE_TEXT):
    require(len(data) <= limit)
    value = data.decode("utf-8-sig")
    require(all(char.isprintable() or char in "\r\n\t" for char in value))
    return value


def node_delivery_version(data, version):
    package = json.loads(delivery_text(data, MAX_METADATA))
    require(isinstance(package, dict) and isinstance(package.get("name"), str) and package["name"].strip())
    require(isinstance(package.get("version"), str) and package["version"].strip())
    require_delivery_version(package["version"], version)


def windows_package_version(data, version, bundle):
    text = delivery_text(data, MAX_METADATA)
    require(not re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.I))
    document = ElementTree.fromstring(text)
    root = "Bundle" if bundle else "Package"
    require(document.tag.startswith("{http://schemas.microsoft.com/appx/") and document.tag.split("}")[-1] == root)
    namespace = document.tag[:-len(root)]
    identities = document.findall(namespace + "Identity")
    require(len(identities) == 1 and identities[0].get("Name") and identities[0].get("Publisher"))
    embedded = identities[0].get("Version", "")
    require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+", embedded))
    require_delivery_version(embedded, version + ".0")


def inspect_workflow(path, release_type, version):
    name, suffix = path.name.lower(), path.suffix.lower()
    size = path.stat().st_size
    require(0 < size < 2**31)
    if suffix in (".exe", ".dll"):
        inspect_pe(suffix, version, name=str(path))
        return True
    elif suffix == ".whl" or release_type == "python" and name.endswith(".tar.gz"):
        require_delivery_version(Version(inspect(path)), Version(version))
        return True
    elif suffix in (".msix", ".appx", ".msixbundle", ".appxbundle"):
        bundle = suffix.endswith("bundle")
        manifest = "AppxMetadata/AppxBundleManifest.xml" if bundle else "AppxManifest.xml"
        required = {manifest, "[Content_Types].xml", "AppxBlockMap.xml"}

        def check_manifest(member):
            required.discard(member)
            if member != manifest:
                return None
            return lambda data: windows_package_version(data, version, bundle)

        inspect_declared(path, {"inspection": "zip", "version": version}, inspect_member=check_manifest, workflow_paths=True)
        require(not required)
        return True
    elif suffix in (".zip", ".tgz") or name.endswith(".tar.gz"):
        node_package = version_marker = False

        def check_member(member):
            nonlocal node_package, version_marker
            if member == "package/package.json":
                node_package = True
                return lambda data: node_delivery_version(data, version)
            if member == "VERSION":
                version_marker = True
                return lambda data: require_delivery_version(delivery_text(data, MAX_METADATA).strip(), version)
            extension = Path(member).suffix.lower()
            if extension in (".dll", ".exe"):
                # Generic archives may include dependencies with independent versions.
                return lambda data: inspect_pe(extension, data=data)
            if extension in (".otf", ".ttf", ".shx"):
                return lambda data: require(font_file(extension, data))
            return None

        adapter = "zip" if suffix == ".zip" else "tar-gzip"
        inspect_declared(path, {"inspection": adapter, "version": version}, inspect_member=check_member, workflow_paths=True)
        if release_type == "node" and suffix == ".tgz":
            require(node_package)
        return node_package or version_marker
    elif suffix in (".otf", ".ttf", ".shx"):
        with path.open("rb") as file:
            require(font_file(suffix, file.read(64)))
    elif name == "package.json":
        require(size <= MAX_METADATA)
        node_delivery_version(path.read_bytes(), version)
        return True
    elif suffix in (".json", ".md", ".txt", ".csv", ".sha256", ".sha512", ".asc") or name in ("readme", "license", "notice", "sha256sums", "sha512sums"):
        require(size <= MAX_RELEASE_TEXT)
        text = delivery_text(path.read_bytes())
        if suffix == ".json":
            json.loads(text)
    else:
        raise UnsupportedDeliveryFormat("unsupported delivery format")
    return False


if __name__ == "__main__":
    workflow_delivery = sys.argv[1:2] == ["--workflow"]
    try:
        if len(sys.argv) == 5 and workflow_delivery:
            print(json.dumps({"versionChecked": inspect_workflow(Path(sys.argv[2]), sys.argv[3], sys.argv[4])}, separators=(",", ":")))
            sys.exit(0)
        elif len(sys.argv) in (4, 5) and sys.argv[1] == "--declared":
            version = inspect_declared(Path(sys.argv[2]), json.loads(Path(sys.argv[3]).read_text(encoding="utf-8")),
                                       Path(sys.argv[4]) if len(sys.argv) == 5 else None)
        elif len(sys.argv) == 4 and sys.argv[1] == "--stage":
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
    except DeliveryVersionError:
        print('{"error":"RN_DELIVERY_VERSION"}')
        sys.exit(2)
    except UnsupportedDeliveryFormat:
        print('{"error":"RN_DELIVERY_UNSUPPORTED"}')
        sys.exit(2)
    except (ValueError, ExceptionGroup, EOFError, NotImplementedError, gzip.BadGzipFile, zlib.error, zipfile.BadZipFile, tarfile.TarError, ElementTree.ParseError):
        print('{"error":"RN_DELIVERY_FORMAT"}' if workflow_delivery else '{"error":"RN_NATIVE_INVALID_ASSET"}')
        sys.exit(2)
