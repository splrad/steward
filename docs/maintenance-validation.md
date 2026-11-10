# 共享运行时维护检查

`maintenance-validation.yml` 是 `maintenance/legacy-runtime-e990eda` 的独立受信检查入口。采用方必须先通过组织 ruleset 将来源固定到本仓库已合并的准确 SHA；相同名称的状态检查不能替代来源绑定。它不授权部署、D1 迁移、秘密读取或合并。

检查只接收同仓 open PR，核对准确 base/head/merge、有效 head 签名及受信 workflow 来源。source/final 两个独立 job 前后读取原生身份；候选代码只在另一只读 job 执行。来源变化、缺失、失败或跳过必需 job 均拒绝。required workflow 不使用并发取消设置；旧结果通过最终来源检查和分支 strict 规则失效。

中央工具由受信提交的 `mise.toml` / `mise.lock` 提供，GitHub API 由 `githubHeaders` 和 `config/github-api.json` 提供。维护测试读取既有 `.node-version`，并核对实际 npm 与 `package.json` 的 `packageManager`。`config/maintenance-ci.json` 的 `toolchainSource` 指向经审查批准的维护源码，候选版本必须与其一致。引用只记录批准来源，版本值不复制到 CI。

持续版本发现由现有 Mend/Renovate 的原生 nodenv/npm 管理器负责，覆盖 `.node-version`、`engines.node` 和 `packageManager`；更新配置由组件更新流程单独采用。发现结果须经过维护 PR 验证与中央批准来源更新，才成为准入依据。

工具升级需同步审查 `.node-version`、`engines.node`、`packageManager`、旧发行工具合同及相关测试，验证真实安装环境，然后推进中央批准来源。npm 与 Node 自带版本不符时检查失败，须准备受审的锁定安装路径，不能通过临时未锁定安装绕过。

工作流清单及非 Action SHA 语义由中央摘要约束；完整 Action 引用另由中央 `allowedActions` 检查。npm scripts、验证脚本和现有测试/编译配置须与 `validationSource` 的批准来源一致，修改检查实现须先经中央审查采用。维护树原有 Action allowlist、完整工作流合同、测试和 runner dist 验证仍必须通过；SHA 归一化不等于批准某个 Action 更新。权限、命令、队列或事件变化须先在中央受审采用，再进入维护 PR。PR307 的一次性 evaluator 与原合同保留。

首次采用顺序为：中央代码及全部审查/CI → 组织 required-workflow 来源绑定 → 维护入口切换 PR 的真实检查 → 必需检查名切换。保留签名、strict、标题、人工审批和线程解决要求；最终 head 的 Copilot、Codex code/security 及意见裁定独立记录，security null 为未知。源码采用完成后，服务切换仍需独立满足消费者、在途与恢复前置。

参考：[GitHub ruleset workflow 并发限制](https://docs.github.com/en/enterprise-cloud%40latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/troubleshooting-rules#concurrency)。
