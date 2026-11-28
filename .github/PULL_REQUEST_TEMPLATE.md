## Summary

- What changed and why?

## Verification

- [ ] `pnpm run format:check`
- [ ] `pnpm run lint`
- [ ] `pnpm run check`
- [ ] `pnpm run typecheck`
- [ ] `pnpm run build && node scripts/check-repo.mjs --require-built`
- [ ] Targeted tests or `pnpm test` (list exact command and pass/fail/skip counts)

## Security and Compatibility

- [ ] No unreviewed dependency or range specifier introduced
- [ ] Positive and negative controls cover every new guard or bug fix
- [ ] Persisted data changes preserve backward compatibility (D81)
