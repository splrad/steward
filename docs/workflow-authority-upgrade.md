# Workflow authority 首次启用方案

核验日期：2026-10-21。采用总基线 v1.8、平台 v3.17 及其 WORKFLOW-EVOLUTION 条款。本文件区分本地实现、拟采用配置和线上启用；当前仍处于本地准备阶段。

## 已核实的权限与来源

组织规则集 `18883080` 覆盖全部仓库默认分支，无 bypass。必需工作流为 steward 的 `.github/workflows/pr-validation.yml@refs/heads/main`；必需检查为 App `4243096` 的 `PR Classification Gate`。`PR Validation Gate` 尚未列为必需检查。

| 仓库 | repositoryId | 调查时默认分支提交 |
| --- | --- | --- |
| LayerScape | 1187527897 | `745ef2cb729642b546a30fefa6ae5a0c2bde7159` |
| steward | 1296724484 | `e444d84a346edfd604241d97420d7f960cd0c546` |
| .github | 1296725317 | `e3b64ceb6e7c58ea6af2fe68c88afca58f02fcfc` |

管理员可见组织清单为上述三个活跃公开仓库。在各自上述不可变提交读取 `.github/workflow-contract.json` 均返回 404，故没有可直接继承的仓库声明采用记录。

当前账号 axiomoth（用户 ID `44151430`）为组织管理员，对三个仓库都有 admin 权限，也是 Maintainers 团队 `18428001` 的唯一成员。#253 作者为 Steward App，故该账号与该 PR 作者独立。最小升级 PR #257 也已由 Steward App 创建并 Ready for review。规则集的 `require_last_push_approval=false`，故 axiomoth 可亲自审阅并批准这两个机器人 PR；尚未提交人工批准。不得据此自动扩大权限或把机器人审查当作人工批准。

Steward App 安装为 all repositories，已有 `contents`、`pull_requests`、`checks`、`actions` 等权限。2026-10-21 回读确认已订阅 `pull_request_review`；正式启用仍须验证投递、撤销重算和定时回读。部署环境 `steward-deployment` 当前只有分支策略，无人工 reviewer，且允许管理员绕过。

## 最小正式升级

本 PR #257 从上述 steward main 准备正式运行时能力升级：加入合同解析、独立批准及 base 采用证明、固定 evaluator 的 authority 读取、既有 Gate 重算、审查事件与定时复核、健康身份、迁移前启用预检。现有业务实现、D1 schema、必需验证入口和主线工作流安全内核保持该正式版本的原有合同。

升级工作树的全部工作流已用当前 main 的 `verifyWorkflowPolicy` 检查通过，证明本地具备通过现行安全内核的路径；原生 PR Validation run `39468506553` 的 validate 与 fragments 已成功；该证据对应 `a8410037bcd295605ba4e4ff33b18f556f757045`，后续 head 须重新核验。部署后保留原有仓库生命周期及议题快照初始化步骤。

正式部署的 `POLICY_SHA` 必须指向实际默认分支合入提交。`WORKFLOW_EVALUATOR_SHA` 独立固定已经审查、含完整验证器与 authority 的提交，随后 required workflow 来源也固定到该提交。两个 SHA 各自验证，部署前预检在 D1 迁移之前执行。本 PR #257 是运行时升级来源，其本地 authority 为空，现行必需入口保持原样；不能将本 PR head 当成已具备完整能力的 evaluator。完整 evaluator 及 authority 在 PR #253 分支中，须待该精确提交审查完成、人工采用并与 required workflow 来源一起固定；当前可供审查的来源为 ff27576b9a80ac8c54ad2145d3050476f3211985，实际启用值尚未冻结。

运行时只有显式配置 `WORKFLOW_EVALUATOR_SHA` 后才启用 authority；源码中出现配置文件不代表已经启用。显式启用后，缺失仓库、读取失败或错误来源均阻断。PR #253 的 evaluator 源中的 authority 是待人工采用的初始配置：三个仓库、批准者 `44151430`、`fragments: retired`、空共享队列。`retired` 表示新基线要求的目标状态，不能解释为线上已退役。#253 的共享队列仍须精确绑定的原生人工 APPROVED Review。

受保护 base 的合同与可信初始合同不同时，验证最后一次语义变更对应的已合并 PR、合并提交祖先关系、精确 head/base/evaluator/摘要批准及当前权限。仅有预置文件不足以继承；纯格式变更继续向前查找采用依据。查询最多 100 次文件提交，无法证明则阻断。

验证器升级时，可信 authority 可用 `adoptionPolicies` 保存“已采用合同的规范 SHA-256 摘要 → 采用时的 evaluator SHA”。升级审查须核实原合并 PR、批准及摘要后迁入该记录；不能从候选声明或任意 Review 正文自动信任旧 SHA。历史采用使用登记的原 SHA 复验，仍检查撤批、自批和当前权限。新合同差异始终绑定当前 evaluator，不能使用历史记录取得新授权。记录缺失或不匹配时保持阻断并补齐升级证据；不得让后续每个普通业务 PR 重新批准同一已采用合同。

完成一次启用后，已支持范围内的工作流新增、删除、改名、拆分及声明变更在同一业务 PR 内验证。只有新增验证能力或信任边界变化需要新的正式能力审查。

## 后续线上操作与批准清单

以下交接操作集中列明；已完成的事件订阅按实际回读标注，其余线上变更仍待授权：

1. #257 已创建并提交审查，作者为 Steward App，axiomoth 满足当前 PR 作者独立条件。最终提交、runner 摘要和双平台验证记录仍须冻结；各 PR 既有 head 的 Copilot 与 Codex 审查均完成且意见核清后才能推送。人工批准由本人操作。
2. 人工采用完整组织范围、三个仓库初始 fragments 退役目标、批准者和不可变 evaluator 提交。#253 的共享队列批准文本须在最终 head、base 和 evaluator 确定后由可信端生成，再由独立真人提交原生 APPROVED Review。
3. 为 steward 的 `steward-deployment` 环境配置指定的独立真人 reviewer、启用防自批、禁止管理员绕过，并保留默认分支来源限制。需确定实际发起者与部署批准者；当前只有一名 Maintainer，不能假设该人可批准本人发起的部署。App 的 `pull_request_review` 订阅已回读确认，启用时验证事件投递。权限现状已满足本实现读取要求。
4. 在部署环境设置 `WORKFLOW_EVALUATOR_SHA` 为人工采用的完整 40 位提交 SHA，再正常审查、合入并部署最小正式版本；回读实际 POLICY_SHA、evaluatorSha、部署来源及健康。变量值须在合入触发自动部署之前准备好。先盘点在途任务与存量数据库；本升级不新增 D1 migration，但原部署仍会列出和应用既有迁移，须核对待应用清单。
5. 保持规则集 active、原人工审批和现有检查，将 required workflow 固定到已采用不可变来源，并加入 App `4243096` 的 `PR Validation Gate`。交接期间保持合并阻断；规则与运行时版本必须相互匹配。
6. 对全部覆盖仓库取得真实运行证据：合法普通变更、无批准合同、旧 head 批准、撤批、权限丢失、错误 evaluator 和伪造检查；最后复核 #253 的 CI、双审查及原评论。失败保存实际到达阶段，恢复动作须另有相应授权并验证版本与数据库兼容性。

## 本地验证与未完成项

两份工作树分别完成 Windows/Linux `npm run verify`，包含测试、类型、配置、dist 重建一致性和工作流检查：

| 工作包 | Windows | Linux |
| --- | --- | --- |
| #253 本地修复 | 1533 passed / 5 skipped，72 files | 1529 passed / 9 skipped，72 files |
| 最小正式升级 | 1740 passed / 4 skipped，46 files | 1743 passed / 1 skipped，46 files |

平台条件用例按各自平台跳过，不能计作双平台都运行。新增负例覆盖未批准的 base 预置、自批、撤批、权限丢失、非祖先采用和未显式启用。

本轮审查对象为 `9a031545947f8491d04be4c8fc426a64b1e76bce`，Copilot 与 Codex code/security 均已完成。新增 P1 与 Copilot 正文中的三类意见已逐项检查，处理记录见 [审查正文与线程核对](pr253-review-followup.md)。实际推送和评论闭环以 GitHub 回读为准。

该 head 的 required-workflow run `39465015749` 仍被当前 main 验证器的共享队列限制阻断。双平台本地通过不能改写这一线上结论。

## 当前审查修正

历史采用 PR 的声明按 API 核实的 head 仓库和精确提交读取；缺少仓库身份时拒绝继续。当前合同批准与历史采用批准在完成检查前重新读取 Review 和协作者权限，检查期间撤批、改为请求修改或权限丢失会阻断。GitHub 多次读取不是事务快照；后续变更仍依赖事件及定时重算。

#253 已通过可信持久化计划完成生成图分页修复；每页最多两个输入，完整多构建汇总仍是独立缺口。本升级不包含该发布链路。首次 authority 采用和 required workflow 切换仍待上述线上交接，相关线程保留开放。

## 安装范围预检与定时复核

部署预检复用既有 Steward App 私钥，以仅含 `metadata: read`、不附加仓库过滤条件的安装令牌枚举全部安装仓库。读取前后核对安装 ID、App ID、组织 ID/login、`repository_selection: all` 和未暂停状态；逐页核对 `total_count`、仓库身份和重复项。安装范围不完整、读取失败或分页不一致均阻断 D1 迁移及部署。活跃的公开、私有仓库和显式受管 catalog 条目都必须具有 authority；当前三个公开仓库的状态不能替代通用范围校验。

GitHub API 的多次读取不是事务快照。此检查证明本次可读取的安装范围，后续仓库和权限变更仍由事件及定时复核处理。API 依据：[创建安装令牌](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)、[枚举安装仓库](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation)。

运行时每 15 分钟全量复核，Review 事件继续立即触发；单次扫描复用 authority 读取结果及各仓库 client。authority 读取失败会传入已知仓库的 Gate 重算，使既有成功结论转为失败。安装枚举失败时仍处理已知 catalog，随后报告枚举错误。未设置 evaluator 时不扫描，显式启用后的错误继续阻断。

Steward 中央验证任务包含 `npm-verify-config`，在候选 checkout 执行 `npm run verify:config`，检查该候选的 Schema 和配置间约束。任务类型、Schema、Profile、runner 映射及生成产物同步更新；可信 evaluator 的配置选择仍使用固定来源。

合同文件读取返回 404 时，必须读取同一精确提交的完整 Git tree，证明声明确实缺失后才继承 baseline；提交或 tree 不可读、tree 被截断、声明实际存在而 Contents 不可读时均阻断。此校验同时覆盖当前与历史 fork 来源。

复核只读取同一 head 最新的 runId，API 返回该运行当前 attempt；旧运行在合同复核之前退出。全量扫描最多并发处理四个仓库，各仓库失败独立记录，其他仓库继续处理；下一次定时扫描重新取得来源清单，重试失败仓库，已写入的 Gate 结果保留。Review 事件仍立即复核，单仓扫描复用一次 authority 快照。
