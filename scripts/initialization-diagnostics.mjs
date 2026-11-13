// Only exact local assertion messages map to codes; arbitrary exception text never leaves the process.
const fixedFailures=new Map([
  ...['input identity','repository identity','merged adoption PR','default head','full source history required','source path','source file required','adopted configuration','LayerScape first-release configuration','reachable history','original cycle required','native unit version','tag component','native tag','native VERSION','native package version','native version adapter required','adoption source moved','original native evidence unknown','closed request','state visibility unknown','state source unknown','missing adopted state requires recovery','obligation identity','original obligation outside adopted history','unrecorded release obligations','default head moved','state moved','adoption readback'].map((value,index)=>['RELEASE_ADOPTION: '+value,'ADOPTION_'+String(index+1).padStart(2,'0')]),
  ...['writer protection target','writer protection pagination','protected writer rules','writer protection read unavailable','writer protection identity','writer update parameters unavailable','single App writer required','writer integrity bypass','writer fetch and merge exception'].map((value,index)=>['RELEASE_RECORD: '+value,'WRITER_PROTECTION_'+String(index+1).padStart(2,'0')]),
  ...['RELEASE_APP_IDENTITY','RELEASE_INSTALLATION_IDENTITY','RELEASE_APP_BOT_IDENTITY','RELEASE_INSTALLATION_TOKEN','RELEASE_REPOSITORY_ID','RELEASE_TOKEN_SCOPE','NATIVE_RULE_PARAMETERS_NODE','NATIVE_RULE_PARAMETERS_IDENTITY','NATIVE_RULE_PARAMETERS_COMPLETE','NATIVE_RULE_PARAMETERS_COUNT','NATIVE_RULE_PARAMETERS_VALUE'].map(value=>[value,value])
]);
/** Initializer-only, allowlisted observations. Tokens are correlation keys in memory only. */
export function initializationDiagnostics(emit=()=>{}) {
  let phase='source-validation',primaryFailure;
  const credentials=new Map(),events=[];
  const phases=new Set(['source-validation','app-identity','release-credential','candidate-read-credential','repository-read','state-read','source-fetch','adoption-reconcile','credential-cleanup','local-cleanup','complete']);
  const record=value=>{events.push(value);emit(value);};
  const status=value=>Number.isInteger(value)&&value>=100&&value<=599?value:null;
  const kind=error=>error?.name==='AbortError'?'ABORT':Number.isInteger(error?.status)?'HTTP':error?.code==='ENOENT'?'PROCESS_NOT_FOUND':Number.isInteger(error?.code)?'PROCESS_EXIT':error?.name==='SyntaxError'?'JSON_PARSE':'UNCLASSIFIED';
  const describe=error=>({phase,errorKind:kind(error),httpStatus:status(error?.status),failureCode:fixedFailures.get(error?.message)??null,processExitCode:Number.isInteger(error?.code)?error.code:null});
  const captureFailure=error=>{primaryFailure??=describe(error);};
  const credentialFor=init=>{
    const header=new Headers(init?.headers).get('authorization')??'';
    return credentials.get(header.replace(/^(?:token|bearer)\s+/i,''));
  };
  const transport=fetcher=>async(url,init)=>{
    const path=new URL(typeof url==='string'?url:url.url??url).pathname,method=init?.method??'GET';
    const nativeOperation=path==='/graphql'?'rule-parameters':path.includes('/rules')?'writer-protection':path.includes('/git/')?'git-object':'native';
    const mint=method==='POST'&&/^\/app\/installations\/\d+\/access_tokens$/.test(path);
    const scope=method==='GET'&&path==='/installation/repositories';
    const revoke=method==='DELETE'&&path==='/installation/token';
    const purpose=credentialFor(init);
    // Each actual finally request enters cleanup, including operation/scope failures.
    // The first failure was captured before unwinding and remains unchanged.
    if(revoke){phase='credential-cleanup';record({event:'stage',phase});}
    let response;
    try {response=await fetcher(url,init);}catch(error){record({event:'request-failed',phase,operation:mint?'issue':scope?'scope':revoke?'revoke':nativeOperation,credential:purpose??null,errorKind:kind(error)});throw error;}
    if(mint||scope||revoke) {
      const event={event:'credential',phase,operation:mint?'issue':scope?'scope':'revoke',credential:purpose??null,httpStatus:status(response.status),expiresAt:null,permissions:null,repositoryIds:null,totalCount:null};
      if(mint||scope) {
        // A diagnostic parse cannot consume or change the response seen by the official SDK.
        try {
          const body=await response.clone().json();
          if(mint&&response.ok&&typeof body.token==='string') {
            const label='credential-'+(credentials.size+1);credentials.set(body.token,label);event.credential=label;
            event.expiresAt=typeof body.expires_at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(body.expires_at)?body.expires_at:null;
            const allowed=['metadata','contents','actions','checks','administration','organization_administration','pull_requests','issues'];
            if(body.permissions&&typeof body.permissions==='object'&&!Array.isArray(body.permissions)) {
              const entries=allowed.filter(k=>['read','write'].includes(body.permissions[k])).map(k=>[k,body.permissions[k]]);
              if(entries.length||Object.keys(body.permissions).length===0)event.permissions=Object.fromEntries(entries);
            }
          }
          if(Array.isArray(body.repositories)&&body.repositories.length<=100&&body.repositories.every(r=>Number.isSafeInteger(r?.id)&&r.id>0))event.repositoryIds=body.repositories.map(r=>r.id);
          if(scope)event.totalCount=Number.isSafeInteger(body.total_count)?body.total_count:null;
        }catch {event.metadata='UNAVAILABLE';}
      }
      record(event);
    } else if(!response.ok)record({event:'request-failed',phase,operation:nativeOperation,httpStatus:status(response.status)});
    if(path==='/graphql'&&response.ok)try {
      const body=await response.clone().json();
      if(Array.isArray(body.errors)&&body.errors.length)record({event:'request-failed',phase,operation:'rule-parameters',httpStatus:status(response.status),graphqlErrorCount:body.errors.length});
    }catch {/* Preserve the SDK's response/parse failure; never print GraphQL content. */}
    return response;
  };
  return {transport,captureFailure,stage(value){phase=phases.has(value)?value:'unknown-stage';record({event:'stage',phase});},failure(error){
    return {...(primaryFailure??describe(error)),credentialEvents:events.filter(e=>e.event==='credential'||e.operation==='revoke'),requestFailures:events.filter(e=>e.event==='request-failed')};
  }};
}
