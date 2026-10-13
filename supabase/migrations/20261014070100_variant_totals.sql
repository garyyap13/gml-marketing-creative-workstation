-- Each Variant's paid-results totals per scope for a date range, summed in the database for the Variant wall (D-75).
-- Scopes are never combined: currency, result type, attribution, time zone and channel scope all stay apart (D-37).
-- Reach is a daily figure; its "results" are returned summed only so the reader can tell it apart and not use it.

create function reporting.variant_totals(p_from date default null, p_to date default null)
returns table (
  variant_id uuid, currency text, result_indicator text, attribution_setting text, time_zone text, channel_scope text,
  spend numeric, results numeric, days bigint, unreported bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.variant_id, r.currency, r.result_indicator, r.attribution_setting, r.time_zone, r.channel_scope,
    sum(r.spend), sum(r.results), count(distinct r.day), count(*) filter (where r.spend is null or r.results is null)
  from reporting.variant_daily_results r
  where (p_from is null or r.day >= p_from) and (p_to is null or r.day <= p_to)
  group by r.variant_id, r.currency, r.result_indicator, r.attribution_setting, r.time_zone, r.channel_scope;
$$;

revoke execute on function reporting.variant_totals(date, date) from public;
grant execute on function reporting.variant_totals(date, date) to authenticated;
