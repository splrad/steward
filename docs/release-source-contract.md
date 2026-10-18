# 发布来源、候选和持久收据

当前入口包括 `release-build`、`release-freeze` 与 `release-candidate`，采用总基线 v1.8 的产品仓候选合同。产品提交 `productTargetSha` 与候选合并提交分别记录；Release 标签始终绑定前者。

## 输入与候选

`release-freeze` 从完整本地 Git 对象库读取明确边界至目标的全部可达提交、净差异、重命名、原始 commit/blob、README 背景及读取缺口。支持明确标签、采用基线和首发完整树。无需每条提交都有 PR；浅克隆、对象缺失、漂移边界、超限均失败。来源 JSON 为 UTF-8/LF，原始源码字节以 Base64 保留。

`release-candidate --operation prepare` 接受一个已准备的 bundle：

- `frozen.json`：`FrozenRelease` 合同，包括仓库、公共 VERSION、产品提交/树、策略、边界、模板摘要、来源/证据摘要、构建清单、资产摘要、中央构建 run/artifact ID、仓库作者及贡献者 ID、可信链接。
- `source.json`：`release-freeze` 的原样输出。
- `evidence.json`：`schemaVersion=1`、`sourceDigest`、`coverage.commitShas`、`coverage.paths`、`internalChanges` 和 `unknowns`；覆盖集合与来源一致。
- `release-notes.zh-CN.md`：按升级须知、更新内容、可选贡献者头像、完整变更排列的草稿。
- `assets/`：恰好包含冻结清单中的平面资产文件；无资产发布可以为空。

准备器复算本地资产，保存来源与证据，再创建专用分支及 PR。产品仓只包含 `.release-notes/candidates/{tag}/candidate.json` 和 `release-notes.zh-CN.md`。前者是中央身份投影，后者支持直接编辑。分支或版本槽被不同对象占用时停止，已有文件不覆盖。PR 说明要求维护者同时确认仓库作者 ID 和贡献者集合；账号存在不等于作者身份已经被人工确认。

中央 API 回读 VERSION、产品树和净差异，验证原始 Git 对象、模板、构建配置/清单、中央 run/artifact 身份及贡献者提交关联。模型不能通过候选文件自报批准。当前链接合同支持冻结区间 compare 和有区间提交关联的同仓 PR；按仓个性化仍保持关闭。

## 批准和发布

`inspect` 回读当前候选 head、两项必需检查及归属、真人 Review 权限和正文。批准绑定精确 head 与正文摘要。旧 head、撤销批准、请求修改、产品树变化、身份投影改变或额外文件都会阻断。`Release Candidate Review` 在 Checks 显示状态及正文入口，待处理项附文件行注释。

Review 事件只调用 `inspect`。`reconcile` 先核验真人手动合并证据，再进入发布；自动合并和合并队列不能替代手动合并。中央能力必须为 active。`release.yml` 的准备、观察和发布作业仅执行固定中央策略，不执行下载 bundle 或产品代码；输入通过环境变量传入命令。发布作业按收据中的中央 artifact ID/run ID 下载资产，重新复算字节。

每次远程写入前复核批准、合并、默认分支产品树、版本顺序、旧标签边界及不可变发布策略。先持久化写入意图，再创建唯一匹配草稿、续传缺少的资产、发布并验证。已有资产 ID、名称、大小和摘要必须一致；不通过删除重传消除冲突。发布后下载资产重新计算 SHA-256，核验标签、正文、标题、immutable 和 latest，再保存 verified 收据。

最终 publish 作业按仓库 ID 串行，不同 tag 共用并发组，且不取消正在发布的作业。排队作业开始后仍重新核验版本顺序；若更高版本已发布，较低版本阻断，不能覆盖 latest。候选准备和审阅仍按各自版本运行。

## 存储与恢复

增量迁移 `0010_release_receipts.sql` 在现有 D1 绑定中增加 `release_receipts` 和 `release_evidence_chunks`；历史迁移及表保留。版本槽由仓库 ID/tag 唯一绑定，修订保留旧记录；更新使用版本 CAS 和十分钟有界租约。

操作包括：

| operation | 行为 |
| --- | --- |
| prepare | 校验 bundle，保存输入，创建或恢复同一候选 |
| inspect | 回读审阅状态并更新 Checks；不发布 |
| reconcile | 回读真实合并和发布状态，继续符合条件的发布 |
| pause / resume | 显式暂停或恢复同一收据 |
| revise | 旧候选已关闭未合并、已暂停、未创建 Release/写入意图时，建立新修订；重新审阅 |
| retry-create | 创建结果长期未知时的人工恢复入口；等待一小时后重新核验不存在同标签 Release/tag，再清理原创建意图；此操作本身不发布 |
| export | 导出当前或 `--revision` 指定的收据及原始来源、证据，并校验摘要 |
| generator-ticket | 固定生成计划和跨重跑预算，签发仅能访问该候选生成账本的凭证；有效期取一小时与计划执行预算加三十分钟排队/初始化余量的较大值，最长八十六分钟 |
| rebind-build | 本地重新复算资产，并校验完整清单、工具链及中央成功运行；相同字节更新下载来源，保留原冻结身份和批准 |

创建、上传和发布响应丢失后先回读远程对象。创建结果仍未知且没有可绑定对象时保留意图，自动重试不会再次创建。已发布内容漂移只报告，不覆盖人工编辑。

初始构建已 accepted、但 seed 上传或后续派发失败时，重跑 `release-build-complete.yml` 全部作业，或手动派发该工作流并传入原 `release-build.yml` 的 runId。完成入口重新定位原请求与构建 artifact，复算资产并重建 seed；同一构建的 finish 可幂等调用，随后重新上传和接续 generate。无需将 accepted 改回 failed。此恢复要求原构建 artifact 仍可用且策略同步；artifact 已过期时明确失败，须人工处理。

尚未 accepted 的初始构建遇到策略或产品提交更新时，下一次通过完整来源校验的 prepare 自动归档旧请求，并为同一 tag 创建新请求。增量迁移 `0013_release_build_restart.sql` 保留历史请求及运行身份；归档和创建在同一事务内完成，版本 CAS 防止与完成回调竞争，同版本只保留一个有效请求。新请求从头构建，迟到回调不能修改已归档请求。每个 tag 最多自动替换三次，每个请求仍最多执行三次；预算随记录持久化。已有候选收据、Release/tag、accepted 请求或预算耗尽时停止并要求人工处理。替换由正常构建准备入口触发，无需另填 abandon/revision 字段；本机制不新增提交事件到发布工作流的调度。

沿用现有 Worker 定时入口，每批最多二十个候选，同对象至少间隔十五分钟；覆盖已绑定待审、已批准、已合并和发布中状态，以发现漏失事件。pending 能力只观察，active 才能调度 reconcile。暂停和旧策略记录不自动恢复。

## 本地验证与尚未完成的环节

本批验证包含真实 SQLite 迁移/CAS/重启、Git 对象与缺口、GitHub 读取适配器、Review/合并事件分流、批准前零发布、无资产与中性仓库、三种响应丢失、资产冲突、正文漂移和下载摘要。GitHub 与远程 D1 通过夹具模拟；不等于线上流程验收。

`release.yml` 的 generate 操作依次固定生成预算、运行隔离模型作业和创建候选。模型作业只注入个人 Copilot PAT；父进程用短时凭证访问生成账本，子进程使用独立空目录和配置，不继承该凭证、App 或发布凭据。CLI 固定为 1.0.91，禁用工具、内置 MCP、自动指令和会话恢复。增量迁移 `0011_release_generation.sql` 保存计划、调用预留、原始格式失败输出和成功输出；未知结果仍计次，完成批次跨重跑复用。结构解析只接受唯一 JSON 对象或明确 json 围栏，拒绝重复键和未知字段。

构建执行层已接入四种 Profile 的参数编排、准确干净提交检查、独立输出目录、原生版本检查器及中央清单收集。`release-build.yml` 固定来源、构建请求和工具链，在隔离作业执行产品构建；`release-build-complete.yml` 回读运行与 artifact 身份，独立验证下载资产，自动生成包含 `source.json`、`frozen.json` 和资产的 seed bundle，再接续 generate。首发请求在 seed 来源摘要验证及文件写入成功后才 finish；此前失败可保存为 failed 并重试。GitHub 文件发布只接受一个非 OCI 构建单元。

有文件资产的首次发布从 `release-build.yml` 开始，构建完成后才进入 generate 和候选准备。候选准备 API 要求冻结清单与配置的 builds 完全一致，并验证中央成功运行及 artifact 身份；缺少所需构建清单会以 `BUILD_SET` 拒绝。配置无构建单元的仓库允许无资产候选。

各 Profile 共用根目录 `VERSION` 合同：冻结产品提交必须包含严格的 `X.Y.Z` 加 LF，且与目标标签及原生资产版本一致。LayerScape 的配套 [PR #168](https://github.com/splrad/LayerScape/pull/168) 增加 `VERSION`，由 `Version.props` 和发布脚本共同读取；须先将配套变更纳入所选产品提交，再运行首发构建。旧产品提交缺少文件时明确失败，不从标签推断文件内容。LayerScape 的发布能力仍为 pending，启用须另行完成部署和真实链路验收。

`ensure-assets` 已接通缺失或过期资产的重建调度。`rebind-build` 必须匹配原冻结工具链、清单及资产字节，同字节更新下载来源并保留批准；异字节走 `revise-rebuild`，重新建立候选并审阅。已准备但尚未绑定 PR 的候选可经 `recover-candidate` 恢复。所有恢复仍严格绑定 `POLICY_SHA`：默认分支与收据策略不一致时明确阻断，待策略同步后重试；旧收据缺少工具链摘要时拒绝推断。

当前 source 验证读取上限为 32 MiB，证据为 512 KiB，正文为 128 KiB；超过上限明确失败。生成最多八批，每批输入 96 KiB，整个计划 256 KiB，每批及最终汇总最多各两次调用；单次 180 秒，小输入总预算十分钟，多批预算在调用前固定。完整文本按 Unicode 字符切片，超限不截断后继续。LayerScape 仍为 pending。

候选创建前，生成计划的来源或策略更新可自动归档旧账本并建立新账本，每个 tag 最多三次。历史调用记录保留，旧票据撤销，版本号继续递增以拒绝迟到写入；同来源同策略的输入变动不重置预算，已归档计划不能恢复。候选收据存在时禁止替换。

资产上传和下载校验共用按大小计算的预算：一分钟初始化余量，加上按 4 MiB/s 计算的传输时间；1 GiB 资产预算为 316 秒，下载重定向共用同一预算。低于该基准仍可能超时，恢复时继续核验远端资产身份和摘要。

发布作业从可信收据计算总预算：二十分钟初始化/收尾余量，加上总资产按 4 MiB/s 下载构建 artifact 的时间，再加全部资产各自上传及回读预算。三个 1 GiB 资产为 65 分钟；128个32 MiB资产为328分钟，均覆盖既定总量并低于托管作业六小时上限。每次有效收据操作续租十分钟，下载每项资产前续租；过期租约不可恢复。安装令牌使用相同仓库和权限范围，每45分钟按需刷新。生成作业上限86分钟，覆盖最大56分钟模型预算和30分钟初始化/收尾余量。

部署前须依次应用新增迁移 `0010_release_receipts.sql`、`0011_release_generation.sql`、`0012_release_build_requests.sql`、`0013_release_build_restart.sql` 和 `0014_release_generation_restart.sql`，再部署相同策略版本的 Worker 与工作流；随后在获准测试对象验证真实网页编辑、Review/手动合并、Actions 下载、D1 绑定及 GitHub 不可变 Release。正式产品发布另行执行对应授权阶段。
