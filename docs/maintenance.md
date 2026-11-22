# 中央维护恢复

中央 [Maintenance 工作流](../.github/workflows/maintenance-event.yml) 按三个固定入口的原生完成事件处理中央维护。维护记录按原 Run 保存于中央仓 `steward/release-state` 的 `maintenance/<runId>.json`，复用受保护的 Git 快进写入。

中央维护分支按原 Run 保存恢复请求。首条真实维护记录在核实仓库身份、完整分支保护和原生 ref 缺席后创建分支。每次写入核对完整当前树和所需历史。

原全仓协调器写入的健康摘要及 `steward/automation-health` 的 Git 历史已离线归档。需要追溯原扫描及错误时，使用归档中的 `health.json`。现役维护结果通过原生 Actions Run 和 `maintenance/<runId>.json` 查询。

App 安装可见性不等于发行参与资格。协调器按准确默认分支读取 `.github/delivery.json`、Release Please 配置/版本清单与既存状态；确认无上述配置且无产品状态、候选/构建 ref 或原生发行线索的仓库，发行判为 `NOT_APPLICABLE`，Pages 与维护仍独立。已有发行义务但配置删除、配置残缺、读取失败或状态漂移均保留错误；有效产品缺少初始化状态仍报 `RELEASE_BOOTSTRAP_REQUIRED`，不自动创建产品接管记录。

历史健康摘要将待审的 `READY` 候选和准确的 `CONFLICT` / `HUMAN_EDIT_CONFLICT` 计为 `waiting`，将 `SOURCE_CHANGED`、缺少原因的冲突及 `UNKNOWN` / `BLOCKED` 计为未知。现役候选、周期、渠道和维护分别依据各自的原生结果判断。

| 固定入口 | 业务作业 |
| --- | --- |
| sync-managed.yml | bootstrap、templates |
| quality-language-summary.yml | quality-summary |
| governance-promotion.yml | promote |

私有 `splrad/steward-settings` 使用官方 full-sync，由受审配置变更、治理事件和明确的人工触发推进；已启用 APPLY 且后续同步成功时可补齐暂时差异，NOP 仅报告差异，不承诺精确恢复时限。settings 不接入中央逐 Run 自动维护，已有历史证据只读保留；失败由已订阅的授权维护者接收原生通知，持续错误或紧急恢复使用原生 Re-run failed jobs，配置修复通过受审提交触发新的 full-sync。

工作流身份从中央仓原生 API 读取，作业名与当前执行器的固定 YAML 对照。维护事件核对触发它的准确 Run、attempt 及相关作业。分页不全、来源变化或无法证明完整作业集合时返回 UNKNOWN。记录包含中央 Run、固定作业键、矩阵序号、结论和恢复请求。

每个原 Run 最多预留两次自动恢复请求。写入请求并回读后，重新核对工作流仍启用、原 Run 身份及 attempt，再调用原生失败作业重跑。三轮实际业务失败或两次请求额度用完后停止自动恢复；删除当前状态文件不会清除 Git 历史中的额度。实际工作流依赖关系决定原生重跑范围。

响应丢失后读取原 Run，新的 attempt 可证明请求已被接受。同一次维护事件仅发送一次请求，收到 201 后等待原生 attempt 可见。结果仍未知时，后续串行事件重新取证，并使用剩余额度。状态写入失败、工作流停用或来源漂移时保留事实，等待下一次观察。原生 API 的读取与重跑请求不构成原子操作，托管环境中的并发和依赖图仍需原生验收。

中央维护通过 `workflow_run.completed` 接收 Sync Managed Files、Quality Chinese Summary 和 Governance Promotion 的业务运行结果。历史 Run 的健康作业仍可读取。若原生失败作业重跑会再次执行已退役的作业，维护程序保留失败记录，业务恢复使用当前工作流的人工入口。

旧 `update-dependencies.yml` 的维护记录（含矩阵、健康 attempt 和已有请求）保持可读；该入口已退出当前扫描和自动重跑，不再读取已删除的 YAML 或查询其 workflow API。Renovate 依赖更新由官方 Mend 托管服务执行，运行故障查看其原生记录。

旧自托管入口及其目标发现、专属认证和日志校验代码已移除。历史提交及记录保留；需要恢复源码时通过受审 revert 还原同源代码与生成物，旧工作流仍须保持人工停用。重新启用旧写者需单独核定与 Mend 的交接，不能直接重跑旧 Run。共享 App 和凭据继续服务其他消费者。

产品 Pages 通过[独立事件入口](../.github/workflows/pages-maintenance-event.yml)处理，使用本仓治理状态、准确来源和有限恢复预算，见[产品 Pages](pages.md)。中央维护本地验证覆盖 API 故障、原 Run 回读、完整分页、预算以及真实 Git 历史恢复；线上启用按当前实施阶段完成。

原生接口：[失败作业重跑](https://docs.github.com/en/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run)、[全部 attempt 的作业](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run)。
