const botId=301115370;
const marker='<!-- steward-configuration-session-v1 ';
export async function readBotComment(api,comment) {
  if(comment.user?.id!==botId || comment.user?.type!=='Bot') return null;
  const {node}=await api.graphql('query($id:ID!){node(id:$id){... on IssueComment{body lastEditedAt editor{login} author{login}}}}',{id:comment.node_id});
  if(!node || node.author?.login!=='splrad-steward' && node.author?.login!=='splrad-steward[bot]') return null;
  if(node.lastEditedAt && node.editor?.login!==node.author.login) return null;
  return node.body;
}

export async function readSession(api,number) {
  if(!number)return {values:{},evidence:{}};
  const comments=await api.paginate(api.rest.issues.listComments,{...api.target,issue_number:number,per_page:100});
  const candidates=comments.filter(c=>c.user?.id===botId && c.body?.startsWith(marker));
  if(candidates.length>1) throw Error('Ambiguous configuration session');
  if(!candidates.length)return {values:{},evidence:{}};
  const body=await readBotComment(api,candidates[0]);
  if(!body || !body.endsWith(' -->')) throw Error('Configuration session was edited outside the App');
  return {...JSON.parse(Buffer.from(body.slice(marker.length,-4),'base64url')),comment:candidates[0].id};
}

export async function writeSession(api,number,state) {
  const {comment,...data}=state;
  const body=marker+Buffer.from(JSON.stringify(data)).toString('base64url')+' -->';
  if(body.length>65536) throw Error('Configuration session exceeds the GitHub comment limit');
  if(comment) await api.rest.issues.updateComment({...api.target,comment_id:comment,body});
  else state.comment=(await api.rest.issues.createComment({...api.target,issue_number:number,body})).data.id;
}
