# 产品 Pages

`templates/release/pages.yml` 在产品接入时生成到 `.github/workflows/pages.yml`，随后由产品维护，Action 引用由该仓 Dependabot 更新。周期 Copier 不覆盖这个文件。LayerScape 使用已有 `docs-site` 构建目录，正文来自产品 Markdown。

仓库变量 `STEWARD_DOCS_SOURCE` 采用 `default-branch` 或 `release`；为空时停止选源和维护。LayerScape 本期采用 `default-branch`。Release 模式另读 `STEWARD_DOCS_UNIT`，核对该单位的正式 Release、tag、源码、manifest、最终资产字节及原生证明。控制器完整 SHA 从该源码中的 Pages YAML 读取；中央协调器升级不会改变已发布源码使用的控制器。实施交付时必须将种子和产品 YAML 的施工 pin 一同绑定到已验证的中央提交。

`select` 只读核源；`build` checkout 准确源码，按产品锁安装并构建站点，没有部署权限。`deploy` 通过原生 needs 接收选源结果与 artifact ID，只执行固定中央控制器，使用 `github-pages` Environment、Pages/OIDC 写权限及必要读取权限。部署前后记录来源、输入摘要、artifact ID/digest、Run/attempt、原生 Environment deployment ID 和 job ID。`deploy-pages` 的 `page_url` 输出不包含 deployment ID，部署身份通过原生 deployment/status 的 job URL 回读。

两个来源共用一个站点并发组，`cancel-in-progress: false`，原生 `queue: max` 保留等待任务。部署前再次读取应采用来源；来源已改变则退出。同 Run、当前 attempt、准确输入摘要、未过期 artifact 和成功 build job 必须同时匹配。重复任务核对最近一次实际成功执行的 `Deploy Pages` 步骤；仅因 Environment 创建而成功、但跳过部署的任务不会被当成网站已替换。部署和 GitHub 原生读取之间仍存在平台可见性窗口，E08-B 使用真实 Run、Environment 和部署记录验证连接。

发行协调器对每个安装仓单独执行 Pages 维护；发行未初始化、渠道等待及发行周期预算不阻塞该维护。它只读取仓库原生变量和固定 `pages.yml`，扫描最近 30 天 Run，并另外完整读取各类在途 Run。筛选查询达到 1000 条时拆窗；单秒饱和、分页不全、权限不足或来源冲突时停止写入。每仓单次扫描最多三分钟、800 次受控 API 请求，健康结果只含固定错误码。

维护记录通过既有 Git 快进连接保存于产品 `steward/governance-state`：

- `maintenance/pages/dispatch-<digest>.json` 保存补接意图和原 Run 绑定，路径摘要包含来源输入摘要及最近实际站点 deployment ID。同一站点状态下重复唤醒沿用记录；已有新站之后回到旧源码时，使用新的实际 deployment 上下文补接。响应未知先查同源 Run；同次协调器不重发，后续唤醒只使用剩余预留次数，最多三次补接请求。已收到原生 204 时等待该请求之后的 Run 可见。
- `maintenance/pages/<runId>.json` 保存准确失败 Run 和恢复请求。首次运行后最多预留两次恢复；使用完整原 Run 重跑，使过期或缺失的 artifact 从同源 build 重新生成。响应丢失先读取 attempt；新 Run 及重复事件不能重置原预算，删除当前缓存也不能清除 Git 历史额度。

请求先写入、回读，再核对当前来源、工作流启用状态和原 Run 后发送。人工停用保持停用。恢复仅使用本产品的短时 App token；它具有状态写入、Actions 写入及 variables/deployments/attestations 读取权限，没有 Pages 部署权限。产品构建和部署 job 不接收 App 私钥。权限范围和实际 API 可读性须在 E08-B 隔离目标验证，生产采用留到 E10。

E10 启用前核对 GitHub Pages 的 workflow 构建方式和 `github-pages` Environment：默认分支模式仅允许真实默认分支，Release 模式允许该产品实际 tag 规则，并继续执行完整正式来源核验。Pages 启用、域名验证、DNS、证书、HTTPS 和公开网站验收各自留证。LayerScape 域名为 `layerscape.splrad.com`，依新版基线在获准阶段配置。

原生接口：[Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[deployment/status](https://docs.github.com/en/rest/deployments/deployments)、[原 Run 重跑](https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-workflow)、[Actions 变量读取](https://docs.github.com/en/rest/actions/variables#get-a-repository-variable)。
