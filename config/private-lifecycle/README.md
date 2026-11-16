# 私有生命周期 updater 合同

`renovate.json` 和 `dependabot.yml` 是唯一当前目标合同。Renovate v3 保留 v2 的稳定 `matchDepNames` controller reusable workflow 匹配和精确 mise `uses-with` 的 `pinDigests: false`，增加与中央当前配置一致的五个原生中文呈现选项：`prHeader`、`prBodyColumns`、`prBodyHeadingDefinitions`、`prBodyTemplate`、`prFooter`。原生警告、说明、更新日志、控制项和页脚槽完整保留。

`history/renovate-v1-base.json` 是 b87eb99b0fd0d96e363b64912348f34163f3b9e9 中旧配置的逐字快照；`history/renovate-v2-base.json` 是 1fb5683cfa3684aba5db9fb1ca4d0106e7ea81da 中目标配置的逐字快照。两者仅用于验证受信迁移 PR 的历史 base。head 含 updater 时必须符合当前 v3；不向消费者递送历史文件，也不允许历史版本成为第二个活动目标。Dependabot 在两个 side 上都必须符合当前精确合同。

原有 updater 可选成对存在规则保持。历史兼容比较完整结构，不忽略 scope、owner、manager、automerge 或未知字段；可信 controller、workflow 结构、12 个统一 refs、原生锁和在线身份/漏洞检查沿用各自验证路径。合同通过不替代真实官方 App 提取、PR 正文、完整更新及锁事务验收。

本目录是验证合同源，不是新仓配置自动生成服务。当前 bootstrap/Copier 不递送 Renovate 配置；登记的私有生命周期消费者通过专项采用当前合同。其他新仓的更新器配置须在其正式接入工作中按实际字段分工采用，并核对既定原生中文选项，不自动扩大本私有合同的仓库或路径范围。
