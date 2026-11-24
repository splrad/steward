# 核对模板采用冲突

维护者可在能读取目标仓库的电脑上重放一次采用。先在本地克隆中取得正式模板标签、目标默认分支和已有同步分支，记录运行当时的完整 Git 提交。已有同步分支时传入其提交，新仓可省略 `--pending-sha`。若模板需要仓库输入，在本地 JSON 文件中填写 `product_repository`，用 `--data-file` 指定该文件。

```sh
uv run --project tools/template --frozen python tools/template/copier_bridge.py diagnose \
  --central /path/to/steward --target /path/to/target \
  --template-sha TEMPLATE_COMMIT --base-sha DEFAULT_COMMIT --pending-sha SYNC_COMMIT \
  --data-file inputs.json --output local-diagnostic.json
```

命令在临时 Git 目录中合并输入并执行原生 Copier。输出文件的 `paths` 列出 Git 合并、首次采用或 Copier 补丁的冲突路径。`pendingConfigurationPaths` 列出同步分支与默认分支间待核的旧入口和选择器。生产递送还会核对签名提交与历史来源，据此收回机器人生成的差异。把诊断文件留在目标仓维护者可访问的位置；公共作业仅汇总数量。

## PR 标题工作流

Dependabot 更新 Steward 的 `.github/workflows/pr-title-reusable.yml` 及对应 Actions 锁。该复用工作流是模板晋级输入。晋级程序为受审提交发布模板标签，Copier 用该标签对应的完整提交 SHA 渲染各仓的 `.github/workflows/pr-title.yml`。Steward 自己采用模板时只更新消费端，后续模板发布仍由模板内容或复用工作流的变动触发。
