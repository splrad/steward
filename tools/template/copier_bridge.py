"""Fixed Copier copy/update connection. Git delivery and PR review remain separate."""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

import yaml
from packaging.version import Version, InvalidVersion

SOURCE = 'https://github.com/splrad/steward.git'
INTERNAL = {'_min_copier_version', '_subdirectory', '_answers_file'}
FORBIDDEN = {'VERSION', 'CHANGELOG.md', 'package.json', 'package-lock.json',
             '.github/workflows/actions.lock',
             '.release-please-manifest.json', 'release-please-config.json',
             'mise.toml', 'mise.lock', '.github/delivery.json', '.github/steward-template-adoption.md'}
ADOPTION_REPORT = '.github/steward-template-adoption.md'


def require(condition, code):
    if not condition:
        raise ValueError(code)


def environment(profile):
    allowed = {'PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'SYSTEMDRIVE',
               'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SSL_CERT_FILE',
               'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE'}
    env = {k: v for k, v in os.environ.items() if k.upper() in allowed}
    env.update(HOME=str(profile), USERPROFILE=str(profile), XDG_CONFIG_HOME=str(profile),
               GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0',
               GIT_CONFIG_COUNT='4', GIT_CONFIG_KEY_0='core.hooksPath', GIT_CONFIG_VALUE_0='',
               GIT_CONFIG_KEY_1='credential.helper', GIT_CONFIG_VALUE_1='',
               GIT_CONFIG_KEY_2='core.fsmonitor', GIT_CONFIG_VALUE_2='false',
               GIT_CONFIG_KEY_3='core.autocrlf', GIT_CONFIG_VALUE_3='false',
               PYTHONNOUSERSITE='1', NO_COLOR='1')
    return env


def command(args, cwd, env):
    result = subprocess.run(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
    if result.returncode:
        # Raw output can contain private paths. Caller keeps it in the local runner only.
        raise ValueError('TEMPLATE_COMMAND_FAILED')
    return result.stdout


def git(directory, args, env):
    return command(['git', '--no-replace-objects', '-c', 'core.hooksPath=',
                    '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', *args], directory, env)


def revision(central, value, env):
    require(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{40}', value), 'TEMPLATE_SHA')
    require(git(central, ['rev-parse', '--verify', value + '^{commit}'], env).decode().strip() == value, 'TEMPLATE_COMMIT')
    tags = git(central, ['tag', '--points-at', value], env).decode().splitlines()
    versions = []
    for tag in tags:
        try:
            version = Version(tag)
            if not version.is_prerelease and not version.is_devrelease:
                versions.append(version)
        except InvalidVersion:
            continue
    require(versions, 'TEMPLATE_VERSION_TAG_REQUIRED')
    return max(versions)


def select_template(central, controller):
    """Select an actual version tag reachable from the reviewed central workflow commit."""
    central=Path(central).resolve()
    with tempfile.TemporaryDirectory(prefix='steward-template-select-') as profile:
        env=environment(Path(profile)); candidates={}
        require(re.fullmatch(r'[a-f0-9]{40}',controller), 'TEMPLATE_CONTROLLER')
        for tag in git(central,['tag','--merged',controller],env).decode().splitlines():
            try: version=Version(tag)
            except InvalidVersion: continue
            if version.is_prerelease or version.is_devrelease: continue
            sha=git(central,['rev-parse','--verify',tag+'^{commit}'],env).decode().strip()
            if not git(central,['ls-tree',sha,'--','copier.yml'],env): continue
            require(version not in candidates or candidates[version]['templateSha']==sha,'TEMPLATE_VERSION_AMBIGUOUS')
            candidates[version]={'templateSha':sha,'tag':tag}
        require(candidates,'TEMPLATE_VERSION_TAG_REQUIRED')
        selected=candidates[max(candidates)]
        # Input questions are validated during native copy/update; selection does not invent values.
        return selected


def contract(central, sha, data, env):
    version = revision(central, sha, env)
    raw = git(central, ['show', sha + ':copier.yml'], env)
    config = yaml.safe_load(raw)
    require(isinstance(config, dict) and config.get('_subdirectory') == 'templates/repository'
            and config.get('_answers_file') == '.copier-answers.yml', 'TEMPLATE_CONFIG')
    questions = {}
    for key, value in config.items():
        require(isinstance(key, str), 'TEMPLATE_CONFIG_KEY')
        if key.startswith('_'):
            require(key in INTERNAL, 'TEMPLATE_EXECUTION_SETTING')
        else:
            require(re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', key) and isinstance(value, dict), 'TEMPLATE_QUESTION')
            require(set(value) <= {'type', 'default', 'help', 'choices'}, 'TEMPLATE_QUESTION_SETTING')
            require('default' in value or key in data, 'TEMPLATE_REQUIRED_INPUT')
            questions[key] = value
    require(set(data) <= set(questions), 'TEMPLATE_UNKNOWN_INPUT')
    entries = git(central, ['ls-tree', '-rz', sha, '--', 'templates/repository/'], env).split(b'\0')
    paths = set()
    for entry in filter(None, entries):
        meta, name = entry.split(b'\t', 1)
        mode, kind, oid = meta.decode().split()
        path = name.decode().removeprefix('templates/repository/')
        require(mode == '100644' and kind == 'blob' and path, 'TEMPLATE_FILE_MODE')
        require(not any(c in path for c in '{}\\\r\n') and not any(p in {'.', '..', '.git'} for p in PurePosixPath(path).parts), 'TEMPLATE_PATH')
        target = path.removesuffix('.jinja')
        require(target not in FORBIDDEN and not target.startswith(('.release-notes/', 'src/', 'docs-site/'))
                and not target.startswith('.github/workflows/steward-release-') and target != '.github/workflows/pages.yml', 'TEMPLATE_PRODUCT_OWNERSHIP')
        require(target not in paths, 'TEMPLATE_DUPLICATE_PATH')
        git(central, ['cat-file', 'blob', oid], env).decode('utf-8', errors='strict')
        paths.add(target)
    require('.copier-answers.yml' in paths and 'AGENTS.md' in paths, 'TEMPLATE_REQUIRED_FILES')
    return version, questions, paths


def answers(central, product, env):
    path = product / '.copier-answers.yml'
    require(path.is_file() and not path.is_symlink(), 'TEMPLATE_ANSWERS_MISSING')
    value = yaml.safe_load(path.read_bytes())
    require(isinstance(value, dict) and value.get('_src_path') == SOURCE, 'TEMPLATE_SOURCE')
    ref = value.get('_commit')
    require(isinstance(ref, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.!_+-]*', ref), 'TEMPLATE_OLD_VERSION')
    # Copier may record git-describe output, not necessarily a full SHA.
    sha = git(central, ['rev-parse', '--verify', ref + '^{commit}'], env).decode().strip()
    data = {k: v for k, v in value.items() if not k.startswith('_')}
    require(set(value) <= {'_src_path', '_commit'} | set(data), 'TEMPLATE_ANSWERS_KEY')
    contract(central, sha, data, env)
    return value, sha, data


def paths_in_tree(directory):
    result = {}
    for path in directory.rglob('*'):
        if '.git' in path.relative_to(directory).parts:
            continue
        require(not path.is_symlink(), 'TEMPLATE_SYMLINK')
        if path.is_file():
            result[path.relative_to(directory).as_posix()] = path.read_bytes()
    return result


def render(central, target, sha, mode, data=None):
    target_path = Path(target).absolute()
    require(not any(p.is_symlink() or getattr(p, 'is_junction', lambda: False)()
                    for p in (target_path, *target_path.parents)), 'TEMPLATE_SYMLINK')
    central, target = Path(central).resolve(), target_path.resolve()
    require(mode in {'copy', 'update'}, 'TEMPLATE_MODE')
    require(target != central and central not in target.parents, 'TEMPLATE_TARGET')
    data = data or {}
    with tempfile.TemporaryDirectory(prefix='steward-copier-profile-') as profile:
        env = environment(Path(profile))
        new_version, _, new_paths = contract(central, sha, data, env)
        before, old_paths = {}, set()
        if mode == 'copy':
            require(not target.exists(), 'TEMPLATE_SEED_EXISTS')
            argv = ['copy', '--defaults', '--vcs-ref', sha, SOURCE, str(target)]
        else:
            require(target.is_dir() and not target.is_symlink(), 'TEMPLATE_TARGET')
            require(not (target / ADOPTION_REPORT).exists(), 'TEMPLATE_ADOPTION_INCOMPLETE')
            require(not git(target, ['status', '--porcelain', '--untracked-files=all'], env), 'TEMPLATE_DIRTY')
            _, old_sha, old_data = answers(central, target, env)
            old_version, _, old_paths = contract(central, old_sha, old_data, env)
            require(new_version >= old_version, 'TEMPLATE_DOWNGRADE')
            before = paths_in_tree(target)
            argv = ['update', '--defaults', '--vcs-ref', sha, '--conflict', 'rej']
        if data:
            data_file = Path(profile) / 'data.json'
            data_file.write_text(json.dumps(data), encoding='utf-8')
            argv += ['--data-file', str(data_file)]
        command([sys.executable, '-m', 'copier', *argv], target if mode == 'update' else target.parent, env)
        after = paths_in_tree(target)
        require(not any(p.endswith('.rej') for p in after), 'TEMPLATE_CONFLICT')
        changed = {p for p in before.keys() | after.keys() if before.get(p) != after.get(p)}
        require(changed <= old_paths | new_paths, 'TEMPLATE_DIFF_PATH')
        for path in changed & after.keys():
            require(not re.search(rb'(?m)^(?:<{7}|={7}|>{7})(?: |$)', after[path]), 'TEMPLATE_CONFLICT')
        require(new_paths <= after.keys(), 'TEMPLATE_REQUIRED_FILE_MISSING')
        generated = yaml.safe_load(after['.copier-answers.yml'])
        require(generated['_src_path'] == SOURCE, 'TEMPLATE_GENERATED_SOURCE')
        require(git(central, ['rev-parse', '--verify', str(generated['_commit']) + '^{commit}'], env).decode().strip() == sha, 'TEMPLATE_GENERATED_VERSION')
        return {'mode': mode, 'paths': sorted(changed), 'answers': generated}


def adoption_diff(seed, product):
    """No overwrite: report exact conflicting bytes for the existing adoption PR."""
    seed, product = Path(seed).resolve(), Path(product).resolve()
    require(seed != product and seed not in product.parents and product not in seed.parents, 'TEMPLATE_ADOPTION_TARGET')
    generated, existing = paths_in_tree(seed), paths_in_tree(product)
    return {'new': sorted(set(generated) - set(existing)),
            'identical': sorted(p for p in generated.keys() & existing.keys() if generated[p] == existing[p]),
            'conflicts': [{'path': p, 'current': existing[p].decode('utf-8'), 'generated': generated[p].decode('utf-8')}
                          for p in sorted(generated.keys() & existing.keys()) if generated[p] != existing[p]]}


def prepare_adoption(central, product, seed, sha, *, expected_report=None, data=None):
    """Native empty-directory copy, additive first PR and a complete conflict report."""
    product, seed = Path(product).resolve(), Path(seed).resolve()
    report = product / ADOPTION_REPORT
    if report.exists():
        require(expected_report is not None and report.read_bytes() == expected_report, 'TEMPLATE_ADOPTION_REPORT_EDITED')
    render(central, seed, sha, 'copy', data)
    diff = adoption_diff(seed, product)
    # The common contribution section is complete; extra product instructions remain verbatim.
    custom, conflicts = [], []
    for value in diff['conflicts']:
        if value['path'] == 'CONTRIBUTING.md' and value['generated'].replace('\r\n','\n').strip() in value['current'].replace('\r\n','\n'):
            custom.append(value['path'])
        else:
            conflicts.append(value)
    for path in diff['new']:
        target = product / path; target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream: stream.write((seed/path).read_bytes())
    if conflicts:
        payload = json.dumps({'templateSha':sha, 'conflicts':conflicts, 'preservedCustomFiles':custom}, ensure_ascii=False, indent=2)
        fence = '`' * max(3, max((len(v) for v in re.findall(r'`+',payload)), default=0)+1)
        text = '# 模板首次采用差异\n\n原有内容保持。请在本 PR 中整合下列完整差异；下一次运行核对实际文件后更新此报告。\n\n'
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(text+fence+'json\n'+payload+'\n'+fence+'\n',encoding='utf-8')
    elif report.exists():
        # Only the exact prior App-owned report is removed after all conflicts are gone.
        report.unlink()
    return {'mode':'adopt','conflicts':[v['path'] for v in conflicts],'preservedCustomFiles':custom}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['copy', 'update', 'select'])
    parser.add_argument('--central', required=True)
    parser.add_argument('--target')
    parser.add_argument('--template-sha', required=True)
    parser.add_argument('--data-file')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    data = json.loads(Path(args.data_file).read_text(encoding='utf-8')) if args.data_file else {}
    if args.mode=='select':
        result=select_template(args.central,args.template_sha)
    else:
        require(args.target,'TEMPLATE_TARGET_REQUIRED')
        result = render(args.central, args.target, args.template_sha, args.mode, data)
    with open(args.output, 'x', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('TEMPLATE_PREPARATION_FAILED', file=sys.stderr)
        sys.exit(1)
