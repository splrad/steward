# 发布区间与逐提交来源合同

R02 将来源选择放在确定性 Core 与远端适配器之间。`ReleaseSourceInput` 固定 repositoryId、defaultBranch、targetSha、policySha、区间边界及每条第一父提交的唯一 PR。该对象是后续事实片段、资产和生成输入的来源部分；完整发布输入及持久收据由后续阶段扩展。

## 区间

区间为 `(boundary, target]`。从 target 沿第一父链选择最近稳定发布提交，排除草稿、预发布及本次目标标签；发布时间不参与选择。轻量和附注标签均解析到提交。已发布标签缺失、错误对象、标签循环、断链或超过 10000 条提交均失败。

同一最近提交有多个稳定标签时，中央 `config/profiles/release-legacy/layerscape.json` 可通过可选 `sourcePolicy.previousStableTag` 显式选定；未选择或选定的标签不在最近节点时失败。首发必须由中央配置 `sourcePolicy.adoption`，字段为 `mode: start-at-adoption`、`boundarySha` 和引用已审阅迁移记录的 `reference`。边界必须位于 target 第一父链，边界本身不进入区间；根提交事实由迁移记录承接。两种配置互斥，未配置时不推断采用边界。

中央配置加载后由适配器绑定当前 repositoryId 和 policySha；产品仓库、PR 正文和命令行不能提供这些例外。本次未登记历史采用边界或标签选择。

## 逐提交归属

每个区间提交必须恰有一个关联的已合并 PR，并匹配目标仓库数字 ID、默认分支和该提交的 mergeSha。零个、多重、跨仓、未合并或错误 mergeSha 均阻断；不先过滤掉异常关联。PR 详情与关联列表交叉校验，文件与提交枚举必须匹配详情计数，重复项和非法事实失败。所有列表沿 GitHub next 链分页，继承页数、项目数和循环上限。

中央受管候选登记采用 `ManagedReviewRecord`，绑定 candidateId、仓库、策略、目标标签、PR、headSha、mergeSha 和作者 ID，且 PR 文件必须恰为对应目录的 `candidate.json` 与 `release-notes.zh-CN.md`，仅允许新增或修改。通过后记录为 `review-record`，不进入产品事实。候选路径缺少中央登记、重命名、删除或混入其他文件均失败。

候选登记接口供后续中央持久层接入；当前 CLI 不接受候选自声明记录，也不从静态 Profile 读取候选白名单。因此在中央登记接线完成前，遇到候选文件会安全阻断。

## 输出与变化复核

远端适配器读取完整 PR 标题、正文、身份、文件、提交及标签，按固定字段顺序投影来源快照；文件与标签集合排序。生成使用这份已读取事实。写出正文前再次读取区间与事实，字节不一致返回 `RN_SOURCE_STALE`，不写出新的正文。

成功时，正文旁保存 `<output>.sources.json`，包含来源合同与被消费事实，UTF-8、LF 结尾；日志显示其 SHA-256。发布工作流将正文和来源快照一起上传至 notes artifact，并下载到 publish job 的 release-notes 目录，沿用现有 1 天保留期。它保留本轮原始来源文本，供审计和重放，不代替后续包含片段、Profile、资产等内容的完整规范化冻结对象或发布收据。

错误代码：`RN_SOURCE_INCOMPLETE` 表示缺失或不匹配；`RN_SOURCE_AMBIGUOUS` 表示来源不唯一或待显式选定；`RN_SOURCE_STALE` 表示读取期间变化。任何错误均不以跳过条目、空说明或首发回退消除。

## 验证

`packages/runner/test/release-notes-input.test.ts` 覆盖附注标签、首发采用边界、同提交多标签、第一父距离、101 个 PR、多页额外关联、缺页、跨仓、错误 mergeSha、来源变化和候选身份/文件范围。Core 选择器和 runner 共用最近第一父节点的标签选择规则。
