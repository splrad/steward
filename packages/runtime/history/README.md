# 历史运行材料

这里保存原 Worker 的部署描述，`../migrations` 保存原 SQL 迁移。`../src/release-history.ts` 提供 SELECT-only 的候选、版本、预算及分块对象导出，并核验对象顺序、长度和摘要。

源码中的 webhook 调度入口和部署工作流已由原生工作流交接。线上旧写入者、Cloudflare 资源、凭据和存量数据的停用或删除属于各能力采用及最终退役阶段，需要独立授权和证据。

本目录的 `wrangler.toml` 是原部署描述副本，保留原来的入口和迁移相对路径，不能在本目录直接部署。恢复时须检出[归档提交中的完整 runtime 目录](https://github.com/splrad/steward/tree/d89aaffa0d0f22e1f8c4d5d160b43da4c7e3262e/packages/runtime)，使用其中的 `src/index.ts`、`migrations/` 和原位置的 `wrangler.toml`，并按已授权的恢复范围核验资源与凭据。
