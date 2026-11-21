# 产品构建作业

LayerScape 的产品入口是 [steward-release-publish.yml](https://github.com/splrad/LayerScape/blob/c08b95a072c9154fa07d1bdf702a6eeabd4852d2/.github/workflows/steward-release-publish.yml)。其中 `build` 作业按产品矩阵执行仓内打包步骤，`evidence` 作业调用工作流内固定版本的 [product-release.yml](https://github.com/splrad/steward/blob/8eae6add9b8013e33098484f66dc5d09a904b448/.github/workflows/product-release.yml)，核对该次构建的原生产物与证据。检查既有发行时，请从冻结产品提交中的工作流读取实际调用版本。

## 公开产品的 GitHub 发行入口

产品可在一张普通 PR 中补齐 Release Please 配置和版本 manifest、经审查的工作流，以及 [`.github/delivery.json` v3](../schema/delivery.schema.json)。采用新发行说明模板时，精简配置只填 `schemaVersion: 3`。`buildWorkflow` 引用非默认入口，默认路径为 `.github/workflows/steward-release-publish.yml`。`notes` 可按 Release Please package 路径覆盖说明文件位置，缺省为 `.release-notes/<unit-id>.md`。候选按 Release Please 文件取得单位、版本和 CHANGELOG，按核验的控制器提交读取公共发行模板。

用产品自己的脚本构建，并在同一 Run 中对每个发行单位交付一次。工作流声明 `workflow_dispatch`，接收 `cycle_id`、`source_sha`、`operation_key`、`controller_sha`。运行名称包含 operation key，以便派发响应丢失时恢复。固定中央控制器提交，使用 `release-pipeline identity` 核验来源。交付 job 的原生名称为 `delivery/<unit-id>`。其中一步使用固定提交的 `actions/upload-artifact`，ID 为 `upload-github-release`，步骤名称为 `Upload GitHub release delivery`。制品名称格式为 `delivery-github-release-<repository-id>-<unit-id>-<source-sha>-<run-id>-<attempt>`。

产品在工作流内为每个单位和渠道选择一次公开附件。上传步骤的 `with.path` 可用原文件名、构建矩阵汇总出的路径或用途明确的通配。Python 工作流可用 `*.tar.gz` 和 `*.whl` 分别选择源包和 wheel，平台矩阵可用 `cli-*.tgz` 收集随构建目标增减的分发包。文件数量可以随匹配结果变化。目录上传会包含其中匹配的文件，审查时应核对哪些步骤写入该目录。用于调试和测试的内部制品可另行上传。

交付归档根目录直接包含公开附件，每件使用唯一的原名。需要保留目录层级时，可将 ZIP/TAR 作为单个附件交付。中央核对准确的 Run、attempt、成功交付 job、制品 ID、摘要和适用的构建证明。对于能映射到归档根的字面文件名和简单文件名模式，中央核对实际名称，并按声明顺序应用可直接映射的同目录包含和排除。跨目录排除、复杂模式和运行时表达式的选件语义由产品工作流审阅确认。平铺归档提供的是实际交件的文件名和字节，无法还原 runner 上的路径和表达式取值。

草稿恢复使用已冻结的 attempt、制品 ID、文件名和摘要。已有完整冻结包的产品仍可从原冻结包取得所选文件，由中央逐字节比较渠道交件和原包。历史 `delivery.json` v1/v2 继续按原规则解码。

中央在冻结交件和写入发布前检查文件格式与适用版本。独立 PE 检查 EXE 或 DLL 类型及版本资源，Python wheel/sdist 与 npm 包检查原生包元数据，AppX/MSIX 检查包或 bundle manifest 的版本。通用 ZIP/TAR 检查容器结构和已识别资源，根 `VERSION` 存在时核对发行单位版本。归档中的第三方 PE 文件可有自己的版本，中央检查其 PE 格式。字体、校验和、文字说明等无内嵌版本的资料走各自的结构和字节检查。格式错误、版本错误和未支持格式分别报告。遇到未支持格式（例如 MSI）时暂停该交件，适用检查需要随产品采用确认。成员路径只表达归档结构，所有公开文件仍由上传步骤选择。

多个平台或架构目标可先在构建矩阵中各自打包，再由依赖这些作业的 `delivery/<unit-id>` job 收集同一 Run 的产物，为每个渠道上传一份归档。新增平台时，沿用用途相同的交付匹配即可纳入新文件。

要共用交付 job，可以用 `delivery/${{ matrix.unit }}` 搭配能确定最终单位行的静态矩阵。中央按矩阵轴及 `include`、`exclude` 展开，最终每个参与单位只有一行。作业可用矩阵字段或前序作业输出选择实际文件。动态构建矩阵可以汇总到单位已确定的交付 job。渠道不同的单位可以各用一个交付 job，或分配到各自的单位行组。

受信外部适配器使用同一 Run 中各自独立的制品。GHCR 对应 `upload-ghcr-assets` 和 `Upload GHCR assets delivery`，WinGet 对应 `upload-winget` 和 `Upload WinGet delivery`。制品名称按上述格式替换渠道段。外部步骤的 `env.STEWARD_CHANNEL_LOCATION` 需与已授权适配器目标匹配。现有外部适配器仍要求单位的正式 GitHub Release，WinGet 还核对公开安装文件的原名与字节。缺少外部制品时，该渠道保留待处理状态。

当同一交件 job 的固定版本 `actions/attest` 或 `actions/attest-build-provenance` 对该上传步骤的全部选件生成证明时，中央会核验这些文件的证明。若由其它 job 生成整组交件的证明，可在该上传步骤声明 `env.STEWARD_DELIVERY_ATTESTED: 'true'`。证明要求按各单位、渠道独立生效。

历史手动构建入口 `product-build.yml`、`release-build.yml` 及其 .NET、Node、custom、OCI Profile 说明见[维护分支对应版本的构建文档](https://github.com/splrad/steward/blob/e01e3ca89fc98548211e89e9da0f9d6cb803c731/docs/product-build.md)。接入其他产品时应核对产品实际使用的构建步骤、交付资产与中央证据接口。
