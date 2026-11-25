# 发布来源、GitHub Release 与历史记录

本文说明当前源码中的发布连接。入口是 [候选事件](../.github/workflows/release-candidate-event.yml)、[发行周期事件](../.github/workflows/release-cycle-event.yml)和[记录读写入口](../scripts/release-record.mjs)。实现存在、仓库已启用和实际发布验收分别判断。

## 候选与准确构建来源

公开仓接受外部贡献者和机器人提交的普通 PR。对同一 PR，Worker 按提交、基准分支、标题和正文识别重复内容。派发前和模型调用前均核对 GitHub 当前内容。GitHub Actions 为每个 PR 保留一个运行中的作业和最近的待运行作业。不同的有效改动仍可能分别消耗组织 Copilot 用量。若已派发的分类作业失败，可在 Actions 中重跑原作业。

Steward 收到指向默认分支的 PR 打开、更新、重开或就绪事件后，通过中央 [PR 影响分类](../.github/workflows/pr-release-impact.yml) 调用组织现有的 Copilot SDK。判定对象是整个 PR 对该项目交付物使用者的影响。只有全部改动均属项目内部维护时，Steward App 才添加 `Internal`。维护者可以直接在 PR 的 Labels 中增删该标签，后续分类保留人工决定。分类会读取当前提交的完整文本补丁、PR 描述和基准提交的 README，补丁缺失或结论无法核实时保留发行素材。路径标签继续由各仓的 `actions/labeler` 管理。

起草新稿时，Steward 从合入 PR 读取标签。范围内有 `Internal` 时，只向 Copilot 提供其余 PR 和直接提交的材料。若全部提交均来自内部 PR，组织模板使用一句维护说明。Release Please 按完整历史计算版本、变更文件和比较链接。贡献者折叠区按[发行说明的署名规则](release-notes.md)列出整个版本的贡献者。已交付候选继续按其保存的稿件恢复。

[官方候选入口](../scripts/official-candidate-event.mjs)验证受审的产品来源，使用固定版本的 Release Please npm 包计算候选。Steward 按组织模板排版候选首页，保留已审正文。候选合并后，中央验证原 PR、已审 head H、准确合并提交 S 与冻结正文，登记原生发行周期。构建及标签绑定 S，中央执行来源另存 controller SHA。

公开产品按 S 中经审查的工作流交件。中央保存在受保护 Git 状态中的回执包含实际 Run/attempt、artifact ID 和摘要，并从这一制品冻结、发布和恢复原文件。构建身份不取得中央发布权限。历史完整冻结包继续按原有 producer 映射和证明核验。参见[产品工作流合同](product-build.md)和[发布管线](../packages/runner/src/release-pipeline.ts)。

单位 notes 由本周期锁定的模板解析。新模板使用[正式发布正文](release-notes.md)的条件栏目和确认过的贡献者。文件封存比较从准确源码和模板重新渲染的完整正文与实际待封存字节，发行版本由 manifest 和原生 tag 绑定。使用旧模板的周期继续读取原格式，历史冻结与恢复使用原文件字节。

新候选的预览标题和 GitHub Release 的 `name` 均使用仓库项目名、一个空格和实际标签，例如 `LayerScape v1.1.1`。正式正文从本版实质内容开始。已审定的旧候选沿用原格式。

## 当前来源输入


`release-freeze` 输出 schemaVersion 3 来源清单，从完整本地 Git 对象库读取明确边界至目标的全部可达提交、净差异、重命名、README 背景及读取缺口。来源身份绑定 `repositoryId`、`defaultBranch`、`targetSha` 和 `controllerSha`，发布单元绑定 Release Please 解析后的 `id`、`path`、`version` 和 `tag`。版本解析与排序复用锁定的 Release Please，支持组件标签、子目录单元和预发布版本。

命令接收 `--repository-id`、`--default-branch`、`--target-sha`、`--controller-sha`、`--unit`、`--unit-path`、`--version`、`--target-tag`，以及原有 Git 根目录和输出路径参数。来源边界选择标签、采用基线或首发完整树之一；标签边界同时提供 `--boundary-version`，用于比较同一发布单元的版本顺序。

原始 commit/blob 留在 Git 对象库。读取器通过单个 `git cat-file --batch` 进程流式读取，复核 Git 对象 ID、完整 SHA-256 和连续字节块的 SHA-256；清单保存对象类型、字节数、编码标识和块区间。默认块大小为 1 MiB。纯校验器核对清单结构、身份、提交图和引用覆盖，实际 Git 字节由读取器验证。后续内容收集须按对象 ID 和字节区间重新读取并核验摘要。

来源全集由 Git 提交图确定。直接提交、一个提交关联多个 PR、同一 PR 关联多条提交均可表达；GitHub PR 元数据只补充已确认的提交范围，并验证同仓身份、提交关联、完整分页和重复项。浅克隆、缺失对象、边界漂移、不完整提交图和超过显式资源预算均失败。来源清单不携带整包 Base64；旧的 8 MiB 单对象、32 MiB JSON 和 64 MiB 总对象默认上限已从该读取器移除，提交数、路径数、进程时间及显式配置的字节预算仍受限。

内容收集与发布连接使用准确来源和受审输入；旧 schema 按对应历史读取器解释，不把旧格式转换为当前来源验证通过。

## 中文初稿与身份

[发布说明客户端](../packages/runner/src/copilot-release-client.ts)调用现有 [SDK入口](../tools/quality-language/release-notes.mjs)，使用隔离临时目录及显式传入的短时身份。当前 release job 声明 `copilot-requests: write`，将 `github.token` 作为 `STEWARD_COPILOT_TOKEN` 交给适配器。SDK与兼容runtime版本由仓库锁定配置及安装校验确定，不在本文另设CLI版本。

生成按既有批次保存输入和结果，认证/额度不可用时保留待处理状态。客户端的有限超时和输出限制属于该调用边界，不形成跨构建、发布和渠道累计的统一失败预算。实际模型服务接受与用量归属须由对应环境的真实调用验证；无模型运行只证明其覆盖的身份和连接事实。

## GitHub Release 与渠道

[GitHub Release适配器](../packages/runner/src/gh-release.ts)复核冻结制品、准确tag/S、Release身份及资产集合；写入响应丢失后先读回同一对象，不盲目重复创建或上传。正式发布后核 immutable、正文与资产身份，实际下载比较字节，并调用 `gh release verify`、`gh release verify-asset` 及来源证明验证。已经公开的字节不覆盖为修复版本。

主发行与渠道分开判定。准确S对应的公开immutable GitHub Release及必需资产、来源、摘要和实际下载验证构成主发行结果；渠道根据已配置的发行单位、准确Release ID和manifest摘要分别派发及观察。渠道等待不改写已确认的主发行结果，未验证渠道不记为通过。

当前交付主线为GitHub Release。已有GHCR/WinGet实现保留，实际分发另行完成对应产品接入与验收。无当前发布消费者的npm、NuGet、PyPI、Helm、cargo和Maven发布保持未启用，不因构建工具或资产格式存在而自动启用上传。根 `package.json` 的 `private: true` 包用于构建依赖；GitHub Release上的wheel/sdist资产不表示已向PyPI发布。

## 逐仓发行暂停

管理员通过私有设置仓 `splrad/steward-settings` 的受保护 `main` 提交审核变更，更新根目录 `release-pauses.json`。文件为不重复的正整数 GitHub 仓库 ID 数组。添加 ID 暂停该仓，移除 ID 恢复，`[]` 表示没有暂停仓库。Steward 使用仅限设置仓的只读令牌核对当前受保护提交及文件 Git blob。文件缺失、格式错误或读取中提交变化会停止领取发行写入任务。

暂停拦截官方候选的令牌签发、Action 写入、首页写入和新合并周期登记。已写入状态分支的准确发行周期按原回执继续构建、发布、采集渠道观察与完成证据及恢复。同一运行中已获准开始的 Action 及其结果落盘可完成。要确认排空，核对进行中的候选运行及已登记周期。暂停解除后，原控制器和来源仍符合准入条件时可重跑原运行的失败步骤。如果候选已有投递预约且缺少 Action 结果，只有原运行各次尝试均证明 Action 步骤未执行时才允许续用该预约。

迁移时先从旧设置的有效快照核对全部暂停 ID，再合入名单。旧读者仍运行期间同步两处暂停状态，或冻结旧入口编辑并在切换时复核最后一次快照。新读者采用后验证该仓暂停、恢复及其他仓隔离，再退役旧配置。

## 有限恢复与历史记录

治理晋级成功后，中央维护会使用已晋级的控制器核对GitHub 日志保留期内的正式候选运行。对于产品当前默认分支的同一 push，若唯一的 App 运行在首次 Copilot 起草时返回 `RESPONSE_UNKNOWN`，后续写入步骤均已跳过，且受保护的同轮记录只保存了来源，Steward App 可自动派发一次续跑。日常治理晋级也会唤醒这项检查。产品已暂停、候选已关闭或来源发生变化时，维护流程跳过该轮。

派发前，中央在自己的受保护状态分支保存产品 ID、来源 SHA、轮次、失败运行和维护运行。若最后一次检查发现产品已暂停或来源已变化，维护作业记录尚未发送请求。GitHub 明确拒绝派发时记录拒绝回执。只有这些能证明请求未受理的情况，下一次晋级才会重新核对并尝试继续。响应丢失、服务端返回 5xx，或已受理的续跑再次失败时，预约继续生效。续跑复用原候选来源，由 Copilot 起草，正式候选流程检查、写入并读回 PR。原运行的日志和失败结论保留。

候选和周期事件按候选、构建、中央发布、渠道派发或观察、原生证据恢复的顺序推进，保存准确Run、attempt和对象身份。恢复复用平台支持的原Run失败job重跑和仍有效制品；成功job及其来源证据可按实际结果复用。未知写入先核实远端状态，缺失或冲突证据明确报告；不承诺平台窗口外无限自动重建。

普通候选按当前登记及原生事实处理，不要求扫描全仓历史或清空旧恢复缓存。旧失败保留失败，修正后沿普通候选路径产生新版本；主发行验证不以旧 `lastCompleted` 非空或active记录清空为条件。

旧D1/Worker收据、生成票据与图协议属于历史实现，不是当前操作步骤。其原文可从[历史版本](https://github.com/splrad/steward/blob/d89aaffa0d0f22e1f8c4d5d160b43da4c7e3262e/docs/release-source-contract.md)查阅；历史数据按原schema保留读取与恢复所需来源。本文不要求重新部署旧SQL迁移、申请生成票据或恢复跨阶段三次预算，也不因清理活动说明而删除历史数据或有效读取能力。
