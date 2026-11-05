import subprocess
import tempfile
import unittest
from pathlib import Path
from promotion import template_tag_plan


class PromotionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='promotion-git-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
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

    def test_sdk_only_commit_keeps_template_version(self):
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
