import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepare, sections, updated, verify} from '../security-policy.mjs';

const body = Buffer.from('## 组织公共规则\n\nFirst rule.\n');
const newer = Buffer.from('## 组织公共规则\n\nUpdated rule.\n');
const initial = updated(null,null,body);
const before = Buffer.concat([Buffer.from('仓库标题\r\n'),initial,Buffer.from('\r\n地方规则\r\n')]);
const diff = (bytes, from, to) => Buffer.from(bytes.toString().replace(from,to));

test('changes exactly one byte range, including when a project uses CRLF and edits its own text', () => {
  const after = updated(before,body,newer);
  assert.deepEqual(after,diff(before,'First rule.','Updated rule.'));
  assert.deepEqual(updated(after,body,newer),after);
  const concurrent = diff(before,'地方规则','管理员的新规则');
  assert.deepEqual(updated(concurrent,body,newer),diff(concurrent,'First rule.','Updated rule.'));
  assert.throws(()=>updated(null,body,newer),/ADOPTED_FILE_MISSING/);
  assert.throws(()=>updated(diff(before,'First','My'),body,newer),/COMMON_EDITED/);
});

test('requires one ordered pair of whole-line markers', () => {
  for (const value of [Buffer.from('old policy'),Buffer.concat([initial,initial]),
    diff(initial,'<!-- BEGIN','text <!-- BEGIN'),
    diff(diff(initial,'<!-- END','<!-- FLIP'),'<!-- BEGIN','<!-- END').toString().replace('<!-- FLIP','<!-- BEGIN')]) {
    assert.throws(()=>sections(Buffer.from(value)),/MARKERS/);
  }
});

test('checks adoption against trusted Git tags, preserves outside bytes on sync and permits administrator edits', t => {
  const root = mkdtempSync(join(tmpdir(),'security-guidance-git-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git = (...args)=>execFileSync('git',['-c','core.hooksPath=','-c','core.autocrlf=false',
    '-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false',...args],{cwd:root}).toString().trim();
  const commit = () => {git('add','--all');git('commit','-qm','fixture');return git('rev-parse','HEAD');};
  git('init','-q');
  const common = join(root,'config/review/security-common.md');
  mkdirSync(join(root,'config/review'),{recursive:true});
  writeFileSync(join(root,'copier.yml'),'_subdirectory: templates/repository\n');
  writeFileSync(join(root,'README.md'),'first');commit();git('tag','v1.0.0');
  writeFileSync(common,body);commit();git('tag','v2.0.0');
  writeFileSync(common,newer);const controller = commit();git('tag','v3.0.0');
  const pin = tag => writeFileSync(join(root,'.copier-answers.yml'), '_src_path: https://github.com/splrad/steward.git\n_commit: '+tag+'\n');
  const policy = join(root,'SECURITY.md');
  pin('v1.0.0');const legacy = commit();
  const check = (base,head,sync=false) => verify(root,base,head,root,controller,sync,false);
  writeFileSync(policy,initial);const standalone = commit();
  check(legacy,standalone);
  assert.equal(git('diff','--name-only',legacy,standalone),'SECURITY.md');
  const localText = Buffer.from('\nAdministrator addition.\n');
  writeFileSync(policy,Buffer.concat([initial,localText]));
  assert.throws(()=>prepare(root,root,controller,controller),/WORKTREE_DIRTY/);
  git('add','SECURITY.md');
  assert.throws(()=>prepare(root,root,controller,controller),/WORKTREE_DIRTY/);
  assert.deepEqual(readFileSync(policy),Buffer.concat([initial,localText]));
  const local = commit();
  check(standalone,local);
  writeFileSync(policy,updated(readFileSync(policy),body,newer));const independentUpgrade = commit();
  check(local,independentUpgrade);
  assert.equal(git('diff','--name-only',local,independentUpgrade),'SECURITY.md');
  writeFileSync(policy,Buffer.concat([initial,localText]));const independentRollback = commit();
  assert.throws(()=>check(independentUpgrade,independentRollback),/POLICY_DOWNGRADE/);
  rmSync(policy);const removed = commit();
  assert.throws(()=>check(independentUpgrade,removed),/FILE_MISSING/);
  pin('v2.0.0');writeFileSync(policy,initial);const first = commit();
  check(legacy,first,true);
  writeFileSync(policy,Buffer.concat([initial,Buffer.from('\nAdministrator text.\n')]));const human = commit();
  check(first,human);assert.throws(()=>check(first,human,true),/OUTSIDE_CHANGED/);
  pin('v3.0.0');writeFileSync(policy,updated(readFileSync(policy),body,newer));const upgraded = commit();
  check(human,upgraded,true);
  writeFileSync(policy,diff(readFileSync(policy),'Updated','Wrong'));const wrong = commit();
  assert.throws(()=>check(upgraded,wrong),/COMMON_MISMATCH/);
  writeFileSync(policy,updated(initial,body,newer));
  mkdirSync(join(root,'.github'));
  writeFileSync(join(root,'.github/SECURITY.md'),'Other policy.');const shadowed = commit();
  assert.throws(()=>check(upgraded,shadowed),/SHADOWED/);
  git('tag','v9.0.0',shadowed);pin('v9.0.0');const future = commit();
  assert.throws(()=>check(upgraded,future));
  pin('v1.0.0');const rollback = commit();
  assert.throws(()=>check(upgraded,rollback),/ADOPTION_REMOVED/);
});
