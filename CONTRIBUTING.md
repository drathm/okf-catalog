# Contributing

okf-catalog is released under the Apache License, Version 2.0 (`LICENSE`, `NOTICE`). Before your first pull request can be merged, you sign the Contributor License Agreement in [CLA.md](CLA.md) by writing the sentence it names as a comment on the pull request; a check records the signature in this repository and later pull requests need nothing more. The agreement grants the maintainer the right to sublicense contributions, which keeps a future change of licence possible (the cases in mind are the GNU Affero General Public License or commercial terms for a hosted edition); everything released under Apache-2.0 stays available under Apache-2.0.

How the work is run:

- Feature branches, never `main`; one focused change per pull request; concise, professional commit messages with no attribution trailers.
- The gates stay green: `npm run check` (formatter, linter, type check, the dependency rules) and `npm test` (the suite runs twice, at UTC+14 and UTC−11).
- Tests before code in the core (`src/bundle`, `src/catalog`, `src/derive`, `src/search`), which imports neither the file system nor qmd nor the MCP SDK; the layering is in [docs/architecture.md](docs/architecture.md) and enforced by dependency-cruiser.
- The repository holds no company names, no company content, no personal data and no secrets; fixtures come from the OKF specification's own examples or are written for the tests.
- A change to a decision needs a row in [docs/decisions/0001-founding-decisions.md](docs/decisions/0001-founding-decisions.md); the build record is [docs/plans/version-0-progress.md](docs/plans/version-0-progress.md).
- Versions stay current: the Node floor is the Active LTS line, and a dependency that would pin an older line is flagged in the pull request, not pinned quietly.
