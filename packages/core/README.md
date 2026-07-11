# Core

Pure governance and validation algorithms. This module must not read process environment or call GitHub directly.

The first extracted contracts cover:

- GitHub login normalization, configurable automation filtering, and hidden contributor metadata;
- stable pull-request input fingerprints that ignore Steward-owned classification output;
- legacy-compatible aggregate blocking-comment state and same-head source replacement.

Callers must pass the configured Steward GitHub App slug through `botLogins`. A syntactically valid login cannot be identified as a project-specific bot without repository configuration.

Core state does not choose localized fallback titles, mention separators, or empty-state text. Presentation adapters supply those values from the trusted Manifest language.
