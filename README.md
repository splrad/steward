# SPLRAD Steward

SPLRAD Steward 是 [`splrad`](https://github.com/splrad) 组织的共享仓库自动化中枢。拉取请求处理、仓库接入、Copilot 说明同步和发布规则集中保存在这里，受管仓库无需复制整套工作流，也不需要保存 Steward 的中央凭据。

本项目按 SPLRAD 当前的仓库和维护方式设计，不是通用的 GitHub 自动化产品，也没有提供开箱即用的 Marketplace 安装包。

## 项目亮点

- 自动收敛拉取请求：在受管仓库中协调分支推送、拉取请求标题与正文、分类标签、Copilot 审查请求和验证结果。
- 集中维护规则：仓库清单、分类、验证、发布及 Copilot 配置均有明确的结构和 Schema，项目差异保留在对应配置中。
- 接入新的公共仓库：按组织默认策略检查并补齐受管文件，通过拉取请求交付变更。
- 管理 LayerScape 发布：校验版本与目标提交，生成发布资产和说明，发布后再读回核对。
- 隔离中央权限：Steward 不会用中央凭据执行拉取请求中的代码；运行时、Copilot、发布和部署凭据留在各自的中央环境中。

## 快速开始

本地开发需要 Node.js `24.14.1` 和 npm `11.11.0`。

```powershell
git clone https://github.com/splrad/steward.git
Set-Location steward
npm ci --ignore-scripts
npm run verify
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

Steward 由无状态 webhook 运行时接收组织事件，再把需要中央权限的任务分派给本仓库中的 GitHub Actions。当前主要流程包括：

1. 接收并核对仓库、事件和策略版本。
2. 根据 `config/repositories.json` 解析仓库是否受管，以及应使用的分类、验证、Copilot 和发布配置。
3. 调度拉取请求自动化、分类、验证、仓库接入、说明同步或发布任务。
4. 将结果写回目标仓库，并保留可复核的检查摘要。

受管仓库只保留项目自己的代码和必要配置。中央工作流、GitHub App 私钥及其他中央凭据不会复制过去。

## 目录说明

```text
config/                 仓库清单、Copilot 说明和各类配置档案
packages/core/          不依赖 GitHub I/O 的规则与决策逻辑
packages/github/        GitHub API、App 身份和上传适配
packages/runner/        GitHub Actions 命令入口及已提交的运行文件
packages/runtime/       webhook 运行时
schema/                 配置文件的 JSON Schema
scripts/                构建及一致性校验脚本
.github/workflows/      中央调度、验证、接入、同步、部署和发布流程
```

## 修改约定

- 仓库范围和项目差异写入 `config/repositories.json` 及其引用的配置档案，不在工作流中散落特殊判断。
- 修改 `packages/runner/src/index.ts` 或相关依赖后，运行 `npm run build` 更新 `packages/runner/dist/index.js`。
- `packages/runner/dist/index.js` 是已提交的运行文件，必须与当前源码构建结果一致；`npm run verify:dist` 会检查这一点。
- 提交前运行 `npm run verify`。工作流、Schema 或配置变化不应跳过对应校验。

## 安全

发现疑似安全问题时，请按 [SECURITY.md](SECURITY.md) 私下报告。不要在 Issue 或拉取请求中提交令牌、私钥、webhook 签名、私有仓库路径或其他敏感数据。

## 许可证

本项目使用 [Apache License 2.0](LICENSE)。
