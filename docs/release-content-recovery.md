# 发布初稿输出合同与显式恢复

每次 DRAFT 请求携带与本地校验器同源的 `outputSchema`。模型只返回 paragraphs 对象；qualification 的合法值为 SOURCE_CONFIRMED、TEST_CONFIRMED、UNVERIFIED。没有测试证据时不得使用 TEST_CONFIRMED。既有来源校验、中文内容要求、长度及证据确定程度约束保持有效。

模型返回后被校验拒绝的正文，在不超过既有 12 KiB 限制时作为该尝试的 diagnostic 保存到目标仓库受保护状态中，包含正文、UTF-8 字节数、SHA256 和最多 16 条校验位置/schema路径/keyword。诊断是未验证模型输出，不得执行，也不得转为成功内容；不会打印到公共 workflow 日志。超出上限或未取得正文时不伪造诊断。历史没有保存正文的失败仍保持原状。

默认不重试 schema 拒绝或未知结果。隔离验收入口可接受人类明确批准的 releaseRecovery：candidateId、batchId、previousAttemptSha256、authorizationId、outputContractSha256。计划同时固定仓库、main、状态 SHA 和当前 controller，maxRequests 必须为 1；仅既定私有隔离样本可使用。

恢复只允许恰有一次 CONTENT_OUTPUT_SCHEMA 拒绝的同一 batch/cache，旧尝试摘要必须完全一致，输出合同摘要必须匹配当前 schema。新尝试以 ordinal=2 追加，并在请求之前持久化 recovery 收据。旧输入、来源、configDigest 和原失败对象均保留，不清零计数。第二次失败、未知结果、过期授权或不匹配记录不能靠同一授权再次发送；成功缓存仍可零调用复用。恢复调用计入原批次总数。
