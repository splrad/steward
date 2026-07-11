import type { MatrixConfiguration } from '../../packages/core/src/index.js';
import type { FeatureConfiguration } from '../../packages/manifest/src/index.js';

export const stewardMatrixConfiguration: MatrixConfiguration = {
  gateName: 'PR Validation Matrix Gate',
  targets: [
    {
      id: 'pr-classification',
      name: 'PR Classification Gate',
      checkNames: ['PR Classification Gate'],
      workflowName: 'PR Classification',
      workflowFile: 'pr-classification.yml',
      jobName: 'Classify Pull Request',
      group: 'full',
      acceptableConclusions: ['success'],
      repairable: true,
      fingerprintBound: true,
      customCheck: true,
    },
    {
      id: 'dco-signoff',
      name: 'DCO Sign-off Advisory',
      checkNames: ['DCO Sign-off Advisory'],
      workflowName: 'DCO Sign-off Advisory',
      workflowFile: 'dco-advisory.yml',
      legacyWorkflowFiles: ['dco-check.yml'],
      jobName: 'DCO Sign-off Advisory',
      group: 'full',
      acceptableConclusions: ['success'],
      required: false,
      repairable: true,
    },
    {
      id: 'main-authorization',
      name: 'PR Governance / Main Authorization Gate',
      checkNames: ['Main Authorization Gate'],
      workflowName: 'PR Governance',
      workflowFile: 'pr-governance.yml',
      jobName: 'Main Authorization Gate',
      group: 'gate',
      acceptableConclusions: ['success'],
      repairable: true,
      fingerprintBound: true,
      customCheck: true,
    },
    {
      id: 'copilot-review-gate',
      name: 'Copilot Code Review Gate',
      checkNames: ['Copilot Code Review Gate'],
      workflowName: 'PR Governance',
      workflowFile: 'pr-governance.yml',
      jobName: 'Update Copilot Review Check',
      group: 'gate',
      acceptableConclusions: ['success'],
      repairable: true,
      customCheck: true,
    },
  ],
};

const targetFeatures: Readonly<Record<string, keyof FeatureConfiguration>> = {
  'pr-classification': 'classification',
  'dco-signoff': 'dcoAdvisory',
  'main-authorization': 'governance',
  'copilot-review-gate': 'copilotReview',
};

export function enabledMatrixConfiguration(features: FeatureConfiguration): MatrixConfiguration {
  return {
    gateName: stewardMatrixConfiguration.gateName,
    targets: stewardMatrixConfiguration.targets.filter((target) => {
      const feature = targetFeatures[target.id];
      if (!feature) throw new Error(`Matrix target ${target.id} has no Manifest feature mapping`);
      return features[feature] === true;
    }),
  };
}
