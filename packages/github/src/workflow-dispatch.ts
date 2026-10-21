import { GitHubClient } from "./client.js";

const ALLOWED = new Set(["onboard-repository.yml", "native-review.yml", "pr-classification.yml", "release.yml", "release-build.yml", "release-build-complete.yml", "sync-review-instructions.yml"]);

export async function dispatchWorkflow(client: GitHubClient, input: {
  owner: string; repo: string; workflow: string; policySha: string; inputs: Record<string, string>;
}): Promise<void> {
  if (!ALLOWED.has(input.workflow)) throw new Error(`不允许调度工作流: ${input.workflow}`);
  if (!/^[0-9a-f]{40}$/i.test(input.policySha)) throw new Error("policySha必须是40位提交编号");
  const repository = await client.getRepository(input.owner, input.repo);
  const defaultBranch = repository?.default_branch;
  if (typeof defaultBranch !== "string" || !defaultBranch.trim()) throw new Error("中央仓库没有可用的默认分支");
  if (input.workflow === "release-build.yml") {
    const head = await client.getRef(input.owner, input.repo, `heads/${defaultBranch}`);
    if (head.object?.sha !== input.policySha) throw new Error("RELEASE_POLICY_DRIFT: synchronize deployed policy and default branch before retrying release build");
  }
  const inputs = ["release.yml", "release-build.yml", "release-build-complete.yml", "sync-review-instructions.yml"].includes(input.workflow) ? input.inputs : { ...input.inputs, policySha: input.policySha };
  await client.request("POST", `/repos/${input.owner}/${input.repo}/actions/workflows/${input.workflow}/dispatches`, { ref: defaultBranch, inputs });
}
