# SPLRAD 仓库说明

## Code Review Rules

### common.current-head-evidence
- 报告文件缺失、配置不存在或生成产物未更新前，核对当前 PR head 的实际文件内容。差异未显示、平台排除、上下文截断或旧 head 的内容，都不能证明当前 head 缺失或过期。
  Safe path: 指出当前 head 的具体不一致，或对应一致性检查的失败证据，并核对检查的提交和覆盖范围。无法读取文件或取得证据时，不发布这类缺陷评论；其他有直接证据的问题照常报告。

### common.direct-evidence
- 只报告当前差异中有直接证据、会造成实际后果或违反明确仓库合同的问题。不得把人工智能审查、局部环境或未运行的测试表述为持续集成通过、批准或可以合并。
  Safe path: 说明受影响的行为和最小安全修正路径；证据不足时不发表评论。

### common.review-language-zh
- 审查标题、摘要和行内意见以简体中文为主；技术术语、代码标识和平台固定字段保留原文，其他内容可按表达需要使用英文。
  Safe path: 代码标识、文件路径、命令、日志原文、严重级别标签和平台固定字段保持原文；每条发现说明位置、实际影响和最小安全修正方向。

### steward.core-boundary
- Core、manifest 和 provider 边界不得把 GitHub、网络、环境变量、当前时间或供应商行为引入确定性核心。
  Safe path: 在 adapter、catalog 或 runner 边界完成供应商集成，把纯数据合同留在核心。

### steward.dist-verification
- runner 产物一致性由 npm run verify:dist 重建并逐字节比较 packages/runner/dist/index.js。报告产物过期时，提供目标提交上该检查的失败证据，或源码与产物的具体不一致；仅凭源码变化不能得出产物未更新。
  Safe path: 读取目标提交的完整产物，并使用仓库固定工具链核验；区分 PR head、合并候选和旧提交的结果。该检查通过只证明 runner 产物与源码一致，行为、配置、测试和权限问题仍按各自证据审查。

### steward.permission-boundary
- 权限、令牌和仓库写入变化不得扩大到任务所需范围，也不得把评论、人工智能结论或检查结果变成自动批准、合并或发布授权。
  Safe path: 使用单仓、短时和最小权限，失败时关闭执行，并保留现有人工门禁。
