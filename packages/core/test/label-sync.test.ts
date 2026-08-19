import { describe, expect, it } from "vitest";
import catalogJson from "../../../config/labels/pr-semantics.json" with { type: "json" };
import profileJson from "../../../config/profiles/classification/default.json" with { type: "json" };
import { type ClassificationProfile, type SemanticCatalog } from "../src/classification.js";
import { assertLabelDefinitionsReadback, desiredLabelDefinitions, planLabelDefinitions } from "../src/label-sync.js";

const catalog = catalogJson as unknown as SemanticCatalog;
const profile = profileJson as unknown as ClassificationProfile;

describe("受管标签物理定义", () => {
  it("只投影profile需要的物理定义并忽略Summary-only facet", () => {
    const desired = desiredLabelDefinitions(catalog, profile);
    expect(desired.map(value => value.name)).toEqual(expect.arrayContaining(["feature", "security", "area:source", "dependencies"]));
    expect(desired.map(value => value.name)).not.toContain("config");
  });

  it("区分缺失、元数据漂移、冲突与legacy并验证读回", () => {
    const desired = desiredLabelDefinitions(catalog, profile);
    const actual = desired.slice(1).map(value => ({ name: value.name, color: value.color, description: value.description }));
    actual[0] = { ...actual[0]!, color: "ffffff" };
    actual.push({ name: "plugin", color: "cccccc", description: "legacy" });
    const plan = planLabelDefinitions(catalog, profile, actual);
    expect(plan.missing).toHaveLength(1);
    expect(plan.metadataDrift).toHaveLength(1);
    expect(plan.legacy.map(value => value.name)).toContain("plugin");
    const exact = desired.map(value => ({ name: value.name, color: value.color, description: value.description }));
    expect(assertLabelDefinitionsReadback(planLabelDefinitions(catalog, profile, exact), exact)).toMatch(/^[0-9a-f]{64}$/u);
  });
});
