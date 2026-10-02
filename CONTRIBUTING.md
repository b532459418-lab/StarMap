# Contributing to StarMap

Thank you for helping build StarMap. This repository is the **StarMap Core /
Community Edition**: an MIT-licensed, local-first personal world graph and 3D
world atlas. It is meant to stay a complete product on its own, not a trimmed
showcase, so real features are welcome here.

## What belongs in this repository

Ask one question about any feature:

> Can a user, without creating an account and without a network connection,
> complete their whole personal world graph with local StarMap?

If the capability is part of that complete local experience, it belongs here.
Examples of work that is welcome in this repository:

- World Graph Core model and the Layer Engine
- Journey, place, and media fundamentals; local editor; local data management
- Import / export, schemas, and migration tooling
- Cesium globe features and map interaction improvements
- Basic search and basic media management
- Plugin / Layer SDK and adapter interfaces
- Bug fixes, performance, accessibility, internationalization, UI polish

Capabilities that are about being *more convenient, more intelligent, or
connected* live in other repositories with different licenses. See
[docs/editions.md](docs/editions.md) before proposing, for example, cloud sync,
accounts, sharing, collaboration, hosted media, or advanced AI automation. If
you are unsure where something belongs, open an issue first.

## Before you start

1. Read [AGENTS.md](AGENTS.md), [README.md](README.md), and
   [01_Web/AGENTS.md](01_Web/AGENTS.md). They describe the privacy boundary,
   the external private layer, and the map-credential rules.
2. Open an issue for anything larger than a small fix so the scope is agreed
   before you write code.
3. Work on a branch from `main`. Keep each pull request to one bounded change.

## Development

All npm commands run from `01_Web/`:

```powershell
npm ci
npm run dev:public       # neutral sample data, no credentials
npm run dev:personal     # your own external private layer
```

Before opening a pull request, make sure these pass:

```powershell
npm run lint
npm test
npm run build:public
npm run privacy:check
```

GitHub Actions runs the **CI / Public checks** job for every pull request to
`main`, every push to `main`, and manual runs. It uses Node.js 24 on Ubuntu and
executes `npm run release:check`: the privacy audit followed by a clean archive
of the committed source, locked dependency installation, lint, the complete
test suite, and a public build. No personal data or map credentials are needed.
New commits cancel older runs for the same pull request or branch.

Before merging, check that **Public checks** passed for the latest commit.
Maintainers can require this check through branch protection; the workflow
alone does not enforce a merge restriction. Browser checks remain necessary
for changes to user-visible behavior.

Architecture rules that lint enforces:

- `src/worldgraph/**` is StarMap Core. It must not import `src/components/**`,
  `src/data/travelAtlas.ts`, or use `import.meta`. Core is consumed by the UI,
  never the other way round.
- Core files use erasable-only TypeScript (`type` / `interface`, no `enum`,
  `namespace`, or parameter properties) so `node --test` can run them directly.

### Interface translations

`npm run lint` includes `npm run i18n:check`, so the existing **Public checks**
job also enforces translations in its clean release archive. All namespaces
registered in `src/i18n/resources.ts` must cover Chinese and English, preserve
the same interpolation parameters, and supply English singular/plural forms.

The TypeScript syntax check follows local imports from `src/main.tsx` and checks
active UI text, placeholders, titles, accessible labels, notices, confirmations,
and translation keys. Use `t()` for fixed wording and keep user notes, place
data, file names, internal state values, and saved metadata intact. The frozen
`AtlasGlobe.tsx` and unreferenced prototypes are outside this active UI check.

Dynamic translation keys need a finite contract in `scripts/i18n-check.mjs`.
Current contracts read option declarations and the layer registry as syntax,
then verify every resulting key in both languages. New choices therefore need
translations too. Exceptions must name one exact literal, its specific file,
and a reason such as a brand, keyboard modifier, or provider attribution; do
not exempt whole components. This guard does not prove rendered layout or
translation quality. Continue to check language switching, drafts, and narrow
screens in the browser.

## Privacy rules for contributors

- Never commit tokens, keys, `.env.local`, personal travel data, or personal
  media. The tracked sample data must stay neutral.
- Never paste a full credential into an issue, pull request, or chat.
- Do not add owner-specific defaults to source files.

## Pull requests

- Describe **what** changed and **why**, and list what you verified.
- Update `README.md` and `README.zh.md` together when user-facing behavior
  changes. Keep both languages in sync.
- Add or update tests for World Graph Core changes.
- Release notes live in `docs/releases/`; maintainers write them at release
  time, so you do not need to.

## Licensing of contributions

By submitting a contribution to this repository you agree that it is licensed
under the [MIT License](LICENSE), the same license as the project
("inbound = outbound"). You confirm that you wrote the contribution or otherwise
have the right to submit it under MIT. No separate contributor license
agreement is required for this repository.

Please add attribution in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when
you introduce a new dependency, dataset, or online service.

## Naming

The MIT License does not cover the StarMap name or logo. See
[TRADEMARK.md](TRADEMARK.md) if you distribute a modified version.
