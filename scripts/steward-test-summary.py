"""Add selected Node test suites and failures to the native Actions summary."""

import os
from html import escape
from pathlib import Path
from xml.etree import ElementTree

STEP_SUITES = {
    "FULL": ("Node tests and configuration", [
        "pages", "private-dependencies", "settings-events", "controller-source",
        "bounded-release", "configuration",
    ]),
    "CONTROLLER": ("Windows governance promotion checks", ["controller-source"]),
    "QUALITY": ("Quality language tests", ["quality-language"]),
}


def summary():
    reports = Path(os.environ["STEWARD_NODE_TEST_REPORTS"])
    run = f'{os.environ["GITHUB_SERVER_URL"]}/{os.environ["GITHUB_REPOSITORY"]}/actions/runs/{os.environ["GITHUB_RUN_ID"]}'
    lines = ["### Steward Node test results", "", f"[Open this run and its step logs]({run})", ""]
    for key, (step, suites) in STEP_SUITES.items():
        outcome = os.environ.get(key)
        if outcome not in {"success", "failure", "cancelled"}:
            continue
        lines.append(f"#### {step}")
        lines.append("")
        for suite in suites:
            path = reports / f"{suite}.xml"
            try:
                data = ElementTree.parse(path)
            except (OSError, ElementTree.ParseError):
                lines.append(f"- <code>{suite}</code> has no complete JUnit report.")
                continue
            tests = data.getroot().findall(".//testcase")
            failed = [test for test in tests if test.find("failure") is not None or test.find("error") is not None]
            skipped = sum(test.find("skipped") is not None for test in tests)
            lines.append(f"- <code>{suite}</code> · {len(tests)} cases · {len(failed)} failures · {skipped} skipped")
            for test in failed:
                name = escape(test.get("name", "")).replace("\r", " ").replace("\n", " ")
                lines.append(f"  - <code>{name}</code>")
        if outcome != "success":
            lines.append(f"- Step ended with **{outcome}**. Open its log for the command and full output.")
        lines.append("")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
        output.write(summary())
