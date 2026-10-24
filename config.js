'use strict';
/**
 * DEMO staging conectado al proyecto independiente iuqmzpahyjganhppcsur.
 * Solo clave PUBLICABLE, nunca service_role ni secret key.
 * Nunca debe apuntar al proyecto Supabase de producción.
 */
window.TankConfig={
 env:'staging',
 label:'DEMO · DATOS FICTICIOS · NO PRODUCCIÓN · v0.10.1',
 supabaseUrl:'https://iuqmzpahyjganhppcsur.supabase.co',
 supabaseAnonKey:'sb_publishable_s79mWzONV_BvYzNZsZPJTQ_3xydPQtx',
 idbName:'cdt_standalone_demo_v1',
 authStorageKey:'tanques-standalone-demo-auth-v1',
 cloudMetaPrefix:'tanques-standalone-demo-meta',
 cloudProfilePrefix:'tanques-standalone-demo',
 swCachePrefix:'control-tanques-standalone-demo-',
 swCache:'control-tanques-standalone-demo-v0101-connected',
 demoOpening:{cisterna:10000,camion:[500,400,300],furgoneta:[800]}
};
