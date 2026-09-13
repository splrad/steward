const reviewRepositories: Readonly<Record<number, string>> = {
  1296724484: "splrad/steward",
  1187527897: "splrad/LayerScape",
};

export function isDependabotReviewEligible(repository: any, pull: any, headSha: string): boolean {
  return reviewRepositories[repository?.id] === repository?.full_name
    && repository?.owner?.id === 302208797
    && repository.private === false && repository.fork === false
    && repository.archived === false && repository.disabled === false
    && pull?.state === "open" && pull.draft === false
    && Number.isSafeInteger(pull.number) && pull.number > 0
    && pull.user?.id === 49699333 && pull.user.login === "dependabot[bot]" && pull.user.type === "Bot"
    && pull.base?.repo?.id === repository.id && pull.head?.repo?.id === repository.id
    && typeof repository.default_branch === "string" && repository.default_branch.length > 0
    && pull.base.ref === repository.default_branch
    && /^[0-9a-f]{40}$/u.test(headSha) && pull.head.sha === headSha;
}
