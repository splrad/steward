# 发布来源、GitHub Release 与历史记录

本文说明当前源码中的发布连接。入口是 [release workflow](../.github/workflows/release.yml)、[协调器](../scripts/release-coordinator.mjs)和[记录读写入口](../scripts/release-record.mjs)。实现存在、仓库已启用和实际发布验收分别判断。

## 候选与准确构建来源

[候选入口](../scripts/release-candidate.mjs)使用 Release Please 的版本与候选结果，并接入内容收集、分批生成和人工稿保护。候选合并后读取原 PR、合并提交 S 和已审 head H，比较完整 Git 树，核对冻结作者集合及原生版本，再通过既有 Git 快进事务登记周期和 activeCycleId。构建及标签绑定准确 S，中央执行来源另存 controller SHA；不以运行时默认分支最新提交替代。

构建按 S 中的 delivery 数据和原生 YAML 生产者映射读取文件，登记实际 Run/attempt、artifact ID、摘要及来源。构建身份不取得中央发布权限；中央读取并核验冻结制品后执行发布。相关数据与检查见[发布管线](../packages/runner/src/release-pipeline.ts)。

单位 notes 仍须包含七节：概述、更新内容、兼容性、升级与迁移、安装说明、已知问题、恢复；[notes解析与模板映射](../packages/core/src/release-template.ts)校验完整标题集合。正式Release正文将概述置于产品/版本一级标题后、“升级须知”前；兼容性、升级与迁移、安装说明、已知问题、恢复五项映射到“升级须知”，并包含下载资产信息；更新内容映射到“更新内容”，再按冻结贡献者和作者ID生成可选“贡献者”，以CHANGELOG准确比较链接等来源组成“完整变更”。这是外层四节布局（贡献者可省略），不减少单位notes的七节要求。展示副本可调整标题层级，原notes/CHANGELOG保留原字节。作者过滤依据已确认的身份，不以账号存在代替作者确认。

GitHub Release的外层展示标题与正文标题、单位notes标题分别处理：当前创建请求使用 `name: m.tag`，即 `Release.name` 为tag；中文正文生成不表示外层展示标题已中文化。

## 当前来源输入


`release-freeze` 输出 schemaVersion 3 来源清单，从完整本地 Git 对象库读取明确边界至目标的全部可达提交、净差异、重命名、README 背景及读取缺口。来源身份绑定 `repositoryId`、`defaultBranch`、`targetSha` 和 `controllerSha`，发布单元绑定 Release Please 解析后的 `id`、`path`、`version` 和 `tag`。版本解析与排序复用锁定的 Release Please，支持组件标签、子目录单元和预发布版本。

命令接收 `--repository-id`、`--default-branch`、`--target-sha`、`--controller-sha`、`--unit`、`--unit-path`、`--version`、`--target-tag`，以及原有 Git 根目录和输出路径参数。来源边界选择标签、采用基线或首发完整树之一；标签边界同时提供 `--boundary-version`，用于比较同一发布单元的版本顺序。

原始 commit/blob 留在 Git 对象库。读取器通过单个 `git cat-file --batch` 进程流式读取，复核 Git 对象 ID、完整 SHA-256 和连续字节块的 SHA-256；清单保存对象类型、字节数、编码标识和块区间。默认块大小为 1 MiB。纯校验器核对清单结构、身份、提交图和引用覆盖，实际 Git 字节由读取器验证。后续内容收集须按对象 ID 和字节区间重新读取并核验摘要。

来源全集由 Git 提交图确定。直接提交、一个提交关联多个 PR、同一 PR 关联多条提交均可表达；GitHub PR 元数据只补充已确认的提交范围，并验证同仓身份、提交关联、完整分页和重复项。浅克隆、缺失对象、边界漂移、不完整提交图和超过显式资源预算均失败。来源清单不携带整包 Base64；旧的 8 MiB 单对象、32 MiB JSON 和 64 MiB 总对象默认上限已从该读取器移除，提交数、路径数、进程时间及显式配置的字节预算仍受限。

内容收集与发布连接使用准确来源和受审输入；旧 schema 按对应历史读取器解释，不把旧格式转换为当前来源验证通过。

## 中文初稿与身份

[发布说明客户端](../packages/runner/src/copilot-release-client.ts)调用现有 [SDK入口](../tools/quality-language/release-notes.mjs)，使用隔离临时目录及显式传入的短时身份。当前 release job 声明 `copilot-requests: write`，将 `github.token` 作为 `STEWARD_COPILOT_TOKEN` 交给适配器。SDK与兼容runtime版本由仓库锁定配置及安装校验确定，不在本文另设CLI版本。

生成按既有批次保存输入和结果，认证/额度不可用时保留待处理状态。客户端的有限超时和输出限制属于该调用边界，不形成跨构建、发布和渠道累计的统一失败预算。实际模型服务接受与用量归属须由对应环境的真实调用验证；无模型运行只证明其覆盖的身份和连接事实。

## GitHub Release 与渠道

[GitHub Release适配器](../packages/runner/src/gh-release.ts)复核冻结制品、准确tag/S、Release身份及资产集合；写入响应丢失后先读回同一对象，不盲目重复创建或上传。正式发布后核 immutable、正文与资产身份，实际下载比较字节，并调用 `gh release verify`、`gh release verify-asset` 及来源证明验证。已经公开的字节不覆盖为修复版本。

主发行与渠道分开判定。准确S对应的公开immutable GitHub Release及必需资产、来源、摘要和实际下载验证构成主发行结果；渠道根据已配置的发行单位、准确Release ID和manifest摘要分别派发及观察。渠道等待不改写已确认的主发行结果，未验证渠道不记为通过。

当前交付主线为GitHub Release。已有GHCR/WinGet实现保留，实际分发另行完成对应产品接入与验收。无当前发布消费者的npm、NuGet、PyPI、Helm、cargo和Maven发布保持未启用，不因构建工具或资产格式存在而自动启用上传。根 `package.json` 的 `private: true` 包用于构建依赖；GitHub Release上的wheel/sdist资产不表示已向PyPI发布。

## 有限恢复与历史记录

协调器按候选、构建、中央发布、渠道派发/观察及原生证据恢复的固定顺序工作，保存准确Run、attempt和对象身份。恢复复用平台支持的原Run失败job重跑和仍有效制品；成功job及其来源证据可按实际结果复用。未知写入先核实远端状态，缺失或冲突证据明确报告；不承诺平台窗口外无限自动重建。

普通候选按当前登记及原生事实处理，不要求扫描全仓历史或清空旧恢复缓存。旧失败保留失败，修正后沿普通候选路径产生新版本；主发行验证不以旧 `lastCompleted` 非空或active记录清空为条件。

旧D1/Worker收据、生成票据与图协议属于历史实现，不是当前操作步骤。其原文可从[历史版本](https://github.com/splrad/steward/blob/d89aaffa0d0f22e1f8c4d5d160b43da4c7e3262e/docs/release-source-contract.md)查阅；历史数据按原schema保留读取与恢复所需来源。本文不要求重新部署旧SQL迁移、申请生成票据或恢复跨阶段三次预算，也不因清理活动说明而删除历史数据或有效读取能力。
