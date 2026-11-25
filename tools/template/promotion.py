"""Prepare the next native template tag from reviewed Git content and PEP 440 tags."""
import argparse
import json
import re
import tempfile
from pathlib import Path
from packaging.version import Version, InvalidVersion
from copier_bridge import environment, git, require

TITLE_CALLER = 'templates/repository/.github/workflows/pr-title.yml.jinja'
TITLE_SOURCE = '.github/workflows/pr-title-reusable.yml'

def template_tag_plan(central, commit, *, released_tag=None):
    central=Path(central).resolve()
    require(re.fullmatch(r'[a-f0-9]{40}',commit),'PROMOTION_COMMIT')
    with tempfile.TemporaryDirectory(prefix='template-promotion-') as profile:
        env=environment(Path(profile)); versions={}
        tags=dict(line.split(' ',1) for line in git(central,['for-each-ref','--format=%(refname) %(objectname)','refs/tags/'],env).decode().splitlines()
                  if not line.startswith('refs/tags/controller-v'))
        require(git(central,['rev-parse',commit+'^{commit}'],env).decode().strip()==commit,'PROMOTION_COMMIT')
        reachable=set(git(central,['tag','--merged',commit],env).decode().splitlines())
        candidates=git(central,['tag','--list'],env).decode().splitlines()
        if released_tag is not None:
            require(tags.get('refs/tags/'+released_tag)==commit,'TEMPLATE_RELEASE_RANGE')
            # Replay promotion just before this tag was created, even if newer tags now exist.
            candidates=reachable-{released_tag}
        for tag in candidates:
            try: version=Version(tag)
            except InvalidVersion: continue
            if version.is_prerelease or version.is_devrelease:continue
            source=git(central,['rev-parse',tag+'^{commit}'],env).decode().strip()
            if not git(central,['ls-tree',source,'--','copier.yml'],env):continue
            require(version not in versions or versions[version]['commit']==source,'TEMPLATE_VERSION_AMBIGUOUS')
            versions[version]={'tag':tag,'commit':source,'reachable':tag in reachable}
        require(versions,'TEMPLATE_INITIAL_ADOPTION_REQUIRED')
        latest=max(versions); previous=versions[latest]
        require(previous['reachable'],'TEMPLATE_NEWER_TAG_OUTSIDE_MAIN')
        # A retry on the just-published commit compares the same inputs that
        # selected its delivery mode, without allocating another version.
        already_tagged=previous['commit']==commit
        comparison=previous
        if already_tagged and len(versions)>1:
            older=versions[sorted(versions)[-2]]
            if older['reachable']:
                comparison=older
        def tree(revision, *paths):
            return git(central,['ls-tree','-rz',revision,'--',*paths],env)
        template_paths=['copier.yml','templates/repository']
        before=tree(comparison['commit'],*template_paths)
        after=tree(commit,*template_paths)
        require(after,'TEMPLATE_SOURCE_MISSING')
        if tree(commit,TITLE_CALLER):
            # Copier renders the title caller with this template's commit SHA.
            # A supplier change requires delivery even if the Jinja bytes match.
            title=tree(commit,TITLE_SOURCE)
            require(re.fullmatch(rb'100644 blob [0-9a-f]{40}\t\.github/workflows/pr-title-reusable\.yml\0',title),
                    'TEMPLATE_TITLE_SOURCE_MODE')
            before+=tree(comparison['commit'],TITLE_SOURCE)
            after+=title
        policy_path='config/review/security-common.md'
        old_policy=tree(comparison['commit'],policy_path)
        new_policy=tree(commit,policy_path)
        require(not old_policy or new_policy,'SECURITY_POLICY_SOURCE_REMOVED')
        if new_policy:
            require(re.fullmatch(rb'100644 blob [0-9a-f]{40}\tconfig/review/security-common\.md\0',new_policy),
                    'SECURITY_POLICY_SOURCE_MODE')
        independent=before==after and not old_policy and bool(new_policy)
        if already_tagged or (before==after and old_policy==new_policy):
            plan={'status':'UNCHANGED','commit':commit,'previous':previous,'tags':tags}
            if already_tagged and independent and previous['tag']=='v'+str(latest) and tags['refs/tags/'+previous['tag']]==commit:
                plan.update(independentSecurityAdoption=True,tag=previous['tag'])
            return plan
        release=list(latest.release)
        while len(release)<3:release.append(0)
        release[-1]+=1
        candidate=(str(latest.epoch)+'!' if latest.epoch else '')+'.'.join(map(str,release))
        require(Version(candidate)>latest,'TEMPLATE_VERSION_ORDER')
        plan={'status':'CREATE','commit':commit,'tag':'v'+candidate,'previous':previous,'tags':tags}
        if independent:
            plan['independentSecurityAdoption']=True
        return plan

def previous_template_tag(central, commit, tag):
    plan=template_tag_plan(central,commit,released_tag=tag)
    require(plan['status']=='CREATE' and plan['tag']==tag,'TEMPLATE_RELEASE_RANGE')
    return plan['previous']['tag']

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--central',required=True);parser.add_argument('--commit',required=True)
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--output');mode.add_argument('--previous-of')
    args=parser.parse_args()
    if args.previous_of is not None:
        print(previous_template_tag(args.central,args.commit,args.previous_of))
    else:
        with open(args.output,'x',encoding='utf-8') as stream:json.dump(template_tag_plan(args.central,args.commit),stream,indent=2)
