-- WP-3.1: enable RLS policies and the non-bypass API role.
-- Apply as the table owner (local docker: postgres). Then point DATABASE_URL
-- at chatmate360_app. Safe to re-run. See db/rls.sql and docs/RLS.md.

\ir rls.sql
