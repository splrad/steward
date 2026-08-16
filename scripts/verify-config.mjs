import { readFile, readdir, stat } from "node:fs/promises";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const pairs = [
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
const release = JSON.parse(await readFile("config/profiles/release/layerscape.json", "utf8"));
if (release.build.projects.length !== 10 || new Set(release.build.projects.map(x => x.path)).size !== 10) throw new Error("LayerScape插件项目必须恰好10个且不重复");
if (release.assets.length !== 3 || new Set(release.assets.map(x => x.nameTemplate)).size !== 3) throw new Error("发布资产必须恰好3项且不重复");
const classification = JSON.parse(await readFile("config/profiles/classification/layerscape.json", "utf8")); if (classification.releaseCategories.filter(x => x.fallback).length !== 1) throw new Error("发布回退类别必须恰好一个");
const forbiddenRuntime = ["queues", "durable_objects", "kv_namespaces", "d1_databases", "r2_buckets", "services", "triggers"];
const wrangler = await readFile("packages/runtime/wrangler.toml", "utf8"); for (const name of forbiddenRuntime) if (wrangler.includes(name)) throw new Error(`运行配置包含禁止绑定: ${name}`);
console.log("configuration verified");
