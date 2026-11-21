"""Regression coverage for the PR lock contract and split fork checkouts."""
import copy
import os
from contextlib import chdir
import runpy
import subprocess
import tempfile
import tomllib
import unittest
from unittest.mock import patch
from pathlib import Path

candidate = runpy.run_path(str(Path(__file__).resolve().parents[1] / "steward-ci-candidate.py"))


class LockContractTest(unittest.TestCase):
    def test_contract_changes(self):
        record = {"version": "1.0.0", "backend": "example", "specifiers": ["latest"],
                  "options": {"compile": False},
                  "platforms.windows-x64": {"url": "old", "checksum": "old", "provenance": "trusted"}}
        base = {"lockfile_version": 3, "tools": {"tool": [record]}}
        for change in (
            lambda doc, tool: doc.update(lockfile_version=4),
            lambda doc, tool: doc["tools"].update(extra=[record]),
            lambda doc, tool: doc["tools"].pop("tool"),
            lambda doc, tool: tool.update(backend="other"),
            lambda doc, tool: tool.update(specifiers=[]),
            lambda doc, tool: tool["options"].update(compile=True),
            lambda doc, tool: tool.pop("platforms.windows-x64"),
            lambda doc, tool: tool["platforms.windows-x64"].update(provenance="other"),
            lambda doc, tool: tool["platforms.windows-x64"].update(extra="field"),
        ):
            new = copy.deepcopy(base)
            change(new, new["tools"]["tool"][0])
            with self.assertRaises(ValueError):
                list(candidate["checked_records"](base, new))
        new = copy.deepcopy(base)
        new["tools"]["tool"][0]["version"] = "1.0.1"
        new["tools"]["tool"][0]["platforms.windows-x64"].update(url="new", checksum="new")
        self.assertEqual(len(list(candidate["checked_records"](base, new))), 1)

    def test_mise_versions_marker_keeps_public_github_assets_eligible(self):
        key = "aqua:oras-project/oras"

        def lock(version, asset, marker=""):
            document = f'lockfile_version = 3\n[[tools."{key}"]]\nversion = "{version}"\nbackend = "{key}"\n'
            for os_name, extension in (("linux", "tar.gz"), ("windows", "zip")):
                document += (
                    f'[tools."{key}"."platforms.{os_name}-x64"]\n'
                    f'url = "https://github.com/oras-project/oras/releases/download/v{version}/oras_{version}_{os_name}_amd64.{extension}"\n'
                    f'url_api = "https://api.github.com/repos/oras-project/oras/releases/assets/{asset}"\n'
                    f'checksum = "sha256:{"a" * 64}"\n{marker}'
                )
            return document.encode()

        base = lock("1.3.5", 10)
        marked = lock("1.4.0", 20, 'checksum_source = "mise-versions"\n')
        unexpected = lock("1.4.0", 20, 'checksum_source = "unknown"\n')
        tool_changes = candidate["rules"].tool_changes
        self.assertEqual(set(tool_changes(base, marked)), {key})
        self.assertEqual(tool_changes(base, unexpected), {})
        check = candidate["checked_records"]
        self.assertEqual(len(list(check(tomllib.loads(base.decode()), tomllib.loads(marked.decode())))), 1)
        with self.assertRaisesRegex(ValueError, "field set"):
            list(check(tomllib.loads(base.decode()), tomllib.loads(unexpected.decode())))

    def test_docs_and_push_parent(self):
        with tempfile.TemporaryDirectory() as directory, chdir(directory):
            repo = Path("target")
            subprocess.run(["git", "init", "-q", repo], check=True)
            def commit(path, content):
                file = repo / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(content, encoding="utf-8")
                subprocess.run(["git", "-C", repo, "add", path], check=True)
                subprocess.run(["git", "-C", repo, "-c", "user.name=Fixture", "-c", "user.email=t@example.com",
                                "-c", "commit.gpgSign=false", "commit", "-qm", content], check=True)
                return candidate["rules"].git("rev-parse", "HEAD").decode().strip()

            classify = candidate["rules"].classify
            first = commit("docs/guide.md", "guide")
            parent = commit("docs/guide.md", "updated guide")
            head = commit("docs/guide.md", "final guide")
            with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "push"}):
                self.assertEqual(classify(parent, head), "docs")
                self.assertEqual(classify(first, head), "full")
                self.assertEqual(classify("0" * 40, head), "full")
                self.assertEqual(classify(first, parent), "full")
                source = commit("packages/runner/dist/index.js", "source")
                self.assertEqual(classify(head, source), "full")
                policy = commit("docs/SECURITY.md", "policy")
                self.assertEqual(classify(source, policy), "full")
            with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "pull_request"}):
                self.assertEqual(classify(first, head), "docs")
                self.assertEqual(classify(first, source), "full")

    def test_base_absent_from_fork(self):
        with tempfile.TemporaryDirectory() as directory:
            refs = []
            for name in ("policy", "target"):
                repo = Path(directory, name)
                subprocess.run(["git", "init", "-q", repo], check=True)
                (repo / "mise.lock").write_text('lockfile_version = 3\n[tools]\n', encoding="utf-8")
                subprocess.run(["git", "-C", repo, "add", "mise.lock"], check=True)
                subprocess.run(["git", "-C", repo, "-c", "user.name=Fixture", "-c", "user.email=t@example.com",
                                "-c", "commit.gpgSign=false", "commit", "-qm", name], check=True)
                refs.append(subprocess.check_output(["git", "-C", repo, "rev-parse", "HEAD"], text=True).strip())
            self.assertNotEqual(refs[0], refs[1])
            result = subprocess.run(["git", "-C", repo, "cat-file", "-e", refs[0]], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            with chdir(directory), patch.dict(os.environ, {"GITHUB_EVENT_NAME": "pull_request"}):
                candidate["verify_other_locks"](*refs)

    def test_full_push_uses_pre_push_lock(self):
        before, after = "a" * 40, "b" * 40
        locks = {
            ("target", before, "mise.lock"): b"lockfile_version = 3\n[tools]\n",
            ("target", after, "mise.lock"): b"lockfile_version = 4\n[tools]\n",
        }
        verify = candidate["verify_other_locks"]
        with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "push"}), patch(
            "subprocess.run", return_value=subprocess.CompletedProcess([], 0)
        ), patch.dict(
            verify.__globals__, {"lock_blob": lambda *args: locks[args]}
        ):
            with self.assertRaisesRegex(ValueError, "Unsupported lockfile contract change"):
                verify(before, after)

    def test_full_push_with_missing_baseline_preserves_full_suite(self):
        with tempfile.TemporaryDirectory() as directory, chdir(directory), patch.dict(
            os.environ, {"GITHUB_EVENT_NAME": "push"}
        ):
            subprocess.run(["git", "init", "-q", "target"], check=True)
            for before in ("", "0" * 40, "a" * 40):
                with self.subTest(before=before):
                    candidate["verify_other_locks"](before, "b" * 40)


if __name__ == "__main__":
    unittest.main()
