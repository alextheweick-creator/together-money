import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const pkg=JSON.parse(await readFile('package.json','utf8'));
let config;
if(process.env.SUPABASE_URL&&process.env.SUPABASE_PUBLISHABLE_KEY)config={supabaseUrl:process.env.SUPABASE_URL,supabaseKey:process.env.SUPABASE_PUBLISHABLE_KEY};
else {const local=JSON.parse(await readFile('desktop/service.json','utf8'));config={supabaseUrl:local.supabaseUrl,supabaseKey:local.supabaseKey};}
if(!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(config.supabaseUrl)||!config.supabaseKey.startsWith('sb_publishable_'))throw new Error('A public Supabase configuration is required. Never use a secret key.');
await writeFile('dist/service.json',JSON.stringify({...config,version:pkg.version}));
const assets=(await readdir('dist/assets')).map(name=>'./assets/'+name);
const files=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png',...assets];
const digest=createHash('sha256');
for(const file of files.filter(x=>x!=='./'))digest.update(await readFile('dist/'+file.slice(2)));
const cache='together-shell-'+digest.digest('hex').slice(0,16);
// Only cache the app shell. Auth, configuration and all financial requests stay
// on the network; new releases wait for the user's explicit Apply update action.
await writeFile('dist/sw.js',`
const CACHE=${JSON.stringify(cache)}, FILES=${JSON.stringify(files)};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('together-shell-')&&key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener('message',event=>{if(event.data?.type==='APPLY_UPDATE')self.skipWaiting();});
self.addEventListener('fetch',event=>{
 if(event.request.method!=='GET')return;
 const url=new URL(event.request.url),base=new URL(self.registration.scope);
 if(url.origin!==base.origin||url.search||!FILES.some(file=>new URL(file,base).href===url.href))return;
 event.respondWith(caches.open(CACHE).then(async cache=>(await cache.match(event.request))||fetch(event.request)));
});
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil(clients.matchAll({type:'window'}).then(windows=>{const existing=windows.find(win=>win.url.startsWith(self.registration.scope));return existing?existing.focus():clients.openWindow(self.registration.scope);}));});
`);
