-- The remaining curated reporting views (T-08; PRD §8 success measures). Like the others they run as the caller, so
-- members read them under row-level security, and they expose curated columns only.

-- Pipeline: every active Variant with its next action and who owns it (PRD §8 "Current next action"). A Variant in
-- production or with changes requested waits on its Creative Owner. One awaiting review waits on whoever a submitted
-- Version notifies (D-56): the Brief's Marketing Owner, plus the Approvers if that owner is not one, or the Approvers
-- alone when its Creative has no Brief. One approved or live waits on the Marketing Owner, or the Creative Owner
-- without a Brief. next_owner_role names which, and next_owner_id the person when there is one. A 复盘 follow-up
-- Variant is due on its action's due date, any other on its Creative's; overdue means past that date in the team's
-- time zone (D-78) and not yet launched. Last activity counts the Variant's own events and those of its Reviews,
-- comments and Launches.
create view reporting.pipeline with (security_invoker = true) as
select va.id as variant_id, va.code as variant_code, va.state, va.production_stage,
  c.id as creative_id, c.code as creative_code, c.title as creative_title, c.is_legacy, c.due_date,
  coalesce(pa.due_date, c.due_date) as variant_due_date,
  b.id as brief_id, b.title as brief_title,
  c.creative_owner_id, co.display_name as creative_owner,
  b.marketing_owner_id, mo.display_name as marketing_owner,
  case va.state
    when 'in_production' then 'Submit the next Version'
    when 'changes_requested' then 'Make the changes and submit the next Version'
    when 'awaiting_review' then 'Review the Version'
    when 'approved' then 'Plan and launch it'
    when 'live' then 'Watch its results; start a 复盘 when ready' end as next_action,
  case when va.state in ('in_production', 'changes_requested') then 'creative_owner'
    when va.state = 'awaiting_review' and b.id is null then 'approvers'
    when va.state = 'awaiting_review' and not mo.is_approver then 'marketing_owner_and_approvers'
    when b.id is not null then 'marketing_owner'
    else 'creative_owner' end as next_owner_role,
  case when va.state in ('in_production', 'changes_requested') then c.creative_owner_id
    when b.id is not null then b.marketing_owner_id
    when va.state = 'awaiting_review' then null
    else c.creative_owner_id end as next_owner_id,
  va.state in ('in_production', 'changes_requested', 'awaiting_review', 'approved')
    and coalesce(pa.due_date, c.due_date) < (now() at time zone (select time_zone from core.settings))::date as overdue,
  -- One lookup per kind of record, so each uses the activity log's entity index.
  greatest(
    (select max(l.occurred_at) from audit.activity_log l where l.entity_id = va.id),
    (select max(l.occurred_at) from review.reviews r join audit.activity_log l on l.entity_id = r.id where r.variant_id = va.id),
    (select max(l.occurred_at) from creative.versions v join review.comments cm on cm.version_id = v.id
       join audit.activity_log l on l.entity_id = cm.id where v.variant_id = va.id),
    (select max(l.occurred_at) from launch.launches la join audit.activity_log l on l.entity_id = la.id where la.variant_id = va.id)) as last_activity_at
from creative.variants va
join creative.creatives c on c.id = va.creative_id
left join brief.brief_versions bv on bv.id = c.brief_version_id
left join brief.briefs b on b.id = bv.brief_id
left join core.members co on co.id = c.creative_owner_id
left join core.members mo on mo.id = b.marketing_owner_id
left join learning.plan_actions pa on pa.variant_id = va.id
where va.state not in ('retired', 'cancelled') and c.archived_at is null;

-- Review rounds: one row per round, with how long the decision took and the comments it drew (PRD §8 "Review rounds"
-- and "Review turnaround"). Rounds per approved Variant, and the median turnaround, are read from these rows.
create view reporting.review_rounds with (security_invoker = true) as
select r.id as review_id, r.variant_id, va.code as variant_code, v.id as version_id, v.version_number, r.round_number,
  r.opened_at, r.decision, r.decided_by, r.decided_at,
  round((extract(epoch from (r.decided_at - r.opened_at)) / 3600)::numeric, 1) as hours_to_decision,
  (select count(*) from review.comments cm where cm.review_id = r.id and cm.parent_id is null) as comments,
  (select count(*) from review.comments cm where cm.review_id = r.id and cm.parent_id is null and cm.kind = 'blocking') as blocking_comments,
  r.approval_ended_at, r.approval_end_reason
from review.reviews r
join creative.versions v on v.id = r.version_id
join creative.variants va on va.id = r.variant_id;

-- 复盘 backlog: every plan with where it stands, its Findings and actions, and whether its check date has passed with
-- or without a Verdict. PRD §8 "Learning closure" = plans past their check date with a Verdict ÷ all past it, counting
-- only closure_eligible plans: a cancelled plan is left out (proposed).
create view reporting.optimization_backlog with (security_invoker = true) as
select p.id as plan_id, p.state, p.priority, p.owner_id, m.display_name as owner,
  p.baseline_variant_id, va.code as variant_code, p.baseline_version_id, p.hypothesis, p.evidence_class,
  p.check_date, p.minimum_spend, p.minimum_spend_currency, p.verdict, p.verdict_by_system, p.verdict_at,
  p.created_at, p.accepted_at, p.completed_at, p.cancelled_at,
  (select count(*) from learning.retrospective_findings f where f.plan_id = p.id
     and not exists (select 1 from learning.retrospective_findings g where g.supersedes_id = f.id)) as findings,
  (select count(*) from learning.plan_actions a where a.plan_id = p.id) as actions,
  p.state not in ('completed', 'cancelled') as open,
  p.check_date is not null and p.check_date < (now() at time zone (select time_zone from core.settings))::date as past_check_date,
  p.verdict is not null as has_verdict,
  p.check_date is not null and p.check_date < (now() at time zone (select time_zone from core.settings))::date
    and p.state <> 'cancelled' as closure_eligible
from learning.optimization_plans p
join core.members m on m.id = p.owner_id
join creative.variants va on va.id = p.baseline_variant_id;

grant select on reporting.pipeline, reporting.review_rounds, reporting.optimization_backlog to authenticated;
