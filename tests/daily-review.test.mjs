import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {reviewQueue} from '../src/money.ts';
const db=new PGlite();
await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
await db.exec(await fs.readFile(new URL('../supabase/migrations/202610030001_household.sql',import.meta.url),'utf8'));
const hid='44444444-4444-4444-8444-444444444444';
await db.query('INSERT INTO households(id,settings) VALUES($1,$2)',[hid,{}]);
await db.query("INSERT INTO bank_items(id,household_id,token,payer,institution) VALUES('bank',$1,'test','you','Test bank')",[hid]);
const bankRow=(id,date,extra={})=>({id,date,amount:1000,payer:'you',kind:'expense',share:50,merchant:'Test',pending:0,account:'Test',...extra});
const today=(await db.query("SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS day")).rows[0].day;
await db.query('SELECT apply_bank_sync($1,$2,$3,$4,$5)',[hid,'bank',[bankRow('old','2025-01-01'),bankRow('old-reviewed','2025-01-02'),bankRow('recent',today)],[],'before']);
await db.query("UPDATE transactions SET reviewed=1 WHERE id='old-reviewed'");
await db.query('SELECT save_transaction($1,$2)',[hid,{...bankRow('manual-old','2025-01-01'),category:'Other',note:'',reviewed:0}]);
await db.exec(await fs.readFile(new URL('../supabase/migrations/202610030002_daily_review.sql',import.meta.url),'utf8'));
const release=async(date,time,seen,start='2026-10-03T16:00:00Z',anchor=start)=>(await db.query('SELECT review_release_at($1,$2,$3,$4,$5) AS at',[date,time,start,anchor,seen])).rows[0].at;
test('Upgrade removes only older unreviewed bank history from the initial queue',async()=>{
 const rows=(await db.query('SELECT id,reviewed,review_available_at FROM transactions ORDER BY id')).rows;
 const byId=Object.fromEntries(rows.map(r=>[r.id,r]));
 assert.equal(rows.length,4);assert.equal(byId.old.review_available_at,null);assert.equal(byId.old.reviewed,0);
 assert.ok(byId.recent.review_available_at);assert.ok(byId['manual-old'].review_available_at);assert.equal(byId['old-reviewed'].reviewed,1);
});
test('Initial cutoff includes exactly 48 hours with timestamps, and the boundary calendar date without times',async()=>{
 assert.equal(await release('2026-10-01','2026-10-01T15:59:59Z','2026-10-03T16:00:00Z'),null);
 assert.ok(await release('2026-10-01','2026-10-01T16:00:00Z','2026-10-03T16:00:00Z'));
 assert.ok(await release('2026-10-01',null,'2026-10-03T16:00:00Z'));
 assert.equal(await release('2026-09-30',null,'2026-10-03T16:00:00Z'),null);
});
test('New arrivals release on 24-hour boundaries, including multiple missed days',async()=>{
 assert.equal(new Date(await release('2026-10-03',null,'2026-10-03T17:00:00Z')).toISOString(),'2026-10-04T16:00:00.000Z');
 assert.equal(new Date(await release('2026-10-04',null,'2026-10-04T16:00:00Z')).toISOString(),'2026-10-04T16:00:00.000Z');
 assert.equal(new Date(await release('2026-10-06',null,'2026-10-06T17:00:00Z')).toISOString(),'2026-10-07T16:00:00.000Z');
});
test('Repeated bank sync keeps excluded history excluded and never ages released backlog out',async()=>{
 const before=(await db.query("SELECT review_available_at FROM transactions WHERE id='recent'")).rows[0].review_available_at;
 await db.query('SELECT apply_bank_sync($1,$2,$3,$4,$5)',[hid,'bank',[bankRow('old','2025-01-01'),bankRow('recent',today)],[],'after']);
 assert.equal((await db.query("SELECT review_available_at FROM transactions WHERE id='old'")).rows[0].review_available_at,null);
 assert.equal(new Date((await db.query("SELECT review_available_at FROM transactions WHERE id='recent'")).rows[0].review_available_at).getTime(),new Date(before).getTime());
 const visible=(await db.query("SELECT id FROM transactions WHERE reviewed=0 AND review_available_at <= now()+interval '30 days'")).rows.map(r=>r.id);
 assert.ok(visible.includes('recent'));assert.ok(visible.includes('manual-old'));assert.ok(!visible.includes('old'));
});
test('A partner bank connected later gets its own fresh 48-hour cutoff',async()=>{
 await db.query("INSERT INTO bank_items(id,household_id,token,payer,institution) VALUES('partner-bank',$1,'test','partner','Test')",[hid]);
 await db.query('SELECT apply_bank_sync($1,$2,$3,$4,$5)',[hid,'partner-bank',[bankRow('partner-old','2025-01-01',{payer:'partner'}),bankRow('partner-recent',today,{payer:'partner'})],[],'partner-cursor']);
 const rows=(await db.query("SELECT id,review_available_at FROM transactions WHERE item_id='partner-bank'")).rows;
 assert.equal(rows.find(r=>r.id==='partner-old').review_available_at,null);assert.ok(rows.find(r=>r.id==='partner-recent').review_available_at);
});
test('Review inbox is newest first and excludes reviewed, pending and removed entries',()=>{
 const rows=[{id:'old',date:'2026-10-01'},{id:'new',date:'2026-10-03'},{id:'pending',date:'2026-10-04',pending:1},{id:'done',date:'2026-10-05',reviewed:1},{id:'removed',date:'2026-10-06',removed:1}];
 assert.deepEqual(reviewQueue(rows).map(t=>t.id),['new','old']);
});
test('Reopening after missed days fills the due batch; extra same-day syncs wait for the next batch',async()=>{
 await db.query("UPDATE households SET review_anchor=now()-interval '3 days 1 hour' WHERE id=$1",[hid]);
 await db.query("UPDATE bank_items SET review_started_at=now()-interval '3 days 1 hour',synced=now()-interval '2 days' WHERE id='bank'");
 await db.query('SELECT apply_bank_sync($1,$2,$3,$4,$5)',[hid,'bank',[bankRow('missed-days',today)],[],'catch-up']);
 assert.equal((await db.query("SELECT review_available_at<=now() AS due FROM transactions WHERE id='missed-days'")).rows[0].due,true);
 await db.query('SELECT apply_bank_sync($1,$2,$3,$4,$5)',[hid,'bank',[bankRow('extra-sync',today)],[],'extra']);
 assert.equal((await db.query("SELECT review_available_at>now() AS waiting FROM transactions WHERE id='extra-sync'")).rows[0].waiting,true);
});
test.after(async()=>await db.close());
