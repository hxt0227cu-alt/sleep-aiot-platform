# Contributing to Sleep AIoT Platform

Thanks for your interest in contributing. This project is a reference implementation, and contributions that improve correctness, clarity, or coverage are welcome.

## Ground rules

- **Respect the architecture boundaries** described in the ADRs under `docs/architecture-decisions/`. If your change crosses a service boundary, open an issue first to discuss.
- **Never commit secrets.** Environment templates live in `.env.example` files; real values stay local. Device keys, tokens, and passwords must not be committed.
- **Keep evidence honest.** This repository explicitly does not claim production or hardware evidence that has not been produced. Do not add claims of validation that the CI does not actually run.

## Development workflow

1. Fork the repository and create a feature branch.
2. Make focused changes with clear commit messages (Conventional Commits style is preferred, e.g. `fix(backend): ...`, `feat(firmware): ...`).
3. Run the relevant checks before opening a PR:

   ```bash
   # Backend
   cd backend
   pnpm install
   pnpm run type-check
   pnpm run lint:ci
   pnpm run test
   pnpm run build

   # Mini-program
   cd ../miniprogram
   pnpm install
   pnpm run lint
   pnpm run type-check
   pnpm run test
   ```

4. Open a pull request against `main`. The CI workflows run on every PR.

## Commit message style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

types: feat | fix | refactor | docs | test | chore | perf | security
scopes: backend | firmware | miniprogram | web | services | platform | docs
```

## Testing

- Backend: Jest unit tests (`pnpm run test`). Prefer small focused specs.
- Mini-program: add unit tests where feasible.
- Firmware: hardware-validated changes cannot be merged without evidence; simulation/compile-level changes are accepted but must be labeled as such.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
