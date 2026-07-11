# GitHub

REST, GraphQL, Check, comment, review, and workflow-dispatch adapters.

`fetchPullRequestPages` is the shared bounded page-number primitive. It supports synchronous and asynchronous adapters, stops after an empty or partial page, and retains the production limit of 30 pages with 100 items per page.

`fetchGitHubLinkPages` follows GitHub `Link` headers within the original API origin, rejects cycles or malformed page payloads, and uses the same 30-page ceiling. API adapters remain responsible for authentication and transport.

`createGitHubRestTransport` accepts an explicit token and an injectable `fetch` implementation. It confines requests to one HTTPS API origin, writes only bounded GitHub error metadata, and never reads process environment.

`GitHubRepositoryClient` is the shared integration adapter for the authenticated user, default-branch Manifest loader, bounded PR/Check/workflow/review-thread reads, and one-call/one-mutation primitives. GitHub.com callers can use one transport; GitHub Enterprise Server callers pass separately confined REST (`https://HOSTNAME/api/v3/`) and GraphQL (`https://HOSTNAME/api/`) transports so `/graphql` resolves to the platform's distinct GraphQL endpoint. The client does not decide policy, retry in time, poll for convergence, or choose which mutations to execute; Action operations use core plans to make those choices.
