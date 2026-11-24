# Steward Worker

此目录包含 Cloudflare 上 `splrad-steward-runtime` 的受审主线候选源码。入口为 `src/index.ts`，两个 Durable Object 的类名、命名空间绑定及迁移标签沿用现役服务。数据库迁移复用仓库的 `packages/runtime/migrations`。

使用仓库固定的 Node/npm，在此目录执行 `npm ci --ignore-scripts`、`npm run typecheck`、`npm test` 和 `npm run build`。最后一条命令调用 Wrangler dry-run，把模块写入 `dist/`。生产采用由维护窗口另行办理，使用当时的版本、已审批环境绑定和恢复记录。

首次移植来源为维护提交 `c2a4f9df8a0bcddd22b14c562c63499dd55d9c7d`。已退役的内部发行 HTTP 路径返回 410，旧发行工作流派发持续拒绝。工作流、路由和绑定的生产采用应以实际部署回读为准。

## 生产状态

上传版本时，在版本消息中写入 `source-sha=<完整 Git 提交 SHA>`，或将完整 SHA 用作版本标签。巡检从 Cloudflare 读取每个在线版本的 UUID、流量比例和上传者声明，检查声明提交是否属于 `main`，并用公网 `/health` 确认响应版本属于当前流量分配。

对首次出现且声明属于主线的版本，独立的只读作业使用该提交锁定的 Wrangler 干运行重建 Worker。它将入口、每个模块的名称、类型和内容纳入 SHA-256 清单，与 Cloudflare 版本 API 的实际模块核对。证明范围为 Worker 模块，运行时绑定和配置另由 Cloudflare 管理。同一不可变版本与提交已有匹配凭证时，分流调整和回滚会复用该凭证。

[GitHub Deployments](https://github.com/splrad/steward/deployments) 的 `production` 环境为每个承载流量的版本显示一条记录。模块一致时记为 success。源码缺失、重建不可用或摘要不同均记为 pending，说明中保留实际流量及原因。没有主线声明时，GitHub 记录使用巡检提交作为观察点。点击记录的环境链接可查看上传者声明、主线归属及模块比对结果。退出流量的回执标记为 inactive。

GitHub 约每 15 分钟巡检一次，也可在默认分支手动运行。仅允许 `main` 的环境 `steward-production-observer` 提供环境变量 `CLOUDFLARE_ACCOUNT_ID` 和环境密钥 `CLOUDFLARE_WORKERS_READ_TOKEN`，令牌在目标账户具有 `Workers Scripts Read`。Cloudflare 或健康接口暂时不可用时，请结合最近回执时间和最新巡检结果判断。
