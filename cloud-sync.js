'use strict';
// Bundled SDK, durable IndexedDB outbox, optimistic revisions and atomic server batches.
const TankCloud=(()=>{
 const C=TankSyncCore;
 const cfg=typeof window!=='undefined'&&window.TankConfig?window.TankConfig:{};
 const PROJECT_URL=cfg.supabaseUrl;
 const KEY=cfg.supabaseAnonKey;
 const AUTH_KEY=cfg.authStorageKey||'tanques-standalone-demo-auth-v1';
 const META_PREFIX=cfg.cloudMetaPrefix||'tanques-standalone-demo-meta';
 const PROFILE_PREFIX=cfg.cloudProfilePrefix||'tanques-standalone-demo';
 const IS_STAGING=cfg.env==='staging';
 const MEMBER_CACHE_PREFIX='tanques-standalone-demo-member:'+(cfg.idbName||'cdt_standalone_demo_v1')+':';
 const EDIT_LOCK_NAME='tanques-standalone-demo-edit-session:'+(cfg.idbName||'cdt_standalone_demo_v1');
 const STAGING_HOST='iuqmzpahyjganhppcsur.supabase.co';
 function assertStagingIsolation(){
  if(!IS_STAGING||!PROJECT_URL||!KEY)throw Error('DEMO bloqueada: configuración staging obligatoria');
  let host='';
  try{host=new URL(PROJECT_URL).hostname;}catch{throw Error('DEMO bloqueada: dirección inválida');}
  if(host!==STAGING_HOST||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(KEY)){
   throw Error('DEMO bloqueada: solo proyecto staging y clave publicable');
  }
 }
 let client,user=null,member=null,meta=C.empty(),busy=false,timer=null,message='Conecta tu cuenta para sincronizar',members=[],editingTab=true;
 let account=null,stopped=false,consecutiveFailures=0;
 const exclusive=C.createGate();
 const count=()=>Object.keys(meta.pending).length;
 const eligibleCount=()=>Object.values(meta.pending).filter(r=>C.permittedPending(r,member,account)).length;
 const quarantinedCount=()=>count()-eligibleCount();
 function visibleMeta(source=meta){
  // Pendientes restringidos para las vistas; NO se eliminan de la cola original.
  if(!connected()||!member?.active)return {...source,rows:{},pending:{}};
  return {...source,pending:Object.fromEntries(
   Object.entries(source.pending).filter(([,r])=>C.permittedPending(r,member,account))
  )};
 }
 const key=()=>`${META_PREFIX}:${account}`;
 const connected=()=>!!account;
 const permitted=r=>member?.active&&(member.role==='gerencia'||member.role===r);
 const canAdjustStock=()=>!!member?.active&&member.role==='gerencia';
 const roleDefault=()=>member?.role==='gerencia'?'gerencia':(['almacen','reparto'].includes(member?.role)?member.role:'reparto');
 const status=()=>{
  if(!editingTab)return 'Otra pestaña está editando; cierra esa pestaña y recarga.';
  if(!connected())return message;
  if(member&&!member.active&&count())return `Cuenta desactivada · ${count()} pendientes conservados. Descarga copia JSON y contacta con Gerencia.`;
  if(!member?.active)return 'Cuenta pendiente de autorización';
  if(!navigator.onLine)return `Sin cobertura · ${count()} pendientes`;
  if(busy)return `Sincronizando · ${count()} pendientes`;
  if(Object.keys(meta.conflicts).length)return `Revisión necesaria · ${Object.keys(meta.conflicts).length} conflictos`;
  if(quarantinedCount())return `${quarantinedCount()} pendientes retenidos por cambio de permisos · ${eligibleCount()} autorizados`;
  if(count())return `${count()} cambios pendientes · ${message}`;
  return message;
 };
 function badge(){const e=document.getElementById('cloudBadge');if(e)e.textContent=status();const b=document.getElementById('cloudForce');if(b)b.disabled=busy||!connected()||!editingTab||(member&&!member.active&&!count());}
 function schedule(ms=1000){
  clearTimeout(timer);
  if(stopped||!editingTab){badge();return;}
  // Cuenta desactivada: no empujar, pero nunca descartar la cola.
  if(member&&!member.active){badge();return;}
  if(!member?.active){badge();return;}
  timer=setTimeout(()=>sync(),ms);
  badge();
 }
 function rescheduleAfterGate(){
  const plan=C.retryAfterGate({busy,online:navigator.onLine,active:!!member?.active,stopped,editingTab,pendingCount:count()});
  if(plan.action==='retry'&&plan.ms!=null){clearTimeout(timer);timer=setTimeout(()=>sync(),plan.ms);}
  badge();
  return plan;
 }
 function tx(values){return new Promise((resolve,reject)=>{const t=db.transaction('state','readwrite');for(const [k,v] of values)t.objectStore('state').put(C.copy(v),k);t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error||Error('Guardado interrumpido'));});}
 async function save(s){
  if(!connected())return dbPut(profileKeys[s.role],s);
  return exclusive(async()=>{
   if(!editingTab)throw Error('Esta pestaña es de solo lectura');
   if(!permitted(s.role))throw Error('Perfil no autorizado');
   if(s.role==='gerencia'&&(s.stockAdjustmentHistory||[]).length&&!canAdjustStock())throw Error('Solo Gerencia puede ajustar existencias');
   // Dos fases: no dar una edición por capturada hasta terminar la transacción IDB.
   // Si falla el guardado, meta.last anterior permite volver a capturar el cambio.
   const staged=C.copy(meta);
   C.capture(staged,s,account,{forbidSyncedDelete:true});
   applyBalances(s,staged);
   await tx([[profileKeys[s.role],s],[key(),staged]]);
   meta=staged;
   consecutiveFailures=0;
   schedule();
  });
 }
 function applyBalances(s,source=meta){const r=C.balances(visibleMeta(source));s.cloudStockReady=r.ready;s.cloudStockProblems=r.problems;
  if(r.balances){s.tanks={camion:r.balances.camion,furgoneta:r.balances.furgoneta};s.cisterna=r.balances.cisterna??0;}
 }
 async function persistRemote(){
  // Commit simultáneo de vista autorizada y metadatos. Las operaciones
  // revocadas permanecen solo en la cola durable; nunca se muestran ni
  // se tienen en cuenta en las existencias visibles de otro perfil.
  const stagedMeta=C.copy(meta),stagedState=C.copy(state);
  const visible=visibleMeta(stagedMeta);
  if(member?.role==='reparto')stagedState.vehicle=member.vehicle;
  C.hydrate(visible,stagedState,account);applyBalances(stagedState,visible);
  if(member&&!member.active)stagedState.page='admin';
  stagedMeta.last[stagedState.role]=Object.fromEntries(Object.entries(C.extract(stagedState)).map(([k,r])=>[k,C.signature(r)]));
  await tx([[profileKeys[stagedState.role],stagedState],[key(),stagedMeta]]);
  meta=stagedMeta;state=stagedState;
  badge();if(['inicio','gerencia','historial','recibir-plan'].includes(state.page)&&!document.querySelector('input:focus,textarea:focus,select:focus'))render();
 }
 async function pull(){
  let after='';const rows=[];
  for(;;){let q=client.from('tanques_records').select('*').order('key').limit(500);if(after)q=q.gt('key',after);const {data,error}=await q;if(error)throw error;rows.push(...data);if(data.length<500)break;after=data.at(-1).key;}
  C.reconcileSnapshot(meta,rows);
 }
 async function sync(){
  clearTimeout(timer);
  if(busy||stopped||!editingTab){badge();return;}
  if(!member?.active){
   if(count())message=`Cuenta desactivada · ${count()} pendientes conservados. Descarga copia JSON.`;
   badge();return;
  }
  if(!navigator.onLine){rescheduleAfterGate();return;}
  return exclusive(async()=>{
   if(busy){rescheduleAfterGate();return;}
   busy=true;badge();
   let rejected=null;
   try{
    const {data:current,error:accessError}=await client.from('tanques_members').select('*').eq('user_id',account).single();
    if(accessError)throw accessError;member=current;localStorage.setItem(MEMBER_CACHE_PREFIX+account,JSON.stringify(member));
    if(!member.active){
     // Un perfil desactivado deja de visualizar datos remotos. La cola local se conserva.
     meta.rows={};meta.conflicts={};members=[];
     message=`Acceso desactivado · ${count()} pendientes conservados. Descarga una copia JSON; no se han descartado.`;
     return;
    }
    if(member.role!=='gerencia')members=[];
    // Cambiar la vista activa si la membresía del servidor ha cambiado.
    // La cola antigua se conserva y solo se sincronizan grupos autorizados.
    if(!permitted(state.role)){
     const nextRole=roleDefault();
     state=await dbGet(profileKeys[nextRole])||fresh(nextRole);
     state.role=nextRole;state.page='inicio';
    }
    await pull();
    // Un conflicto bloquea solo su grupo/visita, no los demás movimientos independientes.
    const sent=C.batch(meta,500,{skipConflicts:true,allowRecord:r=>C.permittedPending(r,member,account)});
    if(sent.length){
     const {data,error}=await client.rpc('tanques_sync_batch',{changes:sent});
     if(error){
      const msg=error.message||'';
      if(/CONFLICT/i.test(msg)){
       await pull();
       rejected='conflict';
      }else if(/STOCK/i.test(msg)){
       rejected='stock';
      }else throw error;
     }else{
      C.acknowledge(meta,sent,data);
     }
    }
    await pull();
    meta.lastSync=new Date().toISOString();
    const heldByRole=Object.values(meta.pending).some(r=>!C.permittedPending(r,member,account));
    const hasAllowed=Object.values(meta.pending).some(r=>C.permittedPending(r,member,account));
    if(Object.keys(meta.conflicts).length){
     consecutiveFailures=0;
     message=`Revisión necesaria · ${Object.keys(meta.conflicts).length} conflictos`;
    }else if(heldByRole&&!hasAllowed){
     consecutiveFailures=0;
     message='Operaciones pendientes retenidas por cambio de permisos. No se envían ni borran; consulta a Gerencia.';
    }else if(rejected==='stock'&&count()){
     consecutiveFailures++;
     message='El servidor rechazó el lote por existencias inválidas. Pendientes conservados; reintento progresivo.';
    }else if(rejected==='conflict'&&count()){
     consecutiveFailures++;
     message='Conflicto de revisión. Pendientes conservados; reintento progresivo.';
    }else{
     consecutiveFailures=0;
     if(count())message=`Quedan ${count()} pendientes · ${new Date(meta.lastSync).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}`;
     else message='Actualizado · '+new Date(meta.lastSync).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'});
    }
   }catch(e){
    consecutiveFailures++;
    const reason=e?.message||'No se ha podido conectar';
    message=/(Permiso denegado|no autorizado|permission denied|JWT|401|403)/i.test(reason)
     ?'Acceso rechazado por el servidor. Pendientes conservados; revisión de permisos necesaria.'
     :reason+' · pendientes conservados; reintento progresivo';
   }finally{
    busy=false;
    try{await persistRemote();}catch(err){consecutiveFailures++;message=err.message||message;}
    // Reducción de carga y batería: de 2 s hasta 120 s tras fallos repetidos.
    // Nunca borrar ni confirmar pendientes después de una respuesta fallida.
    const sendable=Object.values(meta.pending).some(r=>C.permittedPending(r,member,account));
    schedule(sendable&&!Object.keys(meta.conflicts).length
     ?C.retryDelay(consecutiveFailures):15000);
   }
  });
 }
 async function switchRole(role){
  if(!connected())return false;
  if(!permitted(role)){toast('Este usuario no tiene permiso para ese perfil');return true;}
  await save(state);state=await dbGet(profileKeys[role])||fresh(role);state.role=role;state.page='inicio';
  if(member.role==='reparto')state.vehicle=member.vehicle;C.hydrate(visibleMeta(),state,account);applyBalances(state,visibleMeta());
  meta.last[role]=Object.fromEntries(Object.entries(C.extract(state)).map(([k,r])=>[k,C.signature(r)]));
  await tx([[profileKeys[role],state],[key(),meta]]);render();return true;
 }
 function fresh(role){return {...cleanProfile(role),tanks:{camion:[0,0,0],furgoneta:[0]},cisterna:0,cloudStockReady:false};}
 async function activate(session){
  user=session.user;account=user.id;stopped=false;
  const cached=localStorage.getItem(MEMBER_CACHE_PREFIX+account);member=cached?JSON.parse(cached):null;
  if(navigator.onLine){
   let r=await client.from('tanques_members').select('*').eq('user_id',account).maybeSingle();if(r.error)throw r.error;
   if(!r.data){const added=await client.from('tanques_members').insert({user_id:account,nombre:user.email||'Nuevo usuario'}).select().single();if(added.error)throw added.error;r=added;}
   member=r.data;localStorage.setItem(MEMBER_CACHE_PREFIX+account,JSON.stringify(member));
  }
  // Claves estables entre versiones PWA: no renombrar o se pierden colas iPhone.
  // meta → tanques-cloud-meta:<uid> · perfiles → tanques-cloud:<uid>:<rol> · auth → tanques-auth-v1
  // Claves por entorno: staging ≠ producción en el mismo iPhone.
  for(const role of Object.keys(profileKeys))profileKeys[role]=`${PROFILE_PREFIX}:${account}:${role}`;
  meta=await dbGet(key())||C.empty();
  meta.pending=meta.pending||{};meta.rows=meta.rows||{};meta.last=meta.last||{};meta.conflicts=meta.conflicts||{};
  const role=roleDefault();state=await dbGet(profileKeys[role])||fresh(role);state.role=role;state.page=member?.active?'inicio':'admin';
  if(member?.active){if(member.role==='reparto')state.vehicle=member.vehicle;C.hydrate(visibleMeta(),state,account);applyBalances(state,visibleMeta());meta.last[role]=Object.fromEntries(Object.entries(C.extract(state)).map(([k,r])=>[k,C.signature(r)]));}
  else if(count()){message=`Cuenta desactivada o pendiente · ${count()} cambios locales conservados`;}
  else message=member?.active?'Conectado · sincronización automática':'Cuenta pendiente de autorización';
  if(member?.active)message='Conectado · sincronización automática';
  render();schedule(0);
 }
 async function init(){
  try{assertStagingIsolation();}catch(e){message=e.message;badge();render();return;}
  if(navigator.locks){
   // El bloqueo es propio del entorno; dos pestañas del mismo entorno no editan a la vez.
   editingTab=false;
   navigator.locks.request(EDIT_LOCK_NAME,{ifAvailable:true},async lock=>{
    editingTab=!!lock;badge();
    if(!lock){if(connected())render();return;}
    if(connected()){render();schedule(0);}
    await new Promise(()=>{});
   }).catch(err=>{editingTab=false;message='No se obtuvo el bloqueo de edición';console.warn(err);badge();});
  }
  client=supabase.createClient(PROJECT_URL,KEY,{global:{fetch:async(input,options={})=>{const controller=new AbortController(),t=setTimeout(()=>controller.abort(),15000);try{return await fetch(input,{...options,signal:controller.signal});}finally{clearTimeout(t);}}},auth:{storageKey:AUTH_KEY,persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  const {data,error}=await client.auth.getSession();if(error)message=error.message;
  if(data?.session)try{await activate(data.session)}catch(e){message=e.message;badge();}
  client.auth.onAuthStateChange((event,session)=>{
   if(event==='PASSWORD_RECOVERY')setTimeout(()=>{state.page='admin';render();document.getElementById('cloudPasswordPanel')?.removeAttribute('hidden');},0);
   if(event==='TOKEN_REFRESHED'&&session)user=session.user;
  });
  window.addEventListener('online',()=>schedule(0));document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(0)});
  window.addEventListener('focus',()=>schedule(0));
  document.addEventListener('click',e=>{const b=e.target.closest('[data-cloud]');if(b)action(b.dataset.cloud,b).catch(err=>{message=err.message;toast(message);badge();});});
  document.addEventListener('submit',e=>{if(e.target.id==='cloudLoginForm'||e.target.id==='cloudPasswordForm'){e.preventDefault();submit(e.target).catch(err=>{message=err.message;toast(message);badge();});}});
  render();badge();
 }
 async function submit(form){
  if(form.id==='cloudPasswordForm'){const {error}=await client.auth.updateUser({password:document.getElementById('cloudNewPassword').value});if(error)throw error;toast('Contraseña actualizada');render();return;}
  const email=document.getElementById('cloudEmail').value.trim(),password=document.getElementById('cloudPassword').value;
  const {data,error}=await client.auth.signInWithPassword({email,password});if(error)throw error;await activate(data.session);
 }
 async function action(act,button){
  if(act==='force'){if(connected()&&!member?.active){const {data,error}=await client.auth.getSession();if(error)throw error;if(data.session)await activate(data.session);}await sync();return;}
  if(act==='settings'){state.page='admin';render();return;}
  if(act==='logout'){
   if(count())throw Error('Quedan cambios en este móvil. Descarga una copia JSON y sincroniza o resuelve conflictos antes de cerrar sesión. No se descartarán automáticamente.');
   stopped=true;clearTimeout(timer);await client.auth.signOut({scope:'local'});location.reload();return;
  }
  if(act==='recover'){const email=document.getElementById('cloudEmail').value.trim();if(!email)throw Error('Introduce tu correo');const {error}=await client.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});if(error)throw error;toast('Revisa tu correo para recuperar la contraseña');return;}
  if(act==='signup'){
   const email=document.getElementById('cloudEmail').value.trim(),password=document.getElementById('cloudPassword').value;
   if(!email||password.length<8)throw Error('Indica correo y contraseña de al menos 8 caracteres');
   const {data,error}=await client.auth.signUp({email,password,options:{emailRedirectTo:location.origin+location.pathname}});if(error)throw error;
   if(data.session)await activate(data.session);else toast('Confirma tu correo y después inicia sesión para solicitar acceso');return;
  }
  if(act==='members'){const {data,error}=await client.from('tanques_members').select('*').order('nombre');if(error)throw error;members=data;render();return;}
  if(act==='member-save'){
   const id=button.dataset.id,role=document.getElementById('memberRole-'+id).value,vehicle=document.getElementById('memberVehicle-'+id).value;
   if(id===account)throw Error('No puedes cambiar tu propio acceso desde aquí');
   const {error}=await client.from('tanques_members').update({role,active:role!=='pendiente',vehicle:role==='reparto'?vehicle:null}).eq('user_id',id);if(error)throw error;toast('Permisos guardados');return;
  }
  if(act==='conflict-remote'||act==='conflict-local'){
   const k=button.dataset.key,r=meta.conflicts[k];if(!r)return;
   if(!confirm(act==='conflict-local'?'¿Aplicar tu versión? Si es una visita, se resolverán juntas todas sus descargas. Ambas versiones quedarán en la auditoría.':'¿Usar la versión remota de este registro y sus descargas? Tu cambio local se conservará en una copia de conflictos.'))return;
   await dbPut('tanques-conflict-backup:'+Date.now(),{local:meta.pending,remote:meta.rows});
   C.resolve(meta,k,act==='conflict-local');await persistRemote();render();schedule(0);return;
  }
  if(act==='import-catalog'){
   if(member?.role!=='gerencia')return;
   const old=await dbGet('workspace-gerencia-v08');if(!old?.customers?.length)throw Error('No hay clientes anteriores en este dispositivo');
   const ids=new Set(state.customers.map(c=>c.id));state.customers.push(...old.customers.filter(c=>!ids.has(c.id)));await save(state);render();toast('Clientes anteriores conservados y puestos en cola');return;
  }
 }
 function panel(){
  const pendingHint=connected()&&count()?`<p class="notice">Hay ${count()} cambios pendientes en este móvil. No se descartan solos. Descarga una copia JSON antes de borrar datos del sitio o desinstalar la PWA.</p>`:'';
  const deactivated=connected()&&member&&!member.active&&count()?`<p class="notice error">Cuenta sin acceso activo con cola local. Conservamos ${count()} pendientes. Usa «Descargar copia JSON» en Más.</p>`:'';
  const envHint=IS_STAGING
   ?`<p class="notice">${esc(cfg.label||'DEMO STAGING · DATOS FICTICIOS')}</p><p class="hint">Usuarios de prueba del proyecto staging (no producción). Colas e IndexedDB aisladas.</p>`
   :`<p class="hint">Usa la cuenta de Control de Cargas. Los perfiles anteriores quedan conservados en este móvil; la cuenta conectada tiene su propio espacio.</p>`;
  const login=!connected()?`${envHint}<form id="cloudLoginForm" class="form"><label class="field">Correo<input id="cloudEmail" type="email" autocomplete="username" required></label><label class="field">Contraseña<input id="cloudPassword" type="password" autocomplete="current-password" required minlength="8"></label><button class="btn" type="submit">Conectar cuenta</button></form><button class="btn secondary" data-cloud="recover">Recuperar contraseña</button><button class="btn secondary" data-cloud="signup">Crear cuenta de trabajador</button>`:`<p>${esc(member?.nombre||user?.email||'Cuenta conectada')} · ${esc(member?.role||'pendiente')}${IS_STAGING?' · DEMO':''}</p><button class="btn secondary" data-cloud="logout">Cerrar sesión</button>`;
  const conflicts=Object.entries(meta.conflicts).map(([k,r])=>`<details><summary>Revisar ${esc(k)}</summary><p>Versión del servidor</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(r.payload,null,2))}</pre><p>Tu versión pendiente</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(meta.pending[k]?.payload,null,2))}</pre><button class="btn secondary" data-cloud="conflict-remote" data-key="${esc(k)}">Usar remota</button><button class="btn" data-cloud="conflict-local" data-key="${esc(k)}">Aplicar mi cambio</button></details>`).join('');
  const management=member?.role==='gerencia'?`<button class="btn secondary" data-cloud="members">Gestionar accesos</button><button class="btn secondary" data-cloud="import-catalog">Recuperar clientes del perfil anterior</button>${members.map(m=>`<div class="card"><b>${esc(m.nombre)}</b><select id="memberRole-${m.user_id}">${['pendiente','gerencia','almacen','reparto'].map(r=>`<option ${m.role===r?'selected':''}>${r}</option>`).join('')}</select><select id="memberVehicle-${m.user_id}"><option value="camion" ${m.vehicle==='camion'?'selected':''}>Camión</option><option value="furgoneta" ${m.vehicle==='furgoneta'?'selected':''}>Furgoneta</option></select><button class="btn secondary" data-cloud="member-save" data-id="${m.user_id}">Guardar acceso</button></div>`).join('')}`:'';
  return `<div class="card"><h3>Cuenta y sincronización automática</h3><p>${esc(status())}</p>${deactivated}${pendingHint}${login}<p class="hint">Al guardar, al recuperar conexión y mientras la app está abierta se sincroniza automáticamente. Si iPhone suspende la app, continúa al abrirla de nuevo.</p>${conflicts}${management}<div id="cloudPasswordPanel" hidden><form id="cloudPasswordForm"><input id="cloudNewPassword" type="password" required minlength="8" autocomplete="new-password" placeholder="Nueva contraseña"><button class="btn">Guardar contraseña</button></form></div></div>`;
 }
 function decorate(){
  badge();if(!connected())return;
  document.querySelectorAll('[data-act=export-plan]').forEach(b=>b.hidden=true);
  document.querySelectorAll('[data-page="carga"],[data-page="visita"]').forEach(b=>{if(state.role==='gerencia')b.hidden=true;});
  document.querySelectorAll('[data-profile]').forEach(b=>b.hidden=!permitted(b.dataset.profile));
  if(member?.role==='reparto')for(const id of ['vehicle','loadVehicle','planReceiveVehicle']){const e=document.getElementById(id);if(e){e.value=member.vehicle;e.disabled=true;}}
  const screen=document.getElementById('screen');
  const replacements=[
   ['Operación de prueba local. Un tanque por registro. Puedes cargar de nuevo tras enviar un lote. Si la cisterna es desconocida, la conciliación queda pendiente. Confirma que el contador físico se ha puesto a cero.','Un tanque por registro. Los cambios se guardan en el móvil y se sincronizan automáticamente. Confirma que el contador físico se ha puesto a cero.'],
   ['La v1 registra los movimientos y conserva los saldos locales. El Excel diario se genera desde Más → Enviar jornada. El tiempo real queda pendiente.','El movimiento se comparte automáticamente con Reparto y Gerencia cuando hay conexión.'],
   ['Las correcciones y los reinicios se anotan en el historial local. Puedes generar el Excel diario desde Más → Enviar jornada. Solo datos de prueba.','Las correcciones y los reinicios se conservan y se sincronizan automáticamente.'],
   ['Confirmar carga de prueba','Confirmar carga'],['Visitas cerradas · pendientes de envío','Visitas cerradas · correcciones'],
   ['Planificación importada','Planificación sincronizada'],['Guardar ajuste de existencias (DEMO)','Guardar ajuste de existencias'],['Ajuste inicial de existencias · DEMO','Ajuste de existencias (solo Gerencia)']
  ];
  const walker=document.createTreeWalker(screen,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode())for(const [a,b] of replacements)if(node.textContent.includes(a))node.textContent=node.textContent.replaceAll(a,b);
  const banner=document.querySelector('.demo-banner');
  if(banner)banner.textContent=IS_STAGING?(cfg.label||'DEMO STAGING · DATOS FICTICIOS · v0.10.1'):'VERSIÓN 0.10.1 · FASE A SEGURIDAD INVENTARIO';
  if(!member?.active||!editingTab||!permitted(state.role))document.querySelectorAll('#screen form:not(#cloudLoginForm):not(#cloudPasswordForm) input,#screen form:not(#cloudLoginForm):not(#cloudPasswordForm) button').forEach(e=>e.disabled=true);
 }
 function canOperate(){if(!connected())return true;if(!permitted(state.role)){toast('Tu perfil ha cambiado. Revisa los accesos antes de continuar; los pendientes siguen guardados.');return false;}if(!member?.active||!editingTab){toast(count()?'Cuenta sin acceso: tus pendientes siguen guardados. Descarga copia JSON.':'Necesitas acceso autorizado');return false;}if(!state.cloudStockReady){toast('Gerencia debe establecer las existencias iniciales en el panel de saldos');return false;}if(state.cloudStockProblems?.length||Object.keys(meta.conflicts).length){toast('Revisa las incidencias de existencias o sincronización antes de continuar');return false;}return true;}
 return {init,save,switchRole,panel,decorate,connected,permitted,canAdjustStock,canOperate,status,sync,member:()=>member,meta:()=>meta,count,assertStagingIsolation,isStaging:()=>IS_STAGING};
})();
