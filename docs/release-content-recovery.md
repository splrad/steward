# 发布初稿输出合同与显式恢复

每次 DRAFT 请求携带与本地校验器同源的 `outputSchema`。模型只返回 paragraphs 对象；qualification 的合法值为 SOURCE_CONFIRMED、TEST_CONFIRMED、UNVERIFIED。没有测试证据时不得使用 TEST_CONFIRMED。既有来源校验、中文内容要求、长度及证据确定程度约束保持有效。

模型返回后被校验拒绝的正文，在不超过既有 12 KiB 限制时作为该尝试的 diagnostic 保存到目标仓库受保护状态中，包含正文、UTF-8 字节数、SHA256 和最多 16 条校验位置/schema路径/keyword。诊断是未验证模型输出，不得执行，也不得转为成功内容；不会打印到公共 workflow 日志。超出上限或未取得正文时不伪造诊断。历史没有保存正文的失败仍保持原状。

手动验收入口拒绝 releaseRecovery 计划。历史隔离样本的授权记录含 candidateId、batchId、previousAttemptSha256、authorizationId 和 outputContractSha256，同时固定仓库、main、状态 SHA 和 controller，maxRequests 为 1。以下规则用于复核已保存的恢复收据和归档。

恢复限单 unit、单 batch，入口在任何模型请求前拒绝多 batch，不能忽略授权去生成其他单元。恢复只允许恰有一次 CONTENT_OUTPUT_SCHEMA 拒绝的同一 batch/cache，旧尝试摘要必须完全一致，输出合同摘要必须匹配当前 schema。新尝试以 ordinal=2 追加，并在请求之前持久化 recovery 收据。旧输入、来源、configDigest 和原失败对象均保留，不清零计数。第二次失败、未知结果、过期授权或不匹配记录不能靠同一授权再次发送；成功缓存仍可零调用复用。恢复调用计入原批次总数。

受信 controller 更新后的显式归档恢复须成对提供 archiveContentDigest 和 archiveProtectionDigest，准确定位旧内容及保护证据。组织验证器 pin 保留时，按旧归档摘要与新 controller 生成独立恢复目录。后续同 controller 的普通唤醒按已保存的归档身份读取，controller 再前进时由新目录记录其准确来源，并按原有缓存校验复用结果。原生适配器核对摘要所指的旧归档、新归档不存在、新 batch 为无历史的 PENDING，以及旧新生成事实只允许保护证据路径变化。当前保护证据独立绑定从实际组织规则读取的验证器。保护只允许指定 required workflow SHA 随有效规则变化，其他字段均核对。仓库、候选、base、单元、配置、来源、payload 和旧 manifest/cache/grant 必须一致，来源证据只允许已采用的新 controller 身份变化。旧 attempt 完整复制后继续通过 batch/cache 历史相等校验，新请求收据记录两个旧归档定位摘要，旧 manifest 和保护证据保持原字节。已有新归档或再次使用已消费的恢复授权时停止显式恢复请求。

隔离验收日志保留既有 ACCEPTANCE_ 错误码规则；内容错误仅公开 CONTENT_RECOVERY_BINDING、CONTENT_RECOVERY_ARCHIVE、CONTENT_RECOVERY_ARCHIVE_EXISTS 三个固定码。其他异常统一隐藏为 BUSINESS_ACCEPTANCE_STOPPED，诊断正文仍只留在受保护状态中。
