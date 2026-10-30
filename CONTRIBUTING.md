# Contributing to Devia

Thanks for helping. Devia is licensed under Apache-2.0; by contributing you agree your work is released under the same license (Apache-2.0 §5).

## Setup

```bash
nvm use            # Node from .nvmrc
npm install
npm run build
npm run dev
```

## Before opening a pull request

```bash
npm run typecheck
npm run build      # the only step that compiles Angular templates
npm test
npm run lint
```

- Branch from `main`: `feat/…`, `fix/…`, `refactor/…`, `docs/…`, `chore/…`.
- One logical change per PR, with tests for new behaviour. Main-process tests use in-memory fakes, never real CLIs.
- UI strings go through the i18n JSON files; keep all languages in parity (`tools/i18n-parity.test.ts`).
- Read `AGENTS.md` first — it documents the architecture and the security guards you must not relax.

## Reporting bugs and ideas

Use the issue templates. For security problems, do **not** open a public issue: see `SECURITY.md`.

## Conduct

Be respectful. See `CODE_OF_CONDUCT.md`.
