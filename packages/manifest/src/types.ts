export const MANIFEST_PATH = '.github/steward.json';
export const SUPPORTED_SCHEMA_VERSION = 1 as const;

export interface GithubAppConfiguration {
  clientId: string;
  slug: string;
}

export type MaintainerConfiguration =
  | { source: 'organization-team'; teamSlug: string }
  | { source: 'users'; logins: string[] };

export interface AutomationConfiguration {
  githubApp: GithubAppConfiguration;
  maintainers: MaintainerConfiguration;
  language: 'zh-CN';
}

export interface FeatureConfiguration {
  prAutomation: boolean;
  classification: boolean;
  dcoAdvisory: boolean;
  governance: boolean;
  copilotReview: boolean;
  release: boolean;
  webhookRelay: boolean;
}

export interface AreaConfiguration {
  name: string;
  patterns: string[];
}

export interface PublicLabelConfiguration {
  name: string;
  color: string;
  description: string;
}

export interface ReleaseCategoryConfiguration {
  title: string;
  releaseLabel: string;
  labels: string[];
  textPatterns: string[];
  installOrPackage: boolean;
  fallback: boolean;
}

export interface ConventionalTypeKindConfiguration {
  type: string;
  kind: string;
}

export interface DocsOnlyPathRuleConfiguration {
  prefixes?: string[];
  files?: string[];
  suffixes?: string[];
  excludePrefixes?: string[];
}

export interface PublicLabelRuleConfiguration {
  label: string;
  whenAny: {
    kinds?: string[];
    areas?: string[];
    conventionalTypes?: string[];
    bot?: boolean;
  };
}

export interface KindPublicLabelFallbackConfiguration {
  kind: string;
  label: string;
}

export interface ClassificationDecisionConfiguration {
  kinds: {
    byConventionalType: ConventionalTypeKindConfiguration[];
    docsOnly: {
      kind: string;
      pathRules: DocsOnlyPathRuleConfiguration[];
    };
    fallback: string;
  };
  publicLabels: {
    rules: PublicLabelRuleConfiguration[];
    fallbackByKind: KindPublicLabelFallbackConfiguration[];
    fallback: string;
  };
}

export interface ClassificationConfiguration {
  decisions: ClassificationDecisionConfiguration;
  areas: AreaConfiguration[];
  runtimeRelease: {
    includePrefixes: string[];
    includeFiles: string[];
    excludePrefixes: string[];
    excludeFiles: string[];
  };
  installOrPackage: {
    includeFiles: string[];
  };
  labels: {
    public: PublicLabelConfiguration[];
    release: string[];
    internalPrefixes: string[];
  };
  releaseCategories: ReleaseCategoryConfiguration[];
}

export interface ReleaseConfiguration {
  triggerPaths: string[];
  runner: string;
  adapterCommand: string[];
}

export interface StewardManifest {
  $schema?: string;
  schemaVersion: typeof SUPPORTED_SCHEMA_VERSION;
  automation: AutomationConfiguration;
  features: FeatureConfiguration;
  classification?: ClassificationConfiguration;
  release?: ReleaseConfiguration;
}
