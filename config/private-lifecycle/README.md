# 私有生命周期 updater 合同

`renovate.json` 和 `dependabot.yml` 是唯一当前目标合同。Renovate v2 用稳定的 `matchDepNames` 选择 controller reusable workflow，避免 `overridePackageName` 后再次应用规则时失配；精确的 mise `uses-with` 规则设置 `pinDigests: false`，只更新版本值。

`history/renovate-v1-base.json` 是 b87eb99b0fd0d96e363b64912348f34163f3b9e9 中旧配置的逐字快照，仅用于验证迁移 PR 的历史 base。head 含 updater 时必须符合当前 v2；不向消费者递送历史文件，也不允许 v1 成为第二个活动目标。Dependabot 在两个 side 上都必须符合当前精确合同。

原有 updater 可选成对存在规则保持。历史兼容仅比较完整结构，不忽略 scope、owner、manager、automerge 或其他字段；可信 controller、workflow 结构、12 个统一 refs、原生锁和在线身份/漏洞检查沿用各自验证路径。该迁移合同通过不替代真实托管提取、完整更新 PR 及锁事务验收。
