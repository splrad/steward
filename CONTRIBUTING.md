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

`verify:dist` 重建并逐字节比较 `packages/runner/dist/index.js`，结果须对应当前目标提交。产物一致性、行为、权限和配置分别验证。

## GitHub Actions 锁文件

修改本仓 `.github/workflows/` 的 Action 依赖后，使用 `config/actions-lock-version.txt` 指定的官方 `github/gh-actions-lock` 版本，在仓库根目录运行：

```bash
set -euo pipefail
ACTIONS_LOCK_VERSION="$(cat config/actions-lock-version.txt)"
[[ "$ACTIONS_LOCK_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
gh extension install github/gh-actions-lock --pin "$ACTIONS_LOCK_VERSION" --force
gh actions-lock --no-narrow --no-interactive
gh actions-lock --verify --no-interactive
```

保留 workflow 的完整 SHA `uses` 及锁中对应的 SHA 键。提交前核对完整差异，包括每个 workflow 的依赖集合、Action commit、版本 ref、`owner_id` 和 `repo_id`。不要手工改锁。普通生成可能将 SHA 引用改为版本 tag，因此本仓生成使用 `--no-narrow`；只读 `--verify` 不改写文件。

[GitHub 官方说明](https://docs.github.com/en/actions/how-tos/secure-your-work/lock-workflow-dependencies#5-keep-the-lockfile-current)指出，Dependabot 会为已纳入锁的 workflow 在版本更新 PR 中同步更新锁。更新 PR 的维护者仍须检查实际 workflow 与锁差异；如锁未同步、缺少对应 SHA 键或验证失败，应运行上述固定版本命令重新生成并将必要的锁变更提交到同一 PR，再完成验证和实际 CI。新增 workflow 应先用上述官方命令纳入锁。工具版本更新后也应复核生成结果，不把一次验证通过视为后续格式不变的保证。

## Pull Request

使用短期分支，并让一个 Pull Request 只处理一个问题。不要混入无关格式化、生成文件噪声、凭据、私有路径、客户数据或运行时密钥。

同仓和 fork 贡献都由贡献者在准备好后显式创建 PR。推送工作分支用于保存和分享修改，不会自动创建 PR，也不会自动改写已有 PR 的标题或正文。

草稿准备好后，在 PR 页面点击 **Ready for review**。PR 作者或拥有目标仓库 Write 及以上权限的用户均可操作，适用于同仓和 fork PR。机器人创建的 PR 可由具备上述仓库权限的用户操作；fork PR 作者无需上游 Write 权限。Ready 仅表示提交审查，检查、批准和人工合并仍须分别完成。

组织的 [Pull Request 模板](https://github.com/splrad/.github/blob/main/.github/pull_request_template.md)由 `splrad/.github` 维护。请在 PR 正文写明修改目的及验证结果，后续直接更新正文。按需手动关联议题：确认完整解决时使用 `Closes #编号`，部分相关时使用普通编号或链接。Steward 不自动推断、增加、移除或维护议题关联。

合并前需满足组织的 CI、线程解决和审批规则。普通贡献者的 PR 需要作者之外、有相应权限的真人批准；个人审批例外以线上规则为准，不能把本说明视为已生效的权限。新提交后应重新检查审批状态。

发现疑似安全问题时，请遵循仓库安全政策，不要在公开 Pull Request 中报告。

## 代码边界

发布周期的纯状态转换、来源、版本和字节校验位于 core；网络、环境变量、当前时间和供应商调用由 runner 或官方 SDK 边界提供，测试显式传入观察与时间。以当前实际模块为准，不恢复已退役的通用授权和执行框架。

外部写入使用任务所需的最小权限和准确对象。审查评论、检查通过与合并、发布授权分别记录；自动化仅执行已经启用的职责。

## 提交变更与审查

PR 说明应包含实际问题、变更、影响、验证结果及适用的恢复方式，并区分已执行、未执行和环境受限的检查。更新正文时应保留有效的人工补充内容。

审查线程标记解决前，须依据当前 head 核对原问题的处理结果，并在原线程记录处理依据及验证情况。存在未决冲突或证据不足时，线程保持未解决状态；评论过时本身不构成问题已解决的证据。
