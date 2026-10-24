import { verifyWorkflowPolicy, scanWorkflows } from "../packages/runner/dist/index.js";
import { readFile, readdir } from "node:fs/promises";
import YAML from "yaml";

try {
function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort());
}

// Ordinary workflows evolve in the same PR; required entrypoints are checked separately.
const files = (await readdir(".github/workflows")).filter(file => /\.ya?ml$/u.test(file)).sort();
await verifyWorkflowPolicy(process.cwd(),1296724484,[".github/workflows/pr-validation.yml"]);
const workflowDocuments = new Map();
for (const file of files) {
  const text = await readFile(`.github/workflows/${file}`, "utf8"); workflowDocuments.set(file, YAML.parse(text));
}
const validationDocument = workflowDocuments.get("pr-validation.yml");
if (validationDocument?.concurrency?.group !== "steward-pr-validation-${{ github.repository_id }}-${{ github.event.pull_request.number }}" || validationDocument?.concurrency?.["cancel-in-progress"] !== true) throw new Error("PR验证必须按仓库和PR取消旧运行");
if (JSON.stringify(validationDocument?.on?.pull_request?.types) !== JSON.stringify(["opened", "synchronize", "reopened", "edited", "labeled", "unlabeled"])) throw new Error("PR验证必须响应编辑和标签变更");
const validationStep = validationDocument?.jobs?.validate?.steps?.find(step => step?.name === 'validation-policy:${{ steps.policy.outputs.sha }}');
if (validationStep?.env?.VALIDATION_BASE_SHA !== '${{ github.event.pull_request.base.sha }}' || validationStep?.env?.VALIDATION_BASE_REF !== '${{ github.event.pull_request.base.ref }}') throw new Error('验证必须绑定实际base');
if (JSON.stringify(validationDocument).includes('secrets.')) throw new Error('验证不得使用secret');
if (validationDocument?.jobs?.fragments) throw new Error("退役片段作业不得恢复");
const expectedJobEnvironments = new Map([
  ['deploy-runtime.yml:deploy', {name:'steward-deployment',deployment:true}],
  ['native-review.yml:observe', {name:'steward-automation',deployment:false}],
  ['pr-classification.yml:classify', {name:'steward-automation',deployment:false}],
  ['release.yml:plan', {name:'steward-release',deployment:false}],
  ['sync-managed.yml:synchronize', {name:'steward-automation',deployment:false}],
  ['update-dependencies.yml:update', {name:'steward-automation',deployment:false}],
]);
for (const [file, document] of workflowDocuments) {
  for (const [jobName, job] of Object.entries(document?.jobs ?? {})) {
    const key = `${file}:${jobName}`; const expectedEnvironment = expectedJobEnvironments.get(key);
    if (job.environment === undefined) {
      if (expectedEnvironment) throw new Error(`${key}缺少固定环境`);
      continue;
    }
    if (!expectedEnvironment || job.environment?.name !== expectedEnvironment.name || job.environment?.deployment !== expectedEnvironment.deployment) throw new Error(`${key}的环境或部署记录策略不正确`);
    expectedJobEnvironments.delete(key);
  }
}
if (expectedJobEnvironments.size > 0) throw new Error(`缺少固定环境作业: ${[...expectedJobEnvironments.keys()].join(", ")}`);
const reviewDocument = workflowDocuments.get("native-review.yml");
if (!hasExactKeys(reviewDocument.jobs, ['observe']) || !hasExactKeys(reviewDocument.on.workflow_dispatch.inputs, ['repositoryId','eventAfterSha','pullRequestNumber'])) throw new Error('原生审查只保留观察入口');
const deployRuntime = await readFile(".github/workflows/deploy-runtime.yml", "utf8");
for (const required of ["github.event.repository.default_branch", "id: deploy", "tee \"$deployment_log\"", "PIPESTATUS[0]", "复核运行程序健康状态", "steps.deploy.outputs.runtime_url", "EXPECTED_POLICY_SHA", "Date.now() + 60_000", "AbortSignal.timeout", "await response.body?.cancel()", "status: \"waiting\"", "iu.test(body.version)", "健康复核在60秒内未收敛"]) {
  if (!deployRuntime.includes(required)) throw new Error(`部署工作流缺少固定健康复核合同: ${required}`);
}
const deployRuntimeDocument = YAML.parse(deployRuntime);
if (deployRuntimeDocument?.jobs?.deploy?.if !== "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)") throw new Error('部署必须绑定实际默认分支，手工触发不得绕过');
if (JSON.stringify(Object.keys(deployRuntimeDocument.on)) !== '["workflow_dispatch"]') throw new Error('部署必须显式手工触发');
const deploySteps = deployRuntimeDocument?.jobs?.deploy?.steps ?? [];
const migrationStepIndex = deploySteps.findIndex(step => step?.name === "列出并应用D1迁移");
const deployStepIndex = deploySteps.findIndex(step => step?.id === "deploy");
if (migrationStepIndex < 0 || deployStepIndex < 0 || migrationStepIndex >= deployStepIndex) throw new Error("D1迁移没有在运行程序部署前执行");
const migrationStep = deploySteps[migrationStepIndex];
if (String(migrationStep?.env?.CLOUDFLARE_API_TOKEN ?? "").replace(/\s+/gu, "") !== "${{secrets.CLOUDFLARE_API_TOKEN}}") throw new Error("D1迁移没有使用固定Cloudflare密钥");
const expectedMigrationCommand = `set -euo pipefail
npx wrangler d1 migrations list splrad-steward-issue-snapshots --remote --config packages/runtime/wrangler.toml
npx wrangler d1 migrations apply splrad-steward-issue-snapshots --remote --config packages/runtime/wrangler.toml
`;
if (migrationStep?.shell !== "bash" || migrationStep?.run !== expectedMigrationCommand) throw new Error("D1迁移没有固定为先列出、后应用的远程命令");
const healthStepIndex = deploySteps.findIndex(step => step?.name === "复核运行程序健康状态");
if (healthStepIndex < 0) throw new Error("部署缺少健康复核");
if (deploySteps.some(step => String(step.run ?? "").includes("reconcile-repository-lifecycle"))) throw new Error("部署仍触发议题快照同步");
const runtimeConfiguration = await readFile("packages/runtime/wrangler.toml", "utf8");
if (!/\[version_metadata\]\s*binding\s*=\s*"CF_VERSION_METADATA"/u.test(runtimeConfiguration)) throw new Error("运行程序未绑定Cloudflare版本元数据");
await scanWorkflows(process.cwd(), files.map(file => `.github/workflows/${file}`));

const retired = ['release-build-complete.yml','release-build.yml','product-build.yml','sync-review-instructions.yml','sync-managed-labels.yml','onboard-repository.yml','pr-automation.yml','issue-sync.yml','pr-issue-link.yml'];
for (const name of retired) if (workflowDocuments.has(name)) throw new Error(`Retired workflow still present: ${name}`);
for (const [name,d] of workflowDocuments) {
  if (Object.hasOwn(d.on ?? {}, 'workflow_run')) throw new Error(`Retired callback trigger: ${name}`);
  for (const job of Object.values(d.jobs)) for (const step of job.steps ?? []) {
    if (/release-candidate|release-produce|release-build|sync-review-instructions|sync-managed-labels|onboard-repository/.test(step.run ?? '')) throw new Error(`Retired command: ${name}`);
    if (step.uses?.startsWith('jdx/mise-action@') && (step.env?.MISE_SAFE !== '1' || step.env?.MISE_NODE_COMPILE !== 'false' || step.with?.install_args !== '--locked' || step.with?.cache !== false || step.with?.env !== false || step.with?.persist_github_token !== false)) throw new Error(`Unsafe mise consumer: ${name}`);
  }
}
const classification = workflowDocuments.get('pr-classification.yml');
if (Object.hasOwn(classification.on.workflow_dispatch.inputs, 'aiClassification') || JSON.stringify(classification).includes('AI_CLASSIFICATION')) throw new Error('Retired classification model input');
const sync = workflowDocuments.get('sync-managed.yml');
if (JSON.stringify(sync.on.schedule) !== '[{"cron":"47 2 * * 1"}]' || JSON.stringify(sync.on.push.branches) !== '["main"]' || JSON.stringify(sync.on.workflow_dispatch.inputs.mode.options) !== '["sync","onboard"]') throw new Error('Managed synchronization trigger contract');
const labelSteps = sync.jobs.synchronize.steps.filter(step => step.run?.includes('managed-sync labels'));
if (labelSteps.length !== 2 || !labelSteps[0].run.includes('--mode preview') || !labelSteps[1].run.includes('--mode apply')) throw new Error('Label preview/apply integration');
const templates = (await readdir('templates/release')).filter(file => /\.ya?ml$/.test(file)).map(file => 'templates/release/' + file);
await scanWorkflows(process.cwd(), templates);
const product = workflowDocuments.get('product-release.yml');
const publishCaller = YAML.parse(await readFile('templates/release/steward-release-publish.yml', 'utf8'));
if ([product.permissions, product.jobs.identity.permissions, publishCaller.permissions].some(permissions => permissions?.['pull-requests'] !== 'read')) throw new Error('Release identity requires pull-requests read throughout caller and job');
console.log('workflows verified');
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
