import {createClient} from '@supabase/supabase-js';
import './bridge';

// This adapter shares the app UI with the optional desktop wrapper. Bank secrets
// and bank tokens remain exclusively in the authenticated household service.
export async function setupBrowser() {
 if(window.together)return;
 const response=await fetch('./service.json',{cache:'no-store'});
 if(!response.ok)throw new Error('Together could not load its connection settings. Please try again.');
 const config=await response.json();
 const client=createClient(config.supabaseUrl,config.supabaseKey);
 let update:any={status:'idle'},registration:ServiceWorkerRegistration|undefined,installPrompt:any;
 const listeners=new Set<(value:any)=>void>();
 const publish=(value:any)=>{update=value;listeners.forEach(fn=>fn(value));};
 window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;window.dispatchEvent(new Event('together-installable'));});
 let reminder=localStorage.getItem('together-reminder')||'20:00';
 let remindersEnabled=localStorage.getItem('together-reminders-enabled')==='true';
 async function backend(action:string,args:any={}) {
  const {data,error}=await client.auth.getSession();if(error)throw error;
  if(!data.session)throw new Error('Please sign in.');
  const result=await fetch(config.supabaseUrl+'/functions/v1/household',{method:'POST',headers:{apikey:config.supabaseKey,Authorization:'Bearer '+data.session.access_token,'Content-Type':'application/json'},body:JSON.stringify({...args,action}),cache:'no-store'});
  const value=await result.json();if(!result.ok)throw new Error(value.error||'Unable to reach your household.');return value;
 }
 async function invoke(action:string,args:any={}) {
  if(action==='bootstrap'){const {data,error}=await client.auth.getSession();if(error)throw error;return {configured:true,email:data.session?.user.email,version:config.version,update,reminder,remindersEnabled,browser:true};}
  if(action==='signin'){const {data,error}=await client.auth.signInWithPassword(args);if(error)throw error;return {email:data.user.email};}
  if(action==='signup'){const {data,error}=await client.auth.signUp({...args,options:{emailRedirectTo:new URL('./',location.href).href}});if(error)throw error;return {signedIn:!!data.session,message:'Check your email to confirm your account, then sign in here.'};}
  if(action==='signout'){const {error}=await client.auth.signOut();if(error)throw error;return {ok:true};}
  if(action==='install'){if(!installPrompt)throw new Error('Use your browser’s Install app option. In Chrome, look for the install icon beside the address bar.');await installPrompt.prompt();installPrompt=null;return {ok:true};}
  if(action==='reminder'){
   if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(args.time))throw new Error('Choose a valid time.');
   if(args.enabled){if(!('Notification' in window))throw new Error('This browser does not support notifications.');if(await Notification.requestPermission()!=='granted')throw new Error('Allow notifications in your browser settings to enable reminders.');}
   reminder=args.time;remindersEnabled=!!args.enabled;localStorage.setItem('together-reminder',reminder);localStorage.setItem('together-reminders-enabled',String(remindersEnabled));return {ok:true};
  }
  if(action==='updates/check'){if(!registration)throw new Error('Update checking is starting. Please try again shortly.');await registration.update();if(registration.waiting)publish({status:'downloaded'});else if(!registration.installing)publish({status:'current'});return update;}
  if(action==='updates/install'){if(!registration?.waiting)throw new Error('No update is ready yet.');registration.waiting.postMessage({type:'APPLY_UPDATE'});return {ok:true};}
  if(action==='bank/open'){
   const popup=window.open('about:blank','_blank');if(!popup)throw new Error('Allow pop-ups for Together, then try connecting again.');popup.opener=null;
   try{const result=await backend('bank/link',args);const url=new URL(result.url);if(url.protocol!=='https:'||url.hostname!=='secure.plaid.com')throw new Error('Unexpected bank connection address.');popup.location.href=url.href;return {sessionId:result.sessionId};}catch(error){popup.close();throw error;}
  }
  return backend(action,args);
 }
 window.together={invoke:async(action,args)=>{try{return {ok:true,data:await invoke(action,args)};}catch(error){return {ok:false,error:error instanceof Error?error.message:'Unable to complete this request.'};}},onUpdate:fn=>{listeners.add(fn);return()=>{listeners.delete(fn);};}};
 if('serviceWorker' in navigator){
  let refreshing=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(!refreshing){refreshing=true;location.reload();}});
  void navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(reg=>{
   registration=reg;
   const waiting=()=>{if(reg.waiting&&navigator.serviceWorker.controller)publish({status:'downloaded'});};waiting();
   reg.addEventListener('updatefound',()=>{reg.installing?.addEventListener('statechange',waiting);});
   const check=()=>{if(document.visibilityState==='visible')void reg.update().catch(()=>{});};
   document.addEventListener('visibilitychange',check);setInterval(check,3600000);
  }).catch(()=>publish({status:'error',message:'Updates could not be enabled. Check your connection and reopen Together.'}));
 }
 setInterval(()=>{
  if(!remindersEnabled||!('Notification' in window)||Notification.permission!=='granted')return;
  const now=new Date(),day=now.toLocaleDateString('en-CA'),time=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
  if(time!==reminder||localStorage.getItem('together-reminded')===day)return;
  localStorage.setItem('together-reminded',day);
  const options={body:'Take a few minutes together to review your transactions. Your backlog is waiting.',icon:'./icon-192.png',tag:'daily-check-in'};
  if(registration)void registration.showNotification('Your Together check-in',options);else new Notification('Your Together check-in',options);
 },30000);
}
