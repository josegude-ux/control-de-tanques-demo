import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

/**
 * Construye una DEMO separada SIN acceso a producción ni datos reales.
 * Origen: repositorio público de Control de Tanques, commit fijado en CI.
 * Salida: _site/ (GitHub Pages del repositorio DEMO).
 */
const root=resolve('_source');
const output=resolve('_site');
mkdirSync(output,{recursive:true});
const read=p=>readFileSync(join(root,p),'utf8');
const put=(p,data)=>{const target=join(output,p);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,data);};
const copy=(src,dst=src)=>{const target=join(output,dst);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(root,src),target);};
const must=(v,msg)=>{if(!v)throw new Error('PUBLICACION DEMO BLOQUEADA: '+msg);};
const staging='iuqmzpahyjganhppcsur';
const stagingUrl='https://'+staging+'.supabase.co';

// Configuración con clave PUBLICABLE: la obtendremos del repositorio fuente,
// nunca de credenciales privadas ni de Supabase de producción.
let config=read('demo/config.js');
must(config.includes("env:'staging'"),'no hay configuración staging');
must(config.includes(stagingUrl),'el proyecto no es el staging autorizado');
must(/supabaseAnonKey:'sb_publishable_[A-Za-z0-9_-]+'/.test(config),'falta clave publicable');
must(!config.includes('YOUR_STAGING'),'faltan ajustes de staging');
config=config.replace(/^\s*productionHosts:[^\n]*\n/m,'');
config=config.replace("idbName:'cdt_staging_faseb_v1'","idbName:'cdt_standalone_demo_v1'");
config=config.replace("authStorageKey:'tanques-auth-staging-v1'","authStorageKey:'tanques-standalone-demo-auth-v1'");
config=config.replace("cloudMetaPrefix:'tanques-staging-meta'","cloudMetaPrefix:'tanques-standalone-demo-meta'");
config=config.replace("cloudProfilePrefix:'tanques-staging'","cloudProfilePrefix:'tanques-standalone-demo'");
config=config.replaceAll('control-tanques-staging-','control-tanques-standalone-demo-');
config=config.replace('DEMO STAGING · DATOS FICTICIOS · NO PRODUCCIÓN · v0.10.1','DEMO · DATOS FICTICIOS · NO PRODUCCIÓN · v0.10.1');
put('config.js',config);

// Seguridad fail-closed: NO copiar las constantes ni la clave de producción.
// Ni siquiera debe quedar una URL alternativa si faltase TankConfig.
let cloud=read('cloud-sync.js');
const cloudStart=cloud.indexOf(" const PROD_HOST=");
const cloudEnd=cloud.indexOf(" let client,user=",cloudStart);
must(cloudStart>=0&&cloudEnd>cloudStart,'estructura de configuración de sincronización inesperada');
const strictConfig=[
" const PROJECT_URL=cfg.supabaseUrl;",
" const KEY=cfg.supabaseAnonKey;",
" const AUTH_KEY=cfg.authStorageKey||'tanques-standalone-demo-auth-v1';",
" const META_PREFIX=cfg.cloudMetaPrefix||'tanques-standalone-demo-meta';",
" const PROFILE_PREFIX=cfg.cloudProfilePrefix||'tanques-standalone-demo';",
" const IS_STAGING=cfg.env==='staging';",
" const MEMBER_CACHE_PREFIX='tanques-standalone-demo-member:'+(cfg.idbName||'cdt_standalone_demo_v1')+':';",
" const EDIT_LOCK_NAME='tanques-standalone-demo-edit-session:'+(cfg.idbName||'cdt_standalone_demo_v1');",
" const STAGING_HOST='"+staging+".supabase.co';",
" function assertStagingIsolation(){",
"  if(!IS_STAGING||!PROJECT_URL||!KEY)throw Error('DEMO bloqueada: configuración staging obligatoria');",
"  let host='';",
"  try{host=new URL(PROJECT_URL).hostname;}catch{throw Error('DEMO bloqueada: dirección inválida');}",
"  if(host!==STAGING_HOST||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(KEY)){",
"   throw Error('DEMO bloqueada: solo proyecto staging y clave publicable');",
"  }",
" }",
""
].join('\n');
cloud=cloud.slice(0,cloudStart)+strictConfig+cloud.slice(cloudEnd);
cloud=cloud.replaceAll("'tanques-member:'","'tanques-standalone-demo-member:'");
cloud=cloud.replaceAll("'tanques-edit-session'","'tanques-standalone-demo-edit-session'");
must(!cloud.includes("const PROD_HOST=")&&!cloud.includes("||PROD_URL"),'persiste conexión alternativa');
must(cloud.includes('assertStagingIsolation()'),'no existe protección de staging');
put('cloud-sync.js',cloud);

// Quitar todos los datos y utilidades históricas de operación REAL del código.
// La DEMO NO conserva datos de clientes, saldos reales ni incidencias reales.
let app=read('app.js');
const realStart=app.indexOf('// Preparación segura de la base real:');
const realEnd=app.indexOf('function adminPage(){',realStart);
must(realStart>=0&&realEnd>realStart,'no se reconoce el bloque histórico real');
app=app.slice(0,realStart)+app.slice(realEnd);
const legacyStart=app.indexOf('function legacyAdminPage(){');
const legacyEnd=app.indexOf('// v0.4 · Excel local',legacyStart);
must(legacyStart>=0&&legacyEnd>legacyStart,'no se reconoce el panel heredado');
app=app.slice(0,legacyStart)+"function legacyAdminPage(){return '<div class=\"notice\">DEMO: inicia sesión con una cuenta de pruebas autorizada.</div>';}\n\n"+app.slice(legacyEnd);
const unused=[
 "if(act==='save-reconciliation')return saveReconciliation();",
 "if(act==='export-reconciliation')return exportReconciliation();",
 "if(act==='prepare-real')return prepareRealOpening();",
 "if(act==='export-real-opening')return exportRealOpening();"
];
for(const bit of unused)app=app.replace(bit,'');
must(!app.includes('PENDING_BARALLETE')&&!app.includes('REAL_OPENING')&&!app.includes('BARALLETE'),'se detectaron datos reales');
put('app.js',app);

// Adaptar /demo/ → raíz de repositorio exclusivo.
let index=read('demo/index.html').replaceAll('../','./');
index=index.replaceAll('DEMO STAGING · DATOS FICTICIOS · NO PRODUCCIÓN','DEMO · DATOS FICTICIOS · NO PRODUCCIÓN');
put('index.html',index);
let manifest=read('demo/manifest.webmanifest').replaceAll('../','./');
put('manifest.webmanifest',manifest);
let sw=read('demo/sw.js').replaceAll('../','./');
sw=sw.replaceAll('control-tanques-staging-','control-tanques-standalone-demo-');
put('sw.js',sw);
put('version.json',read('demo/version.json'));
copy('demo/assistant-a.js','assistant-a.js');
copy('demo/assistant-a.css','assistant-a.css');
put('.nojekyll','');

// Recursos estrictamente necesarios (sin descargar datos de producción).
for(const name of [
 'supabase-2.57.4.js','sync-core.js','styles.css',
 'xlsx-local.js','xlsx-import-local.js','xlsx-transfer-local.js','plan-import-local.js',
 'mahou-logo.png','logo-control-tanques.png','icon.svg',
 'Control_de_Tanques_icon_192.png','Control_de_Tanques_icon_512.png'
])copy(name);

// Las aplicaciones GitHub Pages bajo el mismo usuario comparten ORIGEN.
// Esta DEMO usa otros nombres de caché, IndexedDB, Auth y lock.
const forbidden=['oevetnszmfxeukcncwji','BARALLETE','240.61','YOUR_STAGING','real-opening-2026'];
const texts=['config.js','cloud-sync.js','app.js','sw.js','index.html','manifest.webmanifest','version.json','assistant-a.js','assistant-a.css'];
for(const file of texts){const data=readFileSync(join(output,file),'utf8');for(const marker of forbidden)must(!data.includes(marker),'contenido prohibido en '+file);}
must(index.includes('script src="config.js"'),'no carga primero su configuración');
must(index.includes('assistant-a.js?v=1')&&index.includes('assistant-a.css?v=1'),'opción A no está habilitada');
must(sw.includes('assistant-a.js?v=1')&&sw.includes('assistant-a.css?v=1'),'PWA no cachea opción A');
must(config.includes("idbName:'cdt_standalone_demo_v1'"),'almacenamiento no aislado');
must(cloud.includes("tanques-standalone-demo-edit-session"),'bloqueo compartido');
must(sw.includes('control-tanques-standalone-demo-'),'caché no aislada');
must(!cloud.includes('PROD_URL'),'hay fallback de producción');
console.log('DEMO_BUILD_PASS · solo Supabase '+staging+' · almacenamiento aislado · sin registros reales');
