# GitHub

REST, GraphQL, Check, comment, review, and workflow-dispatch adapters.

`fetchPullRequestPages` is the shared bounded page-number primitive. It supports synchronous and asynchronous adapters, stops after an empty or partial page, and retains the production limit of 30 pages with 100 items per page.

`fetchGitHubLinkPages` follows GitHub `Link` headers within the original API origin, rejects cycles or malformed page payloads, and uses the same 30-page ceiling. API adapters remain responsible for authentication and transport.
