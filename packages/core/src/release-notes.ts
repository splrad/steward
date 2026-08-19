import { classifyReleaseDecision, type ClassificationDecision, type ClassificationProfile } from './classification.js';

export interface PublishedRelease { tag: string; targetSha: string; publishedAt: string; draft: boolean; prerelease: boolean }
export interface ReleasePullRequest { number: number; title: string; body: string; labels: string[]; files: string[]; author: { login: string; type: string }; mergedAt: string; mergeSha: string }
export interface ClassifiedReleasePullRequest extends ReleasePullRequest { decision: ClassificationDecision }
export interface CategorizedReleasePullRequest extends ClassifiedReleasePullRequest { category: { title: string; icon: string } }

const categoryOrder = ["🚨 破坏性变更", "🔒 安全修复", "✨ 新增功能", "🛠 问题修复", "⚡ 性能优化", "📦 安装与发布包", "🔌 其他插件变更"] as const;

export function selectPreviousRelease(releases: readonly PublishedRelease[], firstParentAncestors: ReadonlySet<string>): PublishedRelease | null {
  return [...releases]
    .filter((release) => !release.draft && !release.prerelease && firstParentAncestors.has(release.targetSha))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0] ?? null;
}

export function collectReleasePullRequests<T extends ReleasePullRequest>(pullRequests: readonly T[], excludedLabels: readonly string[]): T[] {
  const excluded = new Set(excludedLabels);
  const unique = new Map<number, T>();
  for (const pull of pullRequests) if (!pull.labels.some((label) => excluded.has(label))) unique.set(pull.number, pull);
  return [...unique.values()].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number);
}

export function categorizeReleasePullRequests(profile: ClassificationProfile, pullRequests: readonly ClassifiedReleasePullRequest[]): CategorizedReleasePullRequest[] {
  return pullRequests.flatMap((pull) => {
    if (!pull.decision) throw new Error(`发布缺少角色化分类决策: #${pull.number}`);
    const category = classifyReleaseDecision(profile, pull.decision);
    return category ? [{ ...pull, category: { title: category.title, icon: category.icon } }] : [];
  });
}

function actor(pull: ReleasePullRequest): string {
  return pull.author.type.toLowerCase() === 'bot' || pull.author.login.endsWith('[bot]')
    ? '自动化机器人'
    : `[@${pull.author.login}](https://github.com/${pull.author.login})`;
}

export function renderReleaseNotes(input: { repositoryId: number; targetSha: string; policySha: string; displayVersion: string; categorized: readonly CategorizedReleasePullRequest[]; emptyRuntimeText: string }): string {
  const lines = [
    `<!-- steward:release-notes:v1 repository=${input.repositoryId} target=${input.targetSha} policy=${input.policySha} -->`, '',
    '## 📦 下载说明', '', '| 文件 | 用途 |', '| --- | --- |',
    `| \`AFR-Deployer_v${input.displayVersion}.exe\` | 普通用户安装或升级LayerScape的首选安装程序 |`,
    `| \`AFR-DLL_v${input.displayVersion}.zip\` | 手工部署AutoCAD 2018至2027插件文件 |`,
    '| `Fonts.zip` | 单独获取随产品发布的字体资源 |', '',
    `一般用户只需下载 **AFR-Deployer_v${input.displayVersion}.exe**。需要手工部署插件文件时下载 **AFR-DLL_v${input.displayVersion}.zip**；仅需字体资源时下载 **Fonts.zip**。`, '', '---', '', '## 🆕 更新内容', '',
  ];
  const groups = new Map<string, CategorizedReleasePullRequest[]>();
  for (const pull of input.categorized) {
    const key = `${pull.category.icon} ${pull.category.title}`;
    groups.set(key, [...(groups.get(key) ?? []), pull]);
  }
  if (!input.categorized.length) lines.push(input.emptyRuntimeText, '');
  for (const heading of categoryOrder) {
    const pulls = groups.get(heading);
    if (!pulls) continue;
    lines.push(`### ${heading}`, '');
    for (const pull of pulls) lines.push(`- ${pull.title.replace(/\s+/gu, ' ').trim()}（拉取请求 [#${pull.number}](https://github.com/splrad/LayerScape/pull/${pull.number})；贡献者：${actor(pull)}）`);
    lines.push('');
  }
  const contributors = [...new Set(input.categorized.filter((pull) => pull.author.type.toLowerCase() !== 'bot' && !pull.author.login.endsWith('[bot]')).map((pull) => pull.author.login))];
  if (contributors.length) lines.push('## 👥 贡献者', '', ...contributors.map((login) => `[@${login}](https://github.com/${login})`), '', '---', '');
  lines.push('## ⚠️ 升级说明', '', '- 支持直接覆盖安装。', '- 无需卸载旧版本。', '- 已安装字体不会被删除。', '');
  return lines.join('\n');
}
