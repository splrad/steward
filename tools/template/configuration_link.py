"""Add the repository-specific contact without replacing native issue forms or chooser settings."""
import json
from pathlib import Path

import yaml


def add_link(directory, repository):
    # The organization community-health repository supplies defaults to unrelated repositories.
    if repository.lower().endswith('/.github'):
        return
    path = Path(directory) / '.github/ISSUE_TEMPLATE/config.yml'
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise ValueError('Unexpected issue template symlink')
    path.parent.mkdir(parents=True, exist_ok=True)
    source = path.read_text(encoding='utf-8') if path.exists() else ''
    document = yaml.safe_load(source) or {}
    links = document.get('contact_links', [])
    if not isinstance(links, list):
        raise ValueError('Invalid issue chooser contact_links')
    url = 'https://github.com/' + repository + '/blob/HEAD/.github/repository-configuration.md'
    item = {'name': '仓库配置', 'url': url, 'about': '查看已合并的仓库配置或发起调整。'}
    present = [entry for entry in links if entry.get('url') == url or entry.get('name') == item['name']]
    if present:
        if len(present) != 1 or present[0].get('url') != url:
            raise ValueError('Conflicting repository configuration contact')
        return
    value = json.dumps(item, ensure_ascii=False)
    if 'contact_links' not in document:
        output = source + ('\n' if source and not source.endswith('\n') else '') + 'contact_links:\n  - ' + value + '\n'
    else:
        node = next(v for k, v in yaml.compose(source).value if k.value == 'contact_links')
        start = node.start_mark.index
        if node.flow_style:
            output = source[:start+1] + value + (', ' if links else '') + source[start+1:]
        else:
            output = source[:start] + '- ' + value + '\n' + ' ' * node.start_mark.column + source[start:]
    after = yaml.safe_load(output)
    if after != {**document, 'contact_links': [item, *links]}:
        raise ValueError('Unable to preserve existing issue chooser settings')
    path.write_text(output, encoding='utf-8', newline='\n')
