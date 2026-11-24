# Steward Worker

此目录包含 Cloudflare 上 `splrad-steward-runtime` 的受审主线候选源码。入口为 `src/index.ts`，两个 Durable Object 的类名、命名空间绑定及迁移标签沿用现役服务。数据库迁移复用仓库的 `packages/runtime/migrations`。

使用仓库固定的 Node/npm，在此目录执行 `npm ci --ignore-scripts`、`npm run typecheck`、`npm test` 和 `npm run build`。最后一条命令调用 Wrangler dry-run，把模块写入 `dist/`。生产采用由维护窗口另行办理，使用当时的版本、已审批环境绑定和恢复记录。

首次移植来源为维护提交 `c2a4f9df8a0bcddd22b14c562c63499dd55d9c7d`。已退役的内部发行 HTTP 路径返回 410，旧发行工作流派发持续拒绝。工作流、路由和绑定的生产采用应以实际部署回读为准。

## 生产状态

上传版本时，在版本消息中写入 `source-sha=<完整 Git 提交 SHA>`，或将完整 SHA 用作版本标签。巡检从 Cloudflare 当前部署读取所有承载流量的版本和各自占比，再核对版本元数据、提交与 Steward 主线的关系，以及公网 `/health` 实际返回的版本。控制台切换或回滚后沿用该版本原有的源码关联。

GitHub 约每 15 分钟巡检一次，也可在默认分支手动运行。生产作业使用仅允许 `main` 的 `steward-production-observer` 环境，读取环境变量 `CLOUDFLARE_ACCOUNT_ID` 和环境密钥 `CLOUDFLARE_WORKERS_READ_TOKEN`。令牌在目标账户具有 `Workers Scripts Read`。已确认的分流版本分别显示在 `production`，退出流量的旧回执标记为 inactive。来源不明的版本仍在巡检摘要中显示版本号和流量，并标记源码待核实。Cloudflare 或健康接口无法核实时，请结合最近成功回执的时间和最新巡检结果判断。
