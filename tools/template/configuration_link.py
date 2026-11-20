"""Add the repository-specific contact without replacing native issue forms or chooser settings."""
import json
from pathlib import Path

import yaml


def legacy_link_url(repository):
    return 'https://github.com/' + repository + '/blob/HEAD/.github/repository-configuration.md'


def has_legacy_link(source, repository):
    document = yaml.safe_load(source) or {}
    return any(isinstance(link, dict) and link.get('url') == legacy_link_url(repository)
               for link in document.get('contact_links', []))


def add_link(directory, repository, *, retire=False):
    # The organization community-health repository supplies defaults to unrelated repositories.
    if repository.endswith('/.github'):
        return
    path = Path(directory) / '.github/ISSUE_TEMPLATE/config.yml'
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise ValueError('Unexpected issue template symlink')
    if retire and not path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    source = path.read_text(encoding='utf-8') if path.exists() else ''
    document = yaml.safe_load(source) or {}
    links = document.get('contact_links', [])
    if not isinstance(links, list):
        raise ValueError('Invalid issue chooser contact_links')
    url = legacy_link_url(repository)
    item = {'name': '仓库配置', 'url': url, 'about': '查看已合并的仓库配置或发起调整。'}
    value = json.dumps(item, ensure_ascii=False)
    if retire:
        if links.count(item) != 1:
            return
        sequence = next(v for k, v in yaml.compose(source).value if k.value == 'contact_links')
        index = links.index(item)
        node = sequence.value[index]
        start, end = node.start_mark.index, node.end_mark.index
        if source[start:end] != value:
            return  # Preserve a hand-maintained entry.
        if sequence.flow_style:
            if len(links) > 1:
                if index + 1 < len(links):
                    comma = source.index(',', end, sequence.value[index + 1].start_mark.index)
                    output = source[:start] + source[end:comma] + source[comma + 1:]
                else:
                    comma = source.index(',', sequence.value[index - 1].end_mark.index, start)
                    output = source[:comma] + source[comma + 1:start] + source[end:]
            else:
                output = source[:start] + source[end:]
        else:
            start -= 2
            if source[start:start + 2] != '- ':
                return
            replacement = '[]' if len(links) == 1 else ''
            output = source[:start] + replacement + source[end:]
        if yaml.safe_load(output) != {**document, 'contact_links': links[:index] + links[index + 1:]}:
            raise ValueError('Unable to preserve existing issue chooser settings')
        path.write_text(output, encoding='utf-8', newline='\n')
        return
    present = [entry for entry in links if entry.get('url') == url or entry.get('name') == item['name']]
    if present:
        if len(present) != 1 or present[0].get('url') != url:
            raise ValueError('Conflicting repository configuration contact')
        return
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
