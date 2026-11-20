# 产品 Pages

首次接入由产品在配置 PR 中选择仓内已有站点构建、产物目录及内容来源。已有 `.github/workflows/pages.yml` 由产品维护，Copier 周期更新排除此文件。新接入可采用 `templates/release/pages.yml` 的三个原生 job。种子默认仅构建默认分支，仅在仓库变量 `STEWARD_DOCS_SOURCE` 明确选定部署来源时才进入部署 job。仅在产品选用构建并提供可复核入口后才交付该工作流。

种子的 build job 检出准确的产品提交。可在该提交提供受审脚本 `.github/scripts/build-site.sh`，由它调用仓内构建，并向 `$GITHUB_OUTPUT` 写入 `directory=<目录>` 以返回站点的相对目录（目录内须有文件，并采用实际文件而非符号链接）。也可在产品工作流直接采用已有构建步骤并将输出接到上传步骤。运行环境和依赖锁由产品选择。配置 PR 以这些原生步骤和输出为据。LayerScape 现用 Astro、产品 Markdown 和 `docs-site/dist`。

仅构建时，`STEWARD_DOCS_SOURCE` 留空以停用中央部署维护。选源作业读取工作流顶层的 `STEWARD_DOCS_SOURCE` 和 `STEWARD_DOCS_UNIT`。配置 PR 把选定值写入这两个字段，并同步运行名称中的来源。默认分支 push 按当前分支 SHA 构建；选择发行单元时，由已发布事件或匹配的补接事件触发，核对正式 Release、冻结源码和产物证明后构建。例如按正式发行单元仅构建时，配置 PR 在产品 YAML 内将 `env.STEWARD_DOCS_SOURCE` 写为 `release`、`env.STEWARD_DOCS_UNIT` 写为该单元 ID，运维部署变量留空。补接事件中的 `source_mode` 必须与这一受审来源一致。两种仅构建模式均可在开通 Pages 前运行。获准公开部署后，在原生工作流中选用公开部署，并把运维仓库变量设为批准公开的来源。部署作业要求该变量与选源结果的 `mode` 一致；正式发行还要求 `STEWARD_DOCS_UNIT` 仓库变量与核验的发行单元相同。任一不匹配仍可构建，部署作业跳过。历史工作流仍可读取仓库变量作为来源；配置 PR 写入的来源及发行单元用于此后的选源。release 模式另读 `STEWARD_DOCS_UNIT`，核对该单位的正式 Release、tag、源码、manifest、最终资产字节及原生证明。接入时采用已验证的中央提交。LayerScape 的 Renovate 分组更新工作流顶层控制器 SHA、各中央 checkout 和可复用工作流；Dependabot 负责第三方 Action。冻结读取始终按对应产品提交解析其完整 pin。

`select` 只读核源；`build` checkout 准确源码，按产品锁安装并构建站点，没有部署权限。`deploy` 通过原生 needs 接收选源结果与 artifact ID，只执行固定中央控制器，使用 `github-pages` Environment、Pages/OIDC 写权限及必要读取权限。部署前后记录来源、输入摘要、artifact ID/digest、Run/attempt、原生 Environment deployment ID 和 job ID。`deploy-pages` 的 `page_url` 输出不包含 deployment ID，部署身份通过原生 deployment/status 的 job URL 回读。

两个来源共用一个站点并发组，`cancel-in-progress: false`，原生 `queue: max` 保留等待任务。部署前再次读取应采用来源；来源已改变则退出。同 Run、当前 attempt、准确输入摘要、未过期 artifact 和成功 build job 必须同时匹配。重复任务核对最近一次实际成功执行的 `Deploy Pages` 步骤；仅因 Environment 创建而成功、但跳过部署的任务不会被当成网站已替换。部署和 GitHub 原生读取之间仍存在平台可见性窗口，E08-B 使用真实 Run、Environment 和部署记录验证连接。

发行协调器对每个安装仓单独执行 Pages 维护；发行未初始化、渠道等待及发行周期预算不阻塞该维护。它只读取仓库原生变量和固定 `pages.yml`，扫描最近 30 天 Run，并另外完整读取各类在途 Run。筛选查询达到 1000 条时拆窗；单秒饱和、分页不全、权限不足或来源冲突时停止写入。每仓单次扫描最多三分钟、800 次受控 API 请求，健康结果只含固定错误码。

维护记录通过既有 Git 快进连接保存于产品 `steward/governance-state`：

- `maintenance/pages/dispatch-<digest>.json` 保存补接意图和原 Run 绑定，路径摘要包含来源输入摘要及最近实际站点 deployment ID。同一站点状态下重复唤醒沿用记录；已有新站之后回到旧源码时，使用新的实际 deployment 上下文补接。响应未知先查同源 Run；同次协调器不重发，后续唤醒只使用剩余预留次数，最多三次补接请求。已收到原生 204 时等待该请求之后的 Run 可见。
- `maintenance/pages/<runId>.json` 保存准确失败 Run 和恢复请求。首次运行后最多预留两次恢复；使用完整原 Run 重跑，使过期或缺失的 artifact 从同源 build 重新生成。响应丢失先读取 attempt；新 Run 及重复事件不能重置原预算，删除当前缓存也不能清除 Git 历史额度。

请求先写入、回读，再核对当前来源、工作流启用状态和原 Run 后发送。人工停用保持停用。恢复仅使用本产品的短时 App token；它具有状态写入、Actions 写入及 variables/deployments/attestations 读取权限，没有 Pages 部署权限。产品构建和部署 job 不接收 App 私钥。权限范围和实际 API 可读性须在 E08-B 隔离目标验证，生产采用留到 E10。

E10 启用前核对 GitHub Pages 的 workflow 构建方式和 `github-pages` Environment：默认分支模式仅允许真实默认分支，Release 模式允许该产品实际 tag 规则，并继续执行完整正式来源核验。Pages 启用、域名验证、DNS、证书、HTTPS 和公开网站验收各自留证。LayerScape 域名为 `layerscape.splrad.com`，依新版基线在获准阶段配置。

原生接口：[Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[deployment/status](https://docs.github.com/en/rest/deployments/deployments)、[原 Run 重跑](https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-workflow)、[Actions 变量读取](https://docs.github.com/en/rest/actions/variables#get-a-repository-variable)。
