# SPLRAD Steward

SPLRAD Steward 是 [`splrad`](https://github.com/splrad) 组织的共享仓库自动化中枢。拉取请求处理、仓库接入、Copilot 说明同步和发布规则集中保存在这里，受管仓库无需复制整套工作流，也不需要保存 Steward 的中央凭据。

本项目按 SPLRAD 当前的仓库和维护方式设计，不是通用的 GitHub 自动化产品，也没有提供开箱即用的 Marketplace 安装包。

## 项目亮点

- 检查拉取请求：原生入口校验标题、维护路径标签并运行适用验证；Copilot 审查由平台提供，Steward 只读核验当前 head 的审查证据。普通 PR 的标题、正文和议题关联由作者维护。
- 维护治理与产品配置：safe-settings 管理仓库设置，Copier 递送受管文件，产品仓库声明构建与发行身份；对应配置分别校验。
- 接入新的公共仓库：按组织默认策略检查并补齐受管文件，通过拉取请求交付变更。
- 管理 LayerScape 发布：校验版本与目标提交，生成发布资产和说明，发布后再读回核对。
- 隔离中央权限：Steward 不会用中央凭据执行拉取请求中的代码；运行时、Copilot、发布和部署凭据留在各自的中央环境中。

## 快速开始

本地工具由 `mise.toml` 声明、`mise.lock` 及 `.mise/locks/` 锁定。先安装 mise，再按锁恢复工具。

```powershell
git clone https://github.com/splrad/steward.git
Set-Location steward
$env:MISE_SAFE = '1'
$env:MISE_NODE_COMPILE = 'false'
mise install --locked
if ($LASTEXITCODE -ne 0) { throw '工具安装失败' }
mise exec -- npm ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
mise exec -- npm run build
if ($LASTEXITCODE -ne 0) { throw '构建失败' }
mise exec -- npm run verify
if ($LASTEXITCODE -ne 0) { throw '验证失败' }
```

`npm run verify` 会依次运行测试、TypeScript 类型检查、配置校验、生成文件校验和工作流校验。

常用的单项命令：

```powershell
npm test
npm run typecheck
npm run verify:config
npm run verify:dist
npm run verify:workflows
```

## 工作方式

Steward 的入口由原生 GitHub Actions 承担：发行协调、产品构建与渠道观察、仓库接入、Copier 递送、设置同步、依赖更新和验证。仓库范围来自 App 安装与原生仓库配置；产品构建和发行身份保存在产品仓库。各入口的采用变量、Environment 与组织规则在部署阶段分别核验。

中央 Native Validation 对准确 base/head 运行适用检查。governance-promotion 在核实中央 main push 的完整成功结果后，提升组织 required workflow 的固定 SHA，并为实际模板变更创建递增的 Copier 标签。首次模板版本、原生 workflow ID 和治理 App 身份必须先完成采用登记。实现和恢复方式见 [治理提升](docs/governance-promotion.md)。

Copilot 审查成功需要当前 PR head 的有效 Review 摘要和对应的成功 Check。摘要支持 `Findings` 与 `open findings` 格式。fork 的 Copilot Check 可能挂在目标分支提交上；此时通过 GitHub 的 Copilot 动态运行身份、同一次尝试的 job/check，以及平台处理步骤首次检出前的 PR、diff 和来源 head 日志确认归属，保留 Check 原始 SHA。拉取请求自动化的短时令牌需要 `actions:read` 读取这些证据。运行重叠、归属不明、日志不可读、查询超过上限或读取期间状态变化时返回 `unknown`。

管理员可在可信中央环境中运行只读观察命令，检查同仓或 fork PR 的当前审查状态：

```sh
node packages/runner/dist/index.js observe-copilot-review --repository-id REPOSITORY_ID --pull-request-number PR_NUMBER --event-head-sha HEAD_SHA
```

命令使用调用方提供的只读 `GITHUB_TOKEN`，通过官方 Octokit 读取组织内未归档、未禁用仓库的开放 PR。读取前后核对仓库 ID、组织 ID、默认分支和当前 head；输出 JSON 状态及 `state`、`reason`、`headSha`。它保留 fork 日志归属、完整分页、状态漂移和下载令牌隔离检查。

默认分支的 [Native Review](.github/workflows/native-review.yml) 只接受手动调用，输入为 `repositoryId`、`pullRequestNumber`、`eventAfterSha`。该工作流使用原生只读 token；工作流成功表示完成读取，审查结论以返回的 `state` 为准。

发布说明从固定 Git 来源、已审单位文稿和冻结贡献者事实生成，采用同一份[正式发布模板](docs/release-notes.md)。协调器还观察五个固定中央工作流，按准确原 Run 执行[有限维护恢复](docs/maintenance.md)。

受管仓库只保留项目自己的代码和必要配置。中央工作流、GitHub App 私钥及其他中央凭据不会复制过去。

## 目录说明

```text
config/                 治理登记、Copilot 说明和固定工具配置
packages/core/          不依赖 GitHub I/O 的规则与决策逻辑
packages/github/        GitHub API、App 身份和上传适配
packages/runner/        GitHub Actions 命令入口及已提交的运行文件
packages/runtime/       历史 SQL 只读导出、迁移和原恢复描述
schema/                 配置文件的 JSON Schema
scripts/                构建及一致性校验脚本
.github/workflows/      原生协调、验证、接入、同步和发布流程
```

## 修改约定

- 创建 PR 页面的提示维护在 [`splrad/.github/.github/pull_request_template.md`](https://github.com/splrad/.github/blob/main/.github/pull_request_template.md)；页面文案统一在组织仓库中修改和发布。
- 审查指引直接维护两份完整 Markdown：[组织 Copilot 指令](config/review/copilot-organization.md)和[统一 AGENTS 模板](templates/repository/AGENTS.md)。组织稿通过组织设置采用并回读，仓库文件由 Copier 递送；专项事实保存在各仓 CONTRIBUTING。变更与验证步骤见 [审查说明](config/review/README.md)。
- 仓库范围由原生安装和实际配置发现；产品构建命令维护在产品 YAML，模板采用事实由 Copier answers 记录。历史发行只从冻结的原提交解码原目录。
- 修改 `packages/runner/src/index.ts` 或相关依赖后，运行 `npm run build` 更新 `packages/runner/dist/index.js`。
- `packages/runner/dist/index.js` 是已提交的运行文件，必须与当前源码构建结果一致；`npm run verify:dist` 会检查这一点。
- 提交前运行 `npm run verify`。工作流、Schema 或配置变化不应跳过对应校验。

## 安全

发现疑似安全问题时，请按 [SECURITY.md](SECURITY.md) 私下报告。不要在 Issue 或拉取请求中提交令牌、私钥、webhook 签名、私有仓库路径或其他敏感数据。

## 许可证

本项目使用 [Apache License 2.0](LICENSE)。
