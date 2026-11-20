/** Fixed native wake authorization; payloads never select a repository, ref, or command. */
export function assertTemplateWake(env,event={}) {
  const check=ok=>{if(!ok)throw Error('TEMPLATE_EVENT_NOT_AUTHORIZED');};
  if(env.GITHUB_EVENT_NAME==='workflow_dispatch') {
    check(Object.keys(event.inputs ?? {}).every(key => key === 'bootstrap_only'));
    return;
  }
  if(env.GITHUB_EVENT_NAME==='repository_dispatch') {
    check(event.action==='steward-template-event'&&event.sender?.id===353238212
      &&event.sender?.login==='splrad-governance[bot]'&&event.sender?.type==='Bot'
      &&event.client_payload?.schemaVersion===1&&Object.keys(event.client_payload).join(',')==='schemaVersion');return;
  }
  check(false);
}
