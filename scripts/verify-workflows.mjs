import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const expected = ["deploy-runtime.yml", "onboard-repository.yml", "pr-automation.yml", "pr-classification.yml", "pr-validation.yml", "release.yml", "sync-copilot-instructions.yml"];
const files = (await readdir(".github/workflows")).sort();
if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error(`工作流集合不正确: ${files.join(", ")}`);
const allowedActions = new Set([
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  "actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68", "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
]);
const forbidden = [/issue.*comment/iu, /DCO/iu, /validation-matrix/iu, /durable.?object/iu, /queue/iu, /relay/iu, /secrets:\s*inherit/iu];
for (const file of files) {
  const text = await readFile(`.github/workflows/${file}`, "utf8"); YAML.parse(text);
  for (const match of text.matchAll(/uses:\s*([^\s}]+)/gu)) if (!allowedActions.has(match[1])) throw new Error(`${file}使用未锁定操作: ${match[1]}`);
  for (const pattern of forbidden) if (pattern.test(text)) throw new Error(`${file}包含终态禁止内容: ${pattern}`);
}
const prAutomation = await readFile(".github/workflows/pr-automation.yml", "utf8");
if (!prAutomation.includes("copilot-requests: write") || !prAutomation.includes("GITHUB_TOKEN: ${{ github.token }}")) throw new Error("Copilot CLI没有使用内置GITHUB_TOKEN及其最小权限");
if (/COPILOT_CLI_TOKEN|COPILOT_GITHUB_TOKEN/u.test(prAutomation)) throw new Error("Copilot CLI仍引用长期个人令牌");
const deployRuntime = await readFile(".github/workflows/deploy-runtime.yml", "utf8");
for (const required of ["id: deploy", "tee \"$deployment_log\"", "PIPESTATUS[0]", "复核运行程序健康状态", "steps.deploy.outputs.runtime_url", "EXPECTED_POLICY_SHA", "Date.now() + 60_000", "AbortSignal.timeout", "status: \"waiting\"", "iu.test(body.version)", "健康复核在60秒内未收敛"]) {
  if (!deployRuntime.includes(required)) throw new Error(`部署工作流缺少固定健康复核合同: ${required}`);
}
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
  const actionlintArguments = ["-ignore", "unknown permission scope \\\"copilot-requests\\\"", ...files.map(file => `.github/workflows/${file}`)];
  const checked = spawnSync(executable, actionlintArguments, { encoding: "utf8" }); if (checked.status !== 0) throw new Error(checked.stdout || checked.stderr || "actionlint失败");
} finally { await rm(temporary, { recursive: true, force: true }); }
console.log("workflows verified");
