# D 有界重查实现合同 v2

本轮实现候选 6 次/2h、WinGet PR 31 次/14d、索引 13 次/48h；初次登记观察不计重查槽。维护基点 06a8096018721ef4e656c40c90dd92896d47f2b2。B 固定桥、观察入口和 5min WinGet observe job 独立采用；本包没有部署、推送或更改线上 cron。

## 来源、认证和接线

复用 authorizeSingleRepository：固定产品 1187527897，单仓 installation token，现役 App 4243096 / installation 145952003。没有 OIDC、id-token:write 或新共享秘密。令牌只在当前请求/30s reader 内存中使用。Worker 使用现有 App 读取中央 1296724484 的固定 Run 与 artifact，派发中央 release-observe.yml / bounded-release-event.yml 或产品 steward-release-channels.yml。POST 范围写死，不能提供 URL/命令/任意仓库。

候选真实 PR webhook 经现役 HMAC/组织验证，唯一原生 issue event 关联后，在 event:v1:<digest> 对象事务写一次桥意图并预置 alarm，再发一次 workflow_dispatch。D 是唯一完成消费者：+1/+5/+15min 最多三次 GET 核固定来源 Run attempt、App bot、policy SHA、artifact archive SHA/创建时间、原 Git session/chunk/blob 摘要和原生事件。未知 POST 不重发。B 没有 self workflow_run 或 HTTP finalizer。窗口之外的桥未完成保留 UNKNOWN_DELIVERY，不宣称业务接管完成。

候选 identity 源于原 generated session；当前 main 必须仍为原 sourceSha。完成判据来自准确观察 result.json（CACHED_OBSERVATION/READY 或 HUMAN_EDIT_CONFLICT/CONFLICT），并再次核原 Git evidence、PR head、open/unmerged、完整 labels。editing 暂停；unlabeled/reopened 的真实事件恢复原 epoch、T0、deadline、剩余预算。过期及其他终态不复活。

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

本地 SQLite 事务/可控时钟、Git/Run/artifact 反例、精确 WinGet 输入与阶段切换、现役认证与退休回归、TypeScript 和 Wrangler dry-run。未发真实业务 Run、模型或安装测试。E 负责最终 head 独立审查，central 负责采用/推送/部署窗口。

### 端点权限依据

官方 GitHub REST 2026-03-10 issue-events 文档（https://docs.github.com/en/rest/issues/events?apiVersion=2026-03-10#get-an-issue-event）允许 Issues read 或 Pull requests read；pull GET 文档（https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#get-a-pull-request）允许 Pull requests read 或 Contents read。产品只读 token 因此请求 pull_requests:read，中央只读 token不请求该权限，派发 token也不请求；均只含一个repository_id。已有本轮 D-resource-retirement/result.json 的 App4243096 安装元数据记录 Actions/Contents/Pull requests 写权限；这是缩窄既有能力，不修改 App 授权。线上准确 token/consumer 采用验证仍由中央执行，本地 mock 不替代线上权限验收。
