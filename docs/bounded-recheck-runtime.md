# D 有界重查实现合同 v2

本轮实现候选 6 次/2h、WinGet PR 31 次/14d、索引 13 次/48h；初次登记观察不计重查槽。维护基点 06a8096018721ef4e656c40c90dd92896d47f2b2。B 固定桥、观察入口和 5min WinGet observe job 独立采用；维护 PR358 的推送/CI 与部署分别验收，当前没有部署或更改线上 cron。

## 来源、认证和接线

复用 authorizeSingleRepository：固定产品 1187527897，单仓 installation token，现役 App 4243096 / installation 145952003。没有 OIDC、id-token:write 或新共享秘密。令牌只在当前请求/30s reader 内存中使用。Worker 使用现有 App 读取中央 1296724484 的固定 Run 与 artifact，派发中央 release-observe.yml / bounded-release-event.yml 或产品 steward-release-channels.yml。POST 范围写死，不能提供 URL/命令/任意仓库。

候选真实 PR webhook 经现役 HMAC/组织验证，唯一原生 issue event 关联后，在 event:v1:<digest> 对象事务写一次桥意图并预置 alarm，再发一次 workflow_dispatch。D 是唯一完成消费者：+1/+5/+15min 最多三次 GET 核固定来源 Run attempt、App bot、policy SHA、artifact archive SHA/创建时间、原 Git session/chunk/blob 摘要和原生事件。未知 POST 不重发。B 没有 self workflow_run 或 HTTP finalizer。窗口之外的桥未完成保留 UNKNOWN_DELIVERY，不宣称业务接管完成。

候选 identity 源于原 generated session；当前 main 必须仍为原 sourceSha。完成判据来自准确观察 result.json（READY/CACHED_OBSERVATION 或 READY/MANUAL_PROJECTION，并须独立核实 projectionEvidence），并再次核原 Git evidence、PR head、open/unmerged、完整 labels。editing 暂停；unlabeled/reopened 的真实事件恢复原 epoch、T0、deadline、剩余预算。过期及其他终态不复活。

WinGet 初始登记来自验签后的准确产品 workflow_run 完成事件。服务端独立读取 exact submit Run/attempt/App bot、protected Git cycles/<id>.json 的 canonicalRunId/requestKey/targets 以及成功 submit/winget/layerscape job 的 report.json。upstreamPR number 由该 artifact 得出，再 GET microsoft/winget-pkgs 准确 PR 绑定 node_id/base/fork/branch；PR T0 使用原生 created_at。首次登记前若源 state 或证据暂不可读，本实现尚无持久登记意图或自动重试。GitHub 不会自动重投失败 webhook；只能由后续真实事件重新触发，或明确人工 redelivery 再尝试，并仍保留原生 created_at/merged_at，不能新开时间窗。该入口稳定性与首次事件丢失必须在生产采用前真实验收；本轮不新增全局巡检。官方说明：https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries。

WinGet 两阶段共享一个业务对象地址（objectKey 将 winget stage 归一），record.identity 保留当前准确 stage。原生 merged_at 在同一 SQLite 事务内结束 PR alarm 并初始化唯一 index 阶段；不存在跨 DO 创建的中间窗口。重复 submit 事件只读取已有对象，不重设阶段或计数。index observe 使用原 8 inputs 及 canonical request_key；slot intent key 只供内部去重。Run 必须在该 intent 时间窗口，unique，固定 App bot/head/workflow；job observe 成功且不超过5min，report item 在原生 job 窗内并匹配精确版本/PR，独立 PR 回读后才可 DONE。产品不注入回调凭据，使用有限 GET 确认。

## API、持久化和终态

POST /internal/bounded-rechecks/v1/{register,pause,resume,cancel,receipt,status}，无 query，32KiB streaming body 上限。register 需要 registration+producer；pause/resume 需要 identity/expectedGeneration/producer，并独立核 producer 原生事件与当前 label。cancel/status 只允许已认证单仓对象。receipt 仅候选定位提示，不接受 DONE 或 PASS；产品走有限 GET。

专用 BoundedRecheckCoordinator / BOUNDED_RECHECK / migration bounded-recheck-v1，new_sqlite_classes。KV record schemaVersion=1 与 alarm 在 storage.transaction 同时提交。旧 ValidationCoordinator / D1 / routes / cron 不迁移。namespace ID 尚未创建。每动作先持久 claim，外部失败/进程重构只确认既有意图。每槽确认最多3次，平台早到重投不消耗确认。迟到跳过过期槽，不补发；deadline 优先；429 保留未知意图并遵守 Retry-After，不能因此新开 POST 窗口。late verified fact 可追加，但不复活取消对象。

notificationPending 仅持久待处理标记；本轮没有新增消息通知目标或承诺必达。status 返回必要恢复状态，不含令牌。

## 采用与回滚

BOUNDED_RECHECK_ENABLED=false 默认关闭。配置显式保持 LEGACY_RELEASE_RETIRED=true、LEGACY_VALIDATION_RETIRED=true，与已知线上双屏障一致。上线前中央填写 BOUNDED_CONTROLLER_SHA、BOUNDED_PRODUCT_SHA、BOUNDED_DEPLOYMENT_SHA，核 B config enabled/固定部署 SHA 和真实产品 controller pin、原入口暂停策略、App Actions read/write+Contents read+产品 Pull requests read 是否匹配已选两仓。不得用假 SHA、空 namespace ID 或旧 POLICY_SHA 替代这些版本。

回滚保留新 class、schema-v1 解码、status/cancel/alarm handler。先关闭新登记/派发并按已知对象保存 status、暂停、确认在途；再切兼容 bundle。BOUNDED_RECHECK_ENABLED=false 时 alarm 将活跃 record 暂停，不做业务 IO。namespace 不删除；旧 bundle 不可重新开放旧写者。DO 数据恢复后核外部 Run，不能重放未知 POST；原 epoch/预算不清零。业务对象登记清单及生产级恢复演练尚未在线验收，本地测试不等于 Cloudflare 生产恢复保证。

## 验证边界

本地 SQLite 事务/可控时钟、Git/Run/artifact 反例、精确 WinGet 输入与阶段切换、现役认证与退休回归、TypeScript 和 Wrangler dry-run。未发真实业务 Run、模型或安装测试。D 负责已授权维护 PR 的签名推送和验证，E 负责最终 head 独立审查，central 负责采用与部署窗口。

### 端点权限依据

官方 GitHub REST 2026-03-10 issue-events 文档（https://docs.github.com/en/rest/issues/events?apiVersion=2026-03-10#get-an-issue-event）允许 Issues read 或 Pull requests read；pull GET 文档（https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#get-a-pull-request）允许 Pull requests read 或 Contents read。产品只读 token 因此请求 pull_requests:read，中央只读 token不请求该权限，派发 token也不请求；均只含一个repository_id。已有本轮 D-resource-retirement/result.json 的 App4243096 安装元数据记录 Actions/Contents/Pull requests 写权限；这是缩窄既有能力，不修改 App 授权。线上准确 token/consumer 采用验证仍由中央执行，本地 mock 不替代线上权限验收。

## 2026-11-17 集中审查修正

原生候选事件先写 native:v1 对象，再有限准备并派发 release-candidate-event.yml。准备最多四次，确认最多三次；绑定已知 Run 后允许唯一原生完成事件预约验证。Retry-After 下限持久化，暂停/恢复和实例重构保留下限、原 deadline 及已消费次数；提前完成事件只预约限流解除后的验证，不重复 POST。尚未首次 claim 的对象在 deadline 当刻停止，已有对象仍允许最后一个既定 slot。

G 完成须独立读取实际原生 head tree，逐路径/mode/blob 验证其等于 generated.baseSha tree 应用完整 generated.files（包括删除）后的结果，再验证评论与受保护预览。手动候选读取原 source 与当前 head 的完整 tree，所有变化仅限 old G 的完整精确文件路径与当前 unit.notesPath，保留 CHANGELOG 等合法交付范围。树截断或路径证据不完整不能视为通过；未托管变更和 G 字节差异进入 NEEDS_ATTENTION。HUMAN_EDIT_CONFLICT 不属于 DONE；G 仅接受 READY/CACHED_OBSERVATION，手动仅接受 READY/MANUAL_PROJECTION，并均要求独立 projectionEvidence。

microsoft/winget-pkgs 的固定公开 PR GET 复用当前 reader 的原始 30 秒 deadline、注入 transport 和 256KiB 流式响应上限；不扩大 App 安装范围或加入用户 token，处理 429/503 与耗尽公开配额的 403 等待时间。本轮验证采用本地 fixtures，不代表 E12 线上验收。维护 PR358 的签名推送及托管 CI 与实际部署分别记载；上线仍等待中央准确版本窗口。

### 原生完成回执与恢复的有限差量

已知Run的唯一completion从一次实际核验调整为初验加最多一次限流只读重验，receiptRetryUsed在持久预约前占用。已存在Retry-After导致首次GET前延后不占重验；重验再次限流即终止，floor>=原deadline不发新GET。原3次未知派发discovery、唯一POST、T0/deadline/pins不变。normal前置链外读处理最多4准备+3discovery+2receipt=9，较前版增加1；到期标记另1，入站/平台重投/人工redelivery另计。已登记candidate对象1初次+6槽各最多1观察+3确认=28次核验，与基线32保守口径及WinGet192分开，不能把normal前置链纳入32或将核验次数等同GET数。normal已知Run完整核验最坏545 GET，新增重验最多增加545 GET；全部native自动链静态粗上界3798 GET，30秒reader截止会提前截断，不含token POST、内部DO、下游即时wake或人工redelivery。

native事件因关闭或pin变化暂停时持久保留原阶段/nextAt。仅经原HMAC验证的同hint显式redelivery，在原pins复原、enabled、原窗口内且独立原生event/控制状态仍吻合时恢复原阶段/alarm；不推断回PREPARING，不重POST，不重置预算。缺失暂停前状态证据或pins异/过期则保持停止，单独切换配置不会自动恢复。

manual oldG非null路径须保持普通blob且mode匹配，正文允许人工改写；null删除路径须缺失，当前必需notesPath由存在/普通文件/五事实核查优先。迟到成功只保留evidence，超过deadline不能DONE；暂停期间迟到的超deadline限流恢复为NEEDS_ATTENTION且无alarm。
