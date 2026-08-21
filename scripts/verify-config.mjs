import { readFile, readdir, stat } from "node:fs/promises";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const pairs = [
  ["config/labels/pr-semantics.json", "schema/pr-semantics.schema.json"],
  ["config/repositories.json", "schema/repositories.schema.json"],
  ["config/profiles/classification/default.json", "schema/classification-profile.schema.json"],
  ["config/profiles/classification/layerscape.json", "schema/classification-profile.schema.json"],
  ["config/profiles/validation/public-basic.json", "schema/validation-profile.schema.json"],
  ["config/profiles/validation/layerscape.json", "schema/validation-profile.schema.json"],
  ["config/profiles/validation/steward.json", "schema/validation-profile.schema.json"],
  ["config/profiles/release/layerscape.json", "schema/release-profile.schema.json"],
];
const ajv = new Ajv({ allErrors: true, strict: false }); addFormats(ajv);
const validators = new Map();
for (const [dataPath, schemaPath] of pairs) {
  const data = JSON.parse(await readFile(dataPath, "utf8")); const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  let validate = validators.get(schemaPath);
  if (!validate) { validate = ajv.compile(schema); validators.set(schemaPath, validate); }
  if (!validate(data)) throw new Error(`${dataPath}不符合结构: ${ajv.errorsText(validate.errors)}`);
}
const catalog = JSON.parse(await readFile("config/repositories.json", "utf8")); const ids = Object.keys(catalog.repositories); if (new Set(ids).size !== ids.length) throw new Error("仓库编号重复");
const repositoryValidator = validators.get("schema/repositories.schema.json");
const sampleRepository = Object.values(catalog.repositories)[0];
if (!repositoryValidator || !sampleRepository) throw new Error("仓库配置反例验证缺少基础数据");
const invalidRepositoryKeyCatalog = { ...catalog, repositories: { ...catalog.repositories, invalid: sampleRepository } };
if (repositoryValidator(invalidRepositoryKeyCatalog)) throw new Error("仓库编号schema允许非数字键");
const emptyRepositoryCatalog = { ...catalog, repositories: {} };
if (repositoryValidator(emptyRepositoryCatalog)) throw new Error("仓库目录schema允许空集合");
const invalidDefaultWorkflowCatalog = structuredClone(catalog);
invalidDefaultWorkflowCatalog.defaults.public.allowedWorkflowPaths = ["README.md"];
if (repositoryValidator(invalidDefaultWorkflowCatalog)) throw new Error("默认仓库配置允许非工作流路径");
const invalidRepositoryWorkflowCatalog = structuredClone(catalog);
invalidRepositoryWorkflowCatalog.repositories[ids[0]].allowedWorkflowPaths = ["docs/workflow.yml"];
if (repositoryValidator(invalidRepositoryWorkflowCatalog)) throw new Error("单仓配置允许非工作流路径");
const semantics = JSON.parse(await readFile("config/labels/pr-semantics.json", "utf8"));
const primaryIds = semantics.roles.primaryKind.definitions.map(x => x.id);
const exactRoles = {
  primaryKind: ["feature", "bug", "performance", "refactor", "test", "build", "documentation", "workflow", "chore"],
  riskFlags: ["security", "breaking-change"],
  areas: ["area:source", "area:test", "area:workflow", "area:automation", "area:docs", "area:config", "area:runtime", "area:release"],
  facets: ["dependencies", "github_actions", "javascript", "config", "revert", "style", "localization"],
};
for (const [role, expected] of Object.entries(exactRoles)) if (JSON.stringify(semantics.roles[role].definitions.map(x => x.id)) !== JSON.stringify(expected)) throw new Error(`中央语义目录${role}不是v1固定集合`);
const exactManagement = { primaryKind: { metadataOwner: "steward", assignmentOwner: "steward", reconcile: "exclusive-replace" }, riskFlags: { metadataOwner: "steward", assignmentOwner: "shared", reconcile: "provenance-aware-set" }, areas: { metadataOwner: "steward", assignmentOwner: "steward", reconcile: "authoritative-set" }, facets: { metadataOwner: "steward", assignmentOwner: "shared", reconcile: "provenance-aware-set" } };
for (const [role, expected] of Object.entries(exactManagement)) for (const [name, value] of Object.entries(expected)) if (semantics.roles[role].management[name] !== value) throw new Error(`中央语义目录${role}管理合同无效`);
if (JSON.stringify(primaryIds) !== JSON.stringify(semantics.roles.primaryKind.order)) throw new Error("主类定义顺序与order不一致");
const roleDefinitions = Object.values(semantics.roles).flatMap(role => role.definitions);
const definitionIds = roleDefinitions.map(x => x.id); if (new Set(definitionIds).size !== definitionIds.length) throw new Error("中央语义定义编号重复");
const physicalNames = roleDefinitions.flatMap(x => x.githubLabel ? [x.githubLabel.name.toLowerCase()] : []);
if (new Set(physicalNames).size !== physicalNames.length) throw new Error("中央物理标签名称跨角色重复");
const profiles = new Map();
for (const name of ["default", "layerscape"]) {
  const profile = JSON.parse(await readFile(`config/profiles/classification/${name}.json`, "utf8")); profiles.set(name, profile);
  const fileSets = new Set(Object.keys(profile.fileSets)); const textSets = new Set(Object.keys(profile.commitTextSets));
  const allRules = [...profile.rules.primaryKind, ...profile.rules.riskFlags, ...profile.rules.facets, ...profile.areas];
  const ruleIds = allRules.map(x => x.id); if (new Set(ruleIds).size !== ruleIds.length) throw new Error(`${name}规则编号重复`);
  for (const rule of allRules) {
    for (const set of rule.match.fileSets ?? []) if (!fileSets.has(set)) throw new Error(`${name}引用未知fileSet: ${set}`);
    for (const set of rule.match.commitTextSets ?? []) if (!textSets.has(set)) throw new Error(`${name}引用未知commitTextSet: ${set}`);
  }
  for (const set of [...profile.runtimeRelease.includeFileSets, ...profile.runtimeRelease.excludeFileSets, ...profile.installOrPackage.fileSets]) if (!fileSets.has(set)) throw new Error(`${name}发布事实引用未知fileSet: ${set}`);
  for (const patterns of Object.values(profile.commitTextSets)) for (const pattern of patterns) new RegExp(pattern, "iu");
  if (profile.releaseCategories.filter(x => x.fallback).length !== (profile.releaseCategories.length ? 1 : 0)) throw new Error(`${name}发布回退类别数量无效`);
}
const classificationProfileValidator = validators.get("schema/classification-profile.schema.json");
const layerscapeProfile = profiles.get("layerscape");
if (!classificationProfileValidator || !layerscapeProfile) throw new Error("分类配置反例验证缺少基础数据");
const nonFallbackIndex = layerscapeProfile.releaseCategories.findIndex(category => !category.fallback);
const fallbackIndex = layerscapeProfile.releaseCategories.findIndex(category => category.fallback);
if (nonFallbackIndex < 0 || fallbackIndex < 0) throw new Error("分类配置反例验证缺少发布类别");
const missingMatchProfile = structuredClone(layerscapeProfile);
delete missingMatchProfile.releaseCategories[nonFallbackIndex].matchAny;
if (classificationProfileValidator(missingMatchProfile)) throw new Error("发布类别schema允许非回退类别缺少matchAny");
const matchedFallbackProfile = structuredClone(layerscapeProfile);
matchedFallbackProfile.releaseCategories[fallbackIndex].matchAny = structuredClone(layerscapeProfile.releaseCategories[nonFallbackIndex].matchAny);
if (classificationProfileValidator(matchedFallbackProfile)) throw new Error("发布类别schema允许回退类别包含matchAny");
for (const configuration of [...Object.values(catalog.defaults), ...Object.values(catalog.repositories)]) {
  const profile = profiles.get(configuration.classification.profile); if (!profile) throw new Error("仓库引用未知分类profile");
  const classification = configuration.classification;
  if (classification.labelAssignmentMode === "enforce" && classification.labelDefinitionMode !== "enforce") throw new Error("PR标签enforce要求定义enforce");
  if (classification.ai.mode === "shadow" && (classification.ai.adoptedPrimaryKinds.length || classification.ai.canaries.length)) throw new Error("shadow模式不得配置采用主类或canary");
  if (classification.ai.mode !== "shadow" && (!classification.ai.adoptedPrimaryKinds.length || classification.labelAssignmentMode !== "enforce")) throw new Error("AI采用要求主类集合和PR标签enforce");
  if (classification.ai.mode === "draft-canary" && !classification.ai.canaries.length) throw new Error("draft-canary必须配置精确canary");
  if (classification.ai.mode !== "draft-canary" && classification.ai.canaries.length) throw new Error("只有draft-canary允许canary清单");
  for (const kind of classification.ai.adoptedPrimaryKinds) if (!profile.ai.eligiblePrimaryKinds.includes(kind)) throw new Error(`仓库采用未知AI主类: ${kind}`);
}
const release = JSON.parse(await readFile("config/profiles/release/layerscape.json", "utf8"));
if (release.build.projects.length !== 10 || new Set(release.build.projects.map(x => x.path)).size !== 10) throw new Error("LayerScape插件项目必须恰好10个且不重复");
if (release.assets.length !== 3 || new Set(release.assets.map(x => x.nameTemplate)).size !== 3) throw new Error("发布资产必须恰好3项且不重复");
const forbiddenRuntime = ["queues", "durable_objects", "kv_namespaces", "r2_buckets", "services", "triggers"];
const wrangler = await readFile("packages/runtime/wrangler.toml", "utf8");
for (const name of forbiddenRuntime) if (wrangler.includes(name)) throw new Error(`运行配置包含禁止绑定: ${name}`);
const wranglerLines = wrangler.split(/\r?\n/u);
const arrayTables = wranglerLines.filter(line => /^\[\[[^\]]+\]\]$/u.test(line));
if (JSON.stringify(arrayTables) !== JSON.stringify(["[[d1_databases]]"])) throw new Error("运行配置必须恰好包含一个D1绑定");
const d1Start = wranglerLines.indexOf("[[d1_databases]]");
const d1EndOffset = wranglerLines.slice(d1Start + 1).findIndex(line => /^\[[^\]]+\]$/u.test(line));
const d1End = d1EndOffset < 0 ? wranglerLines.length : d1Start + 1 + d1EndOffset;
const actualD1Block = wranglerLines.slice(d1Start, d1End).filter(Boolean);
const expectedD1Block = [
  "[[d1_databases]]",
  'binding = "ISSUE_SNAPSHOTS"',
  'database_name = "splrad-steward-issue-snapshots"',
  'database_id = "75ae2ef8-683d-4a44-b113-e58961473d03"',
  'migrations_dir = "migrations"',
];
if (JSON.stringify(actualD1Block) !== JSON.stringify(expectedD1Block)) throw new Error("运行配置的D1绑定不符合固定合同");
console.log("configuration verified");
