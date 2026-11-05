"""Generate and verify the target's derived lock before any remote delivery write."""
import json
import re
import subprocess
from pathlib import Path

import yaml
import copier_bridge as copier

LOCK = '.github/workflows/actions.lock'
PIN = re.compile(r'([^@\s]+/[^@\s]+)@([a-f0-9]{40})')


class LockFailure(ValueError):
    def __init__(self, code):
        self.code = 'ACTIONS_LOCK_' + code
        super().__init__(self.code)


def require(value, code):
    if not value:
        raise LockFailure(code)


def workflows(files):
    return {name for name in files if name.startswith('.github/workflows/')
            and len(Path(name).parts) == 3 and name.endswith(('.yml', '.yaml'))}


def document(raw):
    class UniqueLoader(yaml.SafeLoader):
        pass

    def mapping(loader, node):
        pairs = loader.construct_pairs(node)
        result = {}
        for key, value in pairs:
            require(isinstance(key, str) and key not in result, 'LOCK_KEYS')
            result[key] = value
        return result

    UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
    try:
        value = yaml.load(raw, Loader=UniqueLoader)
    except (yaml.YAMLError, UnicodeError) as error:
        raise LockFailure('LOCK_PARSE') from error
    require(isinstance(value, dict) and value.get('version') == 'v0.0.3'
            and isinstance(value.get('workflows'), dict) and isinstance(value.get('dependencies'), dict), 'LOCK_SCHEMA')
    require(all(isinstance(v, list) and all(isinstance(x, str) for x in v)
                for v in value['workflows'].values()), 'WORKFLOW_SCHEMA')
    for key, entry in value['dependencies'].items():
        require(isinstance(key, str) and isinstance(entry, dict)
                and isinstance(entry.get('ref'), str) and entry['ref']
                and re.fullmatch(r'sha1-[a-f0-9]{40}', entry.get('commit', ''))
                and isinstance(entry.get('uses', []), list)
                and all(isinstance(child, str) for child in entry.get('uses', []))
                and all(type(entry.get(k)) is int and entry[k] > 0 for k in ['owner_id', 'repo_id']), 'DEPENDENCY_SCHEMA')
    require(all(key in value['dependencies'] for values in value['workflows'].values() for key in values), 'DEPENDENCY_MISSING')
    return value


def reachable(lock, roots):
    """Follow recorded composite edges without synthesizing or rewriting entries."""
    pending = list(roots)
    reached = set()
    while pending:
        key = pending.pop()
        if key in reached:
            continue
        require(key in lock['dependencies'], 'DEPENDENCY_MISSING')
        reached.add(key)
        pending.extend(lock['dependencies'][key].get('uses', []))
    return reached


def check_graph(lock):
    roots = [key for values in lock['workflows'].values() for key in values]
    require(reachable(lock, roots) == set(lock['dependencies']), 'UNREACHABLE_DEPENDENCY')


def check_rewrite(original, generated):
    """Restore formatting only; changing a uses ref invalidates its native lock key."""
    require(original == generated, 'WORKFLOW_REWRITE')


def direct_pins(files, paths, action):
    result = set()
    for path in paths:
        if path not in files:
            continue
        value = yaml.load(files[path], Loader=yaml.BaseLoader)
        jobs = value.get('jobs', {}) if isinstance(value, dict) else {}
        if not isinstance(jobs, dict):
            continue
        for job in jobs.values():
            if not isinstance(job, dict) or not isinstance(job.get('steps', []), list):
                continue
            for step in job.get('steps', []):
                uses = step.get('uses') if isinstance(step, dict) else None
                pin = PIN.fullmatch(uses) if isinstance(uses, str) else None
                if pin and pin[1] == action:
                    result.add('sha1-' + pin[2])
    return result


def check_delta(before, after, changed, before_files, after_files):
    """Inspect the generated file; never merge or synthesize dependency entries."""
    old, new = before['workflows'], after['workflows']
    for path in old.keys() | new.keys():
        require(path in changed or old.get(path) == new.get(path), 'UNRELATED_WORKFLOW')
    old_closure = {path: reachable(before, roots) for path, roots in old.items()}
    new_closure = {path: reachable(after, roots) for path, roots in new.items()}
    allowed = {key for path in changed for key in old_closure.get(path, set()) | new_closure.get(path, set())}
    identities = {}
    for lock in [before, after]:
        for key, entry in lock['dependencies'].items():
            repository = '/'.join(key.split('@')[0].split('/')[:2]).lower()
            identity = (entry['owner_id'], entry['repo_id'])
            require(repository not in identities or identities[repository] == identity, 'SOURCE_IDENTITY_CHANGED')
            identities[repository] = identity
    for key in before['dependencies'].keys() | after['dependencies'].keys():
        first, second = before['dependencies'].get(key), after['dependencies'].get(key)
        consumers = {p for p in old.keys() | new.keys() if key in old_closure.get(p, set()) | new_closure.get(p, set())}
        if first == second or (key in allowed and consumers <= changed and (first is None or second is None)):
            continue
        action = key.rsplit('@', 1)[0]
        require(first is not None and second is not None and consumers <= changed
                and {k: v for k, v in first.items() if k != 'commit'} == {k: v for k, v in second.items() if k != 'commit'}
                and direct_pins(before_files, consumers, action) == {first['commit']}
                and direct_pins(after_files, consumers, action) == {second['commit']}, 'UNRELATED_DEPENDENCY')


def prepare(target, before_copier, run):
    """Called on the complete, merged checkout; any failure discards that checkout."""
    target = Path(target)
    original = copier.paths_in_tree(target)
    require(original.get(LOCK) == before_copier.get(LOCK), 'TEMPLATE_WROTE_DERIVED_LOCK')
    names = workflows(original)
    if not names and LOCK not in original:
        return {'status': 'NO_WORKFLOWS', 'workflows': 0}
    prior = document(original[LOCK]) if LOCK in original else None
    run('generate', target)
    generated = copier.paths_in_tree(target)
    require(LOCK in generated, 'MISSING')
    lock = document(generated[LOCK])
    require(set(lock['workflows']) == names, 'FULL_TREE_COVERAGE')
    check_graph(lock)
    changed = {p for p in original.keys() | generated.keys() if original.get(p) != generated.get(p)}
    require(changed <= names | {LOCK}, 'UNEXPECTED_FILE')
    for name in names & changed:
        try:
            check_rewrite(yaml.load(original[name], Loader=yaml.BaseLoader),
                          yaml.load(generated[name], Loader=yaml.BaseLoader))
        except yaml.YAMLError as error:
            raise LockFailure('WORKFLOW_PARSE') from error
        (target / name).write_bytes(original[name])
    affected = {p for p in workflows(before_copier) | names if before_copier.get(p) != original.get(p)}
    if prior is not None:
        check_delta(prior, lock, affected, before_copier, original)
    expected = copier.paths_in_tree(target)
    run('verify', target)
    require(copier.paths_in_tree(target) == expected, 'VERIFY_MUTATION')
    return {'status': 'VERIFIED', 'workflows': len(names), 'affectedWorkflows': sorted(affected)}


class OfficialTool:
    def __init__(self, gh, central, controller_sha, repository, read_token, profile):
        require(isinstance(controller_sha, str) and re.fullmatch(r'[a-f0-9]{40}', controller_sha), 'CONTROLLER_SHA')
        require(isinstance(repository, str) and re.fullmatch(r'splrad/[A-Za-z0-9_.-]+', repository), 'REPOSITORY')
        require(read_token and not any(c in read_token for c in '\r\n\0'), 'READ_TOKEN')
        self.gh, self.profile = gh, Path(profile)
        self.profile.mkdir()
        self.env = copier.environment(self.profile)
        self.env.update(APPDATA=str(self.profile), LOCALAPPDATA=str(self.profile),
            XDG_DATA_HOME=str(self.profile / 'data'), XDG_CACHE_HOME=str(self.profile / 'cache'),
            GH_CONFIG_DIR=str(self.profile / 'gh'), GH_HOST='github.com', GH_TOKEN=read_token,
            GH_PROMPT_DISABLED='1', GH_NO_UPDATE_NOTIFIER='1', GH_NO_EXTENSION_UPDATE_NOTIFIER='1',
            GH_PAGER='cat', GH_REPO=repository)
        raw = copier.git(central, ['show', controller_sha + ':config/actions-lock-version.txt'], self.env)
        self.version = raw.decode('ascii').strip()
        require(re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', self.version), 'TOOL_VERSION')
        self.installed = False

    def command(self, args, cwd, env):
        try:
            result = subprocess.run([self.gh, *args], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise LockFailure('TOOL_UNAVAILABLE') from error
        require(result.returncode == 0, 'TOOL_' + ('VERIFY_FAILED' if '--verify' in args else 'FAILED'))
        return result.stdout

    def __call__(self, mode, target):
        require(mode in ['generate', 'verify'], 'MODE')
        if not self.installed:
            self.command(['extension', 'install', 'github/gh-actions-lock', '--pin', self.version], self.profile, self.env)
            version = self.command(['actions-lock', '--version'], self.profile, self.env).decode().strip()
            require(version == 'actions-lock version ' + self.version, 'TOOL_VERSION_MISMATCH')
            self.installed = True
        output = self.command(['actions-lock', *(['--verify'] if mode == 'verify' else ['--no-narrow']), '--no-interactive', '--json'],
                              target, {**self.env, 'GH_ACTIONS_LOCK_REPO_ROOT': str(Path(target).resolve())})
        try:
            value = json.loads(output)
        except (json.JSONDecodeError, UnicodeError) as error:
            raise LockFailure('UNKNOWN_RESULT') from error
        require(isinstance(value, dict) and value.get('valid') is True, 'INVALID_RESULT')
