#!/usr/bin/env node
export { parseDeliveryConfig, deliveryAssetNames, assertDeliveryPath } from '../../core/src/delivery-config.js';
export { assertProductDelivery } from './release-pipeline.js';
export { parsePipelineRecord, pipelineSource } from './release-pipeline-record.js';
export { pipelineIdentity, pipelineNotes, pipelineInspect, pipelineRecoverCycleFinal, mergedBuildCycle, findFrozenFinal, pipelineDownloadPhase, pipelineFrozenManifest, pipelinePublish, pipelineVerifyPublished, pipelinePreparePublication, readCycleDelivery, prepareNormalizedDelivery } from './release-pipeline.js';
export { inspectProductArtifacts, sealProductArtifacts, validateProductManifest } from './release-artifacts.js';
export { renderFrozenReleaseNotes } from '../../core/src/release-template.js';
export { decodeCompletionArchive } from '../../core/src/release-history.js';
export { advanceReleaseCandidate } from './release-candidate.js';
export { candidateId } from '../../core/src/release-candidate.js';
export { generateCandidate, pushPreparedCandidate } from './release-candidate-update.js';
export { collectContentInput, planContentBatches, resumeContentBatches, assembleUnitNotes } from './release-content.js';
export { copilotReleaseClient } from './copilot-release-client.js';
export { copilotQualityClient } from './copilot-quality-client.js';
export { collectQualitySources, qualityPages, translateQualitySources, publishQualityCheck, serviceQualityPullRequest } from './quality-language-summary.js';
export { decodeQualityCache, reconcileQualitySources, renderQualitySummary } from '../../core/src/quality-language-summary.js';
export { decodeCandidateArchive, decodeCandidateDocument } from '../../core/src/release-candidate-record.js';
export { splitContentText, releaseAffectedUnitIds } from '../../core/src/release-content.js';
export { inspectCycleHistory, completionFile } from './release-history.js';
export { inspectPublications, invokePublication } from './release-publication.js';
export { decodeReleaseRecord, decodeStateFile, stateRecordOwner, assertRepositoryWrite } from '../../core/src/release-observation.js';
export { inspectNativeCycle, recoverNativeCycle, archiveFile, nativeReadFile, nativeEvidenceTransport } from './native-release-evidence.js';
export { isolatedBuildEnvironment } from './build-environment.js';
export { decodeBuildJson } from '../../core/src/build-manifest.js';
export { inspectReleaseArtifacts, sealReleaseArtifacts, verifySealedArtifacts } from './release-artifacts.js';
export { parseReleaseDescriptor } from '../../core/src/release-descriptor.js';
export { parseSupplementalNotes, renderCommittedReleaseNotes } from '../../core/src/release-template.js';
export { nativeReleaseInspector, nativePythonSourceVersion } from './release-native.js';
export { generateReleaseSbom } from './release-sbom.js';
export { parseLegacyRepositoryCatalog } from '../../core/src/legacy-repository-policy.js';
export { selectReleaseProducers, assertReleaseJobResults } from './release-run.js';
export { dispatchNativeRun, prepareBuildDispatch, dispatchObservationFile, verifyExecutionSource, verifyDispatchWorkflow } from './release-run.js';
export { retainedChannelObservations, observeNativeChannels, readChannelSourceRejections, selectChannelDispatch, prepareChannelDispatch, channelTargetsDigest, verifyChannelProbe, verifyChannelResult, channelEvidenceFile, verifyContinuationReleases } from './release-run.js';
export { nativeRunFact, jobFact, NativeEvidenceReader } from './native-release-evidence.js';
export { nativeJobOrigins, originalJobExecutions } from '../../core/src/native-job-origins.js';
export { evaluateCompletion } from '../../core/src/release-observation.js';
export { NativeGitHubRelease, nativeGhCommand, nativeReleaseDownload } from './gh-release.js';
export { nativeReleaseApp } from '../../github/src/app-auth.js';
export { completeMergedPull } from '../../github/src/merged-pull.js';
export {maintenanceWorkflows,maintenanceJobKeys,maintenanceDisposition,maintenanceFailed,decodeMaintenanceRecord,assertMaintenanceProgress} from '../../core/src/maintenance.js';
export {validatePagesSource,pagesRecordPath,decodePagesMaintenance,assertPagesProgress} from '../../core/src/pages-maintenance.js';
export { bootstrapRepository, bootstrapRulePolicyDigest, decodeBootstrapRecovery } from './repository-bootstrap.js';
export {assertRepositoryInstructions} from './repository-instructions.js';
export {discoverWorkflowFiles,scanWorkflows,resolvePolicyTool} from './workflow-tools.js';
export {renderLinkcheckFirewall,linkcheckEnvironment} from './linkcheck.js';
export {readCopilotReviewState} from './observe-copilot-review.js';
import {observeCopilotReviewCommand} from './observe-copilot-review.js';
import {nativeCommands,nativeReleaseCli} from './native-release-cli.js';
import {freezeReleaseGitInput,type GitReleaseBoundary} from './release-git-input.js';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const runtimeReadFile=((...args:Parameters<typeof readFile>)=>Reflect.apply(readFile,undefined,args)) as typeof readFile;
const commands=new Set(['release-freeze','observe-copilot-review']);
const allowedArguments:Record<string,Set<string>>={
  'release-freeze':new Set(['workspace','repository-id','default-branch','target-sha','controller-sha','unit','unit-path','version','target-tag','boundary-sha','boundary-tag','boundary-version','baseline-reference','full-tree','output']),
  'observe-copilot-review':new Set(['repository-id','pull-request-number','event-head-sha']),
};
export interface ParsedInvocation { command: string; args: Readonly<Record<string, string>> }

export function parseInvocation(argv: readonly string[]): ParsedInvocation {
  const command = argv[0];
  if (!command || !commands.has(command)) throw new Error(`未知命令: ${command ?? "<空>"}`);
  const args: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`参数格式无效: ${flag ?? "<空>"}`);
    const name = flag.slice(2);
    if (!allowedArguments[command]!.has(name)) throw new Error(`未知参数: --${name}`);
    if (Object.hasOwn(args, name)) throw new Error(`重复参数: --${name}`);
    args[name] = value;
  }
  return { command, args: Object.freeze(args) };
}

function required(args: Readonly<Record<string, string>>, name: string): string {
  const value = args[name]; if (!value) throw new Error(`缺少参数: --${name}`); return value;
}
export function env(name: string): string { const value = process.env[name]; if (!value) throw new Error(`缺少环境变量: ${name}`); return value; }
function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name}必须是十进制整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name}必须是安全整数`);
  return parsed;
}
function sha(value: string, name: string): string { if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${name}必须是40位提交编号`); return value.toLowerCase(); }
async function summary(lines: readonly string[]): Promise<void> {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) await writeFile(target, `${lines.join("\n")}\n`, { flag: "a" }); else process.stdout.write(`${lines.join("\n")}\n`);
}

async function releaseFreezeCommand(args: Readonly<Record<string, string>>): Promise<void> {
  let boundary: GitReleaseBoundary;
  if (args["full-tree"] !== undefined) {
    if (args["full-tree"] !== "true" || args["boundary-sha"] || args["boundary-tag"] || args["boundary-version"] || args["baseline-reference"]) throw new Error("首次发布完整树与区间边界不能混用");
    boundary = { kind: "full-tree" };
  } else {
    if (Boolean(args["boundary-tag"]) === Boolean(args["baseline-reference"])) throw new Error("必须选择一个已核验标签或明确基线");
    if (!args["boundary-tag"] && args["boundary-version"]) throw new Error("基线边界不能附带标签版本");
    boundary = args["boundary-tag"]
      ? { kind: "tag", sha: sha(required(args, "boundary-sha"), "boundary-sha"), reference: args["boundary-tag"], version: required(args, "boundary-version") }
      : { kind: "baseline", sha: sha(required(args, "boundary-sha"), "boundary-sha"), reference: args["baseline-reference"]! };
  }
  const source = await freezeReleaseGitInput({ workspace: required(args, "workspace"),
    identity: { repositoryId: integer(required(args, "repository-id"), "repository-id"), defaultBranch: required(args, "default-branch"),
      targetSha: sha(required(args, "target-sha"), "target-sha"), controllerSha: sha(required(args, "controller-sha"), "controller-sha") },
    unit: { id: required(args, "unit"), path: required(args, "unit-path"), version: required(args, "version"), tag: required(args, "target-tag") }, boundary });
  const outputPath = resolve(required(args, "output"));
  try { await writeFile(outputPath, source.bytes, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await runtimeReadFile(outputPath, "utf8") !== source.bytes) throw new Error("输出已存在且内容不同，请指定新文件");
  }
  await summary([`Git 来源：${outputPath}`, `来源摘要：${source.inputSha256}`, `完整提交：${source.input.coverage.commits}`,
    `净差异文件：${source.input.coverage.changedFiles}`, `读取缺口：${source.input.gaps.length}`]);
}

export async function main(argv=process.argv.slice(2)):Promise<void>{
  if(nativeCommands.has(argv[0]!))return nativeReleaseCli(argv);
  const invocation=parseInvocation(argv);
  if(invocation.command==='release-freeze')return releaseFreezeCommand(invocation.args);
  return observeCopilotReviewCommand(invocation.args);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{process.stderr.write('STEWARD_COMMAND_FAILED\n');process.exitCode=1;});
