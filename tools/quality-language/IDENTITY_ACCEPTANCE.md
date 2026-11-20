# 一次性模型身份验收

入口为 `.github/workflows/ai-identity-acceptance.yml`，仅支持人工 `workflow_dispatch`。合入受审 main 后，还须明确批准该次执行、准确 main SHA 及现有组织硬预算内最多两次生成请求的费用；合入本身不构成调用批准。

获批后由操作者将完整获批 SHA 填入下列命令。此命令会实际调用模型，准备和审阅阶段不得执行：

```powershell
gh workflow run ai-identity-acceptance.yml --repo splrad/steward --ref main -f approved_sha=APPROVED_MAIN_SHA -f authorize_two_requests=true
```

执行前核对 GitHub 账户、获批 SHA 仍为当前 main、当前组织计费策略和剩余预算。GitHub 负责执行现有组织硬预算；入口不计算单次金额上限，不增加订阅或预算。每次新 dispatch 都是新的费用操作，须有对应授权。不得重发命令来恢复不明状态；先核对 Run。GitHub rerun 的 attempt 大于 1 时不允许进入模型步骤。

两个串行 job：

| job | Environment | 固定行为 |
| --- | --- | --- |
| quality | steward-release-notes | 一条公开合成发现，经既有 qualityLanguage 适配器生成一次 |
| release | steward-release | quality 成功后，一份公开合成发布资料经既有 contentWireInput 和 releaseNotes 适配器生成一次 |

默认费用授权为 false。非主仓、非 main、审批 SHA 与 workflow SHA 不符、非首次 attempt、缺 token 或 preflight 拒绝均失败关闭。SDK 只接收当前 job 的短时 github.token，不读取 Environment 静态秘密，不回退个人登录。只授予 contents:read 和 copilot-requests:write；不启动生产协调器，不写评论、Check、PR、候选、tag 或 Release。

每个 job 先读认证和可用模型，再最多发送一次生成请求。拒绝、超时、未知结果均终止，不重试；quality 失败时 release 不执行。工作流最多十分钟，适配器请求使用原有超时。取消或失去 runner 时不可推断请求未发生，不应自动再跑。

Run artifact `identity-quality-RUN_ID-1`、`identity-release-RUN_ID-1` 各含 `identity-acceptance.json`。成功记录实际响应模型、模型列表、原生用量单位、controller SHA 和 Run/attempt；不发布生成正文或 SDK 原始错误。失败记录 FAILED_OR_UNKNOWN，不能解释为零调用/零费用。保留十四天，正式采用证据由协调者归档。

通过只证明这两个 Environment 下短时身份与 SDK 消费的小样本结果。真实来源、输出保真、完整消费者写入、拒绝/超时恢复、模型额度和长期运行均须单独验收。
