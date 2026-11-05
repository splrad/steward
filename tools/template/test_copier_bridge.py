"""Real Copier/Git fixtures: no GitHub writes, no hand-written adopted answers."""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml
import copier_bridge as bridge

ROOT = Path(__file__).resolve().parents[2]


class CopierTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='steward-copier-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.central, self.product = self.root / 'central', self.root / 'product'
        self.central.mkdir()
        shutil.copyfile(ROOT / 'copier.yml', self.central / 'copier.yml')
        shutil.copytree(ROOT / 'templates/repository', self.central / 'templates/repository')
        self.identity = ['Fixture', 'fixture@example.invalid']
        self.init(self.central)
        self.old = self.commit(self.central, 'First template')
        self.git(self.central, 'tag', 'v1.0.0')
        original = bridge.environment

        def local_transport(profile):
            env = original(profile)
            # Git transports the exact official URL to a local fixture; Copier writes the real URL in answers.
            env.update(GIT_CONFIG_COUNT='5', GIT_CONFIG_KEY_4='url.' + self.central.as_posix() + '.insteadOf', GIT_CONFIG_VALUE_4=bridge.SOURCE)
            return env
        self.transport = patch.object(bridge, 'environment', local_transport)
        self.transport.start()

    def tearDown(self):
        self.transport.stop()
        self.temp.cleanup()

    def git(self, cwd, *args):
        return subprocess.check_output(['git', '-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', *args], cwd=cwd, stderr=subprocess.PIPE).decode().strip()

    def init(self, directory):
        self.git(directory, 'init', '--initial-branch=main')
        self.git(directory, 'config', 'user.name', self.identity[0])
        self.git(directory, 'config', 'user.email', self.identity[1])
        self.git(directory, 'config', 'core.autocrlf', 'false')

    def commit(self, directory, message):
        self.git(directory, 'add', '--all')
        self.git(directory, 'commit', '--signoff', '--no-gpg-sign', '-m', message)
        body = self.git(directory, 'show', '-s', '--format=%B')
        self.assertEqual(body.count('Signed-off-by:'), 1)
        self.assertIn(f'Signed-off-by: {self.identity[0]} <{self.identity[1]}>', body)
        return self.git(directory, 'rev-parse', 'HEAD')

    def copy_adopt(self):
        bridge.render(self.central, self.product, self.old, 'copy')
        self.init(self.product)
        self.commit(self.product, 'Adopt actual Copier output')

    def next_version(self, change):
        change(self.central / 'templates/repository')
        sha = self.commit(self.central, 'Second template')
        self.git(self.central, 'tag', 'v2.0.0')
        return sha

    def test_native_template_selection_respects_ancestry_versions_and_ambiguous_tags(self):
        newer=self.next_version(lambda directory:(directory/'AGENTS.md').write_text('New shared rules\n'))
        self.assertEqual(bridge.select_template(self.central,self.old)['templateSha'],self.old)
        self.assertEqual(bridge.select_template(self.central,newer)['templateSha'],newer)
        self.git(self.central,'tag','v99.0.0rc1')
        self.assertEqual(bridge.select_template(self.central,newer)['templateSha'],newer)
        (self.central/'templates/repository/AGENTS.md').write_text('Another version\n')
        changed=self.commit(self.central,'Ambiguous tag fixture');self.git(self.central,'tag','2.0.0')
        with self.assertRaisesRegex(ValueError,'TEMPLATE_VERSION_AMBIGUOUS'):bridge.select_template(self.central,changed)

    def test_four_repository_carriers_are_identical_complete_copier_output(self):
        expected=(self.central/'templates/repository/AGENTS.md').read_bytes()
        self.assertNotIn(b'\r',expected);self.assertTrue(expected.endswith(b'\n'));self.assertFalse(expected.endswith(b'\n\n'))
        for name in ['steward','LayerScape','.github','new-repository']:
            seed=self.root/(name+'-seed')
            rendered=bridge.render(self.central,seed,self.old,'copy')
            self.assertEqual((seed/'AGENTS.md').read_bytes(),expected)
            self.assertEqual(rendered['answers']['_src_path'],bridge.SOURCE)
            self.assertFalse((seed/'config/review').exists())
            self.assertFalse((seed/'.github/copilot-instructions.md').exists())

    def test_adoption_preserves_complete_product_contribution_text_and_refuses_report_overwrite(self):
        self.copy_adopt()
        contribution=self.product/'CONTRIBUTING.md'
        contribution.write_bytes(b'# Product-specific instructions\n\n'+contribution.read_bytes()+b'\nKeep all extra product details.\n')
        before=contribution.read_bytes()
        result=bridge.prepare_adoption(self.central,self.product,self.root/'seed',self.old)
        self.assertEqual(result['conflicts'],[]);self.assertEqual(result['preservedCustomFiles'],['CONTRIBUTING.md'])
        self.assertEqual(contribution.read_bytes(),before)
        report=self.product/bridge.ADOPTION_REPORT;report.write_text('Human-owned report\n')
        with self.assertRaisesRegex(ValueError,'TEMPLATE_ADOPTION_REPORT_EDITED'):
            bridge.prepare_adoption(self.central,self.product,self.root/'second-seed',self.old)
        self.assertEqual(report.read_text(),'Human-owned report\n')

    def test_real_copy_adopt_update_and_product_owned_files(self):
        self.copy_adopt()
        (self.product / 'CONTRIBUTING.md').write_text((self.product / 'CONTRIBUTING.md').read_text(encoding='utf-8') + '\n## Product details\nKeep this user text.\n', encoding='utf-8')
        owned = {'VERSION': '9.2.2\n', 'package-lock.json': '{"manual":true}\n', '.release-notes/unit.md': '用户已审说明\n', 'CHANGELOG.md': 'manual history\n'}
        for path, text in owned.items():
            (self.product / path).parent.mkdir(exist_ok=True)
            (self.product / path).write_text(text, encoding='utf-8')
        self.commit(self.product, 'Preserve product inputs')
        old_answers = yaml.safe_load((self.product / '.copier-answers.yml').read_text())
        self.assertEqual(old_answers['_src_path'], bridge.SOURCE)
        def change(template):
            p = template / 'AGENTS.md'; p.write_text(p.read_text(encoding='utf-8') + '\nShared second version.\n', encoding='utf-8')
        new = self.next_version(change)
        result = bridge.render(self.central, self.product, new, 'update')
        self.assertIn('AGENTS.md', result['paths'])
        self.assertIn('Keep this user text.', (self.product / 'CONTRIBUTING.md').read_text(encoding='utf-8'))
        for path, text in owned.items():
            self.assertEqual((self.product / path).read_text(encoding='utf-8'), text)
        self.commit(self.product, 'Adopt second template')
        self.assertEqual(bridge.render(self.central, self.product, new, 'update')['paths'], [])

    def test_copy_does_not_overwrite_and_adoption_diff_preserves_conflicts(self):
        seed = self.root / 'seed'
        bridge.render(self.central, seed, self.old, 'copy')
        self.product.mkdir(); (self.product / 'AGENTS.md').write_text('Existing specific facts\n')
        before = bridge.paths_in_tree(self.product)
        with self.assertRaisesRegex(ValueError, 'SEED_EXISTS'):
            bridge.render(self.central, self.product, self.old, 'copy')
        difference = bridge.adoption_diff(seed, self.product)
        self.assertEqual(difference['conflicts'][0]['current'], before['AGENTS.md'].decode())
        self.assertIn('.copier-answers.yml', difference['new'])
        self.assertEqual(bridge.paths_in_tree(self.product), before)

    def test_review_recovery_uses_a_new_template_version_and_keeps_product_changes(self):
        self.copy_adopt()
        original = (self.product / 'AGENTS.md').read_bytes()
        contribution = self.product / 'CONTRIBUTING.md'
        contribution.write_text(contribution.read_text(encoding='utf-8') + '\n## Product notes\nKeep this recovery evidence.\n', encoding='utf-8')
        self.commit(self.product, 'Keep product contribution text')
        changed = self.next_version(lambda template: (template / 'AGENTS.md').write_bytes(original + b'\nReviewed second version.\n'))
        bridge.render(self.central, self.product, changed, 'update')
        self.commit(self.product, 'Adopt second template')
        (self.central / 'templates/repository/AGENTS.md').write_bytes(original)
        recovery = self.commit(self.central, 'Restore reviewed text in a new version')
        self.git(self.central, 'tag', 'v3.0.0')
        result = bridge.render(self.central, self.product, recovery, 'update')
        self.assertEqual((self.product / 'AGENTS.md').read_bytes(), original)
        self.assertIn('Keep this recovery evidence.', contribution.read_text(encoding='utf-8'))
        self.assertEqual(result['answers']['_src_path'], bridge.SOURCE)
        self.assertEqual(result['answers']['_commit'], 'v3.0.0')
        self.assertEqual(self.git(self.central, 'rev-parse', result['answers']['_commit'] + '^{commit}'), recovery)
        self.commit(self.product, 'Adopt recovery template')
        self.assertEqual(bridge.render(self.central, self.product, recovery, 'update')['paths'], [])

    def test_conflict_and_dirty_tree_are_not_delivery_ready(self):
        self.copy_adopt()
        path = self.product / 'AGENTS.md'
        original = path.read_text(encoding='utf-8')
        path.write_text(original.replace('## Code Review Rules', '## Human review facts'), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'DIRTY'):
            bridge.render(self.central, self.product, self.old, 'update')
        self.commit(self.product, 'Human review change')
        def change(t):
            (t / 'AGENTS.md').write_text(original.replace('## Code Review Rules', '## Central review change'), encoding='utf-8')
        new = self.next_version(change)
        with self.assertRaisesRegex(ValueError, 'CONFLICT|COMMAND_FAILED'):
            bridge.render(self.central, self.product, new, 'update')
        self.assertIn('Human review facts', self.git(self.product, 'show', 'HEAD:AGENTS.md'))
        self.assertTrue(any('Human review facts' in p.read_text(encoding='utf-8') for p in self.product.rglob('*.rej')))

    def test_answers_cannot_select_another_source(self):
        self.copy_adopt()
        p = self.product / '.copier-answers.yml'
        p.write_text(p.read_text().replace(bridge.SOURCE, 'https://attacker.invalid/template.git'))
        self.commit(self.product, 'Untrusted answers fixture')
        with self.assertRaisesRegex(ValueError, 'TEMPLATE_SOURCE'):
            bridge.render(self.central, self.product, self.old, 'update')

    def test_new_tasks_and_required_question_are_refused(self):
        for setting, expected in [('_tasks: [echo BAD]\n', 'EXECUTION_SETTING'), ('answer:\n  type: str\n', 'REQUIRED_INPUT')]:
            with self.subTest(setting=setting):
                p = self.central / 'copier.yml'; original = p.read_text()
                p.write_text(original + setting)
                sha = self.commit(self.central, 'Unsafe template fixture')
                tag = 'v3.0.0' if '_tasks' in setting else 'v4.0.0'; self.git(self.central, 'tag', tag)
                with self.assertRaisesRegex(ValueError, expected):
                    bridge.render(self.central, self.root / tag, sha, 'copy')
                p.write_text(original); self.commit(self.central, 'Restore template fixture')

    def test_old_template_execution_setting_is_rejected_before_update(self):
        p = self.central / 'copier.yml'; original = p.read_text()
        p.write_text(original + '_tasks: [echo BAD]\n')
        bad = self.commit(self.central, 'Previously unsafe template fixture')
        self.git(self.central, 'tag', 'v0.9.0')
        p.write_text(original); self.commit(self.central, 'Restore fixture')
        self.copy_adopt()
        answer = self.product / '.copier-answers.yml'
        value = yaml.safe_load(answer.read_bytes()); value['_commit'] = bad
        answer.write_text(yaml.safe_dump(value))
        self.commit(self.product, 'Old unsafe template answers fixture')
        before = bridge.paths_in_tree(self.product)
        with self.assertRaisesRegex(ValueError, 'EXECUTION_SETTING'):
            bridge.render(self.central, self.product, self.old, 'update')
        self.assertEqual(bridge.paths_in_tree(self.product), before)

    def test_link_target_is_rejected_before_resolution(self):
        self.product.mkdir()
        linked = self.root / 'linked'
        if os.name == 'nt':
            subprocess.run(['cmd', '/c', 'mklink', '/J', str(linked), str(self.product)],
                           check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        else:
            linked.symlink_to(self.product, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'SYMLINK'):
            bridge.render(self.central, linked / 'seed', self.old, 'copy')
        self.assertFalse((self.product / 'seed').exists())

    def test_declared_data_file_handles_required_question_without_tty(self):
        p = self.central / 'copier.yml'; p.write_text(p.read_text() + 'project_name:\n  type: str\n')
        sha = self.commit(self.central, 'Required repository fact'); self.git(self.central, 'tag', 'v3.0.0')
        result = bridge.render(self.central, self.product, sha, 'copy', {'project_name': 'fixture'})
        self.assertEqual(result['answers']['project_name'], 'fixture')

    def test_template_source_delete_rename_and_target_delete_are_observed(self):
        extra = self.central / 'templates/repository/shared.txt'; extra.write_text('shared one\n')
        self.old = self.commit(self.central, 'Additional common file'); self.git(self.central, 'tag', 'v1.1.0')
        self.copy_adopt()
        def change(t):
            (t / 'shared.txt').rename(t / 'renamed.txt')
        new = self.next_version(change)
        bridge.render(self.central, self.product, new, 'update')
        self.assertFalse((self.product / 'shared.txt').exists())
        self.assertTrue((self.product / 'renamed.txt').exists())
        self.commit(self.product, 'Adopt template rename')
        (self.product / 'renamed.txt').unlink(); self.commit(self.product, 'Human deletion')
        with self.assertRaisesRegex(ValueError, 'REQUIRED_FILE_MISSING'):
            bridge.render(self.central, self.product, new, 'update')

    def test_product_paths_cannot_enter_periodic_template_and_environment_has_no_secrets(self):
        def change(t): (t / 'VERSION').write_text('fake\n')
        new = self.next_version(change)
        with self.assertRaisesRegex(ValueError, 'PRODUCT_OWNERSHIP'):
            bridge.render(self.central, self.product, new, 'copy')
        (self.central / 'templates/repository/VERSION').unlink()
        (self.central / 'templates/repository' / bridge.ADOPTION_REPORT).write_text('Template-owned report\n')
        reserved = self.commit(self.central, 'Reserved adoption report fixture'); self.git(self.central, 'tag', 'v3.0.0')
        with self.assertRaisesRegex(ValueError, 'PRODUCT_OWNERSHIP'):
            bridge.render(self.central, self.product, reserved, 'copy')
        with patch.dict(os.environ, {'GH_TOKEN': 'canary', 'APP_ID': 'canary', 'PRIVATE_KEY': 'canary', 'NODE_OPTIONS': 'canary', 'PYTHONPATH': 'canary'}):
            env = bridge.environment(self.root)
            self.assertFalse(set(env) & {'GH_TOKEN', 'APP_ID', 'PRIVATE_KEY', 'NODE_OPTIONS', 'PYTHONPATH'})


if __name__ == '__main__':
    unittest.main()
