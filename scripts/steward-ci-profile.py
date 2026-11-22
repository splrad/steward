"""Select a Steward PR test profile from the exact base and head trees."""
import argparse
import os
import re
import subprocess
import tomllib

PINS = re.compile(rb"(?m)^        uses: amannn/action-semantic-pull-request@([0-9a-f]{40}) # (v[0-9]+\.[0-9]+\.[0-9]+)$")
ROOT_TITLE = ".github/workflows/pr-title.yml"
TEMPLATE_TITLE = "templates/repository/" + ROOT_TITLE
ACTION_LOCK = ".github/workflows/actions.lock"
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


def with_checksum_source(previous, candidate):
    # Mise may add this marker for a public GitHub release checksum.
    if (previous.get("url", "").startswith("https://github.com/")
            and "checksum_source" not in previous and candidate.get("checksum_source") == "mise-versions"):
        return {**previous, "checksum_source": "mise-versions"}
    return previous


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
            asset = {**with_checksum_source(previous, updated), "url": previous["url"].replace(base["version"], version),
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
    return set(git("diff", "--name-only", "--no-renames", "-z", base, head).decode().split("\0")) - {""}


def title_lock_update(before, after, old_pin, new_pin):
    action = b"amannn/action-semantic-pull-request@"

    def entries(pin):
        sha, tag = pin
        reference = action + sha
        workflow = b"    '%s':\n        - '%s'\n" % (ROOT_TITLE.encode(), reference)
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
    # Ordinary authored guides form a subset of Native Validation's Markdown scope.
    # Release inputs, policy instructions, templates and additions/deletions stay full.
    docs = bool(paths) and all(re.fullmatch(r"docs/[a-z][a-z0-9-]*\.md", path) for path in paths)
    if not docs and paths not in ({"mise.lock"}, {TEMPLATE_TITLE}, {ROOT_TITLE, ACTION_LOCK}):
        return "full"
    for path in paths:
        if not all(git("ls-tree", ref, "--", path).startswith(b"100644 blob ") for ref in (base, head)):
            return "full"
    if docs:
        return "docs"
    if paths == {"mise.lock"}:
        return "tool" if tool_changes(blob(base, "mise.lock"), blob(head, "mise.lock")) else "full"
    if paths not in ({TEMPLATE_TITLE}, {ROOT_TITLE, ACTION_LOCK}):
        return "full"
    path = TEMPLATE_TITLE if TEMPLATE_TITLE in paths else ROOT_TITLE
    old, new = (blob(ref, path) for ref in (base, head))
    old_pin, new_pin = PINS.findall(old), PINS.findall(new)
    if len(old_pin) != 1 or len(new_pin) != 1 or PINS.sub(b"PIN", old) != PINS.sub(b"PIN", new):
        return "full"
    if ACTION_LOCK in paths and not title_lock_update(
        blob(base, ACTION_LOCK), blob(head, ACTION_LOCK), old_pin[0], new_pin[0]
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
