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

export interface ClassificationConfiguration {
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
