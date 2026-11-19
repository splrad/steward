# LayerScape 1.0.0

LayerScape 的 AFR 插件会在打开 AutoCAD 图纸时替换缺失字体。可在命令行输入 `AFR` 设置替换字体，输入 `AFRLOG` 查看并调整当前图纸的替换记录。此版本面向 Windows 上的 AutoCAD 2018–2027。

## 下载与安装

- [AFR-Deployer_v1.0.0.exe](https://github.com/splrad/LayerScape/releases/download/v1.0.0/AFR-Deployer_v1.0.0.exe) — **推荐下载**。关闭所有 AutoCAD，运行部署器，选择检测到的 AutoCAD 版本并安装。部署器会安装对应插件和内置字体。
- [AFR-DLL_v1.0.0.zip](https://github.com/splrad/LayerScape/releases/download/v1.0.0/AFR-DLL_v1.0.0.zip) — 供手动加载或测试。解压后按 AutoCAD 年份选择 DLL，用 `NETLOAD` 加载并按提示重启。手动加载时仍可能出现“缺少 SHX 文件”弹窗。
- [Fonts.zip](https://github.com/splrad/LayerScape/releases/download/v1.0.0/Fonts.zip) — 单独获取字体时下载。使用部署器安装时已包含默认字体。

## 从 9.x 迁移

1. 手动下载上面的部署器。旧版更新检查不会提示安装新系列的 1.0.0。
2. 关闭 AutoCAD，将原 DLL、字体和自定义 `FixedProfile.aws` 备份到安装目录以外。导出对应 AutoCAD 的注册表项 `Applications\AFR-ACAD20xx`，记下自定义字体路径。
3. 保留旧版配置，直接用新部署器安装到原路径。逐个打开常用 AutoCAD，用图纸副本检查字体显示、`AFR` 设置和 `AFRLOG` 记录，再保存工作图纸。

[安装与恢复说明](https://github.com/splrad/LayerScape/blob/v1.0.0/README.md) · [完整更新记录](https://github.com/splrad/LayerScape/blob/v1.0.0/CHANGELOG.md)
