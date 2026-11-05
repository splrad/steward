# 工作流验证

中央 [Native Validation](../.github/workflows/pr-validation-native.yml) 从 `job.workflow_repository`、`job.workflow_sha`、`job.workflow_file_path` 取得受信源 P，检出准确的候选 head H。PR 基点还必须与检出时的目标分支一致；main push 使用事件的 before/after。身份检查拒绝缺失对象、浅克隆和来源不符。

固定完整 SHA 的 `dorny/paths-filter` 使用 Git 模式读取准确 base/head，关闭 token，不持久化检出凭据；改名按删除旧路径和新增路径检查。source、dependency、docs、governance 四类过滤器内联在 P 的 YAML 中，候选不能提供自己的过滤策略。原生输出直接驱动 job 的 `if`。普通文档变更运行链接检查；治理输入、共享依赖、构建入口和未知影响路径触发相应检查。源码 job 直接运行 npm 验证或 Windows .NET restore/build，治理 job 执行 JSON/YAML、指令载体和实际工作流扫描。Windows 还解析 PowerShell/MSBuild 文件。

jactionlint、shellcheck、pyflakes 与 zizmor 使用中央锁定工具扫描真实 YAML。候选的忽略配置不能关闭检查。标题入口按已批准的 `E07-TITLE-METADATA-20261028` 固定元数据例外处理；原始诊断、退出码和其他失败保留。扫描工具直接支持 queue 和 `job.workflow_*`，无需旧的工作流镜像或任务解释器。

zizmor 的两个已采用例外只匹配原生 `dangerous-triggers` 诊断的准确文件路径和事件位置：中央及模板的 `pr-title.yml` 中 `on.pull_request_target`，以及中央 `governance-promotion.yml` 中 `on.workflow_run`。后者的决策为 `E07-PROMOTION-WORKFLOW-RUN-20261031`。其他位置、其他诊断、无效输出和工具异常均失败。工作流权限和写入边界由实际入口及常规审查核验，具体见 [治理提升](governance-promotion.md)。

dependency-review 比较准确 base/head，采用 high 阈值，覆盖 runtime、development、unknown，等待原生快照告警最多 600 秒，不回写 PR。NuGet 实际直接/传递覆盖和组织 required workflow 的平台强制仍须在隔离及线上采用阶段取证。

DOC-LINK 读取改变的当前文档及受影响目标的当前引用。lychee 校验本地路径、图片和可识别锚点；Linux 联网前必须通过原生 nft check/load，保留计数器并仅清理本任务的表。网络子进程使用最小环境。历史文件只检查本地引用，外部 404/410 和未知响应保留在报告中。

范围证据保留身份和完整原生过滤输出。最终 `SPLRAD Validation` 要求范围 job 成功、四类布尔输出齐全；被选 job 必须成功，未选 job 必须为 skipped。失败、取消、结果缺失或异常跳过都会阻断汇总。main 成功后的治理采用由 [governance-promotion](governance-promotion.md) 独立完成。
