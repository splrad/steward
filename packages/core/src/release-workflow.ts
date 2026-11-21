export const defaultBuildWorkflow = '.github/workflows/steward-release-publish.yml';
export const channelWorkflow = '.github/workflows/steward-release-channels.yml';
export const workflowPathPattern = '^\\.github/workflows/[A-Za-z0-9][A-Za-z0-9_.-]{0,191}\\.ya?ml$(?![\\s\\S])';
const workflowPath = new RegExp(workflowPathPattern);

export function isBuildWorkflow(path: unknown): path is string {
  return typeof path === 'string' && path !== channelWorkflow && workflowPath.test(path);
}

export function dispatchWorkflow(request: {purpose: string; buildWorkflow?: string}): string {
  return request.purpose === 'build' ? request.buildWorkflow ?? defaultBuildWorkflow : channelWorkflow;
}
