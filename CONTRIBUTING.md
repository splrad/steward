# 为 SPLRAD Steward 做贡献

SPLRAD Steward 是组织的共享自动化服务，不是通用的 GitHub 自动化产品。贡献应当针对现有 Steward 工作流、配置契约、验证规则或运行问题。

修改代码前，请阅读受影响的配置、Schema、工作流和测试。项目专用行为应保留在仓库配置中，不要在中央工作流中加入临时判断。

## 本地环境与检查

Steward 使用 Node.js `24.22.0` 和 npm `11.19.1`。

```powershell
npm ci --ignore-scripts
npm run verify
```

维护分支的工作流扫描复用已采用中央 policy 的原生工具。先在该中央 checkout 安装其 mise 锁定工具，并设置 `STEWARD_WORKFLOW_POLICY_ROOT` 为该 checkout 的绝对路径；`mise` 需在 PATH 中。本地包装入口不替代组织 required workflow。历史合同回归从本地 Git 读取准确 PR307 提交，使用完整历史 checkout。

### Actions 锁文件更新

GitHub 的组织 required workflow 使用本 PR 的 `.github/workflows/actions.lock`，因此锁必须同时覆盖维护树工作流和当前受信来源的 `.github/workflows/maintenance-validation.yml`。来源以组织维护 ruleset 的实际完整 SHA 为准；首次接入来源为 `ffc4e6aab395c0c5e2b4f5e859e24a6fef28db42`，后续随正常来源提升刷新。

使用中央 `config/actions-lock-version.txt` 固定的官方 `gh actions-lock`。在隔离目录复制候选工作流，并将当前受信来源的上述工作流原始字节放入相同路径，仅供生成依赖锁；它不作为维护分支的第二个执行入口提交。若旧锁仍将完整 SHA 映射到 tag，先备份旧锁，再从准确 YAML 重新生成。设置 `GH_ACTIONS_LOCK_REPO_ROOT` 指向隔离目录，执行 `gh actions-lock --no-narrow --no-interactive --json`，逐字节确认所有输入 YAML 未被重写，然后只将生成的锁文件带回候选。

在实际候选树执行 `gh actions-lock --verify-local` 和 `gh actions-lock --verify --no-interactive --json`，保留输出与所用来源 SHA。工具可能将外部 required workflow 根记录为 `stale-workflow` 信息项；该根仍被 GitHub 实际运行使用，不能因它不在候选目录而剪除。不要手工拼接依赖条目，也不要在生成后将 YAML 的 tag 改回 SHA 而沿用 tag-only 锁。最终以托管 required workflow 的真实运行确认覆盖完整。

`npm run verify` 会运行仓库测试、类型检查、配置验证、生成文件验证和工作流验证。针对性改动可以只运行相关检查，但要在 Pull Request 中说明未运行的项目。

修改 `packages/runner/src/index.ts` 或其依赖后，必须重建已提交的运行时文件。运行 `npm run build`，再确认 `npm run verify:dist` 通过。

## Pull Request

使用短期分支，并让一个 Pull Request 只处理一个问题。不要混入无关格式化、生成文件噪声、凭据、私有路径、客户数据或运行时密钥。

同仓和 fork 贡献都由贡献者在准备好后显式创建 PR。推送工作分支用于保存和分享修改，不会自动创建 PR，也不会自动改写已有 PR 的标题或正文。

草稿准备好后，在 PR 页面点击 **Ready for review**。PR 作者或拥有目标仓库 Write 及以上权限的用户均可操作，适用于同仓和 fork PR。机器人创建的 PR 可由具备上述仓库权限的用户操作；fork PR 作者无需上游 Write 权限。Ready 仅表示提交审查，检查、批准和人工合并仍须分别完成。

组织的 [Pull Request 模板](https://github.com/splrad/.github/blob/main/.github/pull_request_template.md)由 `splrad/.github` 维护。请在 PR 正文写明修改目的及验证结果，后续直接更新正文。按需手动关联议题：确认完整解决时使用 `Closes #编号`，部分相关时使用普通编号或链接。Steward 不自动推断、增加、移除或维护议题关联。

合并前需满足组织的 CI、线程解决和审批规则。普通贡献者的 PR 需要作者之外、有相应权限的真人批准；个人审批例外以线上规则为准，不能把本说明视为已生效的权限。新提交后应重新检查审批状态。

发现疑似安全问题时，请遵循仓库安全政策，不要在公开 Pull Request 中报告。
