"""Run the adopted native lock tool against proposed workflow files, without product execution."""
import json
import os
from pathlib import Path
import shutil
import sys

import actions_lock
import copier_bridge


def main():
    target, proposed = map(Path, sys.argv[1:3])
    repo, sha = sys.argv[3:5]
    before = copier_bridge.paths_in_tree(target)
    for path, content in json.loads(proposed.read_text(encoding='utf-8')).items():
        output = (target / path).resolve()
        if not output.is_relative_to(target.resolve()):
            raise ValueError('Invalid configuration lock input')
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(content, encoding='utf-8', newline='\n')
    tool = actions_lock.OfficialTool(shutil.which('gh'), Path.cwd(), sha, repo, os.environ['READ_TOKEN'], target.parent/'profile')
    actions_lock.prepare(target, before, tool)


if __name__ == '__main__':
    main()
