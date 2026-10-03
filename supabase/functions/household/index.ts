
import {createClient} from 'npm:@supabase/supabase-js@2';
import {z} from 'npm:zod@3';
const categories=['Groceries','Dining out','Home','Utilities','Transport','Shopping','Health','Entertainment','Travel','Other'];
const settingsSchema=z.object({you:z.string().trim().min(1).max(30),partner:z.string().trim().min(1).max(30),defaultShare:z.number().int().min(0).max(100),budgets:z.record(z.number().int().min(0).max(1000000000))}).refine(s=>Object.keys(s.budgets).every(c=>categories.includes(c)));
const transactionSchema=z.object({id:z.string().min(1).max(200),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),merchant:z.string().trim().min(1).max(160),amount:z.number().int().min(-1000000000).max(1000000000).refine(n=>n!==0),payer:z.enum(['you','partner']),kind:z.enum(['expense','refund','income','transfer','settlement']),category:z.string().refine(c=>categories.includes(c)),share:z.number().int().min(0).max(100),note:z.string().max(1000),reviewed:z.union([z.literal(0),z.literal(1)]),updated:z.string().optional()});
const env=(key:string)=>Deno.env.get(key)||'';
const ready=()=>!!(env('PLAID_CLIENT_ID')&&env('PLAID_SECRET')&&env('TOKEN_ENCRYPTION_KEY'));
const plaidEnv=()=>env('PLAID_ENV')==='production'?'production':'sandbox';
const admin=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
const checked=async(query:any)=>{const {data,error}=await query;if(error)throw new Error(error.message);return data;};
const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
async function plaid(path:string,body:Record<string,unknown>){if(!ready())throw new Error('Bank syncing needs setup. Add transactions manually for now.');const response=await fetch('https://'+plaidEnv()+'.plaid.com'+path,{method:'POST',headers:{'Content-Type':'application/json','Plaid-Version':'2020-09-14'},body:JSON.stringify({client_id:env('PLAID_CLIENT_ID'),secret:env('PLAID_SECRET'),...body})});const data=await response.json();if(!response.ok)throw new Error(data.error_code==='ITEM_LOGIN_REQUIRED'?'Reconnect this bank to resume syncing.':data.error_code==='TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'?'Bank data changed during sync. Please sync again.':'The bank could not complete this request. Try again later.');return data;}
const to64=(a:Uint8Array)=>btoa(String.fromCharCode(...a));const from64=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function key(){const raw=from64(env('TOKEN_ENCRYPTION_KEY'));if(raw.length!==32)throw new Error('Bank encryption needs setup.');return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);}
async function encrypt(s:string){const iv=crypto.getRandomValues(new Uint8Array(12));return to64(iv)+'.'+to64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(),new TextEncoder().encode(s))));}
async function decrypt(s:string){const [iv,bytes]=s.split('.');return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(iv)},await key(),from64(bytes)));}
async function hash(s:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(b=>b.toString(16).padStart(2,'0')).join('');}
function invite(){return Array.from(crypto.getRandomValues(new Uint8Array(24))).map(b=>b.toString(16).padStart(2,'0')).join('');}
async function sync(household:string){const items=await checked(admin.from('bank_items').select('*').eq('household_id',household));let count=0;const errors:string[]=[];const h=await checked(admin.from('households').select('settings').eq('id',household).single());
 for(const item of items){const lockedUntil=new Date(Date.now()+180000).toISOString();const claimed=await checked(admin.from('bank_items').update({lock_until:lockedUntil}).eq('id',item.id).eq('household_id',household).or('lock_until.is.null,lock_until.lt.'+new Date().toISOString()).select('id'));if(!claimed.length)continue;
 try{const token=await decrypt(item.token);let cursor=item.cursor||undefined,hasMore=true,pages=0;const rows:any[]=[],removed:string[]=[];const accounts:Record<string,string>={};
 while(hasMore){if(++pages>60)throw new Error('Large bank history; please try syncing again.');const page=await plaid('/transactions/sync',{access_token:token,cursor,count:500});for(const account of page.accounts||[])accounts[account.account_id]=account.name+(account.mask?' · '+account.mask:'');
 for(const t of [...page.added,...page.modified]){if(t.iso_currency_code!=='USD')throw new Error('Only USD transactions are supported.');const amount=Math.round(t.amount*100);if(!amount)continue;rows.push({id:t.transaction_id,date:t.date,transacted_at:t.datetime||null,merchant:t.merchant_name||t.name||'Bank transaction',amount,payer:item.payer,kind:amount>0?'expense':'income',share:h.settings.defaultShare,pending:t.pending?1:0,account:accounts[t.account_id]||'Bank account'});}removed.push(...page.removed.map((r:any)=>r.transaction_id));cursor=page.next_cursor;hasMore=page.has_more;}
 // A single Postgres transaction applies all pages and advances the cursor together.
 await checked(admin.rpc('apply_bank_sync',{p_household:household,p_item:item.id,p_rows:rows,p_removed:removed,p_cursor:cursor||''}));count+=rows.length;
 }catch(e){const message=e instanceof Error?e.message:'Bank sync failed.';errors.push(item.institution+': '+message);await checked(admin.from('bank_items').update({error:message}).eq('id',item.id).eq('household_id',household));}
 finally{await checked(admin.from('bank_items').update({lock_until:null}).eq('id',item.id).eq('household_id',household).eq('lock_until',lockedUntil));}}
 return {count,errors};
}
async function handleRequest(request:Request){
 if(request.method!=='POST')return reply({error:'POST required'},405);
 try{
 const token=request.headers.get('Authorization')?.replace(/^Bearer /,'');if(!token)return reply({error:'Please sign in.'},401);
 const {data:auth,error:authError}=await admin.auth.getUser(token);if(authError||!auth.user)return reply({error:'Your sign-in expired. Please sign in again.'},401);
 const text=await request.text();if(text.length>30000)return reply({error:'Request too large'},413);const body=JSON.parse(text),action=body.action,user=auth.user;
 let member=await checked(admin.from('members').select('household_id,role').eq('user_id',user.id).maybeSingle());
 if(action==='household/create'){if(member)throw new Error('You already have a household.');const settings=settingsSchema.parse(body.settings);const code=invite();await checked(admin.rpc('create_household',{p_user:user.id,p_settings:settings,p_invite_hash:await hash(code)}));return reply({inviteCode:code});}
 if(action==='household/join'){if(member)throw new Error('You already have a household.');if(typeof body.code!=='string'||body.code.length!==48)throw new Error('Enter the full household invite code.');await checked(admin.rpc('join_household',{p_user:user.id,p_invite_hash:await hash(body.code.trim())}));return reply({ok:true});}
 if(!member){if(action==='state')return reply({needsHousehold:true});return reply({error:'Create or join a household first.'},403);}
 const hid=member.household_id;
 if(action==='state'){const [household,items,checkins,members]=await Promise.all([checked(admin.from('households').select('settings,review_anchor').eq('id',hid).single()),checked(admin.from('bank_items').select('id,payer,institution,synced,error').eq('household_id',hid)),checked(admin.from('checkins').select('day,at').eq('household_id',hid).order('day',{ascending:false}).limit(90)),checked(admin.from('members').select('role').eq('household_id',hid))]);
 // Page explicitly: PostgREST otherwise truncates a growing backlog at its row limit.
 const transactions:any[]=[];for(let from=0;;from+=1000){const page=await checked(admin.from('transactions').select('*').eq('household_id',hid).eq('removed',0).or('reviewed.eq.1,review_available_at.lte.'+new Date().toISOString()).order('date').order('id').range(from,from+999));transactions.push(...page);if(page.length<1000)break;}
 const cycle=Math.max(0,Math.floor((Date.now()-new Date(household.review_anchor).getTime())/86400000));const nextReviewAt=new Date(new Date(household.review_anchor).getTime()+(cycle+1)*86400000).toISOString();
 return reply({transactions,nextReviewAt,reviewCycle:cycle,settings:household.settings,items,checkins,memberRole:member.role,memberCount:members.length,bankReady:ready(),bankEnvironment:plaidEnv()});}
 if(action==='household/invite'){if(member.role!=='you')throw new Error('Only the household creator can generate an invite.');const code=invite();await checked(admin.from('households').update({invite_hash:await hash(code),invite_expires:new Date(Date.now()+86400000).toISOString()}).eq('id',hid));return reply({inviteCode:code});}
 if(action==='transactions'){const parsed=transactionSchema.parse(body);if(new Date(parsed.date+'T12:00:00Z').toISOString().slice(0,10)!==parsed.date)throw new Error('Enter a valid date.');if((parsed.kind==='expense'&&parsed.amount<0)||(['income','refund'].includes(parsed.kind)&&parsed.amount>0))throw new Error('Check whether this is money in or money out.');await checked(admin.rpc('save_transaction',{p_household:hid,p_data:parsed}));return reply({ok:true});}
 if(action==='settings'){const settings=settingsSchema.parse(body);await checked(admin.from('households').update({settings}).eq('id',hid));return reply({ok:true});}
 if(action==='checkin'){const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(body.day);await checked(admin.from('checkins').upsert({household_id:hid,day,at:new Date().toISOString()}));return reply({ok:true});}
 if(action==='bank/sync')return reply(await sync(hid));
 if(action==='bank/link'){const payer=z.enum(['you','partner']).parse(body.payer);if(payer!==member.role)throw new Error('Each person connects their own bank while signed in to their account.');let mode:any={products:['transactions']};if(body.itemId){const item=await checked(admin.from('bank_items').select('*').eq('id',body.itemId).eq('household_id',hid).eq('payer',member.role).single());mode={access_token:await decrypt(item.token)};}
 const link=await plaid('/link/token/create',{user:{client_user_id:user.id},client_name:'Together',language:'en',country_codes:['US'],hosted_link:{url_lifetime_seconds:1800},...mode});const session=await checked(admin.from('bank_sessions').insert({household_id:hid,user_id:user.id,payer,link_token:await encrypt(link.link_token),item_id:body.itemId||null,expires:new Date(Date.now()+1800000).toISOString()}).select('id').single());return reply({url:link.hosted_link_url,sessionId:session.id});}
 if(action==='bank/poll'){const session=await checked(admin.from('bank_sessions').select('*').eq('id',body.sessionId).eq('household_id',hid).eq('user_id',user.id).single());if(session.completed)return reply({complete:true});if(new Date(session.expires).getTime()<Date.now())throw new Error('Bank connection expired. Start again.');const lockUntil=new Date(Date.now()+120000).toISOString();const lock=await checked(admin.from('bank_sessions').update({lock_until:lockUntil}).eq('id',session.id).or('lock_until.is.null,lock_until.lt.'+new Date().toISOString()).select('id'));if(!lock.length)return reply({complete:false});
 try{const result=await plaid('/link/token/get',{link_token:await decrypt(session.link_token)});const sessions=result.link_sessions||[];const results=sessions.flatMap((s:any)=>s.results?.item_add_results||[]);const tokens=results.map((r:any)=>r.public_token).filter(Boolean);
 if(session.item_id){if(!sessions.some((s:any)=>s.finished_at&&(!s.on_exit?.error)))return reply({complete:false});}
 else{if(!tokens.length)return reply({complete:false});for(const public_token of tokens){const exchange=await plaid('/item/public_token/exchange',{public_token});const accounts=await plaid('/accounts/get',{access_token:exchange.access_token});if(accounts.accounts.some((a:any)=>a.balances?.iso_currency_code!=='USD')){await plaid('/item/remove',{access_token:exchange.access_token});throw new Error('Connect USD accounts only.');}
 let institution='Connected bank';if(accounts.item?.institution_id){const i=await plaid('/institutions/get_by_id',{institution_id:accounts.item.institution_id,country_codes:['US']});institution=i.institution.name;}
 const existing=await checked(admin.from('bank_items').select('household_id').eq('id',exchange.item_id).maybeSingle());if(existing&&existing.household_id!==hid)throw new Error('This connection belongs to another household.');
 await checked(admin.from('bank_items').upsert({id:exchange.item_id,household_id:hid,payer:session.payer,institution,token:await encrypt(exchange.access_token),error:null}));}}
 await checked(admin.from('bank_sessions').update({completed:true,link_token:''}).eq('id',session.id));return reply({complete:true,...await sync(hid)});
 }finally{await checked(admin.from('bank_sessions').update({lock_until:null}).eq('id',session.id).eq('lock_until',lockUntil));}}
 if(action==='bank/disconnect'){const item=await checked(admin.from('bank_items').select('*').eq('id',body.itemId).eq('household_id',hid).eq('payer',member.role).single());await plaid('/item/remove',{access_token:await decrypt(item.token)});await checked(admin.from('bank_items').delete().eq('id',item.id).eq('household_id',hid));return reply({ok:true});}
 return reply({error:'Unknown action'},400);
 }catch(error){return reply({error:error instanceof z.ZodError?'Check the information and try again.':error instanceof Error?error.message:'The request could not complete.'},400);}
}
const allowedOrigins=new Set(['https://alextheweick-creator.github.io','http://127.0.0.1:5180','http://localhost:5180']);
Deno.serve(async request=>{
 const origin=request.headers.get('Origin');
 if(origin&&!allowedOrigins.has(origin))return reply({error:'Origin not allowed'},403);
 const response=request.method==='OPTIONS'?new Response(null,{status:204}):await handleRequest(request);
 if(origin)response.headers.set('Access-Control-Allow-Origin',origin);
 response.headers.set('Vary','Origin');
 response.headers.set('Access-Control-Allow-Methods','POST, OPTIONS');
 response.headers.set('Access-Control-Allow-Headers','authorization, apikey, content-type, x-client-info');
 return response;
});
