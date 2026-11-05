# Python distribution fixtures

These four distributions were built with uv 0.13.5 and Python 3.15.1 from the
small `splrad-uv-fixture` package included in each sdist. They cover stable
`1.2.3` and PEP 440 prerelease `1.2.4rc1` metadata. The prerelease's public
Release Please version input was `1.2.4-rc.1`; that input is provenance, not
evidence of candidate generation.

The build used a hash-locked Hatchling toolchain and
`uv build --offline --no-sources --no-build-isolation`. The original bytes
passed twine metadata checks and isolated wheel/sdist installation. Their
SHA-256 values are recorded in `artifacts.json`; tests reuse those bytes and
make explicit malformed copies only in temporary directories.
