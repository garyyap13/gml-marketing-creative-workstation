-- A1a: schemas for the Brief-to-approval workflow (TRD §4.1–4.3).

create schema label;    -- team label lists (exposed, read-only to members)
create schema brief;    -- Briefs and Brief versions (exposed, read-only to members)
create schema creative; -- Creatives, Variants, Versions (exposed, read-only to members)
create schema review;   -- Reviews, Comments, approval withdrawals (exposed, read-only to members)
create schema worker;   -- functions only background workers call (exposed; never granted to browser roles)

grant usage on schema label, brief, creative, review to authenticated, api_owner;
revoke all on schema worker from public;
grant usage on schema worker to service_role;
grant create on schema worker to api_owner; -- needed to own the functions there

-- From here on, command functions are created as api_owner (set role api_owner), so they belong to it
-- and PUBLIC gets no EXECUTE by default: a function left without an explicit grant is unreachable.
alter default privileges for role api_owner revoke execute on functions from public;

-- Lock order for commands that touch several aggregates: Brief, then Creative, then Variant, then Review.
-- Taking row locks in this order everywhere prevents deadlocks; the second command waits, then sees a
-- changed lock_version or state and returns a conflict (T-03).
