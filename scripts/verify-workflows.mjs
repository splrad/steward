import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort());
}

const expected = ["deploy-runtime.yml", "native-review.yml", "onboard-repository.yml", "pr-classification.yml", "pr-validation.yml", "product-build.yml", "release-build-complete.yml", "release-build.yml", "release.yml", "sync-managed-labels.yml", "sync-review-instructions.yml"];
const files = (await readdir(".github/workflows")).sort();
if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error(`工作流集合不正确: ${files.join(", ")}`);
const registry = JSON.parse(await readFile("config/repositories.json", "utf8"));
const registered = [...registry.repositories["1296724484"].allowedWorkflowPaths].sort();
if (JSON.stringify(registered) !== JSON.stringify(files.map(file => ".github/workflows/" + file))) throw new Error("Steward 工作流允许清单与实际文件不一致");
const workflowDocuments = new Map();
const allowedActions = new Set([
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  "actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68", "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
]);
const forbidden = [/issue.*comment/iu, /DCO/iu, /validation-matrix/iu, /durable.?object/iu, /relay/iu, /secrets:\s*inherit/iu];
for (const file of files) {
  const text = await readFile(`.github/workflows/${file}`, "utf8"); workflowDocuments.set(file, YAML.parse(text));
  for (const match of text.matchAll(/uses:\s*([^\s}]+)/gu)) if (!allowedActions.has(match[1])) throw new Error(`${file}使用未锁定操作: ${match[1]}`);
  for (const pattern of forbidden) if (pattern.test(text)) throw new Error(`${file}包含终态禁止内容: ${pattern}`);
}
const validationDocument = workflowDocuments.get("pr-validation.yml");
if (validationDocument?.concurrency?.group !== "steward-pr-validation-${{ github.repository_id }}-${{ github.event.pull_request.number }}" || validationDocument?.concurrency?.["cancel-in-progress"] !== true) throw new Error("PR验证必须按仓库和PR取消旧运行");
if (JSON.stringify(validationDocument?.on?.pull_request?.types) !== JSON.stringify(["opened", "synchronize", "reopened", "edited", "labeled", "unlabeled"])) throw new Error("PR验证必须响应编辑和标签变更");
const validationStep = validationDocument?.jobs?.validate?.steps?.find(step => step?.name === "执行中央验证");
if (String(validationStep?.env?.VALIDATION_BASE_SHA ?? "").replace(/\s+/gu, "") !== "${{github.event.pull_request.base.sha}}") throw new Error("中央验证没有通过环境变量接收基础分支提交");
if (String(validationStep?.env?.VALIDATION_BASE_REF ?? "").replace(/\s+/gu, "") !== "${{github.event.pull_request.base.ref}}") throw new Error("中央验证没有通过环境变量接收基础分支引用");
if (validationDocument?.jobs?.fragments) throw new Error("退役片段作业不得恢复");
const expectedJobEnvironments = new Map([
  ["deploy-runtime.yml:deploy", { name: "steward-deployment", deployment: true }],
  ["native-review.yml:observe", { name: "steward-automation", deployment: false }],
  ["onboard-repository.yml:onboard", { name: "steward-automation", deployment: false }],
  ["native-review.yml:request", { name: "steward-automation", deployment: false }],
  ["pr-classification.yml:classify", { name: "steward-automation", deployment: false }],
  ["release.yml:revision", { name: "steward-release", deployment: false }],
  ["release.yml:prepare", { name: "steward-release", deployment: false }],
  ["release.yml:inspect", { name: "steward-release", deployment: false }],
  ["release.yml:publish", { name: "steward-release", deployment: false }],
  ["release.yml:generation-ticket", { name: "steward-release", deployment: false }],
  ["release.yml:generate", { name: "steward-release-notes", deployment: false }],
  ["release.yml:generated-candidate", { name: "steward-release", deployment: false }],
  ["product-build.yml:plan", { name: "steward-release", deployment: false }],
  ["release-build.yml:plan", { name: "steward-release", deployment: false }],
  ["release-build-complete.yml:accept", { name: "steward-release", deployment: false }],
  ["sync-review-instructions.yml:synchronize", { name: "steward-automation", deployment: false }],
  ["sync-review-instructions.yml:resolve", { name: "steward-automation", deployment: false }],
  ["sync-managed-labels.yml:synchronize", { name: "steward-automation", deployment: false }],
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
const reviewJob = reviewDocument?.jobs?.request;
const reviewSteps = reviewJob?.steps;
const reviewStep = reviewSteps?.[4];
if (!hasExactKeys(reviewDocument?.on, ["workflow_dispatch"]) || !hasExactKeys(reviewDocument?.on?.workflow_dispatch?.inputs, ["deliveryId", "repositoryId", "eventAfterSha", "policySha", "pullRequestNumber", "observeOnly"])) throw new Error("审查请求触发和输入范围无效");
for (const [name, value] of Object.entries(reviewDocument.on.workflow_dispatch.inputs)) if (value.required !== (!["pullRequestNumber", "observeOnly"].includes(name)) || value.type !== (name === "observeOnly" ? "boolean" : "string") || (name === "observeOnly" && value.default !== false)) throw new Error("审查请求输入合同无效");
if (!hasExactKeys(reviewDocument.permissions, ["contents"]) || reviewDocument.permissions.contents !== "read" || reviewJob?.permissions !== undefined || reviewDocument.env !== undefined || reviewJob?.env !== undefined) throw new Error("审查请求工作流权限或环境范围无效");
if (!hasExactKeys(reviewDocument.jobs, ["request", "observe"]) || reviewJob?.if !== "inputs.observeOnly != true && inputs.pullRequestNumber != '' && github.actor_id == '301115370' && github.repository == 'splrad/steward' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)") throw new Error("审查请求缺少可信工作流身份校验");
if (reviewJob["runs-on"] !== "ubuntu-latest" || reviewJob["timeout-minutes"] !== 5 || reviewSteps?.length !== 5) throw new Error("审查请求运行范围无效");
if (reviewSteps[0]?.uses !== "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" || reviewSteps[0]?.with?.ref !== "${{ github.workflow_sha }}" || reviewSteps[0]?.with?.["persist-credentials"] !== false) throw new Error("审查请求没有检出可信中央提交");
if (reviewSteps[1]?.uses !== "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020" || reviewSteps[1]?.with?.["node-version-file"] !== ".node-version" || reviewSteps[2]?.run !== "npm ci --ignore-scripts") throw new Error("审查请求准备步骤无效");
if (reviewSteps.slice(0, 3).some(step => step.env !== undefined) || reviewStep?.shell !== "bash" || reviewStep?.["continue-on-error"] !== undefined) throw new Error("审查请求密钥或失败处理范围无效");
const reviewInputEnvironment = new Map([
  ["APP_ID", "4243096"], ["INSTALLATION_ID", "145952003"],
  ["STEWARD_APP_PRIVATE_KEY", "${{ secrets.STEWARD_APP_PRIVATE_KEY }}"],
  ["TRIGGER_ACTOR_ID", "${{ github.actor_id }}"], ["WORKFLOW_REPOSITORY", "${{ github.repository }}"], ["WORKFLOW_EVENT", "${{ github.event_name }}"],
  ["WORKFLOW_REF", "${{ github.workflow_ref }}"], ["WORKFLOW_RUN_REF", "${{ github.ref }}"], ["WORKFLOW_SHA", "${{ github.workflow_sha }}"], ["WORKFLOW_DEFAULT_BRANCH", "${{ github.event.repository.default_branch }}"],
  ["DELIVERY_ID", "${{ inputs.deliveryId }}"], ["REPOSITORY_ID", "${{ inputs.repositoryId }}"], ["PULL_REQUEST_NUMBER", "${{ inputs.pullRequestNumber }}"],
  ["EVENT_HEAD_SHA", "${{ inputs.eventAfterSha }}"], ["POLICY_SHA", "${{ github.workflow_sha }}"],
]);
if (!hasExactKeys(reviewStep?.env, [...reviewInputEnvironment.keys()])) throw new Error("审查请求环境字段无效");
for (const [name, value] of reviewInputEnvironment) if (reviewStep.env[name] !== value) throw new Error(`审查请求输入没有安全传递: ${name}`);
const expectedReviewCommand = `review_arguments=(
  --delivery-id "$DELIVERY_ID"
  --repository-id "$REPOSITORY_ID"
  --pull-request-number "$PULL_REQUEST_NUMBER"
  --event-head-sha "$EVENT_HEAD_SHA"
  --policy-sha "$POLICY_SHA"
)
node packages/runner/dist/index.js request-copilot-review "\${review_arguments[@]}"
`;
if (reviewStep.run !== expectedReviewCommand) throw new Error("审查请求没有使用固定参数数组");
if (reviewDocument.concurrency?.group !== "steward-pr-body-${{ inputs.repositoryId }}" || reviewDocument.concurrency?.["cancel-in-progress"] !== false || reviewDocument.concurrency?.queue !== "max") throw new Error("审查请求没有沿用仓库并发锁和等待队列");
const prClassificationDocument = workflowDocuments.get("pr-classification.yml");
const aiClassificationInput = prClassificationDocument?.on?.workflow_dispatch?.inputs?.aiClassification;
if (aiClassificationInput?.required !== false || aiClassificationInput?.type !== "string") throw new Error("分类工作流缺少可选AI影子分类输入");
const classificationStep = prClassificationDocument?.jobs?.classify?.steps?.find(step => step?.name === "分类并发布门禁");
if (classificationStep?.env?.AI_CLASSIFICATION?.replace(/\s+/gu, "") !== "${{inputs.aiClassification}}") throw new Error("AI影子分类输入没有通过环境变量传递");
for (const [name, expectedValue] of [["TRIGGER_ACTOR_ID", "${{github.actor_id}}"], ["WORKFLOW_REPOSITORY", "${{github.repository}}"], ["WORKFLOW_EVENT", "${{github.event_name}}"], ["WORKFLOW_REF", "${{github.workflow_ref}}"], ["WORKFLOW_RUN_REF", "${{github.ref}}"], ["WORKFLOW_SHA", "${{github.workflow_sha}}"]]) {
  if (String(classificationStep?.env?.[name] ?? "").replace(/\s+/gu, "") !== expectedValue) throw new Error(`AI分类工作流没有绑定可信上下文: ${name}`);
}
if (/--ai-classification/iu.test(classificationStep?.run ?? "")) throw new Error("AI影子分类输入不得拼接进shell命令");
const syncInstructionsDocument = workflowDocuments.get("sync-review-instructions.yml");
const syncWorkflowRun = syncInstructionsDocument?.on?.workflow_run;
if (JSON.stringify(syncWorkflowRun?.workflows) !== JSON.stringify(["SPLRAD Steward / Deploy Runtime"]) || JSON.stringify(syncWorkflowRun?.types) !== JSON.stringify(["completed"])) throw new Error("审查说明同步没有只绑定中央部署完成事件");
const syncJob = syncInstructionsDocument?.jobs?.synchronize;
const syncResolveJob = syncInstructionsDocument?.jobs?.resolve;
const syncCondition = String(syncResolveJob?.if ?? "").replace(/\s+/gu, "");
for (const required of [
  "github.event_name=='workflow_dispatch'",
  "github.event.workflow_run.conclusion=='success'",
  "github.event.workflow_run.event=='push'",
  "github.event.workflow_run.head_branch==github.event.repository.default_branch",
  "github.event.workflow_run.head_repository.full_name==github.repository",
]) if (!syncCondition.includes(required)) throw new Error(`审查说明自动同步缺少可信触发条件: ${required}`);
const syncPolicyStep = syncResolveJob?.steps?.find(step => step?.name === "解析已部署规则提交");
if (String(syncPolicyStep?.env?.EVENT_NAME ?? "").replace(/\s+/gu, "") !== "${{github.event_name}}" || String(syncPolicyStep?.env?.DEPLOYED_HEAD_SHA ?? "").replace(/\s+/gu, "") !== "${{github.event.workflow_run.head_sha}}" || !String(syncPolicyStep?.run ?? "").includes('process.env.RUNTIME_URL+"/health"')) throw new Error("审查说明同步没有从部署事件或线上健康接口解析策略提交");
const syncCheckout = syncJob?.steps?.find(step => step?.uses?.startsWith("actions/checkout@"));
if (String(syncCheckout?.with?.ref ?? "").replace(/\s+/gu, "") !== "${{needs.resolve.outputs.policy_sha}}" || syncCheckout?.with?.["persist-credentials"] !== false) throw new Error("审查说明同步没有检出精确中央提交或仍保留检出凭据");
const syncStep = syncJob?.steps?.find(step => step?.name === "同步代码审查说明");
const syncCommand = String(syncStep?.run ?? "");
if (!syncCommand.includes('sync-review-instructions "${repository_arguments[@]}" --policy-sha "$POLICY_SHA"') || /--(?:source|target|path|content)(?:\s|=)/iu.test(syncCommand)) throw new Error("审查说明同步命令或输入合同无效");
if (String(syncStep?.env?.REPOSITORY_ID ?? "").replace(/\s+/gu, "") !== "${{matrix.repositoryId}}" || /\$\{\{[^}]*inputs\.repositoryId/iu.test(syncCommand)) throw new Error("审查说明同步把仓库编号直接拼接进shell命令");
if (String(syncStep?.env?.POLICY_SHA ?? "").replace(/\s+/gu, "") !== "${{needs.resolve.outputs.policy_sha}}" || String(syncStep?.env?.SYNC_TRIGGER ?? "").replace(/\s+/gu, "") !== "${{github.actor_id=='301115370'&&'app-redrive'||github.event_name}}" || String(syncStep?.env?.TRIGGER_ACTOR_ID ?? "").replace(/\s+/gu, "") !== "${{github.actor_id}}" || String(syncStep?.env?.TRIGGER_ACTOR_LOGIN ?? "").replace(/\s+/gu, "") !== "${{github.actor}}") throw new Error("审查说明同步没有绑定线上策略、可信App恢复或手工触发者身份");
for (const required of ['repository_arguments=()', 'repository_arguments+=(--repository-id "$REPOSITORY_ID")', '"${repository_arguments[@]}"']) {
  if (!syncCommand.includes(required)) throw new Error(`审查说明同步没有安全传递可选仓库编号: ${required}`);
}
const syncInputs = syncInstructionsDocument?.on?.workflow_dispatch?.inputs ?? {};
if (!hasExactKeys(syncInputs, ["repositoryId"])) throw new Error("审查说明同步暴露了未允许的手工输入");
const syncLabelsDocument = workflowDocuments.get("sync-managed-labels.yml");
const syncLabelsJob = syncLabelsDocument?.jobs?.synchronize;
if (JSON.stringify(syncLabelsDocument?.on?.workflow_run?.workflows) !== JSON.stringify(["SPLRAD Steward / Deploy Runtime"]) || JSON.stringify(syncLabelsDocument?.on?.workflow_run?.types) !== JSON.stringify(["completed"])) throw new Error("标签同步没有绑定部署完成事件");
if (!Object.hasOwn(syncLabelsDocument?.on ?? {}, "schedule")) throw new Error("标签同步缺少定期漂移扫描");
const labelCondition = String(syncLabelsJob?.if ?? "").replace(/\s+/gu, "");
for (const required of ["github.event_name=='workflow_dispatch'", "github.event_name=='schedule'", "github.event.workflow_run.conclusion=='success'", "github.event.workflow_run.event=='push'", "github.event.workflow_run.head_branch==github.event.repository.default_branch", "github.event.workflow_run.head_repository.full_name==github.repository"]) if (!labelCondition.includes(required)) throw new Error(`标签同步缺少可信触发条件: ${required}`);
const labelPolicyStep = syncLabelsJob?.steps?.find(step => step?.name === "解析已部署规则提交");
if (String(labelPolicyStep?.env?.EVENT_NAME ?? "").replace(/\s+/gu, "") !== "${{github.event_name}}" || String(labelPolicyStep?.env?.DEPLOYED_HEAD_SHA ?? "").replace(/\s+/gu, "") !== "${{github.event.workflow_run.head_sha}}" || !String(labelPolicyStep?.run ?? "").includes('process.env.RUNTIME_URL+"/health"')) throw new Error("标签同步没有从部署事件或线上健康接口解析策略提交");
const labelCheckout = syncLabelsJob?.steps?.find(step => step?.uses?.startsWith("actions/checkout@"));
if (String(labelCheckout?.with?.ref ?? "").replace(/\s+/gu, "") !== "${{steps.policy.outputs.policy_sha}}" || labelCheckout?.with?.["persist-credentials"] !== false) throw new Error("标签同步没有检出精确已部署提交");
const labelStep = syncLabelsJob?.steps?.find(step => step?.name === "同步受管标签定义");
if (String(labelStep?.env?.REPOSITORY_ID ?? "").replace(/\s+/gu, "") !== "${{inputs.repositoryId}}" || /\$\{\{[^}]*inputs\.repositoryId/iu.test(String(labelStep?.run ?? ""))) throw new Error("标签同步没有安全传递仓库编号");
if (!String(labelStep?.run ?? "").includes('sync-managed-labels "${repository_arguments[@]}" --policy-sha "$POLICY_SHA"')) throw new Error("标签同步没有调用固定runner入口");
if (String(labelStep?.env?.POLICY_SHA ?? "").replace(/\s+/gu, "") !== "${{steps.policy.outputs.policy_sha}}" || String(labelStep?.env?.SYNC_TRIGGER ?? "").replace(/\s+/gu, "") !== "${{github.event_name}}" || String(labelStep?.env?.TRIGGER_ACTOR_ID ?? "").replace(/\s+/gu, "") !== "${{github.actor_id}}" || String(labelStep?.env?.TRIGGER_ACTOR_LOGIN ?? "").replace(/\s+/gu, "") !== "${{github.actor}}") throw new Error("标签手工同步没有绑定线上策略与触发者身份");
if (Object.hasOwn(labelStep?.env ?? {}, "COPILOT_REVIEW_REQUEST_TOKEN")) throw new Error("标签同步不应读取Copilot令牌");
const onboardDocument = workflowDocuments.get("onboard-repository.yml");
const onboardStep = onboardDocument?.jobs?.onboard?.steps?.find(step => step?.name === "校验并接入仓库");
const onboardCommand = String(onboardStep?.run ?? "");
for (const [name, expectedValue] of [["REPOSITORY_ID", "${{inputs.repositoryId}}"], ["REPOSITORY_FULL_NAME", "${{inputs.repositoryFullName}}"], ["TRIGGER_ACTOR_ID", "${{github.actor_id}}"], ["TRIGGER_ACTOR_LOGIN", "${{github.actor}}"]]) if (String(onboardStep?.env?.[name] ?? "").replace(/\s+/gu, "") !== expectedValue) throw new Error(`onboarding没有通过环境变量传递${name}`);
if (/\$\{\{/u.test(onboardCommand) || !onboardCommand.includes('--repository-id "$REPOSITORY_ID"') || !onboardCommand.includes('--repository-full-name "$REPOSITORY_FULL_NAME"')) throw new Error("onboarding没有通过环境变量安全传递必填仓库身份");
for (const step of [onboardStep, syncStep]) if (!Object.hasOwn(step?.env ?? {}, "RUNTIME_URL")) throw new Error("正文写入工作流缺少运行时地址");
const deployRuntime = await readFile(".github/workflows/deploy-runtime.yml", "utf8");
for (const required of [".github/workflows/deploy-runtime.yml", "scripts/verify-workflows.mjs", "github.event.repository.default_branch", "id: deploy", "tee \"$deployment_log\"", "PIPESTATUS[0]", "复核运行程序健康状态", "steps.deploy.outputs.runtime_url", "EXPECTED_POLICY_SHA", "Date.now() + 60_000", "AbortSignal.timeout", "await response.body?.cancel()", "status: \"waiting\"", "iu.test(body.version)", "健康复核在60秒内未收敛"]) {
  if (!deployRuntime.includes(required)) throw new Error(`部署工作流缺少固定健康复核合同: ${required}`);
}
const deployRuntimeDocument = YAML.parse(deployRuntime);
if (Object.hasOwn(deployRuntimeDocument?.on?.push ?? {}, "branches")) throw new Error("部署工作流仍固定默认分支名称");
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
const actionlintVersion = "1.7.12";
const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
const architecture = process.arch === "arm64" ? "arm64" : "amd64";
const extension = platform === "windows" ? "zip" : "tar.gz";
const archiveName = `actionlint_${actionlintVersion}_${platform}_${architecture}.${extension}`;
const base = `https://github.com/rhysd/actionlint/releases/download/v${actionlintVersion}`;
const temporary = await mkdtemp(join(tmpdir(), "steward-actionlint-"));
try {
  const [checksumsResponse, archiveResponse] = await Promise.all([fetch(`${base}/actionlint_${actionlintVersion}_checksums.txt`), fetch(`${base}/${archiveName}`)]);
  if (!checksumsResponse.ok || !archiveResponse.ok) throw new Error(`无法下载固定actionlint ${actionlintVersion}`);
  const checksums = await checksumsResponse.text(); const archive = Buffer.from(await archiveResponse.arrayBuffer());
  const expected = checksums.split(/\r?\n/u).map(line => line.trim().split(/\s+/u)).find(([, name]) => name === archiveName)?.[0];
  const actual = createHash("sha256").update(archive).digest("hex"); if (!expected || actual !== expected.toLowerCase()) throw new Error("actionlint压缩包摘要不匹配");
  const archivePath = join(temporary, archiveName); await writeFile(archivePath, archive);
  const extracted = spawnSync("tar", ["-xf", archivePath, "-C", temporary], { encoding: "utf8" }); if (extracted.status !== 0) throw new Error(extracted.stderr || "无法解压actionlint");
  const executable = join(temporary, platform === "windows" ? "actionlint.exe" : "actionlint"); if (platform !== "windows") await chmod(executable, 0o755);
  const actionlintArguments = ["-ignore", 'unexpected key "queue" for "concurrency" section', ...files.map(file => `.github/workflows/${file}`)];
  const checked = spawnSync(executable, actionlintArguments, { encoding: "utf8" }); if (checked.status !== 0) throw new Error(checked.stdout || checked.stderr || "actionlint失败");
} finally { await rm(temporary, { recursive: true, force: true }); }


const modeSteps = [
  [reviewDocument.jobs.request, "${{ github.workflow_sha }}", reviewStep],
  [onboardDocument.jobs.onboard, "${{ github.actor_id == '301115370' && inputs.policySha || github.sha }}", onboardStep],
];
for (const [job, policy, consumer] of modeSteps) {
  const matches = job.steps.filter(step => step.id === "review_policy");
  const step = matches[0];
  if (matches.length !== 1 || step.shell !== "bash" || step.if !== undefined || step["continue-on-error"] !== undefined || job.steps.indexOf(step) >= job.steps.indexOf(consumer)) throw new Error("审查模式解析顺序或失败处理无效");
  const expected = { APP_ID: "4243096", INSTALLATION_ID: "145952003", STEWARD_APP_PRIVATE_KEY: "${{ secrets.STEWARD_APP_PRIVATE_KEY }}", REPOSITORY_ID: "${{ inputs.repositoryId }}", POLICY_SHA: policy };
  if (!hasExactKeys(step.env, Object.keys(expected)) || Object.entries(expected).some(([name, value]) => step.env[name] !== value)) throw new Error("审查模式解析权限或策略绑定无效");
  if (step.run !== 'node packages/runner/dist/index.js review-trigger-mode --repository-id "$REPOSITORY_ID" --policy-sha "$POLICY_SHA"') throw new Error("审查模式解析参数无效");
  if (Object.hasOwn(consumer.env ?? {}, "COPILOT_REVIEW_REQUEST_TOKEN")) throw new Error("审查观察不得注入旧请求令牌");
  for (const candidate of job.steps) if (candidate !== consumer && Object.hasOwn(candidate.env ?? {}, "COPILOT_REVIEW_REQUEST_TOKEN")) throw new Error("审查令牌注入范围扩大");
}
if (!hasExactKeys(syncInstructionsDocument.jobs, ["resolve", "synchronize"]) || syncJob.needs !== "resolve" || syncJob.if !== undefined
  || syncJob.strategy?.matrix !== "${{ fromJSON(needs.resolve.outputs.matrix) }}" || syncJob.strategy?.["fail-fast"] !== false || syncJob.strategy?.["max-parallel"] !== 1
  || syncResolveJob.outputs?.matrix !== "${{ steps.targets.outputs.matrix }}" || syncResolveJob.outputs?.policy_sha !== "${{ steps.policy.outputs.policy_sha }}") throw new Error("审查同步矩阵或已部署策略来源无效");
const targetStep = syncResolveJob.steps.find(step => step.id === "targets");
const targetEnvironment = { APP_ID: "4243096", INSTALLATION_ID: "145952003", STEWARD_APP_PRIVATE_KEY: "${{ secrets.STEWARD_APP_PRIVATE_KEY }}", REPOSITORY_ID: "${{ inputs.repositoryId }}", POLICY_SHA: "${{ steps.policy.outputs.policy_sha }}", SYNC_TRIGGER: "${{ github.actor_id == '301115370' && 'app-redrive' || github.event_name }}", TRIGGER_ACTOR_ID: "${{ github.actor_id }}", TRIGGER_ACTOR_LOGIN: "${{ github.actor }}" };
if (!hasExactKeys(targetStep?.env, Object.keys(targetEnvironment)) || Object.entries(targetEnvironment).some(([name, value]) => targetStep.env[name] !== value)) throw new Error("审查同步目标解析环境扩大或身份绑定无效");
const resolveCheckout = syncResolveJob.steps.find(step => step.uses?.startsWith("actions/checkout@"));
if (resolveCheckout?.with?.ref !== "${{ steps.policy.outputs.policy_sha }}" || resolveCheckout?.with?.["persist-credentials"] !== false
  || targetStep?.shell !== "bash" || targetStep?.if !== undefined || targetStep?.["continue-on-error"] !== undefined
  || targetStep.env?.POLICY_SHA !== "${{ steps.policy.outputs.policy_sha }}" || targetStep.env?.REPOSITORY_ID !== "${{ inputs.repositoryId }}"
  || !targetStep.run?.includes('review-sync-targets "${repository_arguments[@]}" --policy-sha "$POLICY_SHA"') || /\$\{\{/u.test(targetStep.run)) throw new Error("审查同步目标解析权限或参数无效");
if (syncJob.concurrency?.group !== "steward-pr-body-${{ matrix.repositoryId }}" || syncJob.concurrency?.["cancel-in-progress"] !== false || syncJob.concurrency?.queue !== "max") throw new Error("审查同步矩阵未复用单仓并发锁");
if (Object.hasOwn(syncStep.env ?? {}, "COPILOT_REVIEW_REQUEST_TOKEN")) throw new Error("审查同步不得注入旧请求令牌");
for (const step of [...syncResolveJob.steps, ...syncJob.steps.filter(step => step !== syncStep)]) if (Object.hasOwn(step.env ?? {}, "COPILOT_REVIEW_REQUEST_TOKEN")) throw new Error("审查同步令牌注入范围扩大");


const observeDocument = reviewDocument;
const observeJob = observeDocument?.jobs?.observe;
if (observeJob.if !== "inputs.observeOnly == true && github.event_name == 'workflow_dispatch' && github.repository == 'splrad/steward' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)"
  || observeJob["runs-on"] !== "ubuntu-latest" || observeJob["timeout-minutes"] !== 5
  || observeJob.environment?.name !== "steward-automation" || observeJob.environment?.deployment !== false
  || observeJob.permissions !== undefined || observeJob.env !== undefined || observeJob["continue-on-error"] !== undefined)
  throw new Error("审查观察来源或凭据边界无效");
const observeSteps = observeJob.steps;
const observeCommand = observeSteps?.[3];
if (observeSteps?.length !== 4 || observeSteps[0].uses !== "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
  || observeSteps[0].with?.ref !== "${{ github.workflow_sha }}" || observeSteps[0].with?.["persist-credentials"] !== false || observeSteps[0].with?.repository !== undefined
  || observeSteps[1].uses !== "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"
  || observeSteps[1].with?.["node-version-file"] !== ".node-version" || observeSteps[2].run !== "npm ci --ignore-scripts"
  || observeSteps.slice(0, 3).some(step => step.env !== undefined)) throw new Error("审查观察必须检出中央工作流提交并隔离安装阶段凭据");
const observeEnvironment = { APP_ID: "4243096", INSTALLATION_ID: "145952003", STEWARD_APP_PRIVATE_KEY: "${{ secrets.STEWARD_APP_PRIVATE_KEY }}", REPOSITORY_ID: "${{ inputs.repositoryId }}", PULL_REQUEST_NUMBER: "${{ inputs.pullRequestNumber }}", HEAD_SHA: "${{ inputs.eventAfterSha }}", POLICY_SHA: "${{ github.workflow_sha }}" };
const expectedObserveCommand = 'node packages/runner/dist/index.js observe-copilot-review --repository-id "$REPOSITORY_ID" --pull-request-number "$PULL_REQUEST_NUMBER" --event-head-sha "$HEAD_SHA" --policy-sha "$POLICY_SHA"';
if (!hasExactKeys(observeCommand?.env, Object.keys(observeEnvironment)) || Object.entries(observeEnvironment).some(([key, value]) => observeCommand.env[key] !== value)
  || observeCommand.id !== "observe" || observeCommand.shell !== "bash" || observeCommand.if !== undefined || observeCommand["continue-on-error"] !== undefined
  || String(observeCommand.run).replace(/\\\r?\n/gu, " ").replace(/\s+/gu, " ").trim() !== expectedObserveCommand)
  throw new Error("审查观察参数或命令不符合只读合同");

const releaseSourceWorkflow = YAML.parse(await readFile(".github/workflows/release.yml", "utf8"));
if (!hasExactKeys(releaseSourceWorkflow.jobs, ["prepare", "inspect", "publish", "generation-ticket", "generate", "generated-candidate", "revision"]) || !hasExactKeys(releaseSourceWorkflow.on, ["workflow_dispatch"])) throw new Error("发布工作流必须先读取持久候选收据");
const generationJob = releaseSourceWorkflow.jobs.generate;
const productBuild = workflowDocuments.get('release-build.yml');
const buildCompletion = workflowDocuments.get('release-build-complete.yml');
const genericBuild = workflowDocuments.get('product-build.yml');
if (!hasExactKeys(genericBuild.on, ['workflow_dispatch']) || !hasExactKeys(genericBuild.jobs, ['plan', 'build']) || genericBuild.jobs.build.environment !== undefined || genericBuild.jobs.build.needs !== 'plan' || genericBuild.jobs.build['runs-on'] !== '${{ needs.plan.outputs.runner }}' || genericBuild.jobs.plan.outputs.runner !== '${{ steps.plan.outputs.runner }}' || genericBuild.permissions.contents !== 'read' || genericBuild.permissions.actions !== 'read') throw new Error('通用产品构建边界无效');
for (const step of genericBuild.jobs.build.steps) if (JSON.stringify(step).includes('secrets.') || step.env && !hasExactKeys(step.env, ['POLICY_SHA', 'RUN_ID'])) throw new Error('产品构建不得注入秘密');
if (!hasExactKeys(productBuild.on, ['workflow_dispatch']) || !hasExactKeys(productBuild.jobs, ['plan', 'build'])
  || productBuild.jobs.build.needs !== 'plan' || productBuild.jobs.build.environment !== undefined || productBuild.jobs.build['runs-on'] !== '${{ needs.plan.outputs.runner }}' || productBuild.jobs.plan.outputs.runner !== '${{ steps.plan.outputs.runner }}'
  || productBuild.jobs.build['timeout-minutes'] !== 45 || productBuild.permissions.contents !== 'read' || productBuild.permissions.actions !== 'read') throw new Error('产品构建权限或作业边界无效');
for (const step of productBuild.jobs.build.steps) {
  if (JSON.stringify(step).includes('secrets.') || step.env && !hasExactKeys(step.env, ['POLICY_SHA', 'RUN_ID'])) throw new Error('产品构建不得注入秘密');
}
if (buildCompletion.on.workflow_run?.workflows?.[0] !== 'SPLRAD Steward / Release Build' || buildCompletion.on.workflow_run?.types?.[0] !== 'completed'
  || !buildCompletion.jobs.accept.steps.some(step => step.name === '明确阻断策略漂移的完成回调' && step.env?.SOURCE_POLICY === '${{ github.event.workflow_run.head_sha }}' && step.env?.CURRENT_POLICY === '${{ github.workflow_sha }}' && step.run?.includes('RELEASE_POLICY_DRIFT'))
  || !buildCompletion.jobs.accept.if.includes("github.event.workflow_run.event == 'workflow_dispatch'")) throw new Error('构建完成回调未绑定可信运行');
if (buildCompletion.jobs.accept.steps.find(step => step.run?.includes('--operation reject'))?.if !== "failure() && steps.accept.outputs.verificationFailed == 'true'") throw new Error('仅确定的产物验证失败可拒绝构建，基础设施故障必须可重试');
for (const document of [productBuild, buildCompletion, genericBuild]) for (const job of Object.values(document.jobs)) {
  if (job.steps.find(step => step.uses?.startsWith('actions/checkout@'))?.with.ref !== '${{ github.workflow_sha }}' || job.steps.find(step => step.uses?.startsWith('actions/checkout@'))?.with['persist-credentials'] !== false) throw new Error('构建流程未固定中央策略');
  for (const step of job.steps) if (step.run && step.run.includes('${{')) throw new Error('构建输入未经环境变量隔离');
}
if (generationJob.needs !== 'generation-ticket' || releaseSourceWorkflow.jobs['generated-candidate'].needs !== 'generate') throw new Error('生成预算和候选顺序无效');
for (const step of generationJob.steps) {
  if (step.env && (!hasExactKeys(step.env, ['COPILOT_GITHUB_TOKEN']) || step.env.COPILOT_GITHUB_TOKEN !== '${{ secrets.COPILOT_GITHUB_TOKEN }}')) throw new Error('模型作业包含额外凭据');
  if (step.run && /release-candidate|reconcile|STEWARD_APP_PRIVATE_KEY/.test(step.run)) throw new Error('模型作业不得写候选或发布');
}
if (releaseSourceWorkflow.jobs.publish.if !== "inputs.operation == 'reconcile' && needs.inspect.outputs.shouldPublish == 'true'") throw new Error("Review 观察不得直接发布");
if (releaseSourceWorkflow.jobs.publish.concurrency?.group !== 'steward-release-publish-${{ inputs.repositoryId }}'
  || releaseSourceWorkflow.jobs.publish.concurrency?.['cancel-in-progress'] !== false) throw new Error('最终发布必须按仓库串行且不得中断正在发布的版本');
if (releaseSourceWorkflow.jobs.generate['timeout-minutes'] !== 86
  || releaseSourceWorkflow.jobs.publish['timeout-minutes'] !== '${{ fromJSON(needs.inspect.outputs.publishTimeoutMinutes) }}'
  || releaseSourceWorkflow.jobs.inspect.outputs.publishTimeoutMinutes !== '${{ steps.receipt.outputs.publishTimeoutMinutes }}') throw new Error('发布及生成作业必须覆盖冻结预算和初始化余量');
const releaseDownload = releaseSourceWorkflow.jobs.publish.steps.find(step => step.uses?.startsWith("actions/download-artifact@"));
const recoverAssets = releaseSourceWorkflow.jobs.publish.steps.find(step => step.run?.includes('--operation recover-assets'));
const publishAssets = releaseSourceWorkflow.jobs.publish.steps.find(step => step.run?.includes('--operation reconcile'));
if (releaseDownload.id !== 'assets' || releaseDownload['continue-on-error'] !== true || recoverAssets?.if !== "steps.assets.outcome == 'failure'" || publishAssets?.if !== "steps.assets.outcome != 'failure'") throw new Error('下载失败必须进入持久重建恢复并阻止本次发布');
if (releaseDownload?.with?.['artifact-ids'] !== "${{ needs.inspect.outputs.artifactId }}" || releaseDownload?.with?.['run-id'] !== "${{ needs.inspect.outputs.runId }}" || releaseDownload?.with?.repository !== "splrad/steward") throw new Error("发布资产必须绑定持久收据的中央构建产物");
for (const job of Object.values(releaseSourceWorkflow.jobs)) {
  if (job.steps[0].with.ref !== "${{ github.workflow_sha }}" || job.steps[0].with['persist-credentials'] !== false || job.steps[0].with.repository !== undefined) throw new Error("发布只能执行可信中央策略");
  for (const step of job.steps) if (step.run && /release-(preflight|notes|publish|verify)\b|\$\{\{ inputs\./.test(step.run)) throw new Error("旧发布入口或未隔离输入仍存在");
}

console.log("workflows verified");

for (const file of ["pr-automation.yml", "issue-sync.yml", "pr-issue-link.yml"]) {
  if (workflowDocuments.has(file)) throw new Error(`退役工作流仍存在: ${file}`);
}
