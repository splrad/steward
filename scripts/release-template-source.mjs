import {createHash} from 'node:crypto';
import {NativeEvidenceReader,nativeEvidenceTransport,sharedReleaseTemplatePath} from '../packages/runner/dist/index.js';

const validPin = ref => typeof ref === 'string' && /^[a-f0-9]{40}$/.test(ref);

export {releaseTemplateControllerPin} from '../packages/runner/dist/index.js';

export async function readControllerReleaseTemplate(pin, fetcher = fetch) {
  if (!validPin(pin)) throw new Error('CANDIDATE_CONTROLLER_PIN_REQUIRED');
  const reader = new NativeEvidenceReader(nativeEvidenceTransport(undefined, fetcher), 'splrad/steward');
  const file = await reader.json(`contents/${sharedReleaseTemplatePath}?ref=${pin}`);
  if (file.type !== 'file' || file.path !== sharedReleaseTemplatePath || file.encoding !== 'base64' || typeof file.content !== 'string')
    throw new Error('CANDIDATE_RELEASE_TEMPLATE');
  const bytes = Buffer.from(file.content, 'base64');
  const digest = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== file.size || digest !== file.sha) throw new Error('CANDIDATE_RELEASE_TEMPLATE');
  return new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(bytes);
}
