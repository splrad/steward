export const defaultBuildWorkflow = '.github/workflows/steward-release-publish.yml';
export const channelWorkflow = '.github/workflows/steward-release-channels.yml';
export const githubDeliveryStep = 'upload-github-release';
export const githubDeliveryJobStep = 'Upload GitHub release delivery';
export const workflowPathPattern = '^\\.github/workflows/[^/\\\\:\\u0000-\\u001f\\u007f-\\u009f*!?{}()[\\]<>|"]{1,192}\\.ya?ml$(?![\\s\\S])';
const workflowPath = new RegExp(workflowPathPattern);

export function isBuildWorkflow(path: unknown): path is string {
  return typeof path === 'string' && !/\p{Surrogate}/u.test(path) && path !== channelWorkflow && workflowPath.test(path);
}

export function encodeRepositoryPath(path:string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function dispatchWorkflow(request: {purpose: string; buildWorkflow?: string}): string {
  return request.purpose === 'build' ? request.buildWorkflow ?? defaultBuildWorkflow : channelWorkflow;
}
import {createHash} from 'node:crypto';

export function releasePleaseUnitId(path:string,component:unknown):string {
  const input=component??(path==='.'?'root':path.split('/').at(-1));
  const name=typeof input==='string'?input.toLowerCase():'';
  return /^[a-z][a-z0-9-]{0,63}$/.test(name)?name:'unit-'+createHash('sha256').update(path).digest('hex').slice(0,32);
}
