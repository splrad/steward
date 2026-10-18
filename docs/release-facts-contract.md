# 发布事实与迁移合同（R03 历史记录）

> 本文保留旧片段流程的设计记录。当前版本已退役 `collectReleaseFactSnapshot`、迁移 Schema 和片段门禁，以下接口、Schema 及测试名称不代表当前可用能力。当前发布使用固定 Git 来源与持久化候选收据，构建入口见[产品构建作业](product-build.md)。

R03 在 R02 的固定来源合同上收集事实。Core 处理纯数据；runner 的 collectReleaseFactSnapshot 读取 Git 对象及中央上下文，并完成双轮一致性检查。该函数作为 runner 导出接口交付，供后续冻结与发布编排接入；现有 legacy release-notes 命令尚未切换到事实生产者，不能把本合同交付视为 Release 激活。

## 普通片段与原文

从每个产品 PR 的已校验文件列表确定唯一新增片段，再读取该 PR 合并提交和固定 target 的 Git blob。路径、树完整性、文件模式、base64、长度及 Git SHA-1 均校验；片段缺失、修改、重命名和删除阻断。

公开组装接口校验规范 base64，重算 SHA-256 和普通片段 Git blob SHA-1，并从原始字节重新解析、逐字段比对语义值；任何不一致均阻断。原始字节以 rawBase64 留存，不用规范化 JSON 替代；同时保留 path、blobSha、sha256、PR 和 mergeSha。解析器产生供渲染使用的语义值，原字节中的换行和编码表示仍可还原。普通事实 ID 是 fragmentId#entryIndex，索引从 0 开始，按源 entries 顺序。not-user-facing 保留 consumedFragments 和空 factIds，其 reason 只进入排除与审计。

## 历史唯一性和消费

ReleaseFactContextReader 必须来自可信中央历史/收据服务，绑定 repositoryId、targetSha、policySha，complete 必须为 true。fragment 历史记录绑定永久 ID、首次 PR、mergeSha、blobSha、sha256 和 consumed；当前来源也必须在索引中登记，不能把“未查到”解释为新 ID。重复记录、不同来源重用、摘要不同或已消费都阻断。迁移登记同样绑定 migrationId、原始字节摘要和消费状态。当前合同保守要求全部未消费登记中至多存在一个，且必须提供对应原文；缺原文或多个待消费登记均阻断，不从缺失值推断“不适用”。已消费历史登记可保留。

R03 定义并消费此接口，不实现 D1 持久服务，不把测试内存数据视为生产永久索引。接口缺失时失败关闭。R08 持久层须提供覆盖完整历史的索引与消费查询；R14 的 PR 门禁仍需独立接入历史查重。发布前再次检查消费及事务性登记属于 R08/R10，当前两轮只读检查不代替原子消费事务。

## 迁移

schema/release-notes-migration.schema.json 约束 schemaVersion、migrationId、repositoryId、previousRelease、boundarySha、expiresAfterTag 和 entries。沿用严格 UTF-8、无 BOM、重复键拒绝及 512 KiB 上限；最大 10000 条记录，实际 R02 运行预算保持独立。每项绑定 pullNumber、mergeSha 及符合普通片段语义的 fragment。

迁移清单只能经中央 reader 读取，产品文件和 PR 正文不能提供授权。它必须绑定 R02 的上一稳定发布 tag/SHA；boundarySha 位于已核验区间，迁移项恰好覆盖区间中不晚于该边界的所有产品 PR。边界后的产品变更继续采用普通片段或明确 ignored 规则。普通片段与迁移覆盖重叠、遗漏、越界及错误 mergeSha 均失败。迁移条目的 PR 编号或 mergeSha 命中任一历史片段登记时也拒绝，无论登记是否已消费，防止同一来源改用迁移身份再次产出。

迁移事实 ID 为 migration:{migrationId}:{prNumber}#{entryIndex}。迁移原始字节单独保存，无伪造 blob，也不进入文件删除集合。targetTag 必须晚于上一稳定版本且不晚于 expiresAfterTag；已消费清单不可复用。比较使用无前导零的稳定 vMAJOR.MINOR.PATCH 和整数语义，避免字符串字典序错误。

首次 adoption 使用 previousRelease=null，并强制提供独立 root 对象：sha、fragment、classification。runner 每轮读取该 Git 提交，核对 SHA 且 parents 恰为空；Core 要求该 SHA 等于 R02 采用边界，证明是区间之前的首次根内容。为避免遗漏边界前的其他旧提交，本入口只接受根提交本身作为首发采用边界。root 身份不适用于稳定版本迁移。

根事实 ID 为 migration:{migrationId}:root#{entryIndex}，输出显式 rootSha，pullNumber/mergeSha 为 null；不伪造 PR 或 blob，不进入 consumedFragments。rootRecord 保留根身份、状态、factIds 和 not-user-facing 排除理由，security/breaking-change 继续校验。中央迁移登记必须同时绑定 rootSha；同一根被分配给多个 migrationId、未登记或已消费均拒绝。迁移原文摘要仍覆盖根内容及分类。

当迁移 boundarySha 等于该根时，entries 必须为空，区间内 PR 按普通片段处理；边界位于后续区间时，entries 恰好覆盖根之后至该边界的产品 PR。无 PR 的普通区间提交继续由 R02 拒绝；root 不豁免这些提交。

## 覆盖与风险

每个产品来源进入普通片段、迁移或明确排除之一；任何已读取的片段都完整校验。security/breaking-change 继续遵守片段风险合同，安全事实携带 security=true，破坏性修改必须包含操作。R02 已中央认证的 review-record 只作为审阅记录排除，不产生事实；候选路径本身不获得豁免。

## 复核和验证

runner 两次读取来源、原始片段和中央上下文，将事实与历史状态一起比较；变化返回 RN_SOURCE_STALE，缺失和不匹配返回 RN_SOURCE_INCOMPLETE，既有片段校验错误码保留。不输出半份结果。调用方必须传入共用 R02 HTTP 预算的 GitHubClient。R03 入口最多处理 50 条提交（R02 独立入口仍为 120），在 PR 事实读取前检查数量。50 个单页 PR 各有一个三级路径片段时，双轮真实客户端模拟共 1604 次 HTTP 请求；51 条提前拒绝。分页、额外发布标签和网络耗时继续受 1800 请求/8 分钟共享预算约束，超限失败关闭，该模拟不保证全部线上输入均能完成。

Core 与 runner 的 release-facts.test.ts 覆盖原字节留存、ID、历史重用/消费、迁移边界/到期/重放、互斥覆盖、风险、Git blob 篡改/缺失/模式/截断及双轮漂移；现有片段测试继续覆盖文本与编码合同。

## 迁移历史来源与 Schema 文本预校验

每项历史迁移登记必须提供 sources 数组，逐项绑定 pullNumber 与 mergeSha；缺失字段失败关闭，根迁移无 PR 时显式提供空数组。所有迁移登记（已消费或未消费）的 PR 与 mergeSha 分别全局唯一，当前迁移 entries 必须与自身登记完全匹配。所有当前产品来源（包括无片段且按 profile 判为 ignored 的来源）均检查历史迁移登记；只有由同一个待消费迁移完整匹配并覆盖、且不带普通片段的来源可以继续，其他历史来源重用均拒绝。R08 中央持久层必须持久保存这些来源，旧登记补全前不可当作空历史继续；本轮不执行生产数据迁移。

R03 快照显式纳入每个产品 PR 的完整 classification，主类变化即使不改变事实输出也触发 RN_SOURCE_STALE。

迁移 Schema 的 release-fragment-text 与 release-fragment-action 是必须启用的 assertion formats，使用 Core 导出的 releaseFragmentTextFormats 注册，例如 new Ajv2020({ strict: true, formats: releaseFragmentTextFormats })。它们直接调用 parseFragment 使用的文本校验，统一 NFC、trim、长度、Markdown、链接、模板及控制字符规则。未知 format 必须报错，禁止以忽略/禁用 formats 的结构验证结果宣称清单有效。完整原始字节仍必须经过 parseReleaseMigration，JSON Schema 不代替重复键、编码和来源历史验证。
