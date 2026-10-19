# 工作流校验合同

## 普通工作流变更

可信中央 runner 校验工作流安全边界。Steward 的 config/repositories.json 中 allowedWorkflowPaths 描述候选仓库的实际清单：同一个 PR 可以同步增加、删除或改名普通工作流及清单，不需要先向默认分支登记文件名。清单与实际文件必须完全一致。

候选清单不能定义安全规则。必需 pr-validation.yml 由可信策略要求存在；其 validate 与 fragments 作业（依赖、执行条件、权限、可信检出及验证命令）、策略来源 SHA、固定中央检出、验证命令及 PR 事件覆盖由可信 runner 的入口合同保护。工作流名称固定为 `SPLRAD Steward / PR Validation`，与运行时 `trustedValidationRun` 匹配；步骤显示名称可变，跳过条件、吞错、额外执行步骤和候选策略替换会被拒绝。顶层 concurrency 固定按仓库与 PR 分组，cancel-in-progress 固定为 true。修改这个必需安全入口仍属于中央策略变更。

普通工作流统一检查：拒绝 job/service container；workflow/job defaults 及步骤级 shell 仅允许静态 bash、sh、pwsh、powershell、cmd、python；显式只读/none GITHUB_TOKEN 权限、允许的事件类型、受信且锁定提交的 Action、禁用 checkout 凭据持久化、普通文件/YAML 唯一键、禁止可复用作业和本地 Action 绕过、禁止 PR 作业获取受保护环境或密钥。密钥引用必须是显式名称，并匹配中央规定的环境。发布说明模型与 App 密钥使用不同环境。runner 只允许静态标签 ubuntu-latest、ubuntu-24.04、windows-latest、windows-2025、macos-latest；自托管标签、数组和动态表达式均拒绝。来源作业的环境名称不能证明输出安全，动态构建工作流须改用静态 hosted 标签后才能通过本层校验。

现有 actionlint、业务工作流合同、类型、测试、配置和 dist 检查全部保留。scripts/verify-workflows.mjs 复用同一通用模块，移除重复的文件名数组；其中业务作业的专门合同仍须随业务变更同步更新。新增 Action 供应商、权限、密钥或环境属于安全能力变化，需要中央策略审查，不由候选清单放行。

静态校验不证明任意 shell 命令安全，也不等于线上环境已具备审批。代码审查、平台环境保护和人工发布授权继续承担各自责任。

## 部署隔离的合并前置条件

检查时 steward-deployment 仅允许 main 分支，没有 required reviewers。main 上 runner/config 变更会触发部署，前置 PR 合入也不例外。

合并前由另行获授权的管理员保留 main 限制，并增加独立 required reviewers、禁止自审批及管理员绕过。核对全部远程迁移和部署步骤都受该环境保护。若账户能力或维护者配置不能满足要求，保持不合并，另行制定代码级部署隔离方案。批准代码合并不等于批准等待中的部署。

本 PR 不修改线上规则、部署工作流、运行时或数据库。可信验证策略经默认分支工作流使用，无需先部署 Worker。

## 验收依据

正向覆盖普通工作流新增、改名、删除、清单同步及必需入口步骤显示名称变化。反向覆盖清单自授权、必需入口移除/替换/跳过/吞错、额外执行步骤、事件过滤、隐式/写权限、不固定 Action、本地 Action、凭据持久化、密钥混用、表达式密钥索引、PR环境、非许可 runner、重复 YAML 键及别名。

端到端用例确认可信检查通过后仍执行下游任务，失败不会转换成成功。当前 #253 的 release-build.yml 和 product-build.yml 使用动态 runner，须适配为 Windows/Linux 静态 hosted 作业并同步业务合同后，再对完整候选执行本层校验与完整 CI。

## 凭据环境前提

受保护凭据仅存放在环境中，不能在仓库或组织层提供同名副本。持有凭据的环境须通过平台分支策略限制到默认分支；候选 YAML 的环境名称本身不能证明此限制已配置。`deployment: false` 保留环境分支策略，只取消 deployment 记录。每次启用或变更环境前须回读实际分支规则和 secret 名称元数据。

2026-10-20 回读 Steward：steward-automation、steward-release、steward-deployment 均仅允许 main 分支，仓库及组织层可用 secrets 列表为空；steward-release-notes 尚未创建，启用前同样须具备上述保护。此事实不代表其他仓库或未来配置自动满足要求。静态校验与线上环境保护共同构成边界，不能用候选作业 if 表达式替代平台限制。

依据：[GitHub 环境与 deployment 行为](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments#using-environments-without-deployments)。

普通工作流可以省略 concurrency；若在顶层或作业级配置 concurrency，必须显式设置 cancel-in-progress:false；只有完整固定的必需验证入口保留按 PR 取消行为。带受保护环境或密钥的 workflow_run 作业使用 checkout 时，必须检出当前仓库的 github.workflow_sha，不能检出触发方 head_sha 或其他仓库。该约束保护检出来源；任意脚本下载并执行代码仍须代码审查。
现有 sync-review-instructions.yml 与 sync-managed-labels.yml 的已部署策略解析流程按中央固定的完整文档摘要保留；修改解析命令、上游条件或检出引用都会使该例外失效。候选文件不能自行声明例外。

带受保护环境或密钥的 workflow_run 作业禁止使用 download-artifact，防止触发方产物进入凭据执行上下文。
