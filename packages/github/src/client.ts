import {Octokit} from '@octokit/rest';
import {GITHUB_API_VERSION} from './api-version.js';
import {completeMergedPull} from './merged-pull.js';
/** Read-only adapters for current-head Copilot evidence and frozen release-source readers. */
export class GitHubClient {
  private readonly native:Octokit;
  constructor(private readonly token:string,private readonly apiBase='https://api.github.com',private readonly transport:typeof fetch=fetch){
    if(apiBase!=='https://api.github.com')throw Error('GitHub API请求来源无效');
    this.native=new Octokit({auth:token,log:{debug(){},info(){},warn(){},error(){}},request:{headers:{'x-github-api-version':GITHUB_API_VERSION},
      fetch:((input:any,init:any)=>this.transport(this.absoluteUrl(String(input)),{...init,redirect:'error'})) as typeof fetch}});
    this.native.hook.before('request',options=>{options.headers['x-github-api-version']=GITHUB_API_VERSION;});
  }
  private absoluteUrl(path:string):string{
    const value=new URL(path,this.apiBase);
    if(value.origin!==this.apiBase||value.username||value.password||value.hash)throw Error('GitHub API请求来源无效');return value.href;
  }
  async request<T>(method:string,path:string):Promise<T>{
    if(method!=='GET')throw Error('READ_ONLY_CLIENT');
    try{return (await this.native.request(`GET ${this.absoluteUrl(path)}`)).data as T;}
    catch{throw Error('GITHUB_EVIDENCE_READ_FAILED');}
  }
  async paginate<T>(path:string,select:(value:unknown)=>readonly T[]=v=>v as readonly T[],limits:{maxPages?:number;maxItems?:number}={}):Promise<readonly T[]>{
    const rows:T[]=[],seen=new Set<string>();let pages=0;
    try{for await(const response of this.native.paginate.iterator(`GET ${this.absoluteUrl(path)}`)){
      const url=this.absoluteUrl(response.url),values=Array.isArray(response.data)?response.data:select(response.data);
      if(seen.has(url)||!Array.isArray(values)||++pages>(limits.maxPages??10000))throw Error('GITHUB_PAGINATION_INCOMPLETE');
      seen.add(url);rows.push(...values as T[]);if(rows.length>(limits.maxItems??100000))throw Error('GITHUB_PAGINATION_INCOMPLETE');
    }}catch(error){
      const message=error instanceof Error?error.message:'';
      if(/^RN_SOURCE_INCOMPLETE: release API budget: (?:read-only transport|deadline|request count or remaining quota|HTTP (?:403|429)|deadline or cancellation)$/.test(message))throw Error(message);
      throw Error('GITHUB_EVIDENCE_PAGINATION_FAILED');
    }
    return rows;
  }
  async getWorkflowJobLog(owner: string, repo: string, jobId: number): Promise<string> {
    const path = `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;
    let response = await this.transport.call(globalThis, this.absoluteUrl(path), {
      headers: {authorization:`Bearer ${this.token}`,accept:'application/vnd.github+json','x-github-api-version':GITHUB_API_VERSION}, redirect: "manual",
    });
    if (response.status === 302) {
      const location = new URL(response.headers.get("location") ?? "");
      if (location.protocol !== "https:" || location.username || location.password || location.port || location.hash
        || ![".blob.core.windows.net", ".actions.githubusercontent.com"].some(suffix => location.hostname.endsWith(suffix))) throw new Error("运行日志下载地址无效");
      response = await this.transport.call(globalThis, location.href, { redirect: "error" });
    }
    if (!response.ok || !response.body) throw new Error("运行日志读取失败");
    const limit = 8 * 1024 * 1024;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (Number(response.headers.get("content-length")) > limit) throw new Error("运行日志超过读取上限");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error("运行日志超过读取上限");
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }


  getRepositoryById(id:number){return this.request<any>('GET',`/repositories/${id}`);}
  async getPullRequest(owner:string,repo:string,number:number){
    return completeMergedPull(`${owner}/${repo}`,number,await this.request<any>('GET',`/repos/${owner}/${repo}/pulls/${number}`),()=>this.listIssueEvents(owner,repo,number));
  }
  getRequestedReviewers(owner:string,repo:string,number:number){return this.request<any>('GET',`/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`);}
  listPullRequestReviews(owner:string,repo:string,number:number){return this.paginate<any>(`/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`);}
  listIssueEvents(owner:string,repo:string,number:number){return this.paginate<any>(`/repos/${owner}/${repo}/issues/${number}/events?per_page=100`);}
  listAllCheckRuns(owner:string,repo:string,ref:string,filter:'latest'|'all'='all'){return this.paginate<any>(`/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100&filter=${filter}`,v=>(v as any).check_runs);}
  listWorkflowAttemptJobs(owner:string,repo:string,runId:number,attempt:number){return this.paginate<any>(`/repos/${owner}/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,v=>(v as any).jobs);}
  getCheckRun(owner:string,repo:string,id:number){return this.request<any>('GET',`/repos/${owner}/${repo}/check-runs/${id}`);}
  async listDynamicWorkflowRuns(owner:string,repo:string,createdSince:string){
    if(!Number.isFinite(Date.parse(createdSince)))throw Error('动态运行查询边界无效');
    const path=`/repos/${owner}/${repo}/actions/runs?event=dynamic&created=${encodeURIComponent(`>=${createdSince}`)}&per_page=100`;
    const total=(await this.request<any>('GET',path)).total_count;
    if(!Number.isSafeInteger(total)||total<0||total>=1000)throw Error('动态运行查询范围不完整');
    const rows=await this.paginate<any>(path,v=>(v as any).workflow_runs,{maxPages:10,maxItems:999});
    if(rows.length!==total)throw Error('动态运行查询范围不完整');return rows;
  }
  compare(owner: string, repo: string, base: string, head: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`); }
  getCommit(owner: string, repo: string, ref: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`); }
  listPullFiles(owner: string, repo: string, number: number) { return this.paginate<any>(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`); }
  listPullCommits(owner: string, repo: string, number: number) { return this.paginate<any>(`/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`); }
  listLabels(owner: string, repo: string, number: number) { return this.paginate<any>(`/repos/${owner}/${repo}/issues/${number}/labels?per_page=100`); }
  listReleases(owner: string, repo: string) { return this.paginate<any>(`/repos/${owner}/${repo}/releases?per_page=100`); }
  async listPullsForCommit(owner: string, repo: string, sha: string) {
    const pulls=await this.paginate<any>(`/repos/${owner}/${repo}/commits/${sha}/pulls?per_page=100`), completed=[];
    for(const pull of pulls)completed.push(await completeMergedPull(`${owner}/${repo}`,pull.number,pull,()=>this.listIssueEvents(owner,repo,pull.number)));
    return completed;
  }
}
