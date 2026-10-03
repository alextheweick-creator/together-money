
-- All financial data is accessible only through the authenticated household Edge Function.
create table public.households(id uuid primary key default gen_random_uuid(), settings jsonb not null, invite_hash text unique, invite_expires timestamptz, created_at timestamptz not null default now());
create table public.members(user_id uuid primary key, household_id uuid not null references public.households(id) on delete cascade, role text not null check(role in ('you','partner')), unique(household_id,role));
create table public.transactions(id text not null, household_id uuid not null references public.households(id) on delete cascade, date date not null, merchant text not null, amount bigint not null check(amount<>0), payer text not null check(payer in ('you','partner')), kind text not null check(kind in ('expense','income','refund','transfer','settlement')), category text not null, share integer not null check(share between 0 and 100), note text not null default '', reviewed integer not null default 0 check(reviewed in (0,1)), pending integer not null default 0 check(pending in (0,1)), removed integer not null default 0 check(removed in (0,1)), source text not null, account text not null, item_id text, updated timestamptz not null default now(), primary key(household_id,id));
create index transactions_inbox on public.transactions(household_id,removed,reviewed,date);
create table public.bank_items(id text primary key, household_id uuid not null references public.households(id) on delete cascade, token text not null, payer text not null check(payer in ('you','partner')), institution text not null, cursor text, synced timestamptz, error text, lock_until timestamptz);
create index bank_items_household on public.bank_items(household_id);
create table public.bank_sessions(id uuid primary key default gen_random_uuid(), household_id uuid not null references public.households(id) on delete cascade, user_id uuid not null, payer text not null, link_token text not null, item_id text, expires timestamptz not null, completed boolean not null default false, lock_until timestamptz);
create table public.checkins(household_id uuid not null references public.households(id) on delete cascade,day date not null,at timestamptz not null default now(),primary key(household_id,day));
alter table public.households enable row level security;
alter table public.members enable row level security;
alter table public.transactions enable row level security;
alter table public.bank_items enable row level security;
alter table public.bank_sessions enable row level security;
alter table public.checkins enable row level security;
revoke all on public.households,public.members,public.transactions,public.bank_items,public.bank_sessions,public.checkins from anon,authenticated;
grant all on public.households,public.members,public.transactions,public.bank_items,public.bank_sessions,public.checkins to service_role;

create function public.create_household(p_user uuid,p_settings jsonb,p_invite_hash text) returns uuid language plpgsql security definer set search_path=public as $$
declare h uuid;
begin
 if exists(select 1 from members where user_id=p_user) then raise exception 'You already belong to a household'; end if;
 insert into households(settings,invite_hash,invite_expires) values(p_settings,p_invite_hash,now()+interval '24 hours') returning id into h;
 insert into members(user_id,household_id,role) values(p_user,h,'you');
 return h;
end $$;
create function public.join_household(p_user uuid,p_invite_hash text) returns uuid language plpgsql security definer set search_path=public as $$
declare h uuid;
begin
 select id into h from households where invite_hash=p_invite_hash and invite_expires>now() for update;
 if h is null then raise exception 'Invite code is invalid or expired'; end if;
 if exists(select 1 from members where user_id=p_user) then raise exception 'You already belong to a household'; end if;
 if (select count(*) from members where household_id=h)>=2 then raise exception 'This household already has two members'; end if;
 insert into members(user_id,household_id,role) values(p_user,h,'partner');
 update households set invite_hash=null,invite_expires=null where id=h;
 return h;
end $$;
create function public.save_transaction(p_household uuid,p_data jsonb) returns void language plpgsql security definer set search_path=public as $$
declare old transactions; v_updated timestamptz;
begin
 select * into old from transactions where household_id=p_household and id=p_data->>'id' for update;
 if found then
  if old.pending=1 or old.removed=1 then raise exception 'This transaction is pending or was removed'; end if;
  if old.updated is distinct from (p_data->>'updated')::timestamptz then raise exception 'This transaction changed on another device. Refresh before saving'; end if;
  if old.source<>'manual' and (old.amount<>(p_data->>'amount')::bigint or old.date<>(p_data->>'date')::date or old.payer<>p_data->>'payer') then raise exception 'Imported amounts, dates, and owners cannot be changed'; end if;
  update transactions set date=(p_data->>'date')::date,merchant=p_data->>'merchant',amount=(p_data->>'amount')::bigint,payer=p_data->>'payer',kind=p_data->>'kind',category=p_data->>'category',share=(p_data->>'share')::integer,note=p_data->>'note',reviewed=(p_data->>'reviewed')::integer,updated=clock_timestamp() where household_id=p_household and id=old.id;
 else
  if p_data->>'id' not like 'manual-%' then raise exception 'Invalid transaction ID'; end if;
  insert into transactions(id,household_id,date,merchant,amount,payer,kind,category,share,note,reviewed,pending,removed,source,account) values(p_data->>'id',p_household,(p_data->>'date')::date,p_data->>'merchant',(p_data->>'amount')::bigint,p_data->>'payer',p_data->>'kind',p_data->>'category',(p_data->>'share')::integer,p_data->>'note',0,0,0,'manual','Manual entry');
 end if;
end $$;
create function public.apply_bank_sync(p_household uuid,p_item text,p_rows jsonb,p_removed jsonb,p_cursor text) returns void language plpgsql security definer set search_path=public as $$
declare r jsonb;
begin
 if not exists(select 1 from bank_items where id=p_item and household_id=p_household) then raise exception 'Bank connection not found'; end if;
 for r in select * from jsonb_array_elements(p_rows) loop
 insert into transactions(id,household_id,date,merchant,amount,payer,kind,category,share,note,reviewed,pending,removed,source,account,item_id)
 values(r->>'id',p_household,(r->>'date')::date,r->>'merchant',(r->>'amount')::bigint,r->>'payer',r->>'kind','Other',(r->>'share')::integer,'',0,(r->>'pending')::integer,0,'plaid',r->>'account',p_item)
 on conflict(household_id,id) do update set date=excluded.date,merchant=excluded.merchant,amount=excluded.amount,pending=excluded.pending,removed=0,account=excluded.account,reviewed=case when transactions.amount<>excluded.amount or transactions.date<>excluded.date or transactions.pending<>excluded.pending then 0 else transactions.reviewed end,kind=case when (transactions.amount<0)<>(excluded.amount<0) then excluded.kind else transactions.kind end,updated=clock_timestamp();
 end loop;
 update transactions set removed=1,updated=clock_timestamp() where household_id=p_household and item_id=p_item and id in(select jsonb_array_elements_text(p_removed));
 update bank_items set cursor=p_cursor,synced=now(),error=null where id=p_item and household_id=p_household;
end $$;
revoke all on function public.create_household(uuid,jsonb,text),public.join_household(uuid,text),public.save_transaction(uuid,jsonb),public.apply_bank_sync(uuid,text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.create_household(uuid,jsonb,text),public.join_household(uuid,text),public.save_transaction(uuid,jsonb),public.apply_bank_sync(uuid,text,jsonb,jsonb,text) to service_role;

