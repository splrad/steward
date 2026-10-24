# 工作流验证

组织 required workflow 固定中央完整提交。验证入口检出合并候选与该中央提交，读取中央验证配置；候选工作流只作为扫描输入。仓库路径和任务必须与中央配置一致，候选目录不能提供自己的许可或扫描工具。

在可信策略目录运行 `MISE_SAFE=1 MISE_NODE_COMPILE=false mise install --locked`，再用 `mise exec -- npm run verify` 验证。工具版本、双平台下载地址和完整性由 `mise.lock` 与 npm sidecar 保存。扫描入口只解析已经安装的可信工具，不在候选目录加载 mise 配置，不下载工具或读取令牌。actionlint 与 zizmor 使用独立临时目录和固定参数，候选的配置及忽略指令不能关闭检查。actionlint 的可选 shellcheck/pyflakes 未采用。

GitHub 原生 `concurrency.queue` 使用精确兼容校验：YAML AST 先验证 workflow/job 层的值为字面量 `single` 或 `max`；`max` 只接受缺省或字面量 false 的 `cancel-in-progress`。随后读取 actionlint JSON，只接受完整文本、syntax-check 类型、文件及行列都对应已验证 queue 键的已知解析错误。其他错误、重复诊断、异常进程状态或不可解析输出均阻断；不使用通用 `-ignore`。zizmor 继续扫描原始文件。上游支持后零诊断正常通过，升级时复验并移除不再需要的兼容分支。

组织特有校验只负责固定来源、最小权限、secret隔离、共享正文队列与产物交接。通用语法和安全扫描由上述组件执行。reusable workflow 必须来自已登记的中央完整 SHA，输入逐项登记，禁止继承 secrets。B4尚未采用具体实现，因此当前登记集合为空。

验证任务逐项记录成功、失败与不适用；取消或意外跳过不能变成成功。只有确实没有本地工作流时，扫描任务可标为不适用。GitHub required workflow 的实际强制、fork和base更新行为须在远端验收中取证，本地测试不替代该结论。

runtime 不再生成 Validation Gate。发布候选从GitHub有效分支规则读取固定验证来源，再核实真实 required workflow、run/attempt、PR/head/base和成功步骤。Classification Gate在标签迁移阶段前继续保留；发布内容批准独立核对。

部署保留D1、正文及发布恢复。历史 Durable Object 迁移和类身份保留存量数据，类入口返回410；没有绑定、调度或Gate写入。数据退役须单独确定对象与恢复方案。

2026-10-23本地扫描发现构建回调及两处同步工作流的 `workflow_run` 高危告警，仍阻断完整验证。后续须按唯一实施基线协调可复用工作流替换，不降级或忽略此结果。
