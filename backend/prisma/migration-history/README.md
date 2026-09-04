# Pre-baseline migration history

Files under `pre-baseline/` are retained for audit and for diagnosing databases
created before the Prisma deployment baseline. Prisma does not execute this
directory.

Do not replay these files against a database managed by
`prisma/migrations/20260000000000_baseline`; their effects are already included
in that baseline. An existing database must be brought to the complete target
shape, compared against the deploy migration stack, and then adopted with the
baseline adoption tool. Drift is a blocking condition, not permission to mark
migrations as applied.
