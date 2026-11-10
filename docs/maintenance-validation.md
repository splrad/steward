# 共享运行时维护检查

`maintenance-validation.yml` 为 `maintenance/legacy-runtime-e990eda` 提供独立受信检查。组织 ruleset 必须将来源固定到中央已合并的准确 P；候选同名检查不能替代它。此入口不授权部署、迁移、秘密读取或合并。

source/final 核对同仓 open PR、准确 base/head/merge、有效 head 签名、受信 workflow 来源及新鲜原生 refs。候选只在另一只读 job 执行；来源改变或必需 job 失败/缺失/跳过均拒绝。PR307 专用 evaluator 与原恢复合同保留其历史字节，不作为日常工作流结构目录。

source 复用 P 已有的文件发现、jactionlint、zizmor 和隔离扫描环境，直接检查候选真实 YAML、本地调用及复合 Action。工具、mise 锁、扫描配置与 Actions 锁验证器版本来自 P；候选 npm/mise 配置和 ignore 不能决定可信扫描。原生 Actions 项目许可约束外部项目，YAML 与官方 Actions 锁记录当次引用，不另建完整 SHA 批准表。

普通工作流增删、改名、拆分、needs/matrix/命令与同项目 Action 更新可在同一维护 PR 完成，连同调用者、测试及必要配置一起审查。没有旧路径清单、语义摘要或前置合同 PR。改变受信来源、必需检查名称、特权身份或引入未批准外部项目时，仍须完成对应原生配置交接；上游扫描器尚不支持的新语法须先沿现有工具更新链采用支持版本。

维护测试读取候选既有 `.node-version`、`engines.node` 和 `packageManager`，要求精确版本及声明一致，验证真实 Node/npm 环境与测试、类型、配置及产物。版本声明可同 PR 更新，不要求先移动另一份批准来源。维护 npm 以现有 package-lock 锁定的 `devDependencies.npm` 安装，须与 `packageManager` 一致；Node 自带 npm 仅执行无生命周期的 bootstrap `npm ci`，随后用锁定 npm CLI 验证版本并运行候选检查。这样 Node 与 npm 可分别受审更新，不依赖 Node 捆绑 npm 恰好相同。持续版本发现由现有 Mend/Renovate 原生 nodenv/npm 管理器负责，更新配置单独采用，不新增发现器。

候选业务测试和产物一致性检查是候选自检，不证明任意测试变更的语义正确性，也不替代 P 的可信工作流扫描；测试和依赖变化由完整 PR 审查与依赖审查承担。中央检查器自身升级由旧 P 验证候选，新检查器测试是附加证据，合入 M 验证后按既有机制提升来源。

首次采用仍按中央代码及完整审查/CI、原生 required-workflow 来源绑定、维护入口适配 PR 的真实检查、必需检查交接顺序执行。保持签名、strict、标题、人工审批和线程解决要求。最终 head 的 Copilot、Codex code/security 及意见裁定分别留证，security null 保留未知。服务切换另须消费者、在途与恢复条件满足。
