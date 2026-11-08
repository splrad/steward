# 发布说明与历史个性化记录

当前发布说明使用统一模板，不提供按仓库配置的个性化开关、内容区块或模板插槽。发布输入由产品的交付配置、版本说明和已核验资产事实组成；必要的兼容性、升级、安全提醒、真实资产链接及贡献者展示仍属于公共发布内容。

当前模板源为 [`templates/repository/.github/release-template.md.mustache`](../templates/repository/.github/release-template.md.mustache)，确定性正文处理位于 [`packages/core/src/release-template.ts`](../packages/core/src/release-template.ts)。本文件路径保留，供旧链接和历史记录查询使用。

## 历史记录读取与恢复

历史 `FrozenRelease` 可以包含 `personalization` 字段，其类型仍保留在 [`packages/core/src/release-note-receipt.ts`](../packages/core/src/release-note-receipt.ts)。其中的仓库身份、开关、区块、插槽和摘要属于当时冻结记录的原始数据，只用于历史读取、校验和恢复；它们不是当前生产配置入口，也不用于生成新发布内容。

读取或恢复历史记录时，应保留原始字段、档案字节和既有发布正文，不把历史数据改写为当前模板格式，不删除恢复所需信息。缺少该可选字段的旧记录仍按其原有格式读取。恢复须使用与记录对应的来源与恢复流程，不能通过重新启用旧 Profile、配置注册表或插槽生成分支来替代。

本次文档修订不改变历史记录类型、原始档案或已发布正文。历史字段的存在也不表示个性化功能仍可启用。
