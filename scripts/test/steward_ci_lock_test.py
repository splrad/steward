"""Regression coverage for the PR lock contract and split fork checkouts."""
import copy
import hashlib
import io
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

    def test_new_attestations_require_a_github_release_and_cannot_be_removed(self):
        rules = candidate["rules"]
        asset = {"url": "https://github.com/oras-project/oras/releases/download/v1/oras.zip"}
        attested = {**asset, "checksum_source": "mise-versions", "provenance": "github-attestations"}
        self.assertEqual(rules.supplier_metadata(asset, attested), attested)
        self.assertEqual(rules.supplier_metadata(attested, asset), attested)
        self.assertEqual(rules.supplier_metadata(asset, {**asset, "provenance": "unknown"}), asset)
        other = {"url": "https://example.org/oras.zip"}
        self.assertEqual(rules.supplier_metadata(other, attested), other)

    def test_attested_bytes_must_match_digest_and_verify_for_the_supplier(self):
        data = b"release archive"
        asset = {"url": "https://github.com/oras-project/oras/releases/download/v1/oras.zip",
                 "checksum": "sha256:" + hashlib.sha256(data).hexdigest(), "provenance": "github-attestations"}
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp, "archive")
            with patch("urllib.request.urlopen", side_effect=lambda *a, **kw: io.BytesIO(data)), patch("subprocess.run") as gh:
                verify = candidate["verify_archive"]
                self.assertEqual(verify(asset, archive), asset["checksum"])
                self.assertEqual(archive.read_bytes(), data)
                gh.assert_called_once_with(["gh", "attestation", "verify", str(archive), "--repo", "oras-project/oras",
                                            "--hostname", "github.com"], check=True, timeout=120)
                gh.side_effect = subprocess.CalledProcessError(1, "gh")
                with self.assertRaises(subprocess.CalledProcessError):
                    verify(asset, archive)
                gh.reset_mock()
                with self.assertRaisesRegex(ValueError, "digest differs"):
                    verify({**asset, "checksum": "sha256:" + "0" * 64}, archive)
                gh.assert_not_called()

    def test_root_title_lock_updates_both_generated_entries(self):
        old_pin = b"a" * 40, b"v1.2.3"
        new_pin = b"b" * 40, b"v1.2.4"

        def lock(sha, tag):
            reference = b"amannn/action-semantic-pull-request@" + sha
            return (
                b"version: 'v0.0.3'\nworkflows:\n"
                b"    '.github/workflows/pr-title.yml':\n        - '%s'\n"
                b"    '.github/workflows/other.yml':\n        - 'actions/checkout@pinned'\n"
                b"dependencies:\n    '%s':\n        ref: '%s'\n        commit: 'sha1-%s'\n"
                b"        owner_id: 4038316\n        repo_id: 220418983\n"
            ) % (reference, reference, tag, sha)

        matches = candidate["rules"].title_lock_update
        before, after = lock(*old_pin), lock(*new_pin)
        self.assertTrue(matches(before, after, old_pin, new_pin))
        for altered in (
            after.replace(new_pin[0], old_pin[0], 1),
            after.replace(b"commit: 'sha1-" + new_pin[0], b"commit: 'sha1-" + old_pin[0]),
            after.replace(new_pin[1], old_pin[1]),
            after.replace(b"owner_id: 4038316", b"owner_id: 10"),
            after.replace(b"actions/checkout@pinned", b"actions/checkout@different"),
        ):
            with self.subTest(altered=altered):
                self.assertFalse(matches(before, altered, old_pin, new_pin))

        def shared(lock_bytes, sha):
            return lock_bytes.replace(b"actions/checkout@pinned", b"amannn/action-semantic-pull-request@" + sha)

        self.assertFalse(matches(shared(before, old_pin[0]), shared(after, new_pin[0]), old_pin, new_pin))

    def test_central_title_pin_and_lock_select_title_profile(self):
        rules = candidate["rules"]
        workflow = Path(rules.CENTRAL_TITLE).read_bytes()
        (old_pin,) = rules.PINS.findall(workflow)
        new_pin = (b"b" * 40, b"v99.0.0")
        updated = workflow.replace(b"@%s # %s" % old_pin, b"@%s # %s" % new_pin)

        def locked(pin):
            sha, tag = pin
            reference = b"amannn/action-semantic-pull-request@" + sha
            return (
                b"version: 'v0.0.3'\nworkflows:\n    '%s':\n        - '%s'\n"
                b"    '.github/workflows/steward-source.yml': []\n"
                b"dependencies:\n    '%s':\n        ref: '%s'\n        commit: 'sha1-%s'\n"
                b"        owner_id: 4038316\n        repo_id: 220418983\n"
            ) % (rules.CENTRAL_TITLE.encode(), reference, reference, tag, sha)

        snapshots = {
            ("base", rules.CENTRAL_TITLE): workflow,
            ("head", rules.CENTRAL_TITLE): updated,
            ("base", rules.ACTION_LOCK): locked(old_pin),
            ("head", rules.ACTION_LOCK): locked(new_pin),
        }
        with (patch.dict(os.environ, {"GITHUB_EVENT_NAME": "pull_request"}),
              patch.object(rules, "git", return_value=b"100644 blob fixture"),
              patch.object(rules.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)),
              patch.object(rules, "changed_paths", return_value={rules.CENTRAL_TITLE, rules.ACTION_LOCK}),
              patch.object(rules, "blob", side_effect=lambda ref, path: snapshots[ref, path])):
            self.assertEqual(rules.classify("base", "head"), "title")
            snapshots["head", rules.ACTION_LOCK] = locked(old_pin)
            self.assertEqual(rules.classify("base", "head"), "full")

    def test_changed_paths_and_push_parent(self):
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
                policy_source = commit("config/review/security-common.md", "initial public policy")
                self.assertEqual(classify(policy, policy_source), "full")
                revised = commit("config/review/security-common.md", "revised public policy")
                self.assertEqual(classify(policy_source, revised), "policy")
                mixed = commit("packages/runner/dist/index.js", "runtime change")
                self.assertEqual(classify(revised, mixed), "full")
                self.assertEqual(classify(policy_source, mixed), "full")
            with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "pull_request"}):
                self.assertEqual(classify(first, head), "docs")
                self.assertEqual(classify(first, source), "full")
                self.assertEqual(classify(policy_source, revised), "policy")
                self.assertEqual(classify(policy_source, mixed), "full")

            governance = "scripts/governance-promotion.mjs"
            owned_paths = {
                governance, "packages/runner/test/governance-promotion.test.ts",
                "scripts/controller-source.mjs", "scripts/controller-source.test.mjs",
                "scripts/validator-revalidation.mjs", "scripts/validator-revalidation.test.mjs",
                "scripts/validator-source.mjs", "tools/template/promotion.py", "tools/template/test_promotion.py",
            }
            self.assertEqual(candidate["rules"].GOVERNANCE_PROMOTION, owned_paths)
            created = commit(governance, "initial promotion")
            updated = commit(governance, "updated promotion")
            with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "push"}):
                self.assertEqual(classify(created, updated), "full")
            shared = commit("packages/runner/dist/index.js", "updated shared runtime")
            with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "pull_request"}):
                self.assertEqual(classify(mixed, created), "full")
                self.assertEqual(classify(created, updated), "governance")
                self.assertEqual(classify(created, shared), "full")
                self.assertEqual(classify(shared, updated), "full")
                for path in sorted(owned_paths - {governance}):
                    initial = commit(path, "initial")
                    revised = commit(path, "revised")
                    with self.subTest(path=path):
                        self.assertEqual(classify(initial, revised), "governance")
                self.assertEqual(classify(created, revised), "full")

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

    def test_tool_directory_retries_windows_sharing_violation(self):
        locked = PermissionError("file is still in use")
        locked.winerror = 32
        with patch("tempfile.TemporaryDirectory") as temporary, patch("time.sleep") as sleep:
            directory = temporary.return_value
            directory.name = "candidate"
            directory.cleanup.side_effect = [locked, None]
            with candidate["tool_directory"]() as path:
                self.assertEqual(path, Path(directory.name))
            self.assertEqual(directory.cleanup.call_count, 2)
            sleep.assert_called_once_with(0.1)


if __name__ == "__main__":
    unittest.main()
