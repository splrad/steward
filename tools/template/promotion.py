"""Prepare the next native template tag from reviewed Git content and PEP 440 tags."""
import argparse
import json
import re
import tempfile
from pathlib import Path
from packaging.version import Version, InvalidVersion
from copier_bridge import environment, git, require

def template_tag_plan(central, commit):
    central=Path(central).resolve()
    require(re.fullmatch(r'[a-f0-9]{40}',commit),'PROMOTION_COMMIT')
    with tempfile.TemporaryDirectory(prefix='template-promotion-') as profile:
        env=environment(Path(profile)); versions={}
        tags=dict(line.split(' ',1) for line in git(central,['for-each-ref','--format=%(refname) %(objectname)','refs/tags/'],env).decode().splitlines())
        require(git(central,['rev-parse',commit+'^{commit}'],env).decode().strip()==commit,'PROMOTION_COMMIT')
        reachable=set(git(central,['tag','--merged',commit],env).decode().splitlines())
        for tag in git(central,['tag','--list'],env).decode().splitlines():
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
        paths=['copier.yml','templates/repository']
        before=git(central,['ls-tree','-rz',previous['commit'],'--',*paths],env)
        after=git(central,['ls-tree','-rz',commit,'--',*paths],env)
        require(after,'TEMPLATE_SOURCE_MISSING')
        if before==after:return {'status':'UNCHANGED','commit':commit,'previous':previous,'tags':tags}
        release=list(latest.release)
        while len(release)<3:release.append(0)
        release[-1]+=1
        candidate=(str(latest.epoch)+'!' if latest.epoch else '')+'.'.join(map(str,release))
        require(Version(candidate)>latest,'TEMPLATE_VERSION_ORDER')
        return {'status':'CREATE','commit':commit,'tag':'v'+candidate,'previous':previous,'tags':tags}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--central',required=True);parser.add_argument('--commit',required=True);parser.add_argument('--output',required=True)
    args=parser.parse_args()
    with open(args.output,'x',encoding='utf-8') as stream:json.dump(template_tag_plan(args.central,args.commit),stream,indent=2)
