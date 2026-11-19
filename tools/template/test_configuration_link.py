import tempfile
import unittest
from pathlib import Path

import yaml

from configuration_link import add_link


class ConfigurationLinkTests(unittest.TestCase):
    def test_preserves_existing_form_blank_issue_policy_comments_and_contact(self):
        with tempfile.TemporaryDirectory() as workspace:
            root = Path(workspace)
            folder = root / '.github/ISSUE_TEMPLATE'
            folder.mkdir(parents=True)
            form = folder / 'bug-report.yml'
            form.write_bytes(b'name: Report an issue\n')
            chooser = folder / 'config.yml'
            old = '# custom\nblank_issues_enabled: false\n\ncontact_links:\n  - name: Ideas\n    url: https://example.org/ideas\n    about: Ideas\n'
            chooser.write_text(old, encoding='utf-8')
            add_link(root, 'splrad/example')
            text = chooser.read_text(encoding='utf-8')
            after = yaml.safe_load(text)
            self.assertIn('# custom', text)
            self.assertFalse(after['blank_issues_enabled'])
            self.assertEqual(after['contact_links'][1:], yaml.safe_load(old)['contact_links'])
            self.assertIn('splrad/example/blob/HEAD/', after['contact_links'][0]['url'])
            add_link(root, 'splrad/example')
            self.assertEqual(chooser.read_text(encoding='utf-8'), text)
            self.assertEqual(form.read_bytes(), b'name: Report an issue\n')

    def test_organization_repository_does_not_install_an_org_wide_chooser(self):
        with tempfile.TemporaryDirectory() as workspace:
            add_link(workspace, 'splrad/.github')
            self.assertFalse((Path(workspace) / '.github/ISSUE_TEMPLATE/config.yml').exists())
