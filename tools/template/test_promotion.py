import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
import yaml
from copier import run_copy, run_update
from promotion import TITLE_CALLER, TITLE_SOURCE, previous_template_tag, template_tag_plan


class PromotionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='promotion-git-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.git('init','--initial-branch=main')
        self.git('config','user.name','Fixture')
        self.git('config','user.email','fixture@example.invalid')
        (self.root/'copier.yml').write_text('_subdirectory: templates/repository\n')
        (self.root/'templates/repository').mkdir(parents=True)
        (self.root/'templates/repository/README.md').write_text('first\n')
        self.old=self.commit()
        self.git('tag','v1.2.3')

    def git(self,*args):
        return subprocess.check_output(['git','-c','core.hooksPath=',*args],cwd=self.root,stderr=subprocess.PIPE).decode().strip()

    def commit(self):
        self.git('add','--all')
        self.git('commit','--signoff','--no-gpg-sign','-m','fixture')
        self.assertEqual(self.git('show','-s','--format=%B').count('Signed-off-by: Fixture <fixture@example.invalid>'),1)
        return self.git('rev-parse','HEAD')

    def test_sdk_and_controller_versions_leave_the_template_version_unchanged(self):
        self.git('tag','controller-v1000',self.old)
        (self.root/'sdk.txt').write_text('changed SDK\n')
        plan=template_tag_plan(self.root,self.commit())
        self.assertEqual(plan['status'],'UNCHANGED')
        self.assertEqual(plan['tags'],{'refs/tags/v1.2.3':self.old})

    def test_changed_template_tags_exact_validated_commit_and_repeat_is_nop(self):
        (self.root/'templates/repository/README.md').write_text('next\n')
        current=self.commit();plan=template_tag_plan(self.root,current)
        self.assertEqual(plan['tag'],'v1.2.4');self.assertEqual(plan['commit'],current)
        self.git('tag',plan['tag'],current)
        self.assertEqual(template_tag_plan(self.root,current)['status'],'UNCHANGED')

    def test_release_recovers_its_original_range_after_another_promotion(self):
        template=self.root/'templates/repository/README.md'
        template.write_text('second\n')
        target=self.commit()
        self.git('tag','v1.2.4',target)
        self.git('tag','controller-v24',target)
        template.write_text('third\n')
        self.git('tag','v1.2.5',self.commit())
        self.assertEqual(previous_template_tag(self.root,target,'v1.2.4'),'v1.2.3')
        for tag in ['v1.2.3','v1.2.5','controller-v24']:
            with self.subTest(tag=tag),self.assertRaisesRegex(Exception,'TEMPLATE_RELEASE_RANGE'):
                previous_template_tag(self.root,target,tag)
        self.git('tag','v9.9.9',target)
        with self.assertRaisesRegex(Exception,'TEMPLATE_RELEASE_RANGE'):
            previous_template_tag(self.root,target,'v9.9.9')

    def test_release_uses_the_permitted_tag_push_event(self):
        path=Path(__file__).resolve().parents[2]/'.github/workflows/template-release.yml'
        workflow=yaml.load(path.read_text(encoding='utf-8'),Loader=yaml.BaseLoader)
        self.assertEqual(workflow['on'],{'push':{'tags':['v[0-9]*','controller-v[0-9]*']}})
        gate=workflow['jobs']['range']['if']
        for condition in ("github.repository_id == '1296724484'",'github.event.created','!github.event.deleted',
                          'github.event.ref == github.ref','github.event.after == github.sha',
                          'github.event.sender.id == 353238212',"github.event.sender.login == 'splrad-governance[bot]'"):
            self.assertIn(condition,gate)
        self.assertEqual(workflow['jobs']['publish']['needs'],'range')

    def test_controller_release_range_uses_the_previous_number_and_requires_a_strict_ancestor(self):
        path = Path(__file__).resolve().parents[2] / '.github/workflows/template-release.yml'
        workflow = yaml.load(path.read_text(encoding='utf-8'), Loader=yaml.BaseLoader)
        steps = workflow['jobs']['range']['steps']
        script = next(step['run'] for step in steps if step.get('id') == 'range')
        bash = Path(self.git('var', 'GIT_SHELL_PATH')).with_name('bash.exe') if os.name == 'nt' else 'bash'

        (self.root / 'controller.txt').write_text('next\n')
        current = self.commit()
        self.git('tag', 'controller-v33', self.old)
        self.git('tag', 'controller-v34', current)
        output = self.root / 'step-output'
        cases = [
            ('controller-v34', current, 'previous=controller-v33\n'),
            ('controller-v35', current, ''),   # Same commit as v34.
            ('controller-v35', self.old, ''),  # v34 is not an ancestor.
            ('controller-v37', current, ''),   # v36 is missing.
            ('controller-v034', current, ''),
            ('controller-v34-rc1', current, ''),
        ]
        for tag, target, expected in cases:
            with self.subTest(tag=tag, target=target):
                output.write_bytes(b'')
                env = {**os.environ, 'TAG_PREFIX': 'controller-v', 'GITHUB_REF_NAME': tag,
                       'GITHUB_SHA': target, 'GITHUB_OUTPUT': output.name}
                result = subprocess.run([bash, '-c', script], cwd=self.root, env=env,
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, bool(expected), result.stderr)
                self.assertEqual(output.read_text(), expected)

    def test_title_supplier_changes_reach_existing_and_new_copier_consumers(self):
        source_tree=Path(__file__).resolve().parents[2]
        source=self.root/TITLE_SOURCE
        caller=self.root/TITLE_CALLER
        previous_caller=caller.with_suffix('')
        caller.parent.mkdir(parents=True)
        source.parent.mkdir(parents=True)
        source.write_bytes((source_tree/TITLE_SOURCE).read_bytes())
        previous_caller.write_text('name: Legacy title\n',encoding='utf-8')
        answers=Path('templates/repository/.copier-answers.yml.jinja')
        (self.root/answers).write_bytes((source_tree/answers).read_bytes())
        legacy=self.commit()
        self.git('tag','v1.2.4',legacy)

        with tempfile.TemporaryDirectory(prefix='title-copier-consumers-') as directory:
            # Match the bridge's canonical paths when Windows TEMP uses an 8.3 name.
            consumers=Path(directory).resolve()
            current=consumers/'existing'
            run_copy(str(self.root),current,vcs_ref=legacy,defaults=True,quiet=True)
            product_workflow=current/'.github/workflows/pr-title.yml'
            self.assertEqual(product_workflow.read_text(encoding='utf-8'),'name: Legacy title\n')
            def target_git(*args):
                subprocess.run(['git','-c','core.hooksPath=','-C',str(current),*args],check=True,
                               capture_output=True)
            target_git('init','--initial-branch=main')
            target_git('config','user.name','Fixture')
            target_git('config','user.email','fixture@example.invalid')
            def record_adoption():
                target_git('add','--all')
                target_git('commit','--no-gpg-sign','-m','adopt template')
            record_adoption()

            previous_caller.unlink()
            caller.write_bytes((source_tree/TITLE_CALLER).read_bytes())
            initial=self.commit()
            first=template_tag_plan(self.root,initial)
            self.assertEqual((first['status'],first['tag']),('CREATE','v1.2.5'))
            self.git('tag',first['tag'],initial)
            run_update(current,vcs_ref=initial,defaults=True,overwrite=True,quiet=True,conflict='rej')
            self.assertIn(TITLE_SOURCE+'@'+initial,product_workflow.read_text(encoding='utf-8'))
            record_adoption()

            # A normal adoption in Steward also changes its consumer workflow and
            # answers. Those files must not cause another template release.
            (self.root/'.github/workflows/pr-title.yml').write_bytes(product_workflow.read_bytes())
            (self.root/'.copier-answers.yml').write_bytes((current/'.copier-answers.yml').read_bytes())
            consumer_only=self.commit()
            self.assertEqual(template_tag_plan(self.root,consumer_only)['status'],'UNCHANGED')

            # An upstream update changes only the centrally supplied reusable.
            updated, count=re.subn(
                rb'(amannn/action-semantic-pull-request@)[a-f0-9]{40} # v[0-9]+\.[0-9]+\.[0-9]+',
                rb'\g<1>'+b'a'*40+b' # v99.0.0',source.read_bytes())
            self.assertEqual(count,1)
            source.write_bytes(updated)
            supplier_only=self.commit()
            second=template_tag_plan(self.root,supplier_only)
            self.assertEqual((second['status'],second['tag'],second['commit']),('CREATE','v1.2.6',supplier_only))
            self.git('tag',second['tag'],supplier_only)
            run_update(current,vcs_ref=supplier_only,defaults=True,overwrite=True,quiet=True,conflict='rej')
            fresh=consumers/'new'
            run_copy(str(self.root),fresh,vcs_ref=supplier_only,defaults=True,quiet=True)
            existing=product_workflow.read_text(encoding='utf-8')
            self.assertEqual(existing,(fresh/'.github/workflows/pr-title.yml').read_text(encoding='utf-8'))
            self.assertEqual(existing,caller.read_text(encoding='utf-8').replace(
                '{{ _copier_conf.vcs_ref_hash }}',supplier_only))
            self.assertIn(TITLE_SOURCE+'@'+supplier_only,existing)
            self.assertNotIn('_copier_conf',existing)
            self.assertEqual(template_tag_plan(self.root,supplier_only)['status'],'UNCHANGED')

    def test_first_and_later_security_policy_changes_publish_without_other_template_changes(self):
        policy=self.root/'config/review/security-common.md'
        policy.parent.mkdir(parents=True)
        for expected, body in [('v1.2.4','first'), ('v1.2.5','updated')]:
            policy.write_text(body+'\n',encoding='utf-8')
            current=self.commit()
            plan=template_tag_plan(self.root,current)
            self.assertEqual((plan['status'],plan['tag'],plan['commit']),('CREATE',expected,current))
            self.assertEqual(plan.get('independentSecurityAdoption',False),body=='first')
            self.git('tag',expected,current)
            retry=template_tag_plan(self.root,current)
            self.assertEqual(retry['status'],'UNCHANGED')
            self.assertEqual(retry.get('independentSecurityAdoption',False),body=='first')
            if body=='first':
                self.assertEqual((retry['tag'],retry['commit']),(expected,current))

    def test_first_security_policy_with_any_copier_change_keeps_automatic_delivery(self):
        policy=self.root/'config/review/security-common.md'
        policy.parent.mkdir(parents=True)
        policy.write_text('first\n',encoding='utf-8')
        for path in ['copier.yml','templates/repository/README.md']:
            with self.subTest(path=path):
                with (self.root/path).open('a',encoding='utf-8') as file:
                    file.write('# changed\n')
                plan=template_tag_plan(self.root,self.commit())
                self.assertEqual(plan['status'],'CREATE')
                self.assertNotIn('independentSecurityAdoption',plan)
                self.git('restore','--source',self.old,'--',path)

    def test_security_source_cannot_be_removed_or_replaced_by_a_directory_after_release(self):
        policy=self.root/'config/review/security-common.md'
        policy.parent.mkdir(parents=True)
        policy.write_text('first\n',encoding='utf-8')
        self.git('tag','v1.2.4',self.commit())
        policy.unlink()
        with self.assertRaisesRegex(ValueError,'SECURITY_POLICY_SOURCE_REMOVED'):
            template_tag_plan(self.root,self.commit())
        policy.mkdir()
        (policy/'other.md').write_text('other\n',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'SECURITY_POLICY_SOURCE_MODE'):
            template_tag_plan(self.root,self.commit())

    def test_missing_initial_adoption_and_newer_unreachable_template_fail(self):
        self.git('tag','-d','v1.2.3')
        with self.assertRaisesRegex(Exception,'INITIAL_ADOPTION'):template_tag_plan(self.root,self.old)
        self.git('tag','v1.2.3')
        (self.root/'templates/repository/README.md').write_text('next\n');self.commit();self.git('tag','v2.0.0')
        with self.assertRaisesRegex(Exception,'OUTSIDE_MAIN'):template_tag_plan(self.root,self.old)

    def test_pep440_epoch_and_postrelease_are_strictly_increasing(self):
        self.git('tag','1!2.3.4.post2')
        (self.root/'copier.yml').write_text('_subdirectory: templates/repository\nanswers_file: .copier-answers.yml\n')
        self.assertEqual(template_tag_plan(self.root,self.commit())['tag'],'v1!2.3.5')

    def test_same_version_different_commit_is_ambiguous(self):
        (self.root/'templates/repository/README.md').write_text('changed\n');current=self.commit();self.git('tag','1.2.3')
        with self.assertRaisesRegex(Exception,'AMBIGUOUS'):template_tag_plan(self.root,current)

    def test_annotated_tag_snapshot_preserves_tag_object_identity(self):
        self.git('tag','-a','v1.3.0','-m','annotated')
        plan=template_tag_plan(self.root,self.old)
        self.assertEqual(plan['tags']['refs/tags/v1.3.0'],self.git('rev-parse','v1.3.0'))
        self.assertNotEqual(plan['tags']['refs/tags/v1.3.0'],self.old)


if __name__=='__main__':unittest.main()
