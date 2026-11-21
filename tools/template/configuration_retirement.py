"""Reconcile only reproducible legacy changes on an already authenticated delivery branch."""
from pathlib import Path
import tempfile

import copier_bridge as copier
from configuration_link import add_link, has_legacy_link

CHOOSER = '.github/ISSUE_TEMPLATE/config.yml'


class MigrationConflict(ValueError):
    def __init__(self, paths):
        self.paths = sorted(paths)
        super().__init__('SYNC_PENDING_LEGACY_CONFIGURATION')


def chooser_outputs(repository, baseline):
    """Replay the historical link insertion and removal against the exact base bytes."""
    with tempfile.TemporaryDirectory(prefix='template-link-') as directory:
        file = Path(directory) / CHOOSER
        if baseline is not None:
            file.parent.mkdir(parents=True)
            file.write_bytes(baseline)
        add_link(directory, repository)
        outputs = {file.read_bytes()} if file.is_file() else set()
        add_link(directory, repository, retire=True)
        if file.is_file():
            outputs.add(file.read_bytes())
        return outputs


def reconcile(git, base, head, signed_head, historic_template, central, seed, repository, data, verify_change, env):
    """Restore base entries only when the branch's change matches its signed native source."""
    def entry(ref, path):
        return git('ls-tree', ref, '--', path).split(b'\t', 1)[0]

    def read(ref, path, meta):
        return git('show', ref + ':' + path) if meta else None

    def changed_by_bot(path):
        # Imported main commits are excluded. A later bot merge cannot claim an intervening manual edit.
        commits = git('rev-list', '--first-parent', '--full-history', base + '..' + head, '--', path).decode().splitlines()
        return bool(commits) and all(verify_change(commit) for commit in commits)

    expected_paths = None
    restore, conflicts = [], []
    for path in (*copier.LEGACY_CONFIGURATION, CHOOSER):
        previous, current = entry(base, path), entry('HEAD', path)
        if previous == current:
            continue
        current_bytes = read('HEAD', path, current)
        previous_bytes = read(base, path, previous)
        if path == CHOOSER:
            if current_bytes is None or (previous_bytes is not None and has_legacy_link(previous_bytes, repository)):
                continue
            empty_generated = previous_bytes is None and current_bytes == b'contact_links:\n  []\n'
            if not empty_generated and not has_legacy_link(current_bytes, repository):
                continue
            generated = chooser_outputs(repository, previous_bytes)
        else:
            generated = set()
            if expected_paths is None:
                _, _, expected_paths = copier.contract(central, historic_template, data, env)
            if path in expected_paths:
                directory = 'templates/repository/' + path
                jinja = directory + '.jinja'
                templated = bool(copier.git(central, ['ls-tree', historic_template, '--', jinja], env))
                source = copier.git(central, ['show', historic_template + ':' + (jinja if templated else directory)], env)
                if templated and any(mark in source for mark in (b'{{', b'{%', b'{#')):
                    if not seed.exists():
                        copier.render(central, seed, historic_template, 'copy', data)
                    source = (seed / path).read_bytes()
                generated.add(source)
        if (current.startswith(b'100644 blob ') and current_bytes in generated
                and current == entry(signed_head, path) and changed_by_bot(path)):
            restore.append(path)
        else:
            conflicts.append(path)
    if conflicts:
        raise MigrationConflict(conflicts)
    if restore:
        git('restore', '--source=' + base, '--staged', '--worktree', '--', *restore)
        git('commit', '--signoff', '--no-gpg-sign', '-m', 'Reconcile verified legacy template outputs')
