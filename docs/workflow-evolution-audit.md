# 通用工作流演进实施审计

日期：2026-10-20。调查起点为 #253 的 `93e3a147702999e0a7d14ca8fe5cb387284fdf22`；主线及已合入 #256 为 `e444d84a346edfd604241d97420d7f960cd0c546`。

采用总基线 v1.8、平台 v3.17、发布 v3.5、审查 v3.10、分类 v1.5、议题关联 v1.3、Copilot v1.10，以及 2026-10-18 替代矩阵、原生能力采用表、VERSION 合同和最终执行审计中的现行要求。通用工作流演进采用这些文件在 2026-10-20 补充的 WORKFLOW-EVOLUTION 条款。本文记录代码差异及验证边界，不替代上述正式基线，也不表示全部实施工作包已经验收。

| 基线要求 | 代码调查结果 | 本轮处理及剩余边界 |
| --- | --- | --- |
| 必需入口与普通工作流分开 | #256 已完成 runner 主路径拆分；本地验证脚本仍要求固定 11 个文件，另有闲置的全清单相等函数 | 删除目录总数、全清单相等限制和闲置函数；保留必需入口、安全内核及业务协议检查 |
| Profile 来自可信 catalog | 入口 shell 按两个仓库 ID 硬编码，而 core 已有通用选择函数 | 入口调用固定执行器的 `validation-profile`；测试新仓库、公开默认、未知私有仓库、停用配置及非法可见性 |
| 同 PR 声明式合同演进 | 已有合同解析、精确批准绑定、权限和撤销判断、共享队列内核及相关测试 | 已准备三个仓库及现有管理员的初始 authority，补齐 base 最后语义变更的原生批准证据；仍待人工采用及正式启用 |
| 首次启用失败关闭 | 部署前只有 SHA 格式检查，空表会在部署后导致 Gate 失败 | 固定 evaluator 预检在 D1 迁移前执行；已通过管理员身份读取全部三个仓库及实际权限。App 的 review 事件订阅已回读确认，部署保护及独立批准仍待正式交接 |
| 单一现行运行时与版本身份 | 迁移文档仍包含未采用的临时实例路线；分支部署无法满足默认分支可信来源 | 执行稿统一为现有运行时正式能力升级及一次受控交接；业务 POLICY_SHA 与验证器 SHA 分别绑定 |
| 无构建资产也必须有已验收 seed | prepare 仅对非空 build 验证来源 | 复用 generation 的 accepted seed 重建函数；无 build 时除生成的 evidenceDigest 外，所有冻结字段必须一致。测试缺失、归档、错误来源、错误策略、合法 seed 和重复 prepare |
| 完整贡献者集合 | 空名单跳过 GitHub 读取，非空只检查子集 | 始终读取来源提交的人类作者，并检查集合大小及每个稳定 ID/login；保留机器人过滤和独立的 authorIds 检查 |
| DEP-REVIEW／CHECK-SCOPE／DOC-LINK | validation task 类型、Profile、runner 与脚本中未找到三项完整接线 | 尚未交付；完整 npm verify 不代表这些合同已实现 |
| 统一审查正文 | `config/review/rules.json` 和生成 AGENTS 仍包含 `common.pr-creation`、`steward.core-boundary` 等原条目 | 需独立按统一正文修改生成源、消费方及跨仓同步验收；本轮未同步线上 |
| 分类单一现行路径 | `classification.ts` 仍支持 shadow 配置和 wouldPrimary 输出 | 仍须按分类基线核对调用方、状态及持久化消费者，同次退役；不能只删字段 |
| 发布与 VERSION 新合同 | 现行基线允许规定的注释与空行；旧 generation 入口仍有消费者与测试 | VERSION 已统一本地解析和 runtime 消费者，保留原始 blob 身份并拒绝 BOM/CR/多版本；旧 generation 入口及恢复消费者退役仍未完成 |
| 退役与共享消费者验收 | 本地代码、线上运行时、跨仓载体处于不同阶段 | 源码删除、实际停写、运行验收分别取证。线上仍需正式交接，不能以本地删除关闭 R20 |
| 多构建交付 | Release 执行器只消费一个构建计划，配置曾允许引用多个构建 | 本地已在 Schema 和配置验证中提前拒绝单个 GitHub Release 引用多个构建；零资产 Release 和多个独立构建单元保留。基线要求的多构建执行、汇总及故障隔离仍未完成，此保护不构成该能力验收 |

## CI 和评论状态的判定

调查起点的 required-workflow run `39453708332`、job `118734917388` 直接失败于 `ordinary concurrency requires isolated workflow-ref namespace`。当前可信 main 验证器不支持新共享队列；重跑、普通代码推送和本地测试均不能改变它。

Copilot run `39453711323` 已完成。完整 Review、全部线程分页及 Codex code/security 结果已读取；起点共 97 个线程，4 个开放。两条发布准备意见可以在实现及双平台验证后据实回复和解决。两条首次启用意见须分别判断：部署预检封住空表上线风险，但授权表及正式启用尚未完成，不能把预检成功等同启用成功。

2026-10-21 更新：上述 Copilot 记录属于旧 head `93e3a14`。当前远端 `535c37f` 的 Codex code/security 与 Copilot Review `5588828163` 均已完成；推送前 98 个线程中 96 个已解决，authority 和新增 VERSION 两条开放。本轮 VERSION 修复及 authority 升级准备已完成双平台本地验证，已满足推送前双审查条件。详见 [首次启用方案](workflow-authority-upgrade.md)。

Windows 与 Linux 使用相同最终源码和 runner 产物，分别执行 `npm run verify`，包含测试、类型、配置、dist 重建一致性、工作流合同及 actionlint。推送后的原生 CI 和审查须按新 head 单独读取。首次交接具体顺序见 [工作流合同迁移](workflow-contract-migration.md)。

本轮授权包含修复、双平台验证、签署推送和有证据的原线程回复；合并、部署、线上规则及实际批准者配置未执行。

## 2026-10-21 生成图准备与批准复核

运行时从独立核验的 source 建立不可变图计划，并通过 migration 0018 在现有 D1 中保存仓库、tag、sourceDigest、policySha 到 graphDigest 的可信绑定。完整计划使用现有摘要对象存储，最大 1 MiB；后续 prepare 读取计划而不再扫描完整 source，每次接收至多两个输入，逐个核对摘要后写入节点。continue/ticket 同样复用计划，仍要求当前 accepted seed 与完整节点准备。该迁移属于 #253 发布链路，不属于 #257 最小运行时升级。

历史合同采用还须来自默认分支 PR；fork 声明使用 API 核实的仓库和精确 head。当前和历史批准均再次读取 Review 与权限，覆盖检查期间撤批及失权；事件和定时重算仍负责后续变化。
