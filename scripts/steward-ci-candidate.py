"""Run the selected supplier binary on the runner using data from immutable Git trees."""
import base64
from contextlib import contextmanager
import hashlib
import http.server
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
import tarfile
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("profile_rules", Path(__file__).with_name("steward-ci-profile.py"))
rules = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rules)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def child_env():
    return {k: os.environ[k] for k in ("PATH", "SystemRoot", "TEMP", "TMP", "LANG") if k in os.environ}


def read_url(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def github_asset(url):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == "https" and parsed.netloc == "api.github.com" and not parsed.query
            and not parsed.fragment and re.fullmatch(r"/repos/[\w.-]+/[\w.-]+/releases/assets/[1-9]\d*", parsed.path),
            "Unexpected GitHub asset API URL")
    if os.environ.get("GH_TOKEN"):
        return json.loads(subprocess.check_output(["gh", "api", "--hostname", "github.com", parsed.path], timeout=120))
    return json.loads(read_url(url))


def verify_archive(asset, archive):
    with urllib.request.urlopen(asset["url"], timeout=120) as response, archive.open("wb") as output:
        shutil.copyfileobj(response, output)
    with archive.open("rb") as stream:
        digest = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
    require(asset["checksum"] == digest, "Candidate platform digest differs")
    if asset.get("provenance") == "github-attestations":
        # The caller has already matched this release URL to the trusted supplier layout.
        repository = rules.release_repository(asset["url"])
        require(repository, "A GitHub attestation requires a trusted release repository")
        subprocess.run(["gh", "attestation", "verify", str(archive), "--repo", repository,
                        "--hostname", "github.com"], check=True, timeout=120)
    return digest


@contextmanager
def tool_directory():
    directory = tempfile.TemporaryDirectory()
    try:
        yield Path(directory.name)
    finally:
        # Windows may briefly retain a handle to a freshly executed binary.
        for delay in (0.1, 0.2, 0.4, 0.8):
            try:
                directory.cleanup()
                break
            except PermissionError as error:
                if getattr(error, "winerror", None) not in (32, 33):
                    raise
                time.sleep(delay)
        else:
            directory.cleanup()


def lock_blob(repo, ref, path):
    entry = subprocess.check_output(["git", "-C", repo, "ls-tree", ref, "--", path])
    require(entry.startswith(b"100644 blob "), f"Expected regular tracked file: {path}")
    return subprocess.check_output(["git", "-C", repo, "show", f"{ref}:{path}"])


def checked_records(original, candidate):
    before = original["tools"]
    after = candidate["tools"]
    require({k: v for k, v in original.items() if k != "tools"} ==
            {k: v for k, v in candidate.items() if k != "tools"}, "Unsupported lockfile contract change")
    require(before.keys() == after.keys(), "Tool inventory change needs a trusted supplier contract")
    for key, records in after.items():
        previous, = before[key]
        item, = records
        if previous != item:
            require(previous.keys() == item.keys(), f"Unexpected fields or platform set for {key}")
            for field, value in previous.items():
                if field == "version":
                    continue
                if field in rules.PLATFORMS or (field == "aube" and key == "npm"):
                    if field in rules.PLATFORMS:
                        value = rules.supplier_metadata(value, item[field])
                    allowed = {"url", "url_api", "checksum"} if field in rules.PLATFORMS else {"path", "digest"}
                    require(item[field].keys() == value.keys(), f"Unexpected {key} {field} field set")
                    require(all(item[field][k] == v for k, v in value.items() if k not in allowed),
                            f"Unexpected {key} {field} metadata")
                else:
                    require(item[field] == value, f"Unexpected {key} {field} change")
        yield key, previous, item


def verify_other_locks(base, head):
    # On default-branch pushes the full target history contains the pre-push tree.
    # A PR base must come from the separate policy checkout because forks can lack it.
    base_repo = "target" if os.environ.get("GITHUB_EVENT_NAME") == "push" else "policy"
    if base_repo == "target":
        base = base or "0" * 40
        require(re.fullmatch(r"[0-9a-f]{40}", base), "Invalid default-branch push baseline")
        previous_commit = subprocess.run(
            ["git", "-C", base_repo, "rev-parse", "--verify", "--quiet", f"{base}^{{commit}}"],
            stdout=subprocess.DEVNULL,
        )
        if previous_commit.returncode == 1:
            print("Pre-push commit unavailable: running the full suite with the locked toolchain")
            return
        previous_commit.check_returncode()
    before = tomllib.loads(lock_blob(base_repo, base, "mise.lock").decode())
    after = tomllib.loads(lock_blob("target", head, "mise.lock").decode())
    platform = rules.PLATFORMS[int(os.name == "nt")]
    for key, previous, item in checked_records(before, after):
        if previous == item:
            if key != "npm":
                continue
            directory = previous["aube"]["path"]
            if all(lock_blob(base_repo, base, f"{directory}/{name}") == lock_blob("target", head, f"{directory}/{name}")
                   for name in ("aube-lock.yaml", "package.json")):
                continue
        version = item["version"]
        require(re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", version), "Unexpected candidate version")
        if key == "npm":
            lock_path = f".mise/locks/npm/{version}"
            require(item["aube"]["path"] == lock_path, "Unexpected npm lock path")
            lock = lock_blob("target", head, lock_path + "/aube-lock.yaml")
            require(item["aube"]["digest"] == "sha256:" + hashlib.sha256(lock).hexdigest(), "npm lock digest differs")
            manifest = lock_blob("target", head, lock_path + "/package.json")
            meta = json.loads(read_url("https://registry.npmjs.org/npm/" + version))
            subprocess.run(["node", "policy/scripts/npm-tool-lock.mjs"], check=True, input=json.dumps({
                "manifest": manifest.decode(), "lock": lock.decode(), "version": version, "supplier": meta,
            }).encode())
            url = f"https://registry.npmjs.org/npm/-/npm-{version}.tgz"
            sri = "sha512-" + base64.b64encode(hashlib.sha512(read_url(url)).digest()).decode()
            require(meta["dist"]["integrity"] == sri,
                    "npm tarball integrity differs from registry or candidate dependency lock")
            print(f"Verified npm {version} {sri}")
            continue
        if platform not in previous:
            require(platform not in item, "Added platform needs an explicit supplier contract")
            continue
        asset = item[platform]
        url = asset["url"]
        old = urllib.parse.urlsplit(previous[platform]["url"])
        new = urllib.parse.urlsplit(url)
        require((new.scheme, new.netloc) == ("https", old.netloc) and not new.query and not new.fragment,
                "Unexpected tool supplier")
        expected = previous[platform]["url"].replace(previous["version"], version)
        if key == "python":
            old_date = re.search(r"/download/(\d{8})/", expected)
            new_date = re.search(r"/download/(\d{8})/", url)
            require(old_date and new_date, "Unexpected CPython release date")
            expected = expected.replace(old_date[1], new_date[1])
        require(url == expected, "Candidate release name or platform differs from trusted layout")
        if old.netloc == "github.com":
            prefix = old.path.split("/releases/download/")[0] + "/releases/download/"
            require(re.fullmatch(re.escape(prefix) + r"[\w.+-]+/[\w.+-]+", new.path), "Unexpected release asset")
            if "url_api" in previous[platform]:
                api = previous[platform]["url_api"].rsplit("/", 1)[0]
                require(re.fullmatch(re.escape(api) + r"/[1-9]\d*", asset["url_api"]), "Unexpected asset API")
                require(github_asset(asset["url_api"])["browser_download_url"] == url, "Asset ID differs")
        else:
            require(key == "node" and url == previous[platform]["url"].replace(previous["version"], version),
                    "Unexpected Node asset")
        with tool_directory() as directory:
            digest = verify_archive(asset, directory / "archive")
        print(f"Verified {key} {version} {platform} {digest}")


def tool(key, item, root):
    windows = os.name == "nt"
    asset = item[rules.PLATFORMS[int(windows)]]
    upstream = github_asset(asset["url_api"])
    require(upstream["browser_download_url"] == asset["url"], "Supplier asset ID and URL differ")
    if upstream.get("digest"):
        require(upstream["digest"] == asset["checksum"], "Supplier asset digest differs")
    archive = root / "archive"
    verify_archive(asset, archive)
    command, option = rules.COMMANDS[key]
    binary = root / (command + (".exe" if windows else ""))
    if windows:
        with zipfile.ZipFile(archive) as files:
            entry, = [name for name in files.namelist() if Path(name).name == binary.name]
            with files.open(entry) as source, binary.open("wb") as out:
                shutil.copyfileobj(source, out)
    else:
        with tarfile.open(archive) as files:
            entry, = [m for m in files if m.isfile() and Path(m.name).name == command]
            with files.extractfile(entry) as source, binary.open("wb") as out:
                shutil.copyfileobj(source, out)
        binary.chmod(0o700)
    result = subprocess.check_output([binary, option], cwd=root, env=child_env(), text=True,
                                     stderr=subprocess.STDOUT, timeout=30)
    require(re.search(r"(?<![\d.])" + re.escape(item["version"]) + r"(?![\d.])", result),
            f"{command} reported an unexpected version")
    if command == "ruff":
        sample = root / "sample.py"
        sample.write_text("import os\n", encoding="utf-8")
        check = subprocess.run([binary, "check", "--isolated", "--select", "F401", sample], cwd=root,
                               env=child_env(), capture_output=True, text=True, timeout=30)
        require(check.returncode == 1 and "F401" in check.stdout, "Ruff failed to diagnose unused import")
    elif command == "zizmor":
        fixture = root / ".github/workflows/check.yml"
        fixture.parent.mkdir(parents=True)
        fixture.write_text("name: Check\non: push\npermissions: {}\njobs:\n  check:\n"
                           "    runs-on: ubuntu-latest\n    steps:\n      - run: echo check\n", encoding="utf-8")
        subprocess.run([binary, "--offline", "--no-progress", fixture], cwd=root, env=child_env(),
                       timeout=60, check=True)
    print(f"{key} {item['version']} {asset['checksum']} {option} OK")
    return binary


def title(base, head, root):
    path, = rules.changed_paths(base, head) - {rules.ACTION_LOCK}
    workflow = rules.blob(head, path)
    sha, tag = (v.decode() for v in rules.PINS.findall(workflow)[0])
    supplier = "https://github.com/amannn/action-semantic-pull-request.git"
    subprocess.run(["git", "init", "-q", root], check=True)
    subprocess.run(["git", "-C", root, "fetch", "--depth=1", supplier, f"refs/tags/{tag}"], check=True)
    resolved = subprocess.check_output(["git", "-C", root, "rev-parse", "FETCH_HEAD^{commit}"], text=True).strip()
    require(resolved == sha, "Upstream title Action tag and pinned commit differ")
    subprocess.run(["git", "-C", root, "checkout", "--quiet", "--detach", sha], check=True)
    metadata = (root / "action.yml").read_text(encoding="utf-8")
    require(re.search(r"(?m)^  main: ['\"]?dist/index\.js['\"]?$", metadata), "Unexpected Action entry point")
    types = re.search(rb"(?m)^          types: \|\n((?:            \w+\n)+)", workflow)[1].decode().split()
    cases = [(f"{t}: 检查标题", True) for t in types] + [
        ("fix(ci): 检查标题", True), ("invalid: 检查标题", False), ("缺少类型", False)]
    class PullRequest(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/repos/example/steward/pulls/1":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"title": self.server.title, "labels": []}).encode())

        def log_message(self, *args):
            pass

    event = root / "pr.json"
    event.write_text(json.dumps({"pull_request": {"number": 1, "base": {
        "user": {"login": "example"}, "repo": {"name": "steward"}}}}), encoding="utf-8")
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), PullRequest) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        env = {**child_env(), "GITHUB_EVENT_PATH": str(event), "GITHUB_TOKEN": "fixture",
               "GITHUB_REPOSITORY": "example/steward",
               "INPUT_GITHUBBASEURL": f"http://127.0.0.1:{server.server_port}",
               "INPUT_TYPES": "\n".join(types), "INPUT_REQUIRESCOPE": "false",
               "INPUT_VALIDATESINGLECOMMIT": "false", "INPUT_WIP": "false"}
        for name, valid in cases:
            server.title = name
            result = subprocess.run(["node", "dist/index.js"], cwd=root, env=env, timeout=20,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            require((result.returncode == 0) == valid, f"Title fixture {name!r}: {result.stdout}")
        server.shutdown()
    print(f"Verified {tag} at {sha} against {len(cases)} title fixtures")


if __name__ == "__main__":
    profile, base, head = sys.argv[1:]
    if profile == "full-lock":
        verify_other_locks(base, head)
        sys.exit(0)
    require(rules.classify(base, head) == profile, "Candidate profile changed")
    if profile == "tool":
        for key, item in rules.tool_changes(*(rules.blob(ref, "mise.lock") for ref in (base, head))).items():
            with tool_directory() as directory:
                tool(key, item, directory)
    elif profile == "docs":
        key = "aqua:lycheeverse/lychee"
        item, = tomllib.loads(lock_blob("policy", "HEAD", "mise.lock").decode())["tools"][key]
        documents = [Path("target", p).resolve() for p in sorted(rules.changed_paths(base, head))]
        with tempfile.TemporaryDirectory() as directory:
            binary = tool(key, item, Path(directory))
            subprocess.run([binary, "--config", Path("policy/config/linkcheck/lychee.toml").resolve(),
                            "--root-dir", Path("target").resolve(), "--include-fragments=anchor-only",
                            "--scheme", "file", "--offline", "--", *documents],
                           cwd=directory, env=child_env(), check=True, timeout=120)
    elif profile == "title":
        with tempfile.TemporaryDirectory() as directory:
            title(base, head, Path(directory))
    elif profile == "policy":
        subprocess.run(["node", "policy/scripts/security-policy.mjs", "source", "target"], check=True)
        subprocess.run(["node", "--test", "policy/scripts/test/security-policy.test.mjs"], check=True)
    else:
        raise ValueError("Unknown candidate profile")
