import {isDeepStrictEqual as equal} from 'node:util';
import {createHash} from 'node:crypto';

const check=(value,code)=>{if(!value)throw Error('ACTIONS_POLICY_'+code);};
const positive=value=>Number.isSafeInteger(value)&&value>0;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const events=value=>Array.isArray(value)&&value.length>0&&value.every(v=>typeof v==='string'&&/^[a-z_]+$/.test(v))&&new Set(value).size===value.length;
const sorted=value=>[...value].sort();
const sameEvents=(a,b)=>events(a)&&events(b)&&equal(sorted(a),sorted(b));
const fields=['id','name','source_type','source','enforcement'];

function policyPath(listed,scope){
  const url=new URL(listed?._links?.self?.href);
  check(url.origin==='https://api.github.com'&&!url.username&&!url.password&&!url.search&&!url.hash,'DETAIL_ORIGIN');
  const prefix=listed.source_type==='Organization'?`/orgs/${listed.source}`
    :listed.source_type==='Repository'?`/repos/${listed.source}`
    :listed.source_type==='Enterprise'?`/enterprises/${listed.source}`:null;
  // Native inherited lists can link to the exact repository projection instead of the owner endpoint.
  check(prefix&&positive(listed.id)&&[`${prefix}/actions/policies/${listed.id}`,`${scope}/actions/policies/${listed.id}`].includes(url.pathname),'DETAIL_SOURCE');
  check(!url.pathname.includes('..')&&!/%|\\/.test(url.pathname),'DETAIL_PATH');
  return url.pathname;
}

/** Read every applicable parent and each native detail. Fail closed on incomplete lists. */
export async function readActionsPolicies(request,prefix){
  check(prefix==='/orgs/splrad'||/^\/repos\/splrad\/[A-Za-z0-9_.-]+$/.test(prefix),'SCOPE');
  const result=[],seen=new Set();let total=null;
  for(let page=1;page<=10000;page++){
    const response=await request('GET',`${prefix}/actions/policies?has_parents=true&per_page=100&page=${page}`);
    check(response.status===200,'READ_UNKNOWN');const body=response.data;
    check(Number.isSafeInteger(body?.total_count)&&body.total_count>=0&&Array.isArray(body.policies),'LIST');
    check(total===null||total===body.total_count,'LIST_CHANGED');total=body.total_count;
    for(const listed of body.policies){
      const path=policyPath(listed,prefix),identity=JSON.stringify([listed.source_type,listed.source,listed.id]);check(!seen.has(identity),'DUPLICATE');seen.add(identity);
      const detail=await request('GET',path);
      check(detail.status===200&&fields.every(key=>equal(detail.data?.[key],listed[key])),'DETAIL_CHANGED');
      check(detail.data.target==='actions'&&Array.isArray(detail.data.rules)&&detail.data.conditions,'DETAIL_SHAPE');
      result.push({path,value:detail.data});
    }
    check(result.length<=total,'COUNT');
    if(result.length===total)return result;
    check(body.policies.length===100,'PAGINATION_INCOMPLETE');
  }
  throw Error('ACTIONS_POLICY_PAGINATION_LIMIT');
}

export function validateActionsRegistry(registry){
  check(registry?.schemaVersion===1&&equal(Object.keys(registry).sort(),['organization','policies','repositories','schemaVersion']),'REGISTRY');
  check(equal(registry.organization,{login:'splrad',id:302208797})&&Array.isArray(registry.repositories)&&registry.repositories.length>0,'ORGANIZATION');
  check(registry.repositories.every(r=>equal(Object.keys(r).sort(),['full_name','id'])&&positive(r.id)&&/^splrad\/[A-Za-z0-9_.-]+$/.test(r.full_name)),'REPOSITORIES');
  check(new Set(registry.repositories.map(r=>r.id)).size===registry.repositories.length&&new Set(registry.repositories.map(r=>r.full_name)).size===registry.repositories.length,'REPOSITORY_DUPLICATE');
  check(Array.isArray(registry.policies),'REGISTRATIONS');
  const known=new Set();
  for(const row of registry.policies){
    check(equal(Object.keys(row).sort(),['acceptedEvents','conditions','desiredEvents','enforcement','id','name','source','source_type']),'REGISTRATION');
    check(positive(row.id)&&row.source_type==='Organization'&&row.source==='splrad'&&row.enforcement==='active'&&typeof row.name==='string'&&row.name.length>0,'REGISTRATION_IDENTITY');
    check(!known.has(row.id),'REGISTRATION_DUPLICATE');known.add(row.id);
    const ids=row.conditions?.repository_id?.repository_ids,path=row.conditions?.workflow_path;
    check(equal(Object.keys(row.conditions??{}).sort(),['repository_id','workflow_path'])&&Array.isArray(ids)&&ids.length>0&&new Set(ids).size===ids.length&&ids.every(id=>registry.repositories.some(r=>r.id===id)),'REGISTERED_TARGETS');
    check(events(row.acceptedEvents)&&events(row.desiredEvents),'EVENTS');
    const title=equal(path,{include:['.github/workflows/pr-title.yml'],exclude:[]});
    const other=equal(path,{include:['~ALL'],exclude:['.github/workflows/pr-title.yml']});
    check(title||other,'WORKFLOW_PATH');
    check(title?sameEvents(row.desiredEvents,['pull_request_target']):!row.desiredEvents.includes('pull_request_target'),'TITLE_ONLY');
  }
  return registry;
}

function registeredState(value,registration){
  check(fields.every(key=>equal(value?.[key],registration[key]))&&value.target==='actions'&&equal(value.conditions,registration.conditions),'REGISTERED_POLICY_DRIFT');
  const owned=value.rules.filter(rule=>rule.type==='restrict_action_events');
  check(owned.length===1&&equal(Object.keys(owned[0].parameters??{}),['allowed_events'])&&events(owned[0].parameters.allowed_events),'EVENT_RULE');
  return owned[0];
}

/** Update only pre-registered event rules. Initial creation and scope changes stay in E10. */
export async function reconcileActionsPolicies(request,registry,apply=false){
  validateActionsRegistry(registry);
  const scopes=['/orgs/splrad',...registry.repositories.map(r=>'/repos/'+r.full_name)],inventory=[];
  // Complete every read before allowing any write; permission errors cannot mean an empty policy list.
  for(const prefix of scopes)inventory.push({prefix,policies:await readActionsPolicies(request,prefix)});
  const results=[];
  for(const registration of registry.policies){
    const path=`/orgs/splrad/actions/policies/${registration.id}`;
    check(inventory[0].policies.some(p=>p.path===path),'REGISTRATION_MISSING');
    let completed=false;
    for(let attempt=1;attempt<=2;attempt++){
      const current=await request('GET',path);check(current.status===200,'PREWRITE_UNKNOWN');
      const owned=registeredState(current.data,registration);
      if(sameEvents(owned.parameters.allowed_events,registration.desiredEvents)){
        results.push({id:registration.id,status:'UNCHANGED',attempt});completed=true;break;
      }
      check(sameEvents(owned.parameters.allowed_events,registration.acceptedEvents),'EXTERNAL_EVENT_CHANGE');
      if(!apply){results.push({id:registration.id,status:'PLANNED',attempt});completed=true;break;}
      const latest=await request('GET',path);check(latest.status===200&&equal(latest.data,current.data),'CONCURRENT_CHANGE');
      const rules=current.data.rules.map(rule=>rule===owned?{...rule,parameters:{allowed_events:registration.desiredEvents}}:rule);
      let responseUnknown=false;
      try{const response=await request('PUT',path,{rules});responseUnknown=response.status!==200;}catch{responseUnknown=true;}
      const observed=await request('GET',path);check(observed.status===200,'WRITE_READBACK_UNKNOWN');
      registeredState(observed.data,registration);
      if(equal(observed.data.rules,rules)){
        results.push({id:registration.id,status:'APPLIED',attempt,responseUnknown});completed=true;break;
      }
      // Retry only the identical, still unapplied difference; preserve new native/external changes.
      check(equal(observed.data.rules,current.data.rules),'WRITE_READBACK_DRIFT');
    }
    check(completed,'WRITE_UNCONFIRMED');
  }
  return {inventory,results,summary:{scopes:inventory.length,policies:new Set(inventory.flatMap(s=>s.policies.map(p=>JSON.stringify([p.value.source_type,p.value.source,p.value.id])))).size,
    policyReferences:inventory.reduce((n,s)=>n+s.policies.length,0),registered:results.length,
    applied:results.filter(r=>r.status==='APPLIED').length,planned:results.filter(r=>r.status==='PLANNED').length}};
}

/** Repository archive contains identity/digests, never another repository's policy text. */
export function actionsPolicyObservations(result,repository){
  const scope=result.inventory.find(s=>s.prefix==='/repos/'+repository.full_name);check(scope,'ARCHIVE_SCOPE');
  return {plugin:'native-actions-policy-observation',owner:'splrad',repo:repository.name,
    policies:scope.policies.map(({value})=>({id:value.id,source_type:value.source_type,sha256:digest(value)})),
    registered:result.results.filter(r=>scope.policies.some(p=>p.value.source_type==='Organization'&&p.value.source==='splrad'&&p.value.id===r.id))};
}
