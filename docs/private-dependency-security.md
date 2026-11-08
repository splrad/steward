# 私有管理员仓依赖检查

管理员模式绑定中央配置中的管理员仓 ID、名称及 private 状态。已注册的治理仓和下述单个生命周期样本使用各自的有限合同；其余仓仍走原生 Dependency Review。管理员仓每次 PR/main push 执行检查，避免仅改 `.mise/locks/` 或新增未知输入绕过路径筛选；报告记录准确 base/head 和中央来源。

检查只读取候选 Git blob。已有离线工作流检查和原生 `gh actions-lock --verify` 保留；独立在线 zizmor 必须有只读 token。锁定 Action 的仓 ID、tag/commit 对应和完整 SHA 均核验；仅在已验 ref 是该 commit 唯一最长 tag 时使用当前 zizmor 的原生公告匹配，歧义或无映射阻断。锁内所有 Action 另组成只供分析的输入，报告按仓库/SHA/GHSA 比较新增风险。可重用工作流或未识别路径需补充覆盖后采用。

OSV Scanner/Reporter 来自官方按 digest 固定的容器，分别完成实际 npm 清单与原生差异计算。扫描阶段没有治理 App 秘密、不会执行候选安装或回调脚本，不使用 SARIF 上传。准确 upstream checkout SHA 的 package-lock 原字节与摘要、调用 workflow 摘要进入证据。安装入口的行为仍由既有受保护 PR 审查承担；不建立 shell 命令解释器，也不声称依赖扫描能证明任意 shell 安全。

Node 使用官方发行清单/校验和及 security-wg 公告；mise 使用供应商仓公开公告，汇总所有已接受工作流的明确运行时版本；管理员安装入口必须保留有效的 mise-action。版本范围交给 npm semver，不维护漏洞库。仅支持现有 Node/npm 工具声明；未知工具或配置输入失败。npm 官方归档先对账 registry 与 aube integrity，然后由现有 Syft 静态提取包清单；遍历归档内全部 package.json：有包身份的 manifest、Syft 和 OSV 的唯一 name/version 集合必须相同；仅含 type/sideEffects 的模块作用域元数据须归属已识别包并单独记录，其他无身份 manifest 阻断。该范围不等同于穷尽 Node/mise 编译二进制内部所有组件。

新增 high/critical（包含 runtime/development/unknown）阻断。官方 Reporter 的公告次数预筛会忽略部分包版本变化，因此保留其报告，并对官方扫描事实按来源、包名、版本、公告 ID 和严重级别追加核对；不重写漏洞匹配。Actions/工具比较也保留严重级别变化。首次引入的上游依赖没有 base 时按新增处理；相同公告在新包版本上出现不能被旧公告 ID 消掉。许可证变化和未知仅报告，不创建许可白名单。缺 token、默认离线、未知严重级别、无包、来源不符、解析/网络错误、超时、不完整清单均失败。

证据保存于私仓 `private-dependency-evidence` artifact（7天）：包含前置失败原因的摘要、供应商数据、base/head 扫描及许可证、zizmor 原始结果、原生 Reporter 新增结果和 summary。检查失败不解除规则、不改可见性或订阅。中央代码合并及 required workflow 来源提升必须分别完成；代码就绪不等于线上生效。

验证：`npm run test:private-dependencies`、原 native-validation 回归、真实公开上游/npm归档检查、管理员真实首次引入负例与仅文档变化正例。官方来源：[OSV](https://google.github.io/osv-scanner/github-action/)、[zizmor](https://docs.zizmor.sh/audits/#known-vulnerable-actions)、[Node公告数据](https://github.com/nodejs/security-wg/tree/main/vuln/core)、[mise公告](https://github.com/jdx/mise/security/advisories)。

## 固定临时锁例外

仅 splrad/steward-settings 可采用已批准的 safe-settings 3.0.0 源码 `a9a1f366ad6a738b55682d346d94f8d6c4893b09` 临时锁修复。私仓保存单份 `safe-settings/upstream-package-lock.patch` 与 `safe-settings/upstream-lock-exception.json`，中央策略固定 manifest SHA-256。manifest 绑定官方源码、原锁、补丁及结果锁摘要，不复制完整依赖版本清单或上游源码。

检查分别从 base/head Git blob 取得两文件，以原始上游锁重建有效锁，再执行同一 OSV 清单对账和风险比较。Git 原生 patch 解析只接受一个 package-lock.json 文本目标；缺失配对、错误来源/摘要、额外目标、应用失败或结果摘要不符均阻断。两文件均不存在时继续扫描官方原锁；存在补丁而没有运行入口同样阻断。安装 workflow 校验同一 manifest、原锁、补丁和结果锁后才运行 npm ci --ignore-scripts；该步骤不接收治理 App 凭据。安装行为依旧由受保护 PR 审查确认，检查器不解释候选 shell。

SPLRAD 治理维护者负责跟踪上游正式修复并维护此临时例外。每次换源须重新审查，禁止静默重基；官方原锁消除对应风险且通过同等扫描和兼容测试后，在受审变更中移除补丁、安装步骤、中央专用配置及合同例外。低/中风险仍如实报告，不把 high/critical 清零称作零漏洞。

Linux扫描容器保留cap-drop=ALL、no-new-privileges及只读输入/rootfs；专用输出目录设为0770，仅追加runner主组使固定镜像可写该目录。Windows沿用其原生挂载权限。工具失败在私有摘要记录退出码、signal、错误码及截断且去除已知凭据值的stderr，Docker另标记scanner/reporter入口；工具错误始终失败，不作为干净扫描。

扫描器创建的结果文件可能归容器 root 所有。宿主对 upstream 结果合并及 npm 结果规范化时，先在同一输出目录写入自身所有的临时文件，再通过 rename 替换结果；不原地截断 root 文件，不放宽已有结果文件权限。

## 私有生命周期样本

`config/private-dependency-security.json` 的 `lifecycleSamples` 仅登记一个隔离样本。必须同时匹配准确仓 ID、名称、组织、private 状态及现有 `STEWARD_PRIVATE_GOVERNANCE_REPOSITORY_ID`；身份或注册不符立即失败。现有 governance-only 文件白名单不变，管理员模式不变。

样本允许单 app JavaScript 源码/行为测试、VERSION、Release Please simple 配置与 manifest、delivery、两个正式发布模板及必要 Node 验证接口。完整 base/head 文件清单分别核对；未知源码、工作流、工具配置或依赖清单拒绝。`templates/lifecycle-sample/` 的 package/lock、验证脚本和忽略规则统一 LF 换行后必须逐字节匹配，明确证明应用没有第三方 npm 包；不能将空 OSV 结果作为未扫描依赖的替代。新增任何 npm 依赖必须另行修改受审合同。首次治理 base 可没有应用；出现任一应用输入即要求完整配套文件。生成的 CHANGELOG 和 app 发布说明允许保留。首次无应用且无 workflow 的 base 可省略 Action 锁；含应用、含 workflow 的 base 以及所有 head 仍须提供锁。

Copier 文件继续匹配可信版本原文。发布 workflow 的结构必须与当前正式模板一致，中央 checkout 引用限当前可信控制器或其已验证祖先；第三方 Action 不接受替换。唯一允许的中央 product-release reusable workflow 从已验证祖先 Git 对象展开，其 Action 和 mise 声明纳入相同扫描；其他 reusable 或再次嵌套拒绝。Action 锁身份、tag/SHA、完整清单及在线 zizmor 检查保留；所有声明的 mise 版本另用供应商公告检查，缺失或不完整信息失败。源文件在原 Linux/Windows 低权限 job 中验证，不抑制 source job。样本复用中央已固定的 TypeScript 工具链编译 JS、执行编译产物行为测试、类型检查、配置一致性及重复构建产物比较；扫描 job 仍只读候选 blob、不执行样本代码。必需检查、权限和 Environment 不变。

该模式只解决隔离样本的 PR 准入。正式发布模板保持原内容，本轮仅用于发行说明候选验收；模板中现有产品构建矩阵不代表这个样本已具备正式发布能力。样本发布/分发 workflow 在采用后保持停用，真实初始化与模型调用依原批次授权另行执行。回退策略为暂停样本后续写入、保留状态和证据；已有应用时不能直接回退旧 governance-only 检查并声称继续兼容。
