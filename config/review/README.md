# 审查规则载体

`rules.json` 是规则正文的唯一来源，`profiles.json` 定义仓库采用的规则组合。生成器始终保留共享规则的 `AGENTS.md`；默认同时生成 `.github/copilot-instructions.md`，供 Copilot 读取专用规则。

## 导出与采用组织指令

构建 runner 后，可在中央策略 checkout 中只读导出组织文本、规则编号和 SHA-256：

```sh
node packages/runner/dist/index.js render-review-instructions --policy-sha <完整策略提交>
```

输出 JSON 的 `organization.content` 是待保存的完整文本，`organization.digest` 是其 UTF-8 原始字节摘要。命令只读取 `STEWARD_CONFIG_DIRECTORY` 指向的中央配置，未设置时使用现有默认配置目录；它不会读取目标仓库的规则副本，也不访问 GitHub。`policySha` 是调用方提供的来源标识，执行者需核对 checkout 与该提交一致。

省略 `--profile` 时只导出组织文本，即使所有 profile 仍记录旧版本摘要，也能导出更新后的规则。需要同时预览仓库文件时，增加 `--profile common`（或其他 profile）；此时仍须通过该 profile 的采用摘要校验。规则更新后，先导出、保存并验证新组织文本，再更新采用摘要；同步和仓库校验继续拒绝过期摘要。

在组织文本已保存、读回一致，并验证目标消费者能够取得组织规则后，才在对应 profile 增加 `organizationInstructionsDigest`，值使用上述摘要。省略该字段继续使用仓库载体。字段只作用于所在 profile，common profile 的采用状态不会隐式覆盖其他 profile。

采用组织指令后，生成器从仓库 Copilot 文件中移出 common profile 的专用规则；仓库专用 Copilot 规则继续生成。共享规则仍通过 AGENTS 提供给 Codex 等消费者。组织文本使用全部 active common 规则，规则本身不得为迁移而删除或改为 retired。摘要与当前规则不符时，仓库文件生成、同步和校验失败关闭。

这个字段记录已采用的组织版本，不是 GitHub 实时设置读回。发布人员必须分别留存组织文本保存、目标身份消费和仓库同步的证据。外部贡献者、机器人、IDE 和 CLI 的适用范围应分别核验，不能用成员在网页上的一次成功代替其他消费者。

## 文件同步与退役

需要保留的文件按同一中央配置生成。当 Copilot 仓库文件已无必要内容时，同步流程明确声明退役 `.github/copilot-instructions.md`，校验也要求该文件不再存在。

退役前按固定父提交读取原文，要求内容与当前规则生成的完整旧载体逐字一致，再核对 Git tree 完整性、`100644` 普通文件模式和原文 blob 摘要。有人工修改、未知内容、不同文件类型或不完整证据时停止。文件原本不存在时不产生删除项；目标文件全部一致且退役已经完成时不创建空提交。

远端同步仅将 Contents API 的 404 响应视为路径缺失；目录或无法解码的响应使同步失败。本地校验直接读取目标路径元数据，仅将 ENOENT 视为缺失，目录、符号链接及其他读取错误均不能作为退役完成的证据。

文件更新和退役写入同一 tree、同一提交。新提交的文件内容及退役结果读回成功后，才创建或更新受管分支，并保留既有 PR 归属、人工合并和 native 审查合同。Git tree 的模式与删除语义依据 [GitHub REST 文档](https://docs.github.com/en/rest/git/trees)。

若已有旧文件因历史规则不同而无法匹配，先核对差异并走受控修订；不得把不匹配内容强行当作可删除副本。恢复仓库载体时移除对应 profile 的采用摘要，通过原同步流程重新生成文件，并分别处理组织设置的恢复。
