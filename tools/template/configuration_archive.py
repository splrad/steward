"""Inspect native Actions ZIP entries and stage only explicitly selected delivery files."""
from pathlib import Path
import shutil
import re
import stat
from zipfile import ZipFile


def relative_name(name):
    parts = name.split('/')
    if (not name or any(not part or part in {'.', '..'} or part.endswith(('.', ' '))
                        or re.search(r'[<>:"|?*\\\x00-\x1f]', part)
                        or part.split('.')[0].upper() in
                        {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)),
                         *(f'LPT{i}' for i in range(1, 10))} for part in parts)):
        raise ValueError(f'Invalid artifact path: {name!r}')
    return name


def inventory(archive):
    """Leave nested ZIPs and installer packages intact, including their exact bytes."""
    files = {}
    names = set()
    for entry in archive.infolist():
        name = relative_name(entry.orig_filename.removesuffix('/'))
        key = name.casefold()
        mode = stat.S_IFMT(entry.external_attr >> 16)
        if key in names or mode not in (0, stat.S_IFDIR, stat.S_IFREG) or entry.flag_bits & 1:
            raise ValueError(f'Ambiguous or unsupported artifact entry: {name!r}')
        names.add(key)
        if not entry.is_dir():
            files[name] = entry
    if not files:
        raise ValueError('The artifact contains no deliverable files')
    return files


def inspect_archive(path):
    with ZipFile(path) as archive:
        return [{'path': name, 'size': entry.file_size}
                for name, entry in sorted(inventory(archive).items())]


if __name__ == '__main__':
    import argparse
    import json
    parser = argparse.ArgumentParser()
    parser.add_argument('archive')
    parser.add_argument('--request', action='store_true')
    parser.add_argument('--stage')
    parser.add_argument('--files')
    args = parser.parse_args()
    if args.stage:
        directory = Path(args.stage)
        directory.mkdir(exist_ok=False)
        with ZipFile(args.archive) as source:
            entries = inventory(source)
            for path in json.loads(args.files):
                safe = relative_name(path)
                with source.open(entries[safe]) as stream, (directory / safe.split('/')[-1]).open('xb') as output:
                    shutil.copyfileobj(stream, output)
        print(json.dumps(inspect_archive(args.archive)))
    elif args.request:
        with ZipFile(args.archive) as source:
            entries = inventory(source)
            if list(entries) != ['configuration-request.json'] or next(iter(entries.values())).file_size > 1024 * 1024:
                raise ValueError('Invalid configuration request archive')
            print(json.dumps(json.loads(source.read('configuration-request.json'))))
    else:
        print(json.dumps(inspect_archive(args.archive)))
