"""Real Git/Copier with an offline GitHub API; hosted signature acceptance is separate."""
import copy
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote, urlparse, parse_qs

import copier_bridge as bridge
from delivery import deliver, NativeFailure, GitHubCLI, BRANCH, CENTRAL_ID
from test_actions_lock import fixture_tool
from actions_lock import LockFailure

ROOT = Path(__file__).resolve().parents[2]


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='template-delivery-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.central = self.root/'central'; self.central.mkdir()
        self.remote = self.root/'remote'; self.product = self.root/'adopt'
        self.bot = {'login':'fixture[bot]', 'id':17}
        self.identity = [self.bot['login'], '17+fixture[bot]@users.noreply.github.com']
        self.git(self.central,'init','--initial-branch=main'); self.configure(self.central)
        shutil.copyfile(ROOT/'copier.yml', self.central/'copier.yml')
        shutil.copytree(ROOT/'templates/repository', self.central/'templates/repository')
        self.old = self.commit(self.central,'Initial template'); self.git(self.central,'tag','v1.0.0')
        original_env = bridge.environment
        def transport(profile):
            env = original_env(profile)
            env.update(GIT_CONFIG_COUNT='6', GIT_CONFIG_KEY_4='url.'+self.central.as_posix()+'.insteadOf',GIT_CONFIG_VALUE_4=bridge.SOURCE,
                       GIT_CONFIG_KEY_5='url.'+self.remote.as_posix()+'.insteadOf', GIT_CONFIG_VALUE_5='https://github.com/splrad/fixture.git')
            return env
        self.transport = patch.object(bridge,'environment',transport);self.transport.start();self.addCleanup(self.transport.stop)
        bridge.render(self.central,self.product,self.old,'copy')
        self.git(self.product,'init','--initial-branch=develop');self.configure(self.product)
        (self.product/'VERSION').write_text('9.2.2\n');(self.product/'manual.txt').write_text('keep product\n')
        self.base = self.commit(self.product,'Adopt reviewed native Copier output')
        self.git(self.root,'clone','--bare',str(self.product),str(self.remote))
        path=self.central/'templates/repository/AGENTS.md';path.write_text(path.read_text(encoding='utf-8')+'\nShared v2.\n',encoding='utf-8')
        self.new=self.commit(self.central,'Second template');self.git(self.central,'tag','v2.0.0')
        self.request={'repository':'splrad/fixture','repositoryId':12,'defaultBranch':'develop','runId':51,
                      'workflowSha':self.new,'templateSha':self.new,'bot':self.bot,'central':str(self.central),'temporaryRoot':str(self.root)}
        self.api=FixtureAPI(self)

    def git(self,cwd,*args,input=None):
        result=subprocess.run(['git','-c','core.hooksPath=','-c','commit.gpgsign=false','-c','core.autocrlf=false',*args],cwd=cwd,
                              input=input,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)
        return result.stdout.decode().strip()
    def configure(self,path):
        self.git(path,'config','user.name',self.identity[0]);self.git(path,'config','user.email',self.identity[1])
    def commit(self,path,message):
        self.git(path,'add','--all');self.git(path,'commit','--signoff','--no-gpg-sign','-m',message)
        self.assertEqual(self.git(path,'show','-s','--format=%B').count('Signed-off-by:'),1)
        return self.git(path,'rev-parse','HEAD')
    def head(self):
        try:return self.git(self.remote,'rev-parse','--verify','refs/heads/'+BRANCH)
        except subprocess.CalledProcessError:return None
    def run_delivery(self,**kwargs):
        kwargs.setdefault('lock_runner', fixture_tool)
        return deliver(self.request,self.api,self.api,**kwargs)
    def edit(self,branch,path,content):
        with tempfile.TemporaryDirectory(prefix='edit-',dir=self.root) as temp:
            checkout=Path(temp)/'clone';self.git(self.root,'clone',str(self.remote),str(checkout));self.configure(checkout)
            self.git(checkout,'checkout','-B','edit','origin/'+branch)
            file=checkout/path;file.parent.mkdir(parents=True,exist_ok=True);file.write_text(content,encoding='utf-8')
            sha=self.commit(checkout,'Human edit');self.git(checkout,'push','origin','HEAD:refs/heads/'+branch)
            for pr in self.api.prs:
                if branch==BRANCH and pr['state']=='open':pr['head']['sha']=sha
            return sha

    def test_native_copier_signed_tree_and_same_pr_preserve_human_code_and_metadata(self):
        first=self.run_delivery(read_token='read-fixture');self.assertEqual(first['status'],'DELIVERED');self.assertEqual(self.api.creates,1)
        signed=first['head'];self.assertEqual(self.git(self.remote,'show',signed+':VERSION'),'9.2.2')
        self.assertIn('Shared v2.',self.git(self.remote,'show',signed+':AGENTS.md'))
        human=self.edit(BRANCH,'human.txt','manual branch content\n')
        main=self.edit('develop','new-main.txt','new main content\n')
        def metadata_only():
            self.api.prs[0]['title']='Human title';self.api.prs[0]['body']='Human body';self.api.prs[0]['labels']=['manual']
        self.api.before_ref=metadata_only
        result=self.run_delivery();self.assertEqual(result['pullRequest'],1);self.assertEqual(self.api.creates,1)
        self.assertEqual(self.git(self.remote,'show',result['head']+':human.txt'),'manual branch content')
        self.assertEqual(self.git(self.remote,'show',result['head']+':new-main.txt'),'new main content')
        self.assertEqual(self.api.prs[0]['body'],'Human body');self.assertEqual(self.api.prs[0]['title'],'Human title')
        self.assertEqual(self.api.prs[0]['labels'],['manual'])
        parents=self.git(self.remote,'show','-s','--format=%P',result['head']).split();self.assertEqual(parents,[human,main])
        before=len(self.api.mutations);again=self.run_delivery();self.assertEqual(again['status'],'UNCHANGED')
        self.assertEqual(len(self.api.mutations),before)
        self.assertFalse(any('/pulls/' in p for _,p,_ in self.api.mutations))

    def test_initial_adoption_preserves_full_conflict_and_resolves_in_the_same_pr(self):
        self.git(self.product,'rm','.copier-answers.yml')
        (self.product/'AGENTS.md').write_text('Keep all legacy product facts.\n')
        self.base=self.commit(self.product,'Original product before adoption')
        self.git(self.product,'push',str(self.remote),'HEAD:refs/heads/develop')
        first=self.run_delivery();self.assertEqual(self.api.creates,1)
        self.assertEqual(self.git(self.remote,'show',first['head']+':AGENTS.md'),'Keep all legacy product facts.')
        report=self.git(self.remote,'show',first['head']+':'+bridge.ADOPTION_REPORT)
        self.assertIn('Keep all legacy product facts.',report);self.assertIn('Shared v2.',report)
        self.assertEqual(self.run_delivery()['status'],'UNCHANGED');self.assertEqual(self.api.creates,1)
        self.api.prs[0]['title']='Reviewed title';self.api.prs[0]['body']='Reviewed body'
        adopted=(self.central/'templates/repository/AGENTS.md').read_text(encoding='utf-8')
        human=self.edit(BRANCH,'AGENTS.md',adopted)
        result=self.run_delivery();self.assertEqual(result['pullRequest'],1);self.assertEqual(self.api.creates,1)
        self.assertEqual(self.api.prs[0]['body'],'Reviewed body');self.assertEqual(self.api.prs[0]['title'],'Reviewed title')
        self.git(self.remote,'merge-base','--is-ancestor',human,result['head'])
        with self.assertRaises(subprocess.CalledProcessError):self.git(self.remote,'show',result['head']+':'+bridge.ADOPTION_REPORT)
        self.api.prs[0]['state']='closed';self.api.prs[0]['merged_at']='2026-10-29T00:00:00Z'
        self.git(self.remote,'update-ref','refs/heads/develop',result['head'])
        self.assertEqual(self.run_delivery()['status'],'NO_DIFF')

    def test_incomplete_adoption_on_base_cannot_enter_periodic_update(self):
        self.edit('develop',bridge.ADOPTION_REPORT,'Unresolved full report\n')
        with self.assertRaisesRegex(ValueError,'TEMPLATE_ADOPTION_INCOMPLETE'):self.run_delivery()
        self.assertFalse(self.api.mutations)

    def test_lock_verification_failure_keeps_existing_branch_pr_and_lock(self):
        first = self.run_delivery()
        original = self.git(self.remote, 'show', first['head'] + ':.github/workflows/actions.lock')
        metadata = copy.deepcopy(self.api.prs)
        mutations = len(self.api.mutations)
        def fail(mode, target):
            fixture_tool(mode, target)
            if mode == 'verify': raise LockFailure('TOOL_VERIFY_FAILED')
        with self.assertRaisesRegex(LockFailure, 'TOOL_VERIFY_FAILED'):
            self.run_delivery(lock_runner=fail)
        self.assertEqual(self.head(), first['head'])
        self.assertEqual(self.api.prs, metadata)
        self.assertEqual(len(self.api.mutations), mutations)
        self.assertEqual(self.git(self.remote, 'show', first['head'] + ':.github/workflows/actions.lock'), original)

    def test_real_template_rename_and_delete_reach_signed_tree_without_product_changes(self):
        self.git(self.central,'mv','templates/repository/.github/labeler.yml','templates/repository/.github/paths.yml')
        self.new=self.commit(self.central,'Rename shared configuration');self.git(self.central,'tag','v3.0.0')
        self.request.update(workflowSha=self.new,templateSha=self.new)
        result=self.run_delivery()
        self.assertTrue(self.git(self.remote,'show',result['head']+':.github/paths.yml'))
        with self.assertRaises(subprocess.CalledProcessError):self.git(self.remote,'show',result['head']+':.github/labeler.yml')
        self.assertEqual(self.git(self.remote,'show',result['head']+':VERSION'),'9.2.2')
        self.assertEqual(self.git(self.remote,'show',result['head']+':manual.txt'),'keep product')

    def test_ref_response_lost_and_pr_creation_response_lost_are_adopted_once(self):
        self.api.lose_ref=True;self.api.lose_pr=True
        result=self.run_delivery();self.assertEqual(result['status'],'DELIVERED')
        self.assertEqual(self.api.creates,1);before=len(self.api.mutations)
        self.assertEqual(self.run_delivery()['status'],'UNCHANGED');self.assertEqual(len(self.api.mutations),before)

    def test_resume_after_ref_before_pr_and_preserve_intervening_human_commit(self):
        self.api.fail_pr=True
        first=self.run_delivery();self.assertEqual(first['status'],'WAIT_PR_READBACK');self.assertFalse(self.api.prs)
        human=self.edit(BRANCH,'human-after-interruption.txt','keep\n')
        self.api.fail_pr=False
        result=self.run_delivery();self.assertEqual(result['status'],'DELIVERED');self.assertEqual(result['head'],human)
        self.assertEqual(self.api.creates,2)  # first attempt produced no PR; second creates the sole PR
        self.assertEqual(len(self.api.prs),1)

    def test_concurrent_commit_rejects_non_fast_forward_then_next_wake_recomputes(self):
        self.run_delivery();self.edit('develop','main.txt','base advanced\n')
        self.api.before_ref=lambda:self.edit(BRANCH,'race.txt','keep concurrent\n')
        result=self.run_delivery();self.assertEqual(result['status'],'REF_CHANGED')
        concurrent=self.head();self.assertEqual(self.git(self.remote,'show',concurrent+':race.txt'),'keep concurrent')
        resumed=self.run_delivery();self.assertEqual(resumed['status'],'DELIVERED')
        self.assertEqual(self.git(self.remote,'show',resumed['head']+':race.txt'),'keep concurrent')
        self.assertEqual(self.api.creates,1)

    def test_merge_conflict_leaves_remote_head_and_original_pr_untouched(self):
        self.run_delivery();human=self.edit(BRANCH,'manual.txt','branch human\n');self.edit('develop','manual.txt','base human\n')
        before=len(self.api.mutations)
        with self.assertRaisesRegex(ValueError,'GIT_MERGE'):self.run_delivery()
        self.assertEqual(self.head(),human);self.assertEqual(len(self.api.mutations),before)

    def test_closed_unmerged_pr_is_not_reopened_and_merged_branch_keeps_ancestors(self):
        first=self.run_delivery();self.api.prs[0]['state']='closed';before=len(self.api.mutations)
        self.assertEqual(self.run_delivery()['status'],'CLOSED');self.assertEqual(len(self.api.mutations),before)
        self.api.prs[0]['merged_at']='2026-10-28T00:00:00Z'
        self.git(self.remote,'update-ref','refs/heads/develop',first['head'])
        base=self.edit('develop','after-merge.txt','new base\n');before=len(self.api.mutations)
        self.assertEqual(self.run_delivery()['status'],'NO_DIFF');self.assertEqual(self.api.creates,1)
        self.git(self.remote,'merge-base','--is-ancestor',first['head'],self.head())
        self.assertEqual(self.git(self.remote,'rev-parse',self.head()+'^{tree}'),self.git(self.remote,'rev-parse',base+'^{tree}'))
        self.assertEqual(self.git(self.remote,'show','-s','--format=%P',self.head()).split(),[first['head'],base])
        self.assertFalse(any(path.endswith('/git/trees') for _,path,_ in self.api.mutations[before:]))
        before=len(self.api.mutations)
        self.assertEqual(self.run_delivery()['status'],'NO_DIFF');self.assertEqual(len(self.api.mutations),before)

    def test_unverified_signature_or_wrong_tree_never_moves_ref(self):
        for failure in ['signature','tree','parents','identity','message']:
            with self.subTest(failure=failure):
                self.api.invalid=failure
                with self.assertRaisesRegex(ValueError,'SYNC_(SIGNATURE|TREE_MISMATCH|SIGNED_PARENTS|SIGNED_MESSAGE)'):self.run_delivery()
                self.assertIsNone(self.head());self.assertEqual(self.api.creates,0)

    def test_unknown_branch_and_foreign_run_provenance_are_rejected(self):
        self.git(self.remote,'update-ref','refs/heads/'+BRANCH,self.base)
        with self.assertRaisesRegex(ValueError,'UNKNOWN_BRANCH_OWNER'):self.run_delivery()
        self.assertEqual(self.head(),self.base)
        # Remove only this test fixture ref, then generate a valid native history.
        self.git(self.remote,'update-ref','-d','refs/heads/'+BRANCH)
        self.run_delivery();self.api.invalid='run';before=self.head()
        with self.assertRaisesRegex(ValueError,'SOURCE_RUN'):self.run_delivery()
        self.assertEqual(self.head(),before)

    def test_bootstrap_missing_permission_and_unprotected_branch_prevent_all_writes(self):
        for failure in ['bootstrap','variable-permission','protection','bypass-unreadable','scope']:
            with self.subTest(failure=failure):
                self.api.invalid=failure
                with self.assertRaises((ValueError,NativeFailure)):self.run_delivery()
                self.assertFalse(self.api.mutations)

    def test_branch_protection_reads_every_native_page(self):
        self.api.paginated_rules=True
        self.assertEqual(self.run_delivery()['status'],'DELIVERED')
        self.assertEqual(self.api.rule_pages,[1,2,1,2,1,2])

    def test_protection_readback_failure_after_ref_preserves_head_without_creating_pr(self):
        self.api.before_ref=lambda:setattr(self.api,'invalid','protection')
        with self.assertRaisesRegex(ValueError,'SYNC_BRANCH_PROTECTION'):self.run_delivery()
        delivered=self.head();self.assertIsNotNone(delivered);self.assertEqual(self.api.creates,0)
        self.api.invalid=None
        self.assertEqual(self.run_delivery()['status'],'DELIVERED')
        self.assertEqual(self.head(),delivered);self.assertEqual(self.api.creates,1)

    def test_unknown_commit_response_never_moves_a_ref_without_known_verified_commit(self):
        self.api.lose_commit=True
        self.assertEqual(self.run_delivery()['status'],'WAIT_COMMIT_RESPONSE');self.assertIsNone(self.head())
        self.api.lose_commit=False
        self.assertEqual(self.run_delivery()['status'],'DELIVERED');self.assertEqual(self.api.creates,1)

    def test_renderer_has_no_write_or_read_tokens_and_copier_conflict_cannot_deliver(self):
        def render(*args):
            env=bridge.environment(self.root)
            self.assertNotIn('STEWARD_TEMPLATE_TOKEN',env);self.assertNotIn('STEWARD_TEMPLATE_READ_TOKEN',env)
            raise ValueError('TEMPLATE_CONFLICT')
        with patch.dict(os.environ,{'STEWARD_TEMPLATE_TOKEN':'write-canary','STEWARD_TEMPLATE_READ_TOKEN':'read-canary'}):
            with self.assertRaisesRegex(ValueError,'TEMPLATE_CONFLICT'):self.run_delivery(renderer=render)
        self.assertFalse(self.api.mutations)

    def test_gh_cli_uses_fixed_json_files_and_no_metadata_edit_or_push(self):
        profile=self.root/'gh-profile';profile.mkdir()
        calls=[]
        def process(argv,**kwargs):
            calls.append((argv,kwargs['env']))
            if argv[1]=='api':
                data=json.loads(Path(argv[argv.index('--input')+1]).read_text())
                self.assertEqual(data,{'force':False})
                return subprocess.CompletedProcess(argv,0,b'HTTP/2.0 200 OK\r\n\r\n{"ok":true}',b'')
            body=Path(argv[argv.index('--body-file')+1]).read_text();self.assertEqual(body,'Human-safe body\n')
            return subprocess.CompletedProcess(argv,0,b'https://github.com/splrad/fixture/pull/1',b'')
        client=GitHubCLI('fixed-gh','fixture-token',profile,'readonly-token')
        with patch('delivery.subprocess.run',process):
            self.assertEqual(client.request('PATCH','/repos/splrad/fixture/git/refs/heads/'+BRANCH,{'force':False}),{'ok':True})
            client.create_pr('splrad/fixture','develop','Human-safe body\n')
        self.assertTrue(all(env['GH_PROMPT_DISABLED']=='1' for _,env in calls))
        self.assertTrue(all('fixture-token' not in json.dumps(argv) for argv,_ in calls))
        self.assertEqual(calls[1][0][1:3],['pr','create'])
        responses=[subprocess.CompletedProcess([],1,b'HTTP/2.0 404 Not Found\n\n{}',b'error'),
                   subprocess.CompletedProcess([],1,b'HTTP/2.0 403 Forbidden\n\n{}',b'error')]
        def read_process(argv,**kwargs):
            self.assertEqual(kwargs['env']['GH_TOKEN'],'readonly-token');return responses.pop(0)
        with patch('delivery.subprocess.run',read_process):
            self.assertIsNone(client.request('GET','/repos/splrad/fixture/actions/variables/STEWARD_BOOTSTRAP_RECOVERY',optional=True))
            with self.assertRaisesRegex(NativeFailure,'403'):
                client.request('GET','/repos/splrad/fixture/actions/variables/STEWARD_BOOTSTRAP_RECOVERY',optional=True)


class FixtureAPI:
    def __init__(self,test):
        self.test=test;self.prs=[];self.mutations=[];self.creates=0;self.commits=set()
        self.before_ref=None;self.lose_ref=False;self.lose_pr=False;self.fail_pr=False;self.lose_commit=False;self.invalid=None
        self.paginated_rules=False;self.rule_pages=[]
    def request(self,method,path,body=None,optional=False):
        t=self.test;route=urlparse(path).path;repo={'id':12,'full_name':'splrad/fixture','default_branch':'develop','owner':{'id':302208797}}
        if method!='GET':self.mutations.append((method,path,copy.deepcopy(body)))
        if path=='/installation/repositories':return {'total_count':2 if self.invalid=='scope' else 1,'repositories':[repo]}
        if route.startswith('/users/'):return {**t.bot,'type':'Bot'}
        if route=='/repos/splrad/fixture':return repo
        if route.endswith('/actions/variables/STEWARD_BOOTSTRAP_RECOVERY'):
            if self.invalid=='variable-permission':raise NativeFailure('403')
            return {'value':'pending'} if self.invalid=='bootstrap' else None
        if '/rules/branches/' in route:
            query=parse_qs(urlparse(path).query);assert query['per_page']==['100']
            page=int(query['page'][0]);self.rule_pages.append(page)
            if self.paginated_rules and page==1:return [{'type':'required_signatures','ruleset_id':99} for _ in range(100)]
            return [] if self.invalid=='protection' else [{'type':kind,'ruleset_id':i} for i,kind in enumerate(['creation','non_fast_forward','deletion'],1)]
        if '/rulesets/' in route:
            i=int(route.rsplit('/',1)[1]);return {'id':i,'enforcement':'active','rules':[{'type':['creation','non_fast_forward','deletion'][i-1]}],
                **({} if self.invalid=='bypass-unreadable' else {'bypass_actors':[{'actor_id':4243096,'actor_type':'Integration','bypass_mode':'always'}] if i==1 else []})}
        if '/actions/runs/' in route:
            return {'id':int(route.rsplit('/',1)[1]),'repository':{'id':CENTRAL_ID},'head_repository':{'id':0 if self.invalid=='run' else CENTRAL_ID},
                    'head_sha':t.new,'head_branch':'main','event':'workflow_dispatch','workflow_id':42}
        if '/actions/workflows/' in route:return {'id':42,'path':'.github/workflows/sync-managed.yml','state':'active'}
        if '/git/ref/heads/' in route:
            branch=unquote(route.split('/git/ref/heads/')[1])
            try:sha=t.git(t.remote,'rev-parse','--verify','refs/heads/'+branch)
            except subprocess.CalledProcessError:return None
            return {'ref':'refs/heads/'+branch,'object':{'type':'commit','sha':sha}}
        if route.endswith('/pulls'):
            query=parse_qs(urlparse(path).query);assert query['state']==['all'] and query['head']==['splrad:'+BRANCH] and query['base']==['develop']
            return copy.deepcopy(self.prs)
        if method=='POST' and route.endswith('/git/trees'):
            if not body['tree']:raise NativeFailure('SYNC_GH_HTTP_422')
            with tempfile.TemporaryDirectory(prefix='tree-',dir=t.root) as temp:
                env={**os.environ,'GIT_INDEX_FILE':str(Path(temp)/'index'),'GIT_WORK_TREE':str(temp)}
                def git(*args,input=None):return subprocess.check_output(['git',*args],cwd=t.remote,env=env,input=input).decode().strip()
                git('read-tree',body['base_tree'])
                for e in body['tree']:
                    if e.get('sha','content') is None:git('update-index','--force-remove','--',e['path']);continue
                    oid=e.get('sha') or git('hash-object','-w','--stdin',input=e['content'].encode())
                    git('update-index','--add','--cacheinfo',e['mode']+','+oid+','+e['path'])
                tree=git('write-tree')
                return {'sha':'0'*40 if self.invalid=='tree' else tree}
        if method=='POST' and route.endswith('/git/commits'):
            assert set(body)=={'message','tree','parents'}
            env={**os.environ,'GIT_AUTHOR_NAME':t.identity[0],'GIT_AUTHOR_EMAIL':t.identity[1],
                 'GIT_COMMITTER_NAME':t.identity[0],'GIT_COMMITTER_EMAIL':t.identity[1]}
            argv=['git','commit-tree',body['tree']]
            for parent in body['parents']:argv+=['-p',parent]
            sha=subprocess.check_output(argv,cwd=t.remote,env=env,input=body['message'].encode()).decode().strip();self.commits.add(sha)
            if self.lose_commit:raise NativeFailure('response lost')
            return {'sha':sha}
        if '/git/commits/' in route:
            sha=route.rsplit('/',1)[1];message=subprocess.check_output(['git','show','-s','--format=%B',sha],cwd=t.remote).decode().rstrip('\n')
            if self.invalid=='message':message='unexpected title\n'+message.split('\n',1)[1]
            parents=t.git(t.remote,'show','-s','--format=%P',sha).split()
            return {'sha':sha,'message':message,'tree':{'sha':t.git(t.remote,'rev-parse',sha+'^{tree}')},
                    'parents':[{'sha':p} for p in (parents[::-1]+['a'*40] if self.invalid=='parents' else parents)],
                    'verification':{'verified':sha in self.commits and self.invalid!='signature','reason':'valid'}}
        if '/commits/' in route:return {'author':{'id':0 if self.invalid=='identity' else t.bot['id']}}
        if '/git/refs' in route and method in ['POST','PATCH']:
            if self.before_ref:
                callback=self.before_ref;self.before_ref=None;callback()
            current=t.head();candidate=body['sha']
            if method=='POST' and current:raise NativeFailure('422')
            if method=='PATCH':
                assert body['force'] is False
                try:t.git(t.remote,'merge-base','--is-ancestor',current,candidate)
                except subprocess.CalledProcessError:raise NativeFailure('422 non-fast-forward')
            t.git(t.remote,'update-ref','refs/heads/'+BRANCH,candidate)
            for pr in self.prs:
                if pr['state']=='open':pr['head']['sha']=candidate
            if self.lose_ref:self.lose_ref=False;raise NativeFailure('response lost')
            return {'ref':'refs/heads/'+BRANCH,'object':{'type':'commit','sha':candidate}}
        raise AssertionError((method,path))
    def create_pr(self,repository,base,body):
        self.creates+=1
        if self.fail_pr:raise NativeFailure('no response before create')
        number=len(self.prs)+1
        self.prs.append({'id':number,'number':number,'state':'open','merged_at':None,'title':'Initial title','body':body,
                         'head':{'repo':{'id':12},'ref':BRANCH,'sha':self.test.head()},'base':{'repo':{'id':12},'ref':'develop'}})
        if self.lose_pr:self.lose_pr=False;raise NativeFailure('response lost')


if __name__=='__main__':unittest.main()
