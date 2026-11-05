# 中央维护恢复

发行协调器每次唤醒先执行一次有界维护扫描，然后继续产品工作。扫描限时五分钟、最多 1000 次 API 请求；读取失败在健康结果中保留错误码。维护记录按原 Run 保存于中央仓 `steward/release-state` 的 `maintenance/<runId>.json`，复用发行状态的 Git 快进连接。

| 固定入口 | 业务作业 |
| --- | --- |
| sync-managed.yml | bootstrap、templates |
| settings-sync.yml | settings-sync |
| update-dependencies.yml | targets、update 矩阵 |
| quality-language-summary.yml | quality-summary |
| governance-promotion.yml | promote |

工作流身份从中央仓原生 API 读取，作业名与当前执行器的固定 YAML 对照。扫描查询默认分支最近 30 天的运行，并回读已有记录中的准确 Run。达到原生过滤查询上限时拆分时间窗口；分页不全、来源变化或无法证明完整作业集合时返回 UNKNOWN。记录仅包含中央 Run、固定作业键、矩阵序号、结论和恢复请求，不保存产品名称或原始步骤文本。

每个原 Run 最多预留两次自动恢复请求。写入请求并回读后，重新核对工作流仍启用、原 Run 身份及 attempt，再调用原生失败作业重跑。三轮实际业务失败或两次请求额度用完后停止自动恢复；删除当前状态文件不会清除 Git 历史中的额度。实际工作流依赖关系决定原生重跑范围。

响应丢失后读取原 Run，新的 attempt 可证明请求已被接受。同一次协调器运行不会重复发送；已收到 201 时等待原生 attempt 可见。结果仍未知时，后续串行唤醒重新取证，并只能使用剩余的一次额度。状态写入失败、工作流停用或来源漂移时保留事实，等待下一次观察。原生 API 的读取与重跑请求不构成原子操作，托管环境中的并发和依赖图仍需原生验收。

`release.yml` 和 `sync-managed.yml` 各自运行独立的 `automation-health`，共享健康作业 concurrency，且业务作业不依赖它。健康步骤只读取两个固定工作流的状态和默认分支最近一条 Run；`disabled_inactivity` 可恢复，人工停用保持。两小时没有新 Run 时提交一次观察唤醒，并读回原生事实；未知结果留到下一次固定入口重新观察。最近一条 Run 不用于推断全部旧 Run 或业务已经完成。

部署时将既有专用 Issue 编号绑定到仓库变量 `STEWARD_HEALTH_ISSUE`。固定错误码集合变化时，健康作业向该 Issue 写一条包含中央 Run 链接的评论并回读；相同错误和不同观察 Run 不重复通知。权限、真实 enable/dispatch 与订阅送达分别在原生采用阶段验证。

`sync-managed.yml` 的 bootstrap 与 templates 都已成功时，仅健康作业失败不会创建业务恢复请求或占用额度；原生失败作业重跑保留已经成功的作业。业务与健康同时失败时仍沿同一 Run 的有限业务恢复预算处理。旧 `update-dependencies.yml` Run 中已有的健康 attempt 保持可读，适用范围为其原始执行记录。

产品 Pages 在同一协调器中独立观察，使用产品仓自己的治理状态、准确来源和有限恢复预算，见[产品 Pages](pages.md)。中央维护本地验证覆盖 API 故障、原 Run 回读、完整分页、预算以及真实 Git 历史恢复；线上启用按当前实施阶段完成。

原生接口：[失败作业重跑](https://docs.github.com/en/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run)、[全部 attempt 的作业](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run)。
