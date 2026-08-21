import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const expected = ["deploy-runtime.yml", "issue-sync.yml", "onboard-repository.yml", "pr-automation.yml", "pr-classification.yml", "pr-issue-link.yml", "pr-validation.yml", "release.yml", "sync-copilot-instructions.yml", "sync-managed-labels.yml"];
const files = (await readdir(".github/workflows")).sort();
if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error(`工作流集合不正确: ${files.join(", ")}`);
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
const validationStep = validationDocument?.jobs?.validate?.steps?.find(step => step?.name === "执行中央验证");
if (String(validationStep?.env?.VALIDATION_BASE_SHA ?? "").replace(/\s+/gu, "") !== "${{github.event.pull_request.base.sha}}") throw new Error("中央验证没有通过环境变量接收基础分支提交");
if (String(validationStep?.env?.VALIDATION_BASE_REF ?? "").replace(/\s+/gu, "") !== "${{github.event.pull_request.base.ref}}") throw new Error("中央验证没有通过环境变量接收基础分支引用");
const expectedJobEnvironments = new Map([
  ["deploy-runtime.yml:deploy", { name: "steward-deployment", deployment: true }],
  ["issue-sync.yml:synchronize", { name: "steward-automation", deployment: false }],
  ["onboard-repository.yml:onboard", { name: "steward-automation", deployment: false }],
  ["pr-automation.yml:reconcile", { name: "steward-automation", deployment: false }],
  ["pr-classification.yml:classify", { name: "steward-automation", deployment: false }],
  ["pr-issue-link.yml:resolve", { name: "steward-automation", deployment: false }],
  ["pr-issue-link.yml:analyze", { name: "steward-automation", deployment: false }],
  ["release.yml:preflight", { name: "steward-release", deployment: false }],
  ["release.yml:notes", { name: "steward-release", deployment: false }],
  ["release.yml:publish", { name: "steward-release", deployment: false }],
  ["release.yml:verify", { name: "steward-release", deployment: false }],
  ["sync-copilot-instructions.yml:synchronize", { name: "steward-automation", deployment: false }],
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
const prAutomation = await readFile(".github/workflows/pr-automation.yml", "utf8");
const prAutomationDocument = workflowDocuments.get("pr-automation.yml");
const prAutomationPermissions = prAutomationDocument?.permissions ?? {};
if (typeof prAutomationPermissions !== "object" || prAutomationPermissions === null || Array.isArray(prAutomationPermissions) || Object.keys(prAutomationPermissions).length !== 1 || prAutomationPermissions.contents !== "read") throw new Error("拉取请求自动化工作流权限必须只有contents: read");
const copilotStep = prAutomationDocument?.jobs?.reconcile?.steps?.find(step => step?.name === "使用Copilot润色");
if (copilotStep?.env?.COPILOT_GITHUB_TOKEN?.replace(/\s+/gu, "") !== "${{secrets.COPILOT_CLI_TOKEN}}") throw new Error("Copilot CLI没有使用个人Copilot专用环境密钥");
if (copilotStep?.id !== "copilot" || copilotStep?.["continue-on-error"] !== true) throw new Error("Copilot CLI步骤没有保留可读取的失败结果");
if (Object.hasOwn(copilotStep?.env ?? {}, "GITHUB_TOKEN") || /copilot-requests/iu.test(prAutomation)) throw new Error("Copilot CLI仍引用组织内置令牌路径");
const copilotCommand = String(copilotStep?.run ?? "");
const expectedCopilotCommand = 'npx --no-install copilot --available-tools= --no-auto-update --output-format json --stream off --no-color --no-custom-instructions --disable-builtin-mcps --no-ask-user < "$PR_COPILOT_PROMPT_PATH" > "${{ runner.temp }}/copilot-output.jsonl"';
if (copilotCommand !== expectedCopilotCommand) throw new Error("Copilot CLI没有使用固定JSONL输出合同");
if (/(?:^|\s)--allow-tool(?:=|\s|$)/u.test(copilotCommand)) throw new Error("Copilot正文生成不得启用工具");
const prepareStep = prAutomationDocument?.jobs?.reconcile?.steps?.find(step => step?.name === "生成Copilot输入");
const repairPlanStep = prAutomationDocument?.jobs?.reconcile?.steps?.find(step => step?.name === "判断Copilot输出是否需要修复");
if (repairPlanStep?.id !== "repair_plan" || repairPlanStep?.["continue-on-error"] !== true || String(repairPlanStep?.if ?? "").replace(/\s+/gu, "") !== "steps.copilot.outcome=='success'") throw new Error("Copilot修复判断没有严格绑定首次调用成功结果");
if (repairPlanStep?.env?.PREPARE_REPAIR_ONLY !== "true" || repairPlanStep?.env?.STEWARD_APP_PRIVATE_KEY?.replace(/\s+/gu, "") !== "${{secrets.STEWARD_APP_PRIVATE_KEY}}" || repairPlanStep?.run !== prepareStep?.run) throw new Error("Copilot修复判断没有重新读取并核对当前分支事实");
const copilotRepairStep = prAutomationDocument?.jobs?.reconcile?.steps?.find(step => step?.name === "修复Copilot业务JSON");
if (copilotRepairStep?.id !== "copilot_repair" || copilotRepairStep?.["continue-on-error"] !== true || String(copilotRepairStep?.if ?? "").replace(/\s+/gu, "") !== "steps.repair_plan.outputs.repair-required=='true'") throw new Error("Copilot修复步骤没有限制为一次条件调用");
if (copilotRepairStep?.env?.COPILOT_GITHUB_TOKEN?.replace(/\s+/gu, "") !== "${{secrets.COPILOT_CLI_TOKEN}}" || Object.hasOwn(copilotRepairStep?.env ?? {}, "GITHUB_TOKEN")) throw new Error("Copilot修复步骤没有使用隔离的个人令牌");
const expectedCopilotRepairCommand = 'npx --no-install copilot --available-tools= --no-auto-update --output-format json --stream off --no-color --no-custom-instructions --disable-builtin-mcps --no-ask-user < "$PR_COPILOT_REPAIR_PROMPT_PATH" > "${{ runner.temp }}/copilot-repair-output.jsonl"';
if (copilotRepairStep?.run !== expectedCopilotRepairCommand) throw new Error("Copilot修复步骤没有使用固定的无工具JSONL合同");
const reconcileStep = prAutomationDocument?.jobs?.reconcile?.steps?.find(step => step?.name === "收敛拉取请求");
if (reconcileStep?.env?.COPILOT_STEP_OUTCOME?.replace(/\s+/gu, "") !== "${{steps.copilot.outcome}}") throw new Error("收敛步骤没有接收Copilot CLI结果");
if (reconcileStep?.env?.COPILOT_REPAIR_STEP_OUTCOME?.replace(/\s+/gu, "") !== "${{steps.copilot_repair.outcome}}") throw new Error("收敛步骤没有接收Copilot修复结果");
const expectedCopilotOutputPath = "${{runner.temp}}/copilot-output.jsonl";
if (String(prepareStep?.env?.COPILOT_OUTPUT_PATH ?? "").replace(/\s+/gu, "") !== expectedCopilotOutputPath || String(reconcileStep?.env?.COPILOT_OUTPUT_PATH ?? "").replace(/\s+/gu, "") !== expectedCopilotOutputPath) throw new Error("Copilot JSONL输出路径没有贯穿准备与收敛步骤");
const expectedCopilotRepairPromptPath = "${{runner.temp}}/copilot-repair-prompt.txt";
if (String(repairPlanStep?.env?.COPILOT_OUTPUT_PATH ?? "").replace(/\s+/gu, "") !== expectedCopilotOutputPath || String(repairPlanStep?.env?.PR_PREPARED_FACTS_PATH ?? "").replace(/\s+/gu, "") !== "${{runner.temp}}/pr-prepared-facts.json" || String(repairPlanStep?.env?.PR_COPILOT_REPAIR_PROMPT_PATH ?? "").replace(/\s+/gu, "") !== expectedCopilotRepairPromptPath || String(copilotRepairStep?.env?.PR_COPILOT_REPAIR_PROMPT_PATH ?? "").replace(/\s+/gu, "") !== expectedCopilotRepairPromptPath || String(reconcileStep?.env?.COPILOT_REPAIR_OUTPUT_PATH ?? "").replace(/\s+/gu, "") !== "${{runner.temp}}/copilot-repair-output.jsonl") throw new Error("Copilot修复路径没有贯穿事实复核、提示生成、修复调用与收敛步骤");
const cleanupStep = prAutomationDocument?.jobs?.reconcile?.steps?.find(step => step?.name === "删除临时人工智能输入");
const expectedCleanupCommand = 'rm -f "${{ runner.temp }}/copilot-prompt.txt" "${{ runner.temp }}/copilot-output.jsonl" "${{ runner.temp }}/copilot-repair-prompt.txt" "${{ runner.temp }}/copilot-repair-output.jsonl" "${{ runner.temp }}/pr-prepared-facts.json"';
if (String(cleanupStep?.if ?? "").replace(/\s+/gu, "") !== "always()" || cleanupStep?.run !== expectedCleanupCommand) throw new Error("Copilot临时输入输出没有固定为始终清理");
if (!prAutomation.includes("- name: 使用Copilot润色") || !prAutomation.includes('npx --no-install copilot --available-tools=')) throw new Error("拉取请求工作流缺少Copilot正文生成步骤");
if (/hashFiles\([^\n]*runner\.temp/iu.test(prAutomation)) throw new Error("Copilot正文生成仍使用无法读取runner.temp的hashFiles条件");
const prClassificationDocument = workflowDocuments.get("pr-classification.yml");
const aiClassificationInput = prClassificationDocument?.on?.workflow_dispatch?.inputs?.aiClassification;
if (aiClassificationInput?.required !== false || aiClassificationInput?.type !== "string") throw new Error("分类工作流缺少可选AI影子分类输入");
const classificationStep = prClassificationDocument?.jobs?.classify?.steps?.find(step => step?.name === "分类并发布门禁");
if (classificationStep?.env?.AI_CLASSIFICATION?.replace(/\s+/gu, "") !== "${{inputs.aiClassification}}") throw new Error("AI影子分类输入没有通过环境变量传递");
for (const [name, expectedValue] of [["TRIGGER_ACTOR_ID", "${{github.actor_id}}"], ["WORKFLOW_REPOSITORY", "${{github.repository}}"], ["WORKFLOW_EVENT", "${{github.event_name}}"], ["WORKFLOW_REF", "${{github.workflow_ref}}"], ["WORKFLOW_RUN_REF", "${{github.ref}}"], ["WORKFLOW_SHA", "${{github.workflow_sha}}"]]) {
  if (String(classificationStep?.env?.[name] ?? "").replace(/\s+/gu, "") !== expectedValue) throw new Error(`AI分类工作流没有绑定可信上下文: ${name}`);
}
if (/--ai-classification/iu.test(classificationStep?.run ?? "")) throw new Error("AI影子分类输入不得拼接进shell命令");
const issueSyncDocument = workflowDocuments.get("issue-sync.yml");
const issueSyncInputs = issueSyncDocument?.on?.workflow_dispatch?.inputs ?? {};
if (JSON.stringify(Object.keys(issueSyncInputs)) !== JSON.stringify(["deliveryId", "repositoryId", "issueNumber", "scanAll", "policySha"])) throw new Error("议题同步工作流输入集合不正确");
if (issueSyncDocument?.permissions && Object.keys(issueSyncDocument.permissions).length !== 0) throw new Error("议题同步工作流不应使用GITHUB_TOKEN权限");
const issueSyncConcurrency = String(issueSyncDocument?.concurrency?.group ?? "").replace(/\s+/gu, "");
if (issueSyncConcurrency !== "steward-issue-sync-${{inputs.repositoryId}}") throw new Error("议题同步必须使用仓库级并发锁");
if (issueSyncDocument?.concurrency?.["cancel-in-progress"] !== false || issueSyncDocument?.concurrency?.queue !== "max") throw new Error("议题同步必须保留全部等待运行");
const issueSyncStep = issueSyncDocument?.jobs?.synchronize?.steps?.find(step => step?.name === "同步议题快照");
const issueSyncCommand = String(issueSyncStep?.run ?? "");
for (const required of ['issue_arguments=()', 'issue_arguments+=(--issue-number "$ISSUE_NUMBER")', '"${issue_arguments[@]}"', '--scan-all "$SCAN_ALL"', '--policy-sha "$POLICY_SHA"']) if (!issueSyncCommand.includes(required)) throw new Error(`议题同步命令没有安全传递固定输入: ${required}`);
for (const name of ["DELIVERY_ID", "REPOSITORY_ID", "ISSUE_NUMBER", "SCAN_ALL", "POLICY_SHA", "RUNTIME_URL"]) if (!Object.hasOwn(issueSyncStep?.env ?? {}, name)) throw new Error(`议题同步环境缺少${name}`);
if (Object.hasOwn(issueSyncStep?.env ?? {}, "COPILOT_GITHUB_TOKEN") || Object.hasOwn(issueSyncStep?.env ?? {}, "COPILOT_CLI_TOKEN") || /\bcopilot\b/iu.test(issueSyncCommand)) throw new Error("议题同步路径不得调用Copilot");
const issueLinkDocument = workflowDocuments.get("pr-issue-link.yml");
const issueLinkInputs = issueLinkDocument?.on?.workflow_dispatch?.inputs ?? {};
if (JSON.stringify(Object.keys(issueLinkInputs)) !== JSON.stringify(["deliveryId", "repositoryId", "pullRequestNumber", "scanAll", "invalidateOnly", "policySha"])) throw new Error("议题关联工作流输入集合不正确");
if (issueLinkInputs.pullRequestNumber?.required !== false || issueLinkInputs.scanAll?.type !== "boolean" || issueLinkInputs.invalidateOnly?.type !== "boolean") throw new Error("议题关联工作流可选编号或布尔输入契约不正确");
const issueLinkPermissions = issueLinkDocument?.permissions ?? {};
if (JSON.stringify(issueLinkPermissions) !== JSON.stringify({ contents: "read", "copilot-requests": "write" })) throw new Error("议题关联内置令牌权限不正确");
const issueLinkConcurrency = String(issueLinkDocument?.concurrency?.group ?? "").replace(/\s+/gu, "");
if (issueLinkConcurrency !== "steward-pr-body-${{inputs.repositoryId}}") throw new Error("议题关联必须与正文自动化共用仓库级并发锁");
if (issueLinkDocument?.concurrency?.["cancel-in-progress"] !== false) throw new Error("议题关联工作流不得取消在途运行");
if (issueLinkDocument?.concurrency?.queue !== "max") throw new Error("议题关联必须保留全部等待运行");
const prAutomationConcurrency = String(workflowDocuments.get("pr-automation.yml")?.concurrency?.group ?? "").replace(/\s+/gu, "");
if (prAutomationConcurrency !== issueLinkConcurrency) throw new Error("拉取请求自动化没有与议题关联共用正文并发锁");
if (workflowDocuments.get("pr-automation.yml")?.concurrency?.queue !== "max") throw new Error("拉取请求自动化必须保留全部等待运行");
const onboardConcurrency = String(workflowDocuments.get("onboard-repository.yml")?.concurrency?.group ?? "").replace(/\s+/gu, "");
if (onboardConcurrency !== "steward-pr-body-${{inputs.repositoryId}}") throw new Error("接入工作流没有使用数值仓库编号正文并发锁");
if (workflowDocuments.get("onboard-repository.yml")?.on?.workflow_dispatch?.inputs?.repositoryId?.required !== true
  || workflowDocuments.get("onboard-repository.yml")?.concurrency?.queue !== "max") throw new Error("接入工作流必须要求仓库编号并保留全部等待运行");
const queuedWorkflows = [...workflowDocuments.entries()].filter(([, document]) => Object.hasOwn(document?.concurrency ?? {}, "queue")).map(([name]) => name).sort();
if (JSON.stringify(queuedWorkflows) !== JSON.stringify(["issue-sync.yml", "onboard-repository.yml", "pr-automation.yml", "pr-issue-link.yml"])) throw new Error("工作流等待队列范围不正确");
const issueLinkResolve = issueLinkDocument?.jobs?.resolve;
const issueLinkMatrixStep = issueLinkResolve?.steps?.find(step => step?.name === "解析开放拉取请求");
const issueLinkMatrixCommand = String(issueLinkMatrixStep?.run ?? "");
for (const required of ['ISSUE_LINK_LIST_ONLY', 'pull_arguments=()', 'pull_arguments+=(--pull-request-number "$PULL_REQUEST_NUMBER")', '"${pull_arguments[@]}"', '--scan-all "$SCAN_ALL"', '--invalidate-only "$INVALIDATE_ONLY"']) {
  if (!(Object.hasOwn(issueLinkMatrixStep?.env ?? {}, required) || issueLinkMatrixCommand.includes(required))) throw new Error(`议题关联矩阵解析缺少固定约束: ${required}`);
}
if (issueLinkDocument?.jobs?.analyze?.strategy?.["max-parallel"] !== 4 || issueLinkDocument?.jobs?.analyze?.strategy?.["fail-fast"] !== false) throw new Error("议题关联矩阵并发策略不正确");
const issueLinkAnalyze = issueLinkDocument?.jobs?.analyze;
for (const name of ["DELIVERY_ID", "REPOSITORY_ID", "PULL_REQUEST_NUMBER", "INVALIDATE_ONLY", "POLICY_SHA"]) if (!Object.hasOwn(issueLinkAnalyze?.env ?? {}, name)) throw new Error(`议题关联分析环境缺少${name}`);
const issuePrepareStep = issueLinkAnalyze?.steps?.find(step => step?.name === "准备议题与差异证据");
const issueReconcileStep = issueLinkAnalyze?.steps?.find(step => step?.name === "收敛议题关联");
for (const step of [issuePrepareStep, issueReconcileStep]) {
  const command = String(step?.run ?? "");
  if (/\$\{\{/u.test(command) || !command.includes('--delivery-id "$DELIVERY_ID"') || !command.includes('--repository-id "$REPOSITORY_ID"') || !command.includes('--pull-request-number "$PULL_REQUEST_NUMBER"') || !command.includes('--policy-sha "$POLICY_SHA"')) throw new Error("议题关联运行器输入没有通过环境变量安全传递");
}
const issueCopilotStep = issueLinkAnalyze?.steps?.find(step => step?.name === "使用Copilot判断议题");
const expectedIssueCopilotCommand = 'npx --no-install copilot --available-tools= --no-auto-update --output-format json --stream off --no-color --no-custom-instructions --disable-builtin-mcps --no-ask-user < "$ISSUE_COPILOT_PROMPT_PATH" > "$ISSUE_COPILOT_OUTPUT_PATH"';
if (issueCopilotStep?.id !== "copilot" || issueCopilotStep?.["continue-on-error"] !== true || issueCopilotStep?.run !== expectedIssueCopilotCommand || issueCopilotStep?.env?.GITHUB_TOKEN?.replace(/\s+/gu, "") !== "${{github.token}}" || Object.hasOwn(issueCopilotStep?.env ?? {}, "COPILOT_GITHUB_TOKEN")) throw new Error("议题关联Copilot调用合同不正确");
if (/(?:^|\s)(?:-p|--prompt|--allow-tool)(?:=|\s|$)/u.test(String(issueCopilotStep?.run ?? ""))) throw new Error("议题关联Copilot不得使用参数提示或启用工具");
if (String(issueReconcileStep?.env?.COPILOT_STEP_OUTCOME ?? "").replace(/\s+/gu, "") !== "${{steps.copilot.outcome}}") throw new Error("议题关联收敛没有接收Copilot结果");
const issueCleanupStep = issueLinkAnalyze?.steps?.find(step => step?.name === "删除临时议题输入输出");
if (String(issueCleanupStep?.if ?? "").replace(/\s+/gu, "") !== "always()" || issueCleanupStep?.run !== 'rm -f "$ISSUE_PREPARED_FACTS_PATH" "$ISSUE_COPILOT_PROMPT_PATH" "$ISSUE_COPILOT_OUTPUT_PATH"') throw new Error("议题关联临时输入输出没有始终清理");
for (const [step, names] of [[issuePrepareStep, ["ISSUE_PREPARED_FACTS_PATH", "ISSUE_COPILOT_PROMPT_PATH"]], [issueCopilotStep, ["ISSUE_COPILOT_PROMPT_PATH", "ISSUE_COPILOT_OUTPUT_PATH"]], [issueReconcileStep, ["ISSUE_PREPARED_FACTS_PATH", "ISSUE_COPILOT_OUTPUT_PATH"]], [issueCleanupStep, ["ISSUE_PREPARED_FACTS_PATH", "ISSUE_COPILOT_PROMPT_PATH", "ISSUE_COPILOT_OUTPUT_PATH"]]]) {
  for (const name of names) if (!String(step?.env?.[name] ?? "").includes("${{ runner.temp }}")) throw new Error(`议题关联临时路径缺少${name}`);
}
if (String(issueLinkDocument).includes("upload-artifact") || (await readFile(".github/workflows/pr-issue-link.yml", "utf8")).includes("actions/upload-artifact")) throw new Error("议题关联不得上传模型输入输出制品");
const syncInstructionsDocument = workflowDocuments.get("sync-copilot-instructions.yml");
const syncWorkflowRun = syncInstructionsDocument?.on?.workflow_run;
if (JSON.stringify(syncWorkflowRun?.workflows) !== JSON.stringify(["SPLRAD Steward / Deploy Runtime"]) || JSON.stringify(syncWorkflowRun?.types) !== JSON.stringify(["completed"])) throw new Error("Copilot说明同步没有只绑定中央部署完成事件");
const syncJob = syncInstructionsDocument?.jobs?.synchronize;
const syncCondition = String(syncJob?.if ?? "").replace(/\s+/gu, "");
for (const required of [
  "github.event_name=='workflow_dispatch'",
  "github.event.workflow_run.conclusion=='success'",
  "github.event.workflow_run.event=='push'",
  "github.event.workflow_run.head_branch==github.event.repository.default_branch",
  "github.event.workflow_run.head_repository.full_name==github.repository",
]) if (!syncCondition.includes(required)) throw new Error(`Copilot说明自动同步缺少可信触发条件: ${required}`);
const syncPolicyStep = syncJob?.steps?.find(step => step?.name === "解析已部署规则提交");
if (String(syncPolicyStep?.env?.EVENT_NAME ?? "").replace(/\s+/gu, "") !== "${{github.event_name}}" || String(syncPolicyStep?.env?.DEPLOYED_HEAD_SHA ?? "").replace(/\s+/gu, "") !== "${{github.event.workflow_run.head_sha}}" || !String(syncPolicyStep?.run ?? "").includes('process.env.RUNTIME_URL+"/health"')) throw new Error("Copilot说明同步没有从部署事件或线上健康接口解析策略提交");
const syncCheckout = syncJob?.steps?.find(step => step?.uses?.startsWith("actions/checkout@"));
if (String(syncCheckout?.with?.ref ?? "").replace(/\s+/gu, "") !== "${{steps.policy.outputs.policy_sha}}" || syncCheckout?.with?.["persist-credentials"] !== false) throw new Error("Copilot说明同步没有检出精确中央提交或仍保留检出凭据");
const syncStep = syncJob?.steps?.find(step => step?.name === "同步代码审查说明");
const syncCommand = String(syncStep?.run ?? "");
if (!syncCommand.includes('--policy-sha "$POLICY_SHA"') || /--(?:source|target|path|content)(?:\s|=)/iu.test(syncCommand)) throw new Error("Copilot说明同步允许工作流输入指定文件或内容");
if (String(syncStep?.env?.REPOSITORY_ID ?? "").replace(/\s+/gu, "") !== "${{inputs.repositoryId}}" || /\$\{\{[^}]*inputs\.repositoryId/iu.test(syncCommand)) throw new Error("Copilot说明同步把仓库编号直接拼接进shell命令");
if (String(syncStep?.env?.POLICY_SHA ?? "").replace(/\s+/gu, "") !== "${{steps.policy.outputs.policy_sha}}" || String(syncStep?.env?.SYNC_TRIGGER ?? "").replace(/\s+/gu, "") !== "${{github.event_name}}" || String(syncStep?.env?.TRIGGER_ACTOR_ID ?? "").replace(/\s+/gu, "") !== "${{github.actor_id}}" || String(syncStep?.env?.TRIGGER_ACTOR_LOGIN ?? "").replace(/\s+/gu, "") !== "${{github.actor}}") throw new Error("Copilot说明手工同步没有绑定线上策略与触发者身份");
for (const required of ['repository_arguments=()', 'repository_arguments+=(--repository-id "$REPOSITORY_ID")', '"${repository_arguments[@]}"']) {
  if (!syncCommand.includes(required)) throw new Error(`Copilot说明同步没有安全传递可选仓库编号: ${required}`);
}
const syncInputs = syncInstructionsDocument?.on?.workflow_dispatch?.inputs ?? {};
if (JSON.stringify(Object.keys(syncInputs)) !== JSON.stringify(["repositoryId"])) throw new Error("Copilot说明同步暴露了未允许的手工输入");
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
  const actionlintArguments = ["-ignore", 'unknown permission scope "copilot-requests"', "-ignore", 'unexpected key "queue" for "concurrency" section', ...files.map(file => `.github/workflows/${file}`)];
  const checked = spawnSync(executable, actionlintArguments, { encoding: "utf8" }); if (checked.status !== 0) throw new Error(checked.stdout || checked.stderr || "actionlint失败");
} finally { await rm(temporary, { recursive: true, force: true }); }
console.log("workflows verified");
