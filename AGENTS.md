# SPLRAD 仓库说明

## Code Review Rules

### common.direct-evidence
- 只报告当前差异中有直接证据、会造成实际后果或违反明确仓库合同的问题。不得把人工智能审查、局部环境或未运行的测试表述为持续集成通过、批准或可以合并。
  Safe path: 说明受影响的行为和最小安全修正路径；证据不足时不发表评论。

### common.review-language-zh
- 审查标题、摘要和行内意见以简体中文为主；技术术语、代码标识和平台固定字段保留原文，其他内容可按表达需要使用英文。
  Safe path: 代码标识、文件路径、命令、日志原文、严重级别标签和平台固定字段保持原文；每条发现说明位置、实际影响和最小安全修正方向。

### steward.core-boundary
- Core、manifest 和 provider 边界不得把 GitHub、网络、环境变量、当前时间或供应商行为引入确定性核心。
  Safe path: 在 adapter、catalog 或 runner 边界完成供应商集成，把纯数据合同留在核心。

### steward.permission-boundary
- 权限、令牌和仓库写入变化不得扩大到任务所需范围，也不得把评论、人工智能结论或检查结果变成自动批准、合并或发布授权。
  Safe path: 使用单仓、短时和最小权限，失败时关闭执行，并保留现有人工门禁。
