# Core

Pure governance and validation algorithms. This module must not read process environment or call GitHub directly.

The extracted contracts cover:

- GitHub login normalization, configurable automation filtering, and hidden contributor metadata;
- stable pull-request input fingerprints that ignore Steward-owned classification output;
- manifest-driven area, kind, public-label, and release-label decisions with pure mutation planning;
- legacy-compatible aggregate blocking-comment state and same-head source replacement;
- main-authorization and Copilot-review decisions, review-request planning, and presentation keys without consumer-facing copy;
- validation-Matrix target evaluation, versioned Check identity validation, legacy evidence reads, repair planning, and workflow-to-proxy completion planning.

Callers must pass the configured Steward GitHub App slug through `botLogins`. A syntactically valid login cannot be identified as a project-specific bot without repository configuration.

Core state does not choose localized fallback titles, mention separators, or empty-state text. Presentation adapters supply those values from the trusted Manifest language.

The Matrix keeps its target catalogue and Check protocol in Steward-owned configuration. Project Manifests may select platform-defined modes, but cannot redefine trusted workflow paths, Check names, App identity, or repair behavior.
