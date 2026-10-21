# 发布说明个性化

个性化由中央 release Profile 的 `releaseNotes.personalization` 管理。未配置与 `enabled: false, sections: []` 均使用纯通用模板。实际仓库是否启用需按阶段授权；支持该配置不等于开启发布能力。

Profile 的 `repository.id` 与 `repository.fullName` 必须匹配当前仓库；Profile 还须登记在 `config/release-profiles.ts`，配置校验会检查注册表与 Profile 文件一致。其他仓库的 Profile 即使关闭，也不能串用。

## 区块

`bullet-list` 的 `items` 是单行纯文本，支持 `beforeActions` 与 `afterChanges`。前者位于升级须知内，后者位于更新内容末尾、贡献者之前。链接、HTML 和结构性 Markdown 不作为安装或环境说明输入。

`asset-table` 仅支持 `beforeActions`，作为升级须知下的下载子节。`items` 填构建清单的逻辑资产 ID，例如 `installer`；不能填任意 URL、文件路径或产品名推断规则。每个 ID 必须唯一对应一个冻结文件，名称、大小与摘要须和冻结资产集合一致。链接由仓库、目标标签及已核验文件名生成。资产缺失或 ID 歧义时失败，不输出占位下载链接。无资产版本仍可使用纯文本说明。

例如，下面是中性产品的配置片段，仅用于说明结构：

```json
{
  "enabled": true,
  "sections": [
    {
      "id": "downloads",
      "type": "asset-table",
      "slot": "beforeActions",
      "title": "下载",
      "items": ["package"]
    }
  ]
}
```

## 冻结与审阅

新构建准备时，将仓库身份、有效开关、区块资料和确定性摘要写入 `FrozenRelease.personalization`。运行时重新按当前中央 Profile 校验，拒绝调用方自行开启、跨仓资料或过期配置。未带该字段的旧收据仅在当前有效配置仍为关闭时兼容。

个性化进入候选冻结摘要。配置变化需要新冻结输入、预览及重新审阅。中央区块按冻结数据渲染并校验精确字节，其他正文仍可人工编辑；贡献者排除和必要升级提醒不随个性化关闭。

重建资产变化后的新候选仅刷新中央生成的资产详情，保留其余人工正文。旧收据和旧批准正文保持原样，新修订必须重新批准和手动合并。
