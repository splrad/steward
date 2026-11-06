# 私有管理员仓依赖检查

当前实现仅绑定中央配置中的管理员仓 ID、名称及 private 状态。其他仓仍走原生 Dependency Review。管理员仓每次 PR/main push 执行检查，避免仅改 `.mise/locks/` 或新增未知输入绕过路径筛选；报告记录准确 base/head 和中央来源。

检查只读取候选 Git blob。已有离线工作流检查和原生 `gh actions-lock --verify` 保留；独立在线 zizmor 必须有只读 token。锁定 Action 的仓 ID、tag/commit 对应和完整 SHA 均核验；仅在已验 ref 是该 commit 唯一最长 tag 时使用当前 zizmor 的原生公告匹配，歧义或无映射阻断。锁内所有 Action 另组成只供分析的输入，报告按仓库/SHA/GHSA 比较新增风险。可重用工作流或未识别路径需补充覆盖后采用。

OSV Scanner/Reporter 来自官方按 digest 固定的容器，分别完成实际 npm 清单与原生差异计算。扫描阶段没有治理 App 秘密、不会执行候选安装或回调脚本，不使用 SARIF 上传。准确 upstream checkout SHA 的 package-lock 原字节与摘要、调用 workflow 摘要进入证据。安装入口的行为仍由既有受保护 PR 审查承担；不建立 shell 命令解释器，也不声称依赖扫描能证明任意 shell 安全。

Node 使用官方发行清单/校验和及 security-wg 公告；mise 使用供应商仓公开公告，汇总所有已接受工作流的明确运行时版本；管理员安装入口必须保留有效的 mise-action。版本范围交给 npm semver，不维护漏洞库。仅支持现有 Node/npm 工具声明；未知工具或配置输入失败。npm 官方归档先对账 registry 与 aube integrity，然后由现有 Syft 静态提取包清单；遍历归档内全部 package.json：有包身份的 manifest、Syft 和 OSV 的唯一 name/version 集合必须相同；仅含 type/sideEffects 的模块作用域元数据须归属已识别包并单独记录，其他无身份 manifest 阻断。该范围不等同于穷尽 Node/mise 编译二进制内部所有组件。

新增 high/critical（包含 runtime/development/unknown）阻断。官方 Reporter 的公告次数预筛会忽略部分包版本变化，因此保留其报告，并对官方扫描事实按来源、包名、版本、公告 ID 和严重级别追加核对；不重写漏洞匹配。Actions/工具比较也保留严重级别变化。首次引入的上游依赖没有 base 时按新增处理；相同公告在新包版本上出现不能被旧公告 ID 消掉。许可证变化和未知仅报告，不创建许可白名单。缺 token、默认离线、未知严重级别、无包、来源不符、解析/网络错误、超时、不完整清单均失败。

证据保存于私仓 `private-dependency-evidence` artifact（7天）：包含前置失败原因的摘要、供应商数据、base/head 扫描及许可证、zizmor 原始结果、原生 Reporter 新增结果和 summary。检查失败不解除规则、不改可见性或订阅。中央代码合并及 required workflow 来源提升必须分别完成；代码就绪不等于线上生效。

验证：`npm run test:private-dependencies`、原 native-validation 回归、真实公开上游/npm归档检查、管理员真实首次引入负例与仅文档变化正例。官方来源：[OSV](https://google.github.io/osv-scanner/github-action/)、[zizmor](https://docs.zizmor.sh/audits/#known-vulnerable-actions)、[Node公告数据](https://github.com/nodejs/security-wg/tree/main/vuln/core)、[mise公告](https://github.com/jdx/mise/security/advisories)。
