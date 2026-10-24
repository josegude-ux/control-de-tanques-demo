// Service worker DEMO staging — scope /demo/. No comparte caché con producción.
const CACHE='control-tanques-standalone-demo-v0101-assistente-a-1';
const FILES=[
 './','./index.html','./config.js','./manifest.webmanifest','./assistant-a.css?v=1','./assistant-a.js?v=1',
 './supabase-2.57.4.js','./sync-core.js?v=0.10.1','./cloud-sync.js?v=0.10.1','./app.js?v=0.10.1',
 './styles.css?v=0.10.1','./xlsx-local.js?v=0.10.1','./xlsx-import-local.js?v=0.10.1',
 './xlsx-transfer-local.js?v=0.10.1','./plan-import-local.js?v=0.10.1',
 './icon.svg','./mahou-logo.png','./logo-control-tanques.png',
 './Control_de_Tanques_icon_192.png','./Control_de_Tanques_icon_512.png','./version.json'
];
self.addEventListener('install',e=>{e.waitUntil((async()=>{
 const c=await caches.open(CACHE);
 await Promise.all(FILES.map(async file=>{
  const request=new Request(file,{cache:'reload'});
  const response=await fetch(request);
  if(!response.ok)throw new Error('No se pudo preparar '+file);
  await c.put(request,response);
 }));
 await self.skipWaiting();
})())});
self.addEventListener('message',e=>{if(e.data?.type==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('activate',e=>{
 e.waitUntil(caches.keys().then(keys=>Promise.all(
  keys.filter(k=>k.startsWith('control-tanques-standalone-demo-')&&k!==CACHE).map(k=>caches.delete(k))
 )).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;
 e.respondWith(fetch(e.request).then(r=>{
  if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}
  return r;
 }).catch(async()=>await caches.match(e.request)||(e.request.mode==='navigate'?await caches.match('./index.html'):Response.error())));
});
