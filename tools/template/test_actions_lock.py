"""Offline transaction boundaries; official network tool acceptance is separate."""
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml
import actions_lock as lock
import copier_bridge as bridge

SHA = 'a' * 40
YAML = f'name: fixture\non: workflow_dispatch\npermissions: {{}}\njobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@{SHA} # v1.0.0\n      - run: echo unchanged\n'


def fixture_document(target):
    files = bridge.paths_in_tree(target)
    result = {'version': 'v0.0.3', 'workflows': {}, 'dependencies': {}}
    def refs(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == 'uses' and isinstance(value, str) and lock.PIN.fullmatch(value) and '/.github/workflows/' not in value:
                    yield value
                else:
                    yield from refs(value)
        elif isinstance(node, list):
            for value in node:
                yield from refs(value)
    for path in sorted(lock.workflows(files)):
        values = []
        for ref in refs(yaml.load(files[path], Loader=yaml.BaseLoader)):
            action, sha = ref.split('@')
            tag = 'fixture-' + sha
            key = action + '@' + tag
            values.append(key)
            result['dependencies'][key] = {'ref': tag, 'commit': 'sha1-' + sha,
                'owner_id': 1, 'repo_id': int(hashlib.sha256(action.split('/')[1].encode()).hexdigest()[:7], 16) + 1}
        result['workflows'][path] = sorted(set(values))
    return result


def fixture_tool(mode, target):
    expected = fixture_document(target)
    path = target / lock.LOCK
    if mode == 'generate':
        path.write_text(yaml.safe_dump(expected, sort_keys=False), encoding='utf-8')
    else:
        if lock.document(path.read_bytes()) != expected:
            raise lock.LockFailure('FIXTURE_VERIFY')


class LockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='actions-lock-transaction-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / '.github/workflows/managed.yml'
        self.path.parent.mkdir(parents=True)
        self.path.write_text(YAML, encoding='utf-8')
        (self.root / 'package-lock.json').write_bytes(b'EXACT ecosystem lock\r\n')
        (self.root / 'draft.md').write_bytes(b'EXACT human draft\r\n')

    def save_lock(self, value):
        (self.root / lock.LOCK).write_text(yaml.safe_dump(value, sort_keys=False), encoding='utf-8')

    def test_full_target_and_run_only_workflows_keep_original_bytes(self):
        (self.path.parent / 'manual.yaml').write_text(YAML.replace('echo unchanged', 'echo human'), encoding='utf-8')
        (self.path.parent / 'empty.yml').write_text('on: workflow_dispatch\njobs: {}\n', encoding='utf-8')
        before = bridge.paths_in_tree(self.root)
        calls = []
        def tool(mode, target):
            calls.append(mode)
            fixture_tool(mode, target)
            if mode == 'generate':
                self.path.write_text(YAML + '# tool formatting only\n', encoding='utf-8')
        result = lock.prepare(self.root, before, tool)
        self.assertEqual(result['workflows'], 3)
        self.assertEqual(calls, ['generate', 'verify'])
        after = bridge.paths_in_tree(self.root)
        self.assertEqual({k: v for k, v in after.items() if k != lock.LOCK}, before)
        again = lock.prepare(self.root, after, fixture_tool)
        self.assertEqual(again['affectedWorkflows'], [])
        self.assertEqual(bridge.paths_in_tree(self.root), after)

    def test_same_commit_tag_rewrite_is_rejected_before_verification(self):
        before = bridge.paths_in_tree(self.root)
        calls = []
        def tool(mode, target):
            calls.append(mode)
            fixture_tool(mode, target)
            if mode == 'generate':
                # The CLI can report this alias valid while the runner rejects
                # the restored full-SHA workflow because its exact key is absent.
                self.path.write_text(YAML.replace('@' + SHA, '@fixture-' + SHA), encoding='utf-8')
        with self.assertRaisesRegex(lock.LockFailure, 'WORKFLOW_REWRITE'):
            lock.prepare(self.root, before, tool)
        self.assertEqual(calls, ['generate'])

    def test_managed_rename_delete_and_new_dependency_preserve_manual_lock_entries(self):
        manual = self.path.parent / 'manual.yml'
        manual.write_text(YAML, encoding='utf-8')
        fixture_tool('generate', self.root)
        before = bridge.paths_in_tree(self.root)
        self.path.unlink()
        (self.path.parent / 'renamed.yml').write_text(YAML.replace('actions/checkout', 'actions/upload-artifact').replace(SHA, 'b' * 40), encoding='utf-8')
        result = lock.prepare(self.root, before, fixture_tool)
        self.assertEqual(result['affectedWorkflows'], ['.github/workflows/managed.yml', '.github/workflows/renamed.yml'])
        first = lock.document(before[lock.LOCK])
        after = lock.document((self.root / lock.LOCK).read_bytes())
        for key in first['workflows']['.github/workflows/manual.yml']:
            self.assertEqual(first['dependencies'][key], after['dependencies'][key])

    def test_existing_lock_is_input_and_unrelated_entries_cannot_be_refreshed(self):
        fixture_tool('generate', self.root)
        before = bridge.paths_in_tree(self.root)
        def tool(mode, target):
            self.assertEqual((target / lock.LOCK).read_bytes(), before[lock.LOCK])
            changed = fixture_document(target)
            next(iter(changed['dependencies'].values()))['commit'] = 'sha1-' + 'b' * 40
            self.save_lock(changed)
        with self.assertRaisesRegex(lock.LockFailure, 'UNRELATED_DEPENDENCY'):
            lock.prepare(self.root, before, tool)

    def test_initial_and_incremental_locks_reject_unreachable_global_entries(self):
        for existing in [False, True]:
            with self.subTest(existing=existing), tempfile.TemporaryDirectory(dir=self.root) as folder:
                target = Path(folder)
                path = target / '.github/workflows/managed.yml'
                path.parent.mkdir(parents=True)
                path.write_text(YAML, encoding='utf-8')
                if existing:
                    fixture_tool('generate', target)
                before = bridge.paths_in_tree(target)
                if existing:
                    path.write_text(YAML.replace(SHA, 'b' * 40), encoding='utf-8')
                def tool(mode, directory):
                    if mode == 'generate':
                        value = fixture_document(directory)
                        entry = next(iter(value['dependencies'].values()))
                        value['dependencies']['actions/checkout@unused'] = {**entry, 'ref': 'unused'}
                        (directory / lock.LOCK).write_text(yaml.safe_dump(value), encoding='utf-8')
                    # The official v0.4.0 --verify accepts an unreachable global entry.
                with self.assertRaisesRegex(lock.LockFailure, 'UNREACHABLE_DEPENDENCY'):
                    lock.prepare(target, before, tool)

    def test_reachable_transitive_entries_are_preserved_and_missing_edges_fail(self):
        before = bridge.paths_in_tree(self.root)
        value = fixture_document(self.root)
        root = next(iter(value['dependencies']))
        child = 'shared/action@v1'
        value['dependencies'][root]['uses'] = [child]
        value['dependencies'][child] = {'ref': 'v1', 'commit': 'sha1-' + 'b' * 40, 'owner_id': 2, 'repo_id': 3}
        def tool(mode, target):
            if mode == 'generate':
                self.save_lock(value)
            else:
                self.assertEqual(lock.document((target / lock.LOCK).read_bytes()), value)
        self.assertEqual(lock.prepare(self.root, before, tool)['status'], 'VERIFIED')
        self.assertEqual(lock.document((self.root / lock.LOCK).read_bytes()), value)
        existing = bridge.paths_in_tree(self.root)
        del value['dependencies'][child]
        with self.assertRaisesRegex(lock.LockFailure, 'DEPENDENCY_MISSING'):
            lock.prepare(self.root, existing, tool)

    def test_composite_transitive_add_upgrade_delete_and_shared_preservation(self):
        manual = self.path.parent / 'manual.yml'
        manual.write_text(YAML, encoding='utf-8')
        def composite_tool(mode, target):
            value = fixture_document(target)
            for key, entry in list(value['dependencies'].items()):
                if key.startswith('example/composite@'):
                    child = 'shared/action@' + entry['ref']
                    entry['uses'] = [child]
                    value['dependencies'][child] = {**entry, 'uses': [], 'owner_id': 7, 'repo_id': 9}
            if mode == 'generate': self.save_lock(value)
            else: self.assertEqual(lock.document((target / lock.LOCK).read_bytes()), value)
        composite_tool('generate', self.root)
        before = bridge.paths_in_tree(self.root)
        self.path.write_text(YAML.replace('actions/checkout', 'example/composite').replace(SHA, 'b' * 40), encoding='utf-8')
        self.assertEqual(lock.prepare(self.root, before, composite_tool)['status'], 'VERIFIED')
        adopted = bridge.paths_in_tree(self.root)
        self.path.write_text(YAML.replace('actions/checkout', 'example/composite').replace(SHA, 'c' * 40), encoding='utf-8')
        self.assertEqual(lock.prepare(self.root, adopted, composite_tool)['status'], 'VERIFIED')
        previous = bridge.paths_in_tree(self.root)
        manual.write_bytes(self.path.read_bytes())
        composite_tool('generate', self.root)
        shared = bridge.paths_in_tree(self.root)
        self.path.unlink()
        self.assertEqual(lock.prepare(self.root, shared, composite_tool)['status'], 'VERIFIED')
        after = lock.document((self.root / lock.LOCK).read_bytes())
        self.assertEqual(after['dependencies'], lock.document(shared[lock.LOCK])['dependencies'])
        only_manual = bridge.paths_in_tree(self.root)
        manual.unlink()
        self.assertEqual(lock.prepare(self.root, only_manual, composite_tool)['status'], 'VERIFIED')
        self.assertEqual(lock.document((self.root / lock.LOCK).read_bytes())['dependencies'], {})
        self.assertNotEqual(previous, adopted)

    def test_unchanged_workflow_transitive_consumer_blocks_refresh(self):
        manual = self.path.parent / 'manual.yml'
        manual.write_text(YAML, encoding='utf-8')
        value = fixture_document(self.root)
        root = next(iter(value['dependencies']))
        child = 'shared/action@v1'
        value['dependencies'][root]['uses'] = [child]
        value['dependencies'][child] = {'ref':'v1','commit':'sha1-' + 'b' * 40,'owner_id':7,'repo_id':9}
        self.save_lock(value)
        before = bridge.paths_in_tree(self.root)
        self.path.write_text(YAML.replace('echo unchanged','echo modified'),encoding='utf-8')
        value['dependencies'][child]['commit'] = 'sha1-' + 'c' * 40
        with self.assertRaisesRegex(lock.LockFailure,'UNRELATED_DEPENDENCY'):
            lock.prepare(self.root,before,lambda mode,target:self.save_lock(value))

    def test_explicit_managed_pin_update_under_same_ref_preserves_unaffected_shared_entries(self):
        def branch_tool(mode, target):
            value = fixture_document(target)
            entries = list(value['dependencies'].values())
            assert len(entries) == 1
            value['dependencies'] = {'actions/checkout@main': {**entries[0], 'ref': 'main'}}
            value['workflows'] = {p: ['actions/checkout@main'] for p in value['workflows']}
            if mode == 'generate': self.save_lock(value)
            else: self.assertEqual(lock.document((target / lock.LOCK).read_bytes()), value)
        branch_tool('generate', self.root)
        before = bridge.paths_in_tree(self.root)
        self.path.write_text(YAML.replace(SHA, 'b' * 40), encoding='utf-8')
        result = lock.prepare(self.root, before, branch_tool)
        self.assertEqual(result['affectedWorkflows'], ['.github/workflows/managed.yml'])
        self.assertEqual(lock.document((self.root / lock.LOCK).read_bytes())['dependencies']['actions/checkout@main']['commit'], 'sha1-' + 'b' * 40)
        # An unchanged workflow also consumes the global dependency entry.
        manual = self.path.parent / 'manual.yml'
        manual.write_text(YAML.replace(SHA, 'b' * 40), encoding='utf-8')
        branch_tool('generate', self.root)
        before = bridge.paths_in_tree(self.root)
        self.path.write_text(YAML.replace(SHA, 'c' * 40), encoding='utf-8')
        def shared_update(mode, target):
            value = lock.document(before[lock.LOCK])
            value['dependencies']['actions/checkout@main']['commit'] = 'sha1-' + 'c' * 40
            self.save_lock(value)
        with self.assertRaisesRegex(lock.LockFailure, 'UNRELATED_DEPENDENCY'):
            lock.prepare(self.root, before, shared_update)

    def test_source_repository_identity_change_rejected_across_version_keys(self):
        fixture_tool('generate', self.root)
        before = bridge.paths_in_tree(self.root)
        self.path.write_text(YAML.replace(SHA, 'b' * 40), encoding='utf-8')
        def tool(mode, target):
            changed = fixture_document(target)
            next(iter(changed['dependencies'].values()))['repo_id'] += 1
            self.save_lock(changed)
        with self.assertRaisesRegex(lock.LockFailure, 'SOURCE_IDENTITY_CHANGED'):
            lock.prepare(self.root, before, tool)

    def test_new_unmanaged_coverage_is_not_silently_adopted_into_existing_lock(self):
        fixture_tool('generate', self.root)
        (self.path.parent / 'manual-new.yml').write_text('jobs: {}\n', encoding='utf-8')
        before = bridge.paths_in_tree(self.root)
        with self.assertRaisesRegex(lock.LockFailure, 'UNRELATED_WORKFLOW'):
            lock.prepare(self.root, before, fixture_tool)

    def test_workflow_or_ecosystem_rewrites_and_missing_coverage_fail(self):
        for case in ['workflow', 'ecosystem', 'coverage', 'wrong-pin', 'verify-write']:
            with self.subTest(case=case), tempfile.TemporaryDirectory(dir=self.root) as folder:
                target = Path(folder)
                path = target / '.github/workflows/managed.yml'
                path.parent.mkdir(parents=True); path.write_text(YAML, encoding='utf-8')
                before = bridge.paths_in_tree(target)
                def tool(mode, directory):
                    fixture_tool(mode, directory)
                    if mode == 'generate':
                        if case == 'workflow': path.write_text(YAML.replace('echo unchanged', 'echo changed'))
                        if case == 'ecosystem': (target / 'package-lock.json').write_text('changed')
                        if case == 'wrong-pin': path.write_text(YAML.replace(SHA, 'b' * 40))
                        if case == 'coverage':
                            value = fixture_document(target); value['workflows'] = {}
                            (target / lock.LOCK).write_text(yaml.safe_dump(value))
                    elif case == 'verify-write': (target / 'draft.md').write_text('changed')
                code = {'workflow': 'WORKFLOW_REWRITE', 'ecosystem': 'UNEXPECTED_FILE', 'coverage': 'FULL_TREE_COVERAGE',
                        'wrong-pin': 'WORKFLOW_REWRITE', 'verify-write': 'VERIFY_MUTATION'}[case]
                with self.assertRaisesRegex(lock.LockFailure, code): lock.prepare(target, before, tool)

    def test_derived_lock_from_template_and_unknown_tool_results_are_rejected(self):
        before = bridge.paths_in_tree(self.root)
        fixture_tool('generate', self.root)
        with self.assertRaisesRegex(lock.LockFailure, 'TEMPLATE_WROTE_DERIVED_LOCK'):
            lock.prepare(self.root, before, fixture_tool)
        for raw in [b'not: a lock', b'version: v0.0.3\nversion: v0.0.3\nworkflows: {}\ndependencies: {}']:
            with self.assertRaises(lock.LockFailure): lock.document(raw)

    def test_official_tool_uses_reviewed_version_read_token_and_no_target_execution_flags(self):
        with self.assertRaisesRegex(lock.LockFailure, 'CONTROLLER_SHA'):
            lock.OfficialTool('fixed-gh', self.root, 'main', 'splrad/fixture', 'read-only', self.root / 'bad-profile')
        profile = self.root / 'profile'
        with patch.object(bridge, 'git', return_value=b'v0.4.0\n') as git, patch.dict('os.environ',
                {'STEWARD_TEMPLATE_TOKEN': 'write-bait', 'GITHUB_TOKEN': 'other-bait', 'NODE_OPTIONS': 'bait'}):
            tool = lock.OfficialTool('fixed-gh', self.root, SHA, 'splrad/fixture', 'read-only', profile)
        self.assertEqual(git.call_args.args[1], ['show', SHA + ':config/actions-lock-version.txt'])
        self.assertEqual(tool.env['GH_TOKEN'], 'read-only')
        self.assertFalse(any(k in tool.env for k in ['STEWARD_TEMPLATE_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS']))
        calls = []
        def command(args, cwd, env):
            calls.append((args, cwd))
            if '--version' in args: return b'actions-lock version v0.4.0\n'
            return b'{"valid":true}'
        tool.command = command
        tool('generate', self.root); tool('verify', self.root)
        self.assertEqual(calls[0], (['extension', 'install', 'github/gh-actions-lock', '--pin', 'v0.4.0'], profile))
        self.assertEqual(calls[2][0], ['actions-lock', '--no-narrow', '--no-interactive', '--json'])
        self.assertEqual(calls[3][0], ['actions-lock', '--verify', '--no-interactive', '--json'])
        for raw in [b'{"valid":false}', b'{}', b'unknown']:
            tool.command = lambda *args, raw=raw: raw
            with self.assertRaises(lock.LockFailure): tool('verify', self.root)


if __name__ == '__main__':
    unittest.main()
