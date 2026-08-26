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

组织的 Pull Request 模板由本项目管理。保留其中的受管标记，并在“人工补充”部分写入实际验证证据。涉及仓库治理、权限或事件处理的改动，不能只用通过的检查代替变更说明。

发现疑似安全问题时，请遵循仓库安全政策，不要在公开 Pull Request 中报告。
