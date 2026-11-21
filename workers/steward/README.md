# Steward Worker

此目录包含 Cloudflare 上 `splrad-steward-runtime` 的受审主线候选源码。入口为 `src/index.ts`，两个 Durable Object 的类名、命名空间绑定及迁移标签沿用现役服务。数据库迁移复用仓库的 `packages/runtime/migrations`。

使用仓库固定的 Node/npm，在此目录执行 `npm ci --ignore-scripts`、`npm run typecheck`、`npm test` 和 `npm run build`。最后一条命令调用 Wrangler dry-run，把模块写入 `dist/`。生产采用由维护窗口另行办理，使用当时的版本、已审批环境绑定和恢复记录。

首次移植来源为维护提交 `c2a4f9df8a0bcddd22b14c562c63499dd55d9c7d`。已退役的内部发行 HTTP 路径返回 410，旧发行工作流派发持续拒绝。工作流、路由和绑定的生产采用应以实际部署回读为准。
