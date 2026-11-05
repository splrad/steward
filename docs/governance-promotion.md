# 治理版本提升

[Governance Promotion](../.github/workflows/governance-promotion.yml) 核验中央 Native Validation 的真实 workflow ID、路径、仓库 ID、main push、当前提交和完整 jobs。范围与汇总 job 必须成功；可信工作流中按范围选择的 job 可为 skipped，其适用性由成功的汇总核验。其他失败、取消或缺失结果都会阻断采用。它从默认分支受审源码执行，并在获取治理 App 安装令牌前再次核对 main。

workflow_run 只接收 main 分支事件，job 先筛选中央仓库的成功 main push。独立预检步骤使用只读 token，未注入治理私钥；其结果只决定是否进入后续步骤。获取治理凭据的步骤重新读取原生来源和当前 main，预检文件不能充当写授权。

扫描采用独立决策 `E07-PROMOTION-WORKFLOW-RUN-20261031`：只接受 `.github/workflows/governance-promotion.yml` 的准确 `on.workflow_run` 原生 dangerous-triggers 诊断。原始扫描结果和非零退出码保留；其他发现继续失败。此诊断例外不替代事件来源、ref、job 权限、environment 和写入前复核，也不改变工作流修改的常规审查要求。

采用前设置真实 `NATIVE_VALIDATION_WORKFLOW_ID`、`GOVERNANCE_APP_ID` 和 `steward-automation/GOVERNANCE_APP_PRIVATE_KEY`，完成首次模板标签与组织规则交接，再启用 `STEWARD_GOVERNANCE_PROMOTION`。这些原生登记和部署状态需要分别回读；本地实现不等于线上启用。

提升与 bootstrap 共用 `steward-governance-mutation` 原生 job 并发组。只更新 Ruleset 18883080 中中央 Native Validation 条目的 `sha`；其他规则与未知字段来自写前最新完整读取。证据保存完整写前、写后对象。原生 PUT 没有 CAS 保证：写后若出现无法合并的外部修改，任务失败并保留事实；丢失响应时先回读，已采用目标 SHA 即成功，仍为旧值才可重试，第三值重新读取后判断。

模板比较只包含 `copier.yml` 和 `templates/repository`。实际变化从最新已采用 PEP 440 稳定版本生成严格递增标签，标签固定到同一个已验证提交。SDK 单独变化不产生模板版本。标签创建前后核对全部标签快照和目标指向；同名异对象、外部标签漂移和未知响应不执行覆盖。下一次原生 Copier 递送从已发布标签继续。

原生 Run 的证据产物含来源、规则前后状态和模板计划，不含令牌。故障恢复使用原 Run 重跑；旧 main 的运行只记录过期结果。每日补扫会重新查询当前 main 的原生验证结果。历史 SQL 保留在 [runtime](../packages/runtime/history/README.md)，不参与新入口的授权。
