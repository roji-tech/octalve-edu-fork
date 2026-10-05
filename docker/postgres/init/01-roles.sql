-- Local development only (docker compose): creates the RUNTIME role the app connects as. Runs once, on a fresh volume.
-- The role is deliberately unprivileged: no superuser, NO BYPASSRLS, no DDL — row-level security applies to it.
-- (The POSTGRES_USER of this container is the MIGRATOR: it owns the tables and runs `prisma migrate`.)
-- For an existing database, or a production one, run `pnpm db:roles` or the equivalent SQL by hand — see the Solo
-- installer notes. The migration grants privileges to `app_user` if it exists when the migration runs.
CREATE ROLE app_user LOGIN PASSWORD 'app_user' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE octalve_edu TO app_user;
