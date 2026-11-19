# 产品构建作业

LayerScape 的产品入口是 [steward-release-publish.yml](https://github.com/splrad/LayerScape/blob/c08b95a072c9154fa07d1bdf702a6eeabd4852d2/.github/workflows/steward-release-publish.yml)。其中 `build` 作业按产品矩阵执行仓内打包步骤，`evidence` 作业调用工作流内固定版本的 [product-release.yml](../.github/workflows/product-release.yml)，核对该次构建的原生产物与证据。检查既有发行时，请从冻结产品提交中的工作流读取实际调用版本。

历史手动构建入口 `product-build.yml`、`release-build.yml` 及其 .NET、Node、custom、OCI Profile 说明见[维护分支对应版本的构建文档](https://github.com/splrad/steward/blob/e01e3ca89fc98548211e89e9da0f9d6cb803c731/docs/product-build.md)。接入其他产品时应核对产品实际使用的构建步骤、交付资产与中央证据接口。
