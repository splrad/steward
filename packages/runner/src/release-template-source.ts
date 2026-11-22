import {parseDocument} from 'yaml';
import {parseDeliveryConfig} from '../../core/src/delivery-config.js';
import {productReleaseTemplatePath} from '../../core/src/release-template.js';

const validPin = (ref: unknown): ref is string => typeof ref === 'string' && /^[a-f0-9]{40}$/.test(ref);

export function releaseTemplateControllerPin(source: string | null | undefined, requirePinnedCheckout = false): string {
  if (typeof source !== 'string') throw new Error('CANDIDATE_CONTROLLER_PIN_REQUIRED');
  const workflow = parseDocument(source, {uniqueKeys:true});
  if (workflow.errors.length) throw new Error('CANDIDATE_CONTROLLER_PIN_INVALID');
  const parsed = workflow.toJS({maxAliasCount:0}) as {jobs?: Record<string, {
    uses?: unknown;
    steps?: { uses?: string; with?: {repository?: unknown; path?: unknown; ref?: unknown} }[];
  } | null>} | null;
  const jobs = Object.values(parsed?.jobs ?? {});
  const steps = jobs.flatMap(job => Array.isArray(job?.steps) ? job.steps : []);
  const checkouts = steps.filter(step => requirePinnedCheckout
    ? step?.with?.repository === 'splrad/steward' || step?.with?.path === 'controller'
    : step?.with?.repository === 'splrad/steward' && step?.with?.path === 'controller');
  if (requirePinnedCheckout && (!checkouts.some(step => step?.with?.path === 'controller')
    || checkouts.some(step => step?.with?.repository !== 'splrad/steward'
      || !/^actions\/checkout@[a-f0-9]{40}$/.test(step.uses ?? ''))))
    throw new Error('CANDIDATE_CONTROLLER_PIN_INVALID');
  const refs = checkouts.map(step => step.with?.ref);
  if (!refs.length || !validPin(refs[0]) || refs.some(ref => ref !== refs[0]))
    throw new Error('CANDIDATE_CONTROLLER_PIN_REQUIRED');
  if (requirePinnedCheckout && jobs.some(job => typeof job?.uses === 'string'
    && job.uses.startsWith('splrad/steward/.github/workflows/product-release.yml@')
    && job.uses !== 'splrad/steward/.github/workflows/product-release.yml@' + refs[0]))
    throw new Error('CANDIDATE_CONTROLLER_PIN_INVALID');
  return refs[0];
}

export type HistoricalTemplate = { bytes: Buffer; controllerSha?: string };

/** Reapply the template source rules at the protected generated base. */
export async function readLegacyReleaseTemplate(
  sourceSha: string,
  readProduct: (sha: string, path: string) => Promise<Buffer | null>,
  readController: (sha: string) => Promise<Buffer>,
): Promise<HistoricalTemplate | null> {
  const product = await readProduct(sourceSha, productReleaseTemplatePath);
  if (product !== null) return { bytes: product };
  const config = await readProduct(sourceSha, '.github/delivery.json');
  if (!config) return null;
  const raw = JSON.parse(config.toString('utf8'));
  if (![1, 2].includes(raw?.schemaVersion)) return null;
  const {buildWorkflow} = parseDeliveryConfig(raw);
  if (!buildWorkflow) return null;
  const workflow = await readProduct(sourceSha, buildWorkflow);
  const controllerSha = releaseTemplateControllerPin(workflow?.toString('utf8'), true);
  return { bytes: await readController(controllerSha), controllerSha };
}
