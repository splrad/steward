// This object crosses the SDK process boundary and can appear in Actions logs.
// SDK error messages, provider-specific fields and request identifiers stay out.
const stages = new Set(['start', 'auth', 'models', 'session', 'send', 'response', 'usage', 'cleanup', 'process']);
const types = new Set(['authentication', 'authorization', 'policy', 'quota', 'rate_limit', 'context_limit', 'query']);

/** @param {{sdkStage?:unknown,sdkErrorType?:unknown,status?:unknown}} fields */
export function copilotDiagnosticFields(fields) {
  const { sdkStage, sdkErrorType, status } = fields;
  return {
    ...(typeof sdkStage === 'string' && stages.has(sdkStage) ? { sdkStage } : {}),
    ...(typeof sdkErrorType === 'string' && types.has(sdkErrorType) ? { sdkErrorType } : {}),
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}),
  };
}
