# SPLRAD 设置事件转接

独立 Worker `splrad-settings-events` 只验证治理 App 的真实 webhook 并唤起私有设置仓官方 full-sync，不实现设置同步。它与仍承担其他职责的 `splrad-steward-runtime` 分离。

固定目标为 `splrad/steward-settings` main、事件类型 `settings-source-event`。临时 installation token 限制单仓 `contents:write` 和 `metadata:read`；治理 App 私钥自身仍具有 App 全部既有权限。使用专用密钥和签名 secret，仅放入 Worker Secrets；构建不取得凭据。

JWT 使用 WebCrypto 原生 PKCS#8 导入和 RSASSA-PKCS1-v1_5/SHA-256 签名，固定 RS256、App issuer 及原有五分钟有效期，RSA至少2048位；jose独立验证测试生成的JWT。生产bundle不加载通用JWT算法分派。同一 isolate 对每个密钥绑定仅复用一个已完成导入的 CryptoKey；绑定值改变即重新导入。缓存不保留 JWT、installation token 或跨请求待完成的 Promise；每个有效事件仍重新签发、验签、检查范围并撤销 token。这些优化不替代线上 Free 能力验收。

`repository.created/edited/unarchived`、默认分支 create、`label.created/edited/deleted`、指定 installation 与 installation_repositories 事件触发同步。准确组织、installation 与来源经校验；自身 Bot 的标签和 repository.edited 事件忽略以阻止回环。配置 push 由私仓已有入口处理。六个合并字段的直接更改没有经过验证的逐字段事件保证。

从仓库根运行 `npm ci --ignore-scripts --no-audit --no-fund`，再运行 `npm run test:settings-events`。部署检查为 `npm run deploy:check --workspace=@splrad/settings-events`。正式部署使用同一已审构建的 prebuilt 产物；初始 ENABLED=false，完成 secret 与 App webhook 配置后由授权维护者启用。Free 配额及 CPU 限制须在真实运行核实，不自动升级或增加订阅。

没有 cron、数据库或精确一次保证。重复事件可重复唤起幂等同步；未知响应不盲重试。GitHub 不自动重投失败 webhook：维护者查看 Recent deliveries，按 delivery UUID 对账私仓 Run 后人工 Redeliver。日志不记录 payload、仓名、标签正文或凭据；上游错误不直接回传。

撤回时先停 App webhook/本服务 ENABLED，核对在途 Run，再撤销本服务专用密钥；保留原 Actions key、共享 Worker 及配置 push 入口。
