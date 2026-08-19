import { digest, type ClassificationProfile, type GitHubLabelDefinition, type SemanticCatalog, type SemanticDefinition } from "./classification.js";

export interface DesiredLabelDefinition extends GitHubLabelDefinition { description: string; role: "primaryKind" | "riskFlags" | "areas" | "facets"; id: string }
export interface ActualLabelDefinition { name: string; color: string; description: string | null }
export interface LabelDefinitionPlan {
  desired: DesiredLabelDefinition[];
  missing: DesiredLabelDefinition[];
  metadataDrift: Array<{ desired: DesiredLabelDefinition; actual: ActualLabelDefinition }>;
  conflicts: Array<{ desired: DesiredLabelDefinition; actual: ActualLabelDefinition }>;
  legacy: ActualLabelDefinition[];
  desiredDigest: string;
  actualDigest: string;
  status: "in-sync" | "drift-observed" | "blocked";
}

function definition(catalog: SemanticCatalog, role: DesiredLabelDefinition["role"], id: string): SemanticDefinition {
  const value = catalog.roles[role].definitions.find((item) => item.id === id);
  if (!value) throw new Error(`标签目录缺少定义: ${role}/${id}`);
  return value;
}
function desired(role: DesiredLabelDefinition["role"], value: SemanticDefinition): DesiredLabelDefinition | null {
  return value.githubLabel ? { id: value.id, role, name: value.githubLabel.name, color: value.githubLabel.color.toLowerCase(), description: value.description } : null;
}
export function desiredLabelDefinitions(catalog: SemanticCatalog, profile: ClassificationProfile): DesiredLabelDefinition[] {
  const values = [
    ...catalog.roles.primaryKind.definitions.map((item) => desired("primaryKind", item)),
    ...catalog.roles.riskFlags.definitions.map((item) => desired("riskFlags", item)),
    ...profile.areas.map((item) => desired("areas", definition(catalog, "areas", item.area))),
    ...profile.rules.facets.map((item) => desired("facets", definition(catalog, "facets", item.facet))),
  ].filter((item): item is DesiredLabelDefinition => item !== null);
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = item.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function projectedActual(desiredDefinitions: readonly DesiredLabelDefinition[], actual: readonly ActualLabelDefinition[]): Array<Record<string, string | null>> {
  const byName = new Map(actual.map((item) => [item.name.toLowerCase(), item]));
  return desiredDefinitions.map((item) => {
    const current = byName.get(item.name.toLowerCase());
    return { name: item.name, color: current?.color.toLowerCase() ?? null, description: current?.description ?? null };
  });
}
export function planLabelDefinitions(catalog: SemanticCatalog, profile: ClassificationProfile, actual: readonly ActualLabelDefinition[]): LabelDefinitionPlan {
  const definitions = desiredLabelDefinitions(catalog, profile);
  const exact = new Map(actual.map((item) => [item.name, item]));
  const folded = new Map<string, ActualLabelDefinition[]>();
  for (const item of actual) folded.set(item.name.toLowerCase(), [...(folded.get(item.name.toLowerCase()) ?? []), item]);
  const missing: DesiredLabelDefinition[] = [];
  const metadataDrift: LabelDefinitionPlan["metadataDrift"] = [];
  const conflicts: LabelDefinitionPlan["conflicts"] = [];
  for (const item of definitions) {
    const caseMatches = folded.get(item.name.toLowerCase()) ?? [];
    if (caseMatches.length > 1 || (caseMatches.length === 1 && caseMatches[0]!.name !== item.name)) {
      for (const current of caseMatches) conflicts.push({ desired: item, actual: current });
      continue;
    }
    const current = exact.get(item.name);
    if (!current) missing.push(item);
    else if (current.color.toLowerCase() !== item.color || (current.description ?? "") !== item.description) metadataDrift.push({ desired: item, actual: current });
  }
  const desiredNames = new Set(definitions.map((item) => item.name.toLowerCase()));
  const legacy = actual.filter((item) => !desiredNames.has(item.name.toLowerCase()));
  return {
    desired: definitions, missing, metadataDrift, conflicts, legacy,
    desiredDigest: digest(definitions.map(({ name, color, description }) => ({ name, color, description }))),
    actualDigest: digest(projectedActual(definitions, actual)),
    status: conflicts.length ? "blocked" : missing.length || metadataDrift.length ? "drift-observed" : "in-sync",
  };
}
export function assertLabelDefinitionsReadback(plan: LabelDefinitionPlan, actual: readonly ActualLabelDefinition[]): string {
  const byName = new Map(actual.map((item) => [item.name, item]));
  for (const item of plan.desired) {
    const current = byName.get(item.name);
    if (!current || current.color.toLowerCase() !== item.color || (current.description ?? "") !== item.description) throw new Error(`标签定义读回不一致: ${item.name}`);
  }
  const actualDigest = digest(projectedActual(plan.desired, actual));
  if (actualDigest !== plan.desiredDigest) throw new Error("标签定义实际摘要不匹配");
  return actualDigest;
}
