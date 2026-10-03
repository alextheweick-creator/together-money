-- Freeze each connection's initial cutoff. Never use a moving 48-hour filter:
-- once admitted, unreviewed work must remain through missed days.
alter table public.households add column review_anchor timestamptz not null default now();
alter table public.bank_items add column review_started_at timestamptz;
alter table public.transactions add column transacted_at timestamptz;
alter table public.transactions add column review_available_at timestamptz default now();

create function public.review_release_at(p_date date,p_time timestamptz,p_start timestamptz,p_anchor timestamptz,p_seen timestamptz)
returns timestamptz language sql immutable set search_path=public as $$
 select case
  when p_time is not null and p_time < p_start - interval '48 hours' then null
  -- Plaid often gives dates without times. Include the boundary calendar date
  -- rather than inventing a transaction time and dropping recent purchases.
  when p_time is null and p_date < ((p_start - interval '48 hours') at time zone 'America/New_York')::date then null
  when p_seen <= p_start then p_start
  else p_anchor + greatest(1,ceil(extract(epoch from (p_seen-p_anchor))/86400)) * interval '24 hours'
 end
$$;
revoke all on function public.review_release_at(date,timestamptz,timestamptz,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.review_release_at(date,timestamptz,timestamptz,timestamptz,timestamptz) to service_role;

-- One-time correction of the original historical import. Keep reviews and
-- manual entries intact; excluded bank history remains stored, unreviewed.
update public.bank_items set review_started_at=now();
update public.transactions t set review_available_at=public.review_release_at(t.date,t.transacted_at,b.review_started_at,h.review_anchor,now()),updated=clock_timestamp()
from public.bank_items b,public.households h
where t.source='plaid' and t.reviewed=0 and t.item_id=b.id and t.household_id=b.household_id and h.id=t.household_id;

create or replace function public.apply_bank_sync(p_household uuid,p_item text,p_rows jsonb,p_removed jsonb,p_cursor text) returns void language plpgsql security definer set search_path=public as $$
declare r jsonb; v_start timestamptz; v_anchor timestamptz; v_synced timestamptz; v_boundary timestamptz; v_seen timestamptz;
begin
 select review_started_at,synced into v_start,v_synced from bank_items where id=p_item and household_id=p_household for update;
 if not found then raise exception 'Bank connection not found'; end if;
 select review_anchor into v_anchor from households where id=p_household;
 v_boundary:=v_anchor+greatest(0,floor(extract(epoch from (now()-v_anchor))/86400))*interval '24 hours';
 -- If the app was closed, populate the batch that already came due immediately.
 -- Additional syncs inside that same period stage arrivals for the next batch.
 v_seen:=case when v_start is not null and v_synced<v_boundary and v_boundary>v_start then v_boundary else now() end;
 if v_start is null and jsonb_array_length(p_rows)>0 then
  v_start:=now();
  update bank_items set review_started_at=v_start where id=p_item and household_id=p_household;
 end if;
 for r in select * from jsonb_array_elements(p_rows) loop
  insert into transactions(id,household_id,date,merchant,amount,payer,kind,category,share,note,reviewed,pending,removed,source,account,item_id,transacted_at,review_available_at)
  values(r->>'id',p_household,(r->>'date')::date,r->>'merchant',(r->>'amount')::bigint,r->>'payer',r->>'kind','Other',(r->>'share')::integer,'',0,(r->>'pending')::integer,0,'plaid',r->>'account',p_item,(r->>'transacted_at')::timestamptz,
   review_release_at((r->>'date')::date,(r->>'transacted_at')::timestamptz,v_start,v_anchor,v_seen))
  on conflict(household_id,id) do update set
   date=excluded.date,merchant=excluded.merchant,amount=excluded.amount,pending=excluded.pending,removed=0,account=excluded.account,transacted_at=excluded.transacted_at,
   review_available_at=case
    when transactions.reviewed=1 then coalesce(transactions.review_available_at,now())
    when transactions.pending=1 and excluded.pending=0 then coalesce(excluded.review_available_at,transactions.review_available_at)
    else coalesce(transactions.review_available_at,excluded.review_available_at) end,
   reviewed=case when transactions.amount<>excluded.amount or transactions.date<>excluded.date or transactions.pending<>excluded.pending then 0 else transactions.reviewed end,
   kind=case when (transactions.amount<0)<>(excluded.amount<0) then excluded.kind else transactions.kind end,updated=clock_timestamp();
 end loop;
 update transactions set removed=1,updated=clock_timestamp() where household_id=p_household and item_id=p_item and id in(select jsonb_array_elements_text(p_removed));
 update bank_items set cursor=p_cursor,synced=now(),error=null where id=p_item and household_id=p_household;
end $$;
create index transactions_review_release on public.transactions(household_id,review_available_at) where removed=0 and reviewed=0;
