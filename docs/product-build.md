# 产品构建作业

`product-build.yml` 提供按中央已登记构建单元执行的手动作业。输入为仓库 ID、buildId 和精确 targetSha；规划阶段核对公共仓库身份、读取配置及 VERSION，生成 BuildPlan 与 Git bundle。没有 VERSION 时保留 version=null。构建阶段根据计划选择 windows-2025 或 ubuntu-24.04，检出精确来源并运行中央适配器。规划与构建分离，构建作业不注入 App、发布或部署凭据。

四类 Profile 共用干净来源、空输出目录、输入路径及产物合同检查：

- dotnet-assets-v1：执行 dotnet publish，原生 PE 版本由中央检查器核验。
- node-package-v1：执行 npm ci 和登记的 npm task；产物必须符合配置和中央原生版本检查器支持的格式。package.json 由中央解析并核验版本。
- custom-adapter-v1：执行登记的 pwsh、node 或 bash 入口；运行时与 runner 家族由可信配置确定。
- oci-image-v1：执行 buildx 并导出本地 OCI layout，核验索引、平台、版本标签和全部 blob 摘要。本次支持每个构建单元一个镜像输出，可包含多个登记平台；多个镜像使用不同构建单元。

当前原生文件检查器支持 PE、符合约束的 DLL/字体 ZIP 和 package.json。其他产物格式需补对应原生检查器后使用，不能用产品自报版本替代核验。OCI 保持镜像摘要合同，不能作为 GitHub Release 文件资产；通用产品作业不会发布镜像或创建 Release。

`release-build.yml` 的文件资产链已接通 .NET、Node 和 custom Profile，并使用同一 runner 路由。通用产品入口为 `release-build --operation plan-product` 与 `--operation execute-product`；执行入口接收 plan 和 source bundle，产出 artifact-manifest.json 及其 execution.json，记录仓库、提交、构建身份、输入和工具链摘要。通用构建产物上传与后续发布分开。

工具链目录固定于 core/release-build-request.ts。执行时检查相关工具版本，不匹配即失败；通用作业依赖 runner 已提供对应 Docker/Buildx 或 PowerShell 版本。本地执行验证不证明 GitHub 托管 runner 已具备全部相同版本，远端第一次运行须回读实际环境与作业结果。现有仓库的发布开关不因新增工作流改变。

参考：[dotnet publish](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-publish)、[Docker Buildx 构建与导出参数](https://docs.docker.com/reference/cli/docker/buildx/build/)。
