-- Claude's read-only access (D-08; TRD §9 "Claude's role", AC-27). Claude reads the curated reporting views, and nothing
-- else, through the Data API as the role reporting_reader:
-- - reporting_reader cannot sign in to the database. The Data API switches to it for a request whose token names it;
--   the Admin mints that token for Claude and rotates it, outside the repository. A direct database login was not
--   used: on Supabase every login role inherits platform defaults this project cannot revoke, such as the HTTP
--   extension's public grants, and could switch its read-only default off.
-- - Through the Data API it sees only the exposed claude_reporting schema, where it may SELECT the views and nothing
--   else: no base tables, no raw ingest data, no commands. Requests run no SQL of the caller's own.
-- - The claude_reporting views are copies of the curated reporting views, owned by the non-login role reporting_owner.
--   The reporting views run as their caller (members read them under row-level security), and a caller's view checks
--   the caller's rights even when another view wraps it, so Claude's views can't simply select from them. The copies
--   run as reporting_owner instead, which holds SELECT on just the base tables those views use (sensitive columns
--   excepted) and a read policy on each. app.refresh_claude_reporting() rebuilds the copies from the current reporting
--   views; a migration that changes a reporting view calls it.

create role reporting_owner nologin noinherit;
grant reporting_owner to postgres; -- so migrations can hand it the views
create role reporting_reader nologin noinherit;
alter role reporting_reader set statement_timeout = '30s';
grant reporting_reader to authenticator; -- the Data API may act as it for a token that names it

create schema claude_reporting;
comment on schema claude_reporting is $$Read-only copies of the workstation's curated reporting views, for Claude (D-08).
Rules for reading them (D-37, T-06): a missing figure is null, never zero; Reach is a per-row figure and is never added up;
only rows with the same currency, result type, attribution setting, time zone and channel scope may be added together;
Breakdown rows (breakdowns) are a split of the same results and are never added to the totals (variant_daily_results,
ad_daily_results); results are whole-ad numbers and cannot show which part of a video worked.$$;
revoke all on schema claude_reporting from public;
grant create on schema claude_reporting to reporting_owner; -- needed to own the views there

-- reporting_owner reads the tables behind the curated views, and nothing more.
grant usage on schema audit, brief, core, creative, ingest, launch, learning, measure, meta, review, work to reporting_owner;
grant select on
  brief.brief_versions, brief.briefs, core.files, core.settings,
  creative.creatives, creative.variants, creative.version_files, creative.versions,
  ingest.csv_imports, ingest.sync_runs,
  launch.accounts, launch.launches,
  learning.optimization_plans, learning.plan_actions, learning.retrospective_findings,
  measure.metric_values, measure.observation_revisions, measure.observations, measure.report_scopes, measure.reporting_entities,
  meta.ads, meta.posts, review.comments, review.reviews
to reporting_owner;
-- Never a member's email or WhatsApp number, an activity payload (it can carry both), a raw Meta row, the Meta secret's
-- name, or a job's payload.
grant select (id, display_name, team, is_approver, is_admin, active) on core.members to reporting_owner;
grant select (entity_id, occurred_at) on audit.activity_log to reporting_owner;
grant select (id, run_id, row_locator, error, resolution, created_at) on ingest.quarantine_rows to reporting_owner;
grant select (id, authorisation_state) on ingest.connections to reporting_owner;
grant select (id, type, dedupe_key, state, attempts, last_error, created_at, finished_at) on work.jobs to reporting_owner;

do $$
declare
  v_table regclass;
begin
  foreach v_table in array array[
    'audit.activity_log', 'brief.brief_versions', 'brief.briefs', 'core.files', 'core.settings', 'core.members',
    'creative.creatives', 'creative.variants', 'creative.version_files', 'creative.versions',
    'ingest.csv_imports', 'ingest.quarantine_rows', 'ingest.sync_runs', 'ingest.connections',
    'launch.accounts', 'launch.launches',
    'learning.optimization_plans', 'learning.plan_actions', 'learning.retrospective_findings',
    'measure.metric_values', 'measure.observation_revisions', 'measure.observations', 'measure.report_scopes', 'measure.reporting_entities',
    'meta.ads', 'meta.posts', 'review.comments', 'review.reviews', 'work.jobs']::regclass[]
  loop
    execute format('create policy reporting_owner_read on %s for select to reporting_owner using (true)', v_table);
  end loop;
end;
$$;

-- Rebuilds Claude's copies of the curated reporting views from their current definitions, in dependency order (a view
-- before the views that read it). A reference to another curated view points at its copy. The copies are security
-- barriers, so a caller's filter can't see rows a view leaves out. Run by migrations only.
create function app.refresh_claude_reporting() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_views text[] := array[
    'variant_daily_results', 'ad_daily_results', 'breakdowns', 'manual_results', 'plan_spend',
    'pipeline', 'review_rounds', 'optimization_backlog',
    'data_health', 'sync_problems', 'csv_imports', 'drive_flags', 'unresolved_posts'];
  v_view text;
  v_definition text;
begin
  -- Dropped in reverse order without cascade, so anything else that came to depend on a copy stops the rebuild loudly.
  foreach v_view in array (select array_agg(x order by n desc) from unnest(v_views) with ordinality u(x, n)) loop
    execute format('drop view if exists claude_reporting.%I', v_view);
  end loop;
  foreach v_view in array v_views loop
    -- With an empty search path every name in the definition comes back schema-qualified.
    v_definition := pg_get_viewdef(format('reporting.%I', v_view)::regclass, false);
    v_definition := regexp_replace(v_definition, '\mreporting\.(' || array_to_string(v_views, '|') || ')\M', 'claude_reporting.\1', 'g');
    execute format('create view claude_reporting.%I with (security_barrier) as %s', v_view, v_definition);
    execute format('alter view claude_reporting.%I owner to reporting_owner', v_view);
    execute format('comment on view claude_reporting.%I is %L', v_view,
      format('Copy of reporting.%s for Claude; see the schema comment for how its figures may be added up.', v_view));
    execute format('grant select on claude_reporting.%I to reporting_reader', v_view);
  end loop;
end;
$$;
revoke execute on function app.refresh_claude_reporting() from public;

grant usage on schema claude_reporting to reporting_reader;
select app.refresh_claude_reporting();
