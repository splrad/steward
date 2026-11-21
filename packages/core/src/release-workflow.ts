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
