export class GitHubRetryError extends Error {
 constructor(readonly httpStatus:number,retry:string,readonly dispatchAttempted:boolean){super('RETRY_AFTER:'+retry);}
}
/** Provider retry lower bound; invalid headers fail closed beyond the original window. */
export function retryAfterTime(error:unknown,now:number,deadline:number):number|undefined {
 const message=error instanceof Error?error.message:'';if(!message.startsWith('RETRY_AFTER:'))return undefined;
 const raw=message.slice(12),at=/^[0-9]+(?:\.[0-9]+)?$/.test(raw)?now+Number(raw)*1000:Date.parse(raw);
 return Number.isFinite(at)?Math.max(now,at):deadline+1;
}
