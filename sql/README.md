# window-calculator/sql — history, not a queue

**New schema does not go here (Fix 1, 2026-10-12).** `calculator_events` and `estimate_jobs` live in the
HL Supabase project (`jtlngmcrtqncimtjjzlz`), as both files say. Every schema change for that project is
now a file in `HL-MCP/supabase/migrations/`, checked and applied by CI there. For the LP project it is
`LP-MCP/supabase/migrations/`. Doctrine: `LP-MCP/sql/README.md`.

The two files here are the record of what was applied by hand. Keep them; do not add to them.

Note (found 2026-10-12): empty copies of both tables also exist in the LP project's `public` schema,
so at some point the files were run against the wrong project as well. `LP-MCP/sql/cleanup/
2026-10-12_archive_backup_tables.sql` proposes moving those copies out of the way.
