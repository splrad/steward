# 为 SPLRAD Steward 做贡献

SPLRAD Steward 是组织的共享自动化服务，不是通用的 GitHub 自动化产品。贡献应当针对现有 Steward 工作流、配置契约、验证规则或运行问题。

修改代码前，请阅读受影响的配置、Schema、工作流和测试。项目专用行为应保留在仓库配置中，不要在中央工作流中加入临时判断。

## 本地环境与检查

Steward 使用 Node.js `24.14.1` 和 npm `11.11.0`。

```powershell
npm ci --ignore-scripts
npm run verify
```

`npm run verify` 会运行仓库测试、类型检查、配置验证、生成文件验证和工作流验证。针对性改动可以只运行相关检查，但要在 Pull Request 中说明未运行的项目。

修改 `packages/runner/src/index.ts` 或其依赖后，必须重建已提交的运行时文件。运行 `npm run build`，再确认 `npm run verify:dist` 通过。

## Pull Request

使用短期分支，并让一个 Pull Request 只处理一个问题。不要混入无关格式化、生成文件噪声、凭据、私有路径、客户数据或运行时密钥。

有本仓库写权限时，向本仓库非默认工作分支推送后等待 Steward 自动创建或更新 PR，首次创建为草稿。没有对应 PR 时先检查自动化；仍在运行则等待，状态不明则先核查，确认机器人故障、无法自动创建且仍无对应 PR 后才手动补建。通过 fork 贡献时，从自己的 fork 向本仓库创建 PR，无需等待机器人代开。

草稿准备好后，在 PR 页面点击 **Ready for review**。同仓 PR 可由拥有本仓库 Write 或更高权限的用户操作，即使作者是机器人；fork PR 可由创建者凭作者身份操作，无需上游 Write 权限。Ready 仅表示提交审查，检查、批准和人工合并仍须分别完成。

组织的 [Pull Request 模板](https://github.com/splrad/.github/blob/main/.github/pull_request_template.md)由 `splrad/.github` 维护。手动创建时填写标题和变更说明，保留受管标记。Steward 后续可能重建其管理的 PR 标题和完整正文；需要保留的补充说明和验证证据请写入 PR 评论。涉及仓库治理、权限或事件处理的改动，不能只用通过的检查代替变更说明。

发现疑似安全问题时，请遵循仓库安全政策，不要在公开 Pull Request 中报告。
