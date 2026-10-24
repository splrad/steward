# 为 SPLRAD Steward 做贡献

SPLRAD Steward 是组织的共享自动化服务，不是通用的 GitHub 自动化产品。贡献应当针对现有 Steward 工作流、配置契约、验证规则或运行问题。

修改代码前，请阅读受影响的配置、Schema、工作流和测试。项目专用行为应保留在仓库配置中，不要在中央工作流中加入临时判断。

## 本地环境与检查

Steward 使用 `mise.toml`、`mise.lock` 及 `.mise/locks/` 统一管理 Node.js、npm 和验证工具。

```powershell
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

`npm run verify` 会运行仓库测试、类型检查、配置验证、生成文件验证和工作流验证。针对性改动可以只运行相关检查，但要在 Pull Request 中说明未运行的项目。

修改 `packages/runner/src/index.ts` 或其依赖后，必须重建已提交的运行时文件。运行 `npm run build`，再确认 `npm run verify:dist` 通过。

## Pull Request

使用短期分支，并让一个 Pull Request 只处理一个问题。不要混入无关格式化、生成文件噪声、凭据、私有路径、客户数据或运行时密钥。

同仓和 fork 贡献都由贡献者在准备好后显式创建 PR。推送工作分支用于保存和分享修改，不会自动创建 PR，也不会自动改写已有 PR 的标题或正文。

草稿准备好后，在 PR 页面点击 **Ready for review**。PR 作者或拥有目标仓库 Write 及以上权限的用户均可操作，适用于同仓和 fork PR。机器人创建的 PR 可由具备上述仓库权限的用户操作；fork PR 作者无需上游 Write 权限。Ready 仅表示提交审查，检查、批准和人工合并仍须分别完成。

组织的 [Pull Request 模板](https://github.com/splrad/.github/blob/main/.github/pull_request_template.md)由 `splrad/.github` 维护。请在 PR 正文写明修改目的及验证结果，后续直接更新正文。按需手动关联议题：确认完整解决时使用 `Closes #编号`，部分相关时使用普通编号或链接。Steward 不自动推断、增加、移除或维护议题关联。

合并前需满足组织的 CI、线程解决和审批规则。普通贡献者的 PR 需要作者之外、有相应权限的真人批准；个人审批例外以线上规则为准，不能把本说明视为已生效的权限。新提交后应重新检查审批状态。

发现疑似安全问题时，请遵循仓库安全政策，不要在公开 Pull Request 中报告。

## 创建与维护拉取请求

同仓和 fork 的普通贡献 PR 均由贡献者显式发起；向工作分支推送不自动创建 PR，也不自动重写既有 PR 的标题和正文。PR 作者或拥有目标仓库 Write 及以上权限的用户可使用 GitHub 原生按钮调整草稿状态。关联议题由作者按需填写，Steward 不自动推断、增加、移除或维护关联。

AI 代为创建 PR 或调整草稿状态，须有对应仓库、分支和操作的明确授权；提交或推送授权不包含创建 PR。创建前检查是否已有对应 PR，填写目的和验证情况，并回读来源、目标及草稿状态。人工关联只在确认完整解决时使用 Closes，部分相关使用普通编号或链接。审批例外由组织规则控制，不以机器人作者身份代替。
