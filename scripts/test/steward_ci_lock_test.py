"""Regression coverage for the PR lock contract and split fork checkouts."""
import copy
from contextlib import chdir
import runpy
import subprocess
import tempfile
import unittest
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
            with chdir(directory):
                candidate["verify_other_locks"](*refs)


if __name__ == "__main__":
    unittest.main()
