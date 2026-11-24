"""Select a Steward PR test profile from the exact base and head trees."""
import argparse
import os
import re
import subprocess
import tomllib

PINS = re.compile(rb"(?m)^        uses: amannn/action-semantic-pull-request@([0-9a-f]{40}) # (v[0-9]+\.[0-9]+\.[0-9]+)$")
ROOT_TITLE = ".github/workflows/pr-title.yml"
TEMPLATE_TITLE = "templates/repository/" + ROOT_TITLE
CENTRAL_TITLE = ".github/workflows/pr-title-reusable.yml"
ACTION_LOCK = ".github/workflows/actions.lock"
SECURITY_POLICY = {"SECURITY.md", "config/review/security-common.md"}
# These entry points and their direct tests belong to the promotion workflow.
# Shared runner code, dependencies and workflow wiring keep both full suites.
GOVERNANCE_PROMOTION = {
    "scripts/controller-source.mjs", "scripts/controller-source.test.mjs",
    "scripts/validator-revalidation.mjs", "scripts/validator-revalidation.test.mjs",
    "scripts/validator-source.mjs",
    "scripts/governance-promotion.mjs", "packages/runner/test/governance-promotion.test.ts",
    "tools/template/promotion.py", "tools/template/test_promotion.py",
}
# Single-file tools with a native version command on both supported runners.
COMMANDS = {
    "aqua:anchore/syft": ("syft", "version"),
    "aqua:astral-sh/ruff": ("ruff", "--version"),
    "aqua:astral-sh/uv": ("uv", "--version"),
    "aqua:cli/cli": ("gh", "--version"),
    "aqua:oras-project/oras": ("oras", "version"),
    "aqua:zizmorcore/zizmor": ("zizmor", "--version"),
    "aqua:lycheeverse/lychee": ("lychee", "--version"),
}
PLATFORMS = ("platforms.linux-x64", "platforms.windows-x64")


def git(*args):
    return subprocess.check_output(["git", "-C", "target", *args])


def blob(ref, path):
    return git("show", f"{ref}:{path}")


def release_repository(url):
    match = re.fullmatch(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/releases/download/[\w.+-]+/[\w.+-]+", url)
    return match[1] if match else None


def supplier_metadata(previous, candidate):
    if not release_repository(previous.get("url", "")):
        return previous
    expected = dict(previous)
    for field, marker in (("checksum_source", "mise-versions"), ("provenance", "github-attestations")):
        if field not in previous and candidate.get(field) == marker:
            expected[field] = marker
    return expected


def tool_changes(before, after):
    old = tomllib.loads(before.decode())
    new = tomllib.loads(after.decode())
    original = old.pop("tools")
    candidate = new.pop("tools")
    if old != new or original.keys() != candidate.keys():
        return {}
    changed = {}
    for key, records in candidate.items():
        if original[key] == records:
            continue
        if key not in COMMANDS or len(records) != 1 or len(original[key]) != 1:
            return {}
        base = original[key][0]
        item = records[0]
        version = item["version"]
        if not re.fullmatch(r"\d+\.\d+\.\d+", version) or version == base["version"]:
            return {}
        expected = {**base, "version": version}
        for platform in PLATFORMS:
            previous = base[platform]
            updated = item[platform]
            # Keep supplier, tag scheme, platform filename, provenance and backend.
            asset = {**supplier_metadata(previous, updated), "url": previous["url"].replace(base["version"], version),
                     "checksum": updated["checksum"], "url_api": updated["url_api"]}
            api = previous["url_api"].rsplit("/", 1)[0]
            if not re.fullmatch(re.escape(api) + r"/[1-9]\d*", asset["url_api"]):
                return {}
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", asset["checksum"]):
                return {}
            expected[platform] = asset
        if expected != item:
            return {}
        changed[key] = item
    return changed


def changed_paths(base, head):
    return set(git("diff", "--name-only", "--no-ext-diff", "--no-textconv", "--no-renames", "-z", base, head)
               .decode().split("\0")) - {""}


def title_lock_update(before, after, old_pin, new_pin, path=ROOT_TITLE):
    action = b"amannn/action-semantic-pull-request@"

    def entries(pin):
        sha, tag = pin
        reference = action + sha
        workflow = b"    '%s':\n        - '%s'\n" % (path.encode(), reference)
        dependency = b"    '%s':\n        ref: '%s'\n        commit: 'sha1-%s'\n" % (reference, tag, sha)
        return workflow, dependency

    # A shared dependency or a change in the generated lock format takes the full path.
    workflows, separator, dependencies = before.partition(b"\ndependencies:\n")
    old_workflow, old_dependency = entries(old_pin)
    new_workflow, new_dependency = entries(new_pin)
    old_ref, new_ref = action + old_pin[0], action + new_pin[0]
    if (not separator or workflows.count(old_workflow) != 1 or dependencies.count(old_dependency) != 1
            or before.count(old_ref) != 2 or (new_ref != old_ref and new_ref in before)):
        return False
    return (workflows.replace(old_workflow, new_workflow) + separator
            + dependencies.replace(old_dependency, new_dependency)) == after


def classify(base, head):
    if os.environ.get("GITHUB_EVENT_NAME") == "push":
        # Only a single-parent default-branch update can reuse a narrow profile.
        if git("rev-list", "--parents", "-n1", "HEAD").decode().split() != [head, base]:
            return "full"
    # A stale/diverged branch needs the complete suite with ordinary base handling.
    if subprocess.run(["git", "-C", "target", "merge-base", "--is-ancestor", base, head]).returncode:
        return "full"
    paths = changed_paths(base, head)
    # The narrow profiles cover reviewed file roles with a matching validator.
    # Mixed source changes and additions/deletions keep the full suite.
    docs = bool(paths) and all(path == "README.md" or re.fullmatch(r"docs/[a-z][a-z0-9-]*\.md", path)
                               for path in paths)
    policy = bool(paths) and paths <= SECURITY_POLICY
    governance = (os.environ.get("GITHUB_EVENT_NAME") == "pull_request"
                  and bool(paths) and paths <= GOVERNANCE_PROMOTION)
    title_paths = ({TEMPLATE_TITLE}, {ROOT_TITLE, ACTION_LOCK}, {CENTRAL_TITLE, ACTION_LOCK})
    if not (docs or policy or governance) and paths not in ({"mise.lock"}, *title_paths):
        return "full"
    for path in paths:
        if not all(git("ls-tree", ref, "--", path).startswith(b"100644 blob ") for ref in (base, head)):
            return "full"
    if docs:
        return "docs"
    if policy:
        return "policy"
    if governance:
        return "governance"
    if paths == {"mise.lock"}:
        return "tool" if tool_changes(blob(base, "mise.lock"), blob(head, "mise.lock")) else "full"
    if paths not in title_paths:
        return "full"
    path = (paths - {ACTION_LOCK}).pop()
    old, new = (blob(ref, path) for ref in (base, head))
    old_pin, new_pin = PINS.findall(old), PINS.findall(new)
    if len(old_pin) != 1 or len(new_pin) != 1 or PINS.sub(b"PIN", old) != PINS.sub(b"PIN", new):
        return "full"
    if ACTION_LOCK in paths and not title_lock_update(
        blob(base, ACTION_LOCK), blob(head, ACTION_LOCK), old_pin[0], new_pin[0], path
    ):
        return "full"
    return "title"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("base")
    parser.add_argument("head")
    args = parser.parse_args()
    try:
        print(classify(args.base, args.head))
    except (ValueError, KeyError, TypeError, IndexError, subprocess.CalledProcessError):
        print("full")
