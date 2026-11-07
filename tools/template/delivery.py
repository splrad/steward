"""Fixed Copier -> Git -> GitHub signed commit -> same-PR delivery connection."""
import argparse
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urlencode

import yaml
import copier_bridge as copier
import actions_lock

BRANCH = 'steward/managed-sync'
CENTRAL = 'splrad/steward'
CENTRAL_ID = 1296724484
APP_ID = 4243096
SHA = re.compile(r'[a-f0-9]{40}')


def require(value, reason):
    copier.require(value, 'SYNC_' + reason)


class NativeFailure(Exception):
    pass


class GitHubCLI:
    """Fixed JSON files and noninteractive gh; no PR edit, force, or implicit push."""
    def __init__(self, executable, token, directory, read_token=None):
        require(token and not any(c in token for c in '\r\n\0'), 'TOKEN')
        self.executable, self.directory = executable, Path(directory)
        self.env = copier.environment(self.directory)
        self.env.update(GH_TOKEN=token, GH_HOST='github.com', GH_CONFIG_DIR=str(self.directory),
                        GH_PROMPT_DISABLED='1', GH_NO_UPDATE_NOTIFIER='1', GH_NO_EXTENSION_UPDATE_NOTIFIER='1',
                        GH_PAGER='cat')
        self.read_env = {**self.env, 'GH_TOKEN': read_token} if read_token else self.env

    def execute(self, argv):
        result = subprocess.run([self.executable, *argv], cwd=self.directory, env=self.env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
        if result.returncode:
            raise NativeFailure('SYNC_GH_UNAVAILABLE')
        return result.stdout

    def request(self, method, path, body=None, optional=False):
        argv = ['api', '--method', method, '-H', 'Accept: application/vnd.github+json',
                '-H', 'X-GitHub-Api-Version: 2026-03-10', path]
        # --include retains the real HTTP status, including optional 404. Do not
        # infer absence from stderr, access failures, or an unreadable response.
        argv += ['--include']
        with tempfile.TemporaryDirectory(prefix='request-', dir=self.directory) as temp:
            if body is not None:
                payload = Path(temp) / 'input.json'
                payload.write_text(json.dumps(body, ensure_ascii=False), encoding='utf-8')
                argv += ['--input', str(payload)]
            result = subprocess.run([self.executable, *argv], cwd=self.directory, env=self.read_env if method == 'GET' else self.env,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
        raw = result.stdout.replace(b'\r\n', b'\n')
        header, separator, content = raw.partition(b'\n\n')
        match = re.match(rb'HTTP/\S+ (\d{3})', header)
        if not match or not separator:
            raise NativeFailure('SYNC_GH_RESPONSE_UNKNOWN')
        status = int(match[1])
        if optional and status == 404:
            return None
        if result.returncode or not 200 <= status < 300:
            raise NativeFailure('SYNC_GH_HTTP_' + str(status))
        return json.loads(content) if content.strip() else None

    def create_pr(self, repository, base, body):
        with tempfile.TemporaryDirectory(prefix='pr-', dir=self.directory) as temp:
            path = Path(temp) / 'body.md'; path.write_text(body, encoding='utf-8')
            self.execute(['pr', 'create', '--repo', repository, '--base', base, '--head', BRANCH,
                          '--title', 'chore: 更新公共仓库模板', '--body-file', str(path)])


def deliver(request, api, central_api, *, read_token=None, renderer=copier.render, lock_runner=None):
    repository, repository_id = request['repository'], request['repositoryId']
    require(re.fullmatch(r'splrad/[A-Za-z0-9_.-]+', repository) and type(repository_id) is int and repository_id > 0, 'REPOSITORY')
    require(type(request['runId']) is int and request['runId'] > 0, 'RUN')
    require(all(isinstance(request[k], str) and SHA.fullmatch(request[k]) for k in ['workflowSha', 'templateSha']), 'SOURCE')
    bot = request['bot']; require(re.fullmatch(r'[A-Za-z0-9-]+\[bot\]', bot['login']) and type(bot['id']) is int and bot['id'] > 0, 'BOT')
    email = f"{bot['id']}+{bot['login']}@users.noreply.github.com"
    signoff = f"Signed-off-by: {bot['login']} <{email}>"
    central = Path(request['central']).resolve()
    prefix = '/repos/' + repository
    get = lambda path, optional=False: api.request('GET', prefix + '/' + path, optional=optional)

    def snapshot():
        repo = api.request('GET', prefix)
        require(repo['id'] == repository_id and repo['full_name'] == repository and repo['owner']['id'] == 302208797
                and not repo.get('archived') and not repo.get('disabled'), 'REPOSITORY_CHANGED')
        require(repo['default_branch'] == request['defaultBranch'], 'DEFAULT_BRANCH_CHANGED')
        require(get('actions/variables/STEWARD_BOOTSTRAP_RECOVERY', True) is None, 'BOOTSTRAP_PENDING')
        return repo

    def protection():
        rules = []
        for page in range(1, 10001):
            batch = get('rules/branches/' + quote(BRANCH, safe='') + '?' + urlencode({'per_page': 100, 'page': page}))
            require(isinstance(batch, list), 'BRANCH_RULES_RESPONSE')
            rules.extend(batch)
            if len(batch) < 100: break
        else: raise ValueError('SYNC_BRANCH_RULES_PAGINATION')
        for kind in ['creation', 'non_fast_forward', 'deletion']:
            matches = [r for r in rules if r['type'] == kind]
            require(matches, 'BRANCH_PROTECTION')
            for match in matches:
                rule = get('rulesets/' + str(match['ruleset_id']))
                require(rule.get('enforcement') == 'active' and rule.get('id') == match['ruleset_id']
                        and any(r['type'] == kind for r in rule['rules']), 'BRANCH_RULE_CHANGED')
                expected = [{'actor_id': APP_ID, 'actor_type': 'Integration', 'bypass_mode': 'always'}] if kind == 'creation' else []
                require(rule.get('bypass_actors') == expected, 'BRANCH_BYPASS')

    def ref(branch):
        value = get('git/ref/heads/' + quote(branch, safe='/'), True)
        if value is None:
            return None
        require(value.get('ref') == 'refs/heads/' + branch and value.get('object', {}).get('type') == 'commit'
                and SHA.fullmatch(value['object']['sha']), 'REF')
        return value['object']['sha']

    def pulls():
        values, ids = [], set()
        for page in range(1, 10001):
            batch = get('pulls?' + urlencode({'state': 'all', 'head': 'splrad:' + BRANCH,
                        'base': request['defaultBranch'], 'per_page': 100, 'page': page}))
            require(isinstance(batch, list), 'PR_LIST')
            for value in batch:
                require(value['id'] not in ids and value['head']['repo']['id'] == repository_id
                        and value['base']['repo']['id'] == repository_id and value['head']['ref'] == BRANCH
                        and value['base']['ref'] == request['defaultBranch'], 'PR_BINDING')
                ids.add(value['id']); values.append(value)
            if len(batch) < 100:
                opened = [v for v in values if v['state'] == 'open']
                require(len(opened) <= 1, 'COMPETING_PRS')
                return opened[0] if opened else max(values, key=lambda v: v['number'], default=None)
        raise ValueError('SYNC_PR_PAGINATION')

    def closed(pr):
        return pr and pr['state'] == 'closed' and not pr.get('merged_at')

    snapshot(); protection()
    scope = api.request('GET', '/installation/repositories')
    require(scope['total_count'] == 1 and [r['id'] for r in scope['repositories']] == [repository_id], 'TOKEN_SCOPE')
    observed_bot = api.request('GET', '/users/' + quote(bot['login']))
    require(observed_bot['id'] == bot['id'] and observed_bot['type'] == 'Bot', 'BOT_IDENTITY')
    prior = pulls()
    if closed(prior):
        return {'status': 'CLOSED', 'pullRequest': prior['number']}
    base, head = ref(request['defaultBranch']), ref(BRANCH)
    require(base, 'BASE_MISSING')
    if prior and prior['state'] == 'open':
        require(head and prior['head']['sha'] == head, 'PR_HEAD_DRIFT')

    # Every invocation prepares a new checkout. It never touches the user's checkout.
    with tempfile.TemporaryDirectory(prefix='steward-template-delivery-', dir=request['temporaryRoot']) as temp:
        root = Path(temp); work = root / 'product'; work.mkdir()
        profile = root / 'profile'; profile.mkdir()
        env = copier.environment(profile)
        remote = f'https://github.com/{repository}.git'
        fetch_env = dict(env)
        if read_token:
            import base64
            header = 'AUTHORIZATION: basic ' + base64.b64encode(('x-access-token:' + read_token).encode()).decode()
            slot = int(fetch_env.get('GIT_CONFIG_COUNT', '0'))
            fetch_env.update({'GIT_CONFIG_COUNT':str(slot+1), f'GIT_CONFIG_KEY_{slot}':f'http.{remote}.extraheader', f'GIT_CONFIG_VALUE_{slot}':header})
        def git(*args, network=False, allow_failure=False):
            result = subprocess.run(['git', '--no-replace-objects', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false',
                    '-c', 'credential.helper=', '-c', 'commit.gpgsign=false', '-c', 'diff.external=', *args],
                    cwd=work, env=fetch_env if network else env, stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
            if result.returncode and not allow_failure:
                raise ValueError('SYNC_GIT_' + args[0].upper())
            return result if allow_failure else result.stdout
        def string(*args): return git(*args).decode().strip()
        def ancestor(first, second):
            result = git('merge-base', '--is-ancestor', first, second, allow_failure=True)
            require(result.returncode in [0, 1], 'ANCESTRY_UNKNOWN')
            return result.returncode == 0
        def fetch_branch(branch, expected):
            git('fetch', '--no-tags', '--no-recurse-submodules', remote, 'refs/heads/' + branch, network=True)
            require(string('rev-parse', 'FETCH_HEAD') == expected, 'REF_DRIFT')
        git('init', '--initial-branch=sync-prepare')
        git('config', 'user.name', bot['login']); git('config', 'user.email', email)
        git('config', 'core.autocrlf', 'false')
        fetch_branch(request['defaultBranch'], base)
        if head: fetch_branch(BRANCH, head)
        git('checkout', '--detach', head or base)

        def signed(sha, tree=None, parents=None, message=None):
            value = get('git/commits/' + sha)
            identity = get('commits/' + sha)
            require(value['sha'] == sha and value.get('verification', {}).get('verified') is True
                    and value['verification'].get('reason') == 'valid' and identity.get('author', {}).get('id') == bot['id'], 'SIGNATURE')
            require(value['message'].splitlines().count(signoff) == 1
                    and len(re.findall(r'^Signed-off-by:', value['message'], re.M)) == 1, 'SIGNOFF')
            if tree is not None: require(value['tree']['sha'] == tree, 'SIGNED_TREE')
            if parents is not None: require([p['sha'] for p in value['parents']] == parents, 'SIGNED_PARENTS')
            if message is not None: require(value['message'] == message, 'SIGNED_MESSAGE')
            return value

        def verify_run(run_id, source):
            run = central_api.request('GET', f'/repos/{CENTRAL}/actions/runs/{run_id}')
            require(run['id'] == run_id and run['repository']['id'] == CENTRAL_ID and run['head_repository']['id'] == CENTRAL_ID
                    and run['head_sha'] == source and run['head_branch'] == 'main'
                    and (run['event'] in ['push', 'schedule', 'workflow_dispatch']
                         or (run['event'] == 'repository_dispatch' and run.get('actor', {}).get('id') == 353238212
                             and run.get('actor', {}).get('login') == 'splrad-governance[bot]')), 'SOURCE_RUN')
            workflow = central_api.request('GET', f"/repos/{CENTRAL}/actions/workflows/{run['workflow_id']}")
            require(workflow['path'] == '.github/workflows/sync-managed.yml' and workflow['state'] == 'active', 'SOURCE_WORKFLOW')
            result = subprocess.run(['git', '--no-replace-objects', 'merge-base', '--is-ancestor', source, request['workflowSha']],
                                    cwd=central, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
            require(result.returncode == 0, 'SOURCE_HISTORY')
        verify_run(request['runId'], request['workflowSha'])
        expected_report = None
        if head:
            owned = False
            for commit in string('rev-list', head).splitlines():
                message = string('show', '-s', '--format=%B', commit)
                markers = {key: re.findall('^' + key + r': (.+)$', message, re.M) for key in ['Steward-Sync-Run','Steward-Sync-Source','Steward-Template']}
                if not any(markers.values()): continue
                require(all(len(v) == 1 for v in markers.values()), 'SOURCE_TRAILERS')
                run_value, source, template = [markers[k][0] for k in markers]
                require(re.fullmatch(str(CENTRAL_ID) + r'/[1-9][0-9]*', run_value) and SHA.fullmatch(source) and SHA.fullmatch(template), 'SOURCE_TRAILERS')
                signed(commit); verify_run(int(run_value.split('/')[1]), source)
                value = yaml.safe_load(git('show', commit + ':.copier-answers.yml'))
                require(value['_src_path'] == copier.SOURCE and isinstance(value['_commit'], str)
                        and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]*', value['_commit']), 'SOURCE_ANSWERS')
                require(copier.git(central, ['rev-parse','--verify',value['_commit']+'^{commit}'], env).decode().strip() == template, 'SOURCE_TEMPLATE')
                raw_report = git('show', commit + ':' + copier.ADOPTION_REPORT, allow_failure=True)
                expected_report = raw_report.stdout if raw_report.returncode == 0 else None
                owned = True; break
            require(owned, 'UNKNOWN_BRANCH_OWNER')
            if prior and prior.get('merged_at'):
                require(ancestor(prior['head']['sha'], head), 'MERGED_PR_HISTORY')
            git('merge', '--no-ff', '--no-edit', '--signoff', base)
        require(not string('status', '--porcelain', '--untracked-files=all'), 'PREPARATION_DIRTY')
        template_sha = request['templateSha']
        before_copier = copier.paths_in_tree(work)
        adopted = git('cat-file', '-e', base + ':.copier-answers.yml', allow_failure=True).returncode == 0
        if adopted:
            renderer(central, work, template_sha, 'update')
        else:
            # A pending adoption keeps its actual native source while newer template tags appear.
            if (work / '.copier-answers.yml').exists():
                _, template_sha, _ = copier.answers(central, work, env)
            copier.prepare_adoption(central, work, root/'seed', template_sha, expected_report=expected_report)
        require(lock_runner is not None, 'ACTION_LOCK_RUNNER_REQUIRED')
        actions_lock.prepare(work, before_copier, lock_runner)
        if string('status', '--porcelain', '--untracked-files=all'):
            git('add', '--all'); git('commit', '--signoff', '--no-gpg-sign', '-m', 'chore: update common repository template')
            require(string('show','-s','--format=%B').splitlines().count(signoff) == 1, 'LOCAL_SIGNOFF')
        tree = string('rev-parse', 'HEAD^{tree}')
        base_tree = string('rev-parse', base + '^{tree}')
        different = tree != base_tree
        write = (tree != string('rev-parse', head + '^{tree}') or not ancestor(base, head)) if head else different

        def finish(delivered):
            snapshot(); protection()
            current = pulls()
            if closed(current): return {'status': 'CLOSED', 'head': delivered, 'pullRequest': current['number']}
            if current and current['state'] == 'open':
                require(not prior or prior['state'] != 'open' or current['number'] == prior['number'], 'PR_REPLACED')
                require(current['head']['sha'] == delivered, 'PR_READBACK_DRIFT')
                return {'status': 'DELIVERED' if write else 'UNCHANGED', 'head': delivered, 'pullRequest': current['number']}
            if not different: return {'status': 'NO_DIFF', 'head': delivered}
            body = '更新公共仓库模板。\n\n模板来源：`' + template_sha + '`。具体变更见文件差异。\n'
            if not adopted:
                body += '\n首次采用请核对全部公共文件；如有同名差异，完整报告见 `.github/steward-template-adoption.md`。\n'
            try: api.create_pr(repository, request['defaultBranch'], body)
            except (NativeFailure, subprocess.TimeoutExpired):
                # Creation may have succeeded; the next native PR read is authoritative.
                pass
            current = pulls()
            if current and current['state'] == 'open':
                require(current['head']['sha'] == delivered, 'PR_READBACK_DRIFT')
                return {'status': 'DELIVERED', 'head': delivered, 'pullRequest': current['number']}
            if closed(current): return {'status': 'CLOSED', 'head': delivered, 'pullRequest': current['number']}
            return {'status': 'WAIT_PR_READBACK', 'head': delivered}

        if not write: return finish(head or base)
        # Read native state again immediately before writing; metadata edits are never replayed.
        snapshot(); protection()
        require(ref(request['defaultBranch']) == base and ref(BRANCH) == head, 'PREWRITE_REF_CHANGED')
        latest = pulls()
        if closed(latest): return {'status': 'CLOSED', 'pullRequest': latest['number']}
        def entries(sha):
            values = {}
            for row in git('ls-tree', '-rz', sha).split(b'\0'):
                if not row: continue
                meta, path = row.split(b'\t', 1); mode, kind, oid = meta.decode().split()
                values[path.decode('utf-8')] = {'mode':mode, 'type':kind, 'sha':oid}
            return values
        before, after = entries(base), entries('HEAD')
        known = {v['sha'] for v in before.values()} | ({v['sha'] for v in entries(head).values()} if head else set())
        changes = []
        for path in sorted(before.keys() | after.keys()):
            if before.get(path) == after.get(path): continue
            require(not PurePosixPath(path).is_absolute() and not any(p in {'..','.git',''} for p in path.split('/')) and '\\' not in path, 'TREE_PATH')
            value = after.get(path)
            if value is None:
                changes.append({'path':path,'mode':before[path]['mode'],'type':before[path]['type'],'sha':None}); continue
            entry = {'path':path, **value}
            if value['sha'] not in known:
                require(value['mode'] == '100644' and value['type'] == 'blob', 'GENERATED_FILE_MODE')
                content = git('cat-file', 'blob', value['sha']).decode('utf-8', errors='strict')
                require('\0' not in content, 'GENERATED_BINARY')
                del entry['sha']; entry['content'] = content
            changes.append(entry)
        # An adopted base can need a merge commit with no file changes. GitHub
        # rejects an empty tree update; the existing base tree already has the bytes.
        if changes:
            created = api.request('POST', prefix + '/git/trees', {'base_tree':base_tree,'tree':changes})
            require(created['sha'] == tree, 'TREE_MISMATCH')
        else:
            require(base_tree == tree, 'TREE_MISMATCH')
        parents = list(dict.fromkeys(([head] if head else []) + [base]))
        message = ('chore: update common repository template\n\n' + signoff + '\n'
                   + f"Steward-Sync-Run: {CENTRAL_ID}/{request['runId']}\n"
                   # The native API removes trailing newlines. Send its canonical
                   # representation so signature readback can still compare exactly.
                   + f"Steward-Sync-Source: {request['workflowSha']}\nSteward-Template: {template_sha}")
        try: commit = api.request('POST', prefix + '/git/commits', {'message':message,'tree':tree,'parents':parents})
        except (NativeFailure, subprocess.TimeoutExpired): return {'status':'WAIT_COMMIT_RESPONSE'}
        commit_sha = commit.get('sha'); require(isinstance(commit_sha,str) and SHA.fullmatch(commit_sha), 'COMMIT_SHA')
        signed(commit_sha, tree, parents, message)
        try:
            if head: api.request('PATCH', prefix + '/git/refs/heads/' + BRANCH, {'sha':commit_sha,'force':False})
            else: api.request('POST', prefix + '/git/refs', {'ref':'refs/heads/'+BRANCH,'sha':commit_sha})
        except (NativeFailure, subprocess.TimeoutExpired):
            # Reconcile the actual ref after an ambiguous write response.
            pass
        actual = ref(BRANCH)
        if actual is None or actual == head: return {'status':'WAIT_REF_READBACK','candidate':commit_sha}
        fetch_branch(BRANCH, actual)
        # Rejected C can remain an unattached remote object and therefore need
        # not exist in this fetch. The complete fetched ancestry is authoritative.
        if commit_sha not in string('rev-list', actual).splitlines(): return {'status':'REF_CHANGED','head':actual}
        return finish(actual)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True); parser.add_argument('--output', required=True)
    parser.add_argument('--gh', required=True)
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text(encoding='utf-8'))
    with tempfile.TemporaryDirectory(prefix='steward-template-gh-') as temp:
        root = Path(temp); (root/'target').mkdir(); (root/'central').mkdir()
        require(os.environ.get('STEWARD_TEMPLATE_READ_TOKEN'), 'READ_TOKEN_REQUIRED')
        target = GitHubCLI(args.gh, os.environ.get('STEWARD_TEMPLATE_TOKEN'), root/'target', os.environ['STEWARD_TEMPLATE_READ_TOKEN'])
        central = GitHubCLI(args.gh, os.environ.get('STEWARD_CENTRAL_READ_TOKEN'), root/'central')
        locker = actions_lock.OfficialTool(args.gh, request['central'], request['workflowSha'], request['repository'],
                                          os.environ.get('STEWARD_CENTRAL_READ_TOKEN'), root/'actions-lock')
        result = deliver(request, target, central, read_token=os.environ.get('STEWARD_TEMPLATE_READ_TOKEN'), lock_runner=locker)
        with open(args.output, 'x', encoding='utf-8') as stream: json.dump(result, stream)
        if result['status'] not in ['DELIVERED','UNCHANGED','NO_DIFF','CLOSED']: raise NativeFailure('SYNC_INCOMPLETE')


if __name__ == '__main__':
    try: main()
    except actions_lock.LockFailure as error:
        import sys
        print(error.code, file=sys.stderr); sys.exit(1)
    except Exception:
        import sys
        print('TEMPLATE_DELIVERY_FAILED', file=sys.stderr); sys.exit(1)
