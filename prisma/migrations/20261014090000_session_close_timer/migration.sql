-- Closing a session takes time (plan, "Design change — closing a session takes time, and a closed session can be reopened"). ADDITIVE ONLY:
-- three columns on AcademicSession, two nullable and one with a constant default (no table rewrite). Row-level security is untouched (the
-- table's existing FORCE RLS policies cover the new columns).
ALTER TABLE "AcademicSession" ADD COLUMN "closeAt" TIMESTAMP(3),
ADD COLUMN "closeRequestedById" TEXT,
ADD COLUMN "closeForced" BOOLEAN NOT NULL DEFAULT false;

-- A scheduled close needs someone who asked for it.
ALTER TABLE "AcademicSession" ADD CONSTRAINT "AcademicSession_close_has_requester" CHECK ("closeAt" IS NULL OR "closeRequestedById" IS NOT NULL);
