# 工作流验证

中央 [Native Validation](../.github/workflows/pr-validation-native.yml) 从 `job.workflow_repository`、`job.workflow_sha`、`job.workflow_file_path` 取得受信源 P，检出准确的候选 head H。PR 基点还必须与检出时的目标分支一致；main push 使用事件的 before/after。身份检查拒绝缺失对象、浅克隆和来源不符。

固定完整 SHA 的 `dorny/paths-filter` 使用 Git 模式读取准确 base/head，关闭 token，不持久化检出凭据；改名按删除旧路径和新增路径检查。P 的原生范围决定依赖、文档和治理作业。登记的产品工作流继续核对入口和触发范围；是否等待 Product CI 另由准确差异决定。Steward 普通指南和其他组织仓已存在的根安全政策只修改普通文件内容时，由原生文档或治理作业签收。Steward 安全政策源与根安全政策的正文变更等待 Linux 专项验证和原生治理、文档检查。源码、共享依赖、执行配置及影响未明的变更保留适用的产品检查；新增、删除、模式变更或来源关系不明时使用完整检查。PR 与单父主线提交采用同一范围边界。

Product CI 证据绑定工作流、提交、Run 和 attempt。已完成的 Run 在原 attempt 内有界复读。Actions 作业清单须与该 Run 的 GitHub Checks 作业逐项对应，并连续两次一致。重跑时用 GitHub 的作业 ID 和 attempt 归属排除旧检查，保留平台归入本次重跑的继承作业。身份冲突、作业明确失败、等待耗尽或读取期间 attempt 改变均阻断验证。

jactionlint、shellcheck、pyflakes 与 zizmor 使用中央锁定工具扫描真实 YAML。候选的忽略配置不能关闭检查。标题入口按已批准的 `E07-TITLE-METADATA-20261028` 固定元数据例外处理；原始诊断、退出码和其他失败保留。扫描工具直接支持 queue 和 `job.workflow_*`，无需旧的工作流镜像或任务解释器。

zizmor 保留原始扫描输出及退出码。标题、治理提升和标签入口的已审触发器按各自文件和事件位置核验。中央维护决定 `E11-CENTRAL-MAINTENANCE-WORKFLOW-RUN-20261118` 仅在原生事件已绑定中央仓 ID 1296724484 时接受 `.github/workflows/maintenance-event.yml` 的 `on.workflow_run` 主位置产生的原生 `dangerous-triggers` 诊断。其他仓、无仓身份的本地扫描、其他路径、事件、诊断、解析错误和工具失败仍阻断采用。维护接收器的来源、分支、权限、写入及暂停保护须随其实现独立审查。关于治理提升的既有决定见[治理提升](governance-promotion.md)。

dependency-review 比较准确 base/head，采用 high 阈值，覆盖 runtime、development、unknown，等待原生快照告警最多 600 秒，不回写 PR。NuGet 实际直接/传递覆盖和组织 required workflow 的平台强制仍须在隔离及线上采用阶段取证。

DOC-LINK 读取改变的当前文档及受影响目标的当前引用。lychee 校验本地路径、图片和可识别锚点；Linux 联网前必须通过原生 nft check/load，保留计数器并仅清理本任务的表。网络子进程使用最小环境。历史文件只检查本地引用，外部 404/410 和未知响应保留在报告中。

范围证据保留身份和完整原生过滤输出。最终 `SPLRAD Validation` 要求范围 job 成功、四类布尔输出齐全；被选 job 必须成功，未选 job 必须为 skipped。失败、取消、结果缺失或异常跳过都会阻断汇总。main 成功后的治理采用由 [governance-promotion](governance-promotion.md) 独立完成。
