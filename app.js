'use strict';
// Versión 0.9.6: existencias iniciales provisionales y conciliación pendiente (demo).
// TankConfig (demo/staging) aísla IndexedDB respecto a producción.
const STORE=(typeof window!=='undefined'&&window.TankConfig&&window.TankConfig.idbName)||'cdt_demo_v1';
const APP_VERSION='0.10.1';
const litres=n=>{const v=Math.round(Number(n)*100)/100;return Number.isFinite(v)?v:NaN;};
let formBusy=false;
const UPDATE_CHECK_MS=6*60*60*1000;
let updateAvailable=false, updating=false, lastUpdateCheck=0, remoteVersion=null;
const baseline=()=>({role:'reparto',page:'inicio',vehicle:'camion',tanks:{camion:[800,650,1000],furgoneta:[900]},cisterna:18000,loads:[],visits:[],openVisit:null,log:[],created:new Date().toISOString()});
let db,state;
let editingId=null;
const el=id=>document.getElementById(id);
const uid=()=>crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(16).slice(2)}`;
const esc=s=>String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fmt=n=>Number(n||0).toLocaleString('es-ES',{maximumFractionDigits:2});
const now=()=>new Date().toISOString();
const showTime=t=>new Date(t).toLocaleString('es-ES',{dateStyle:'short',timeStyle:'short'});
const profileKeys={almacen:'workspace-almacen-v08',reparto:'workspace-reparto-v08',gerencia:'workspace-gerencia-v08'};
const activeProfile=()=>state?.role||'reparto';
const openDB=()=>new Promise((res,rej)=>{const r=indexedDB.open(STORE,1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
const dbGet=(key)=>new Promise((res,rej)=>{const r=db.transaction('state','readonly').objectStore('state').get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
const dbPut=(key,value)=>new Promise((res,rej)=>{const t=db.transaction('state','readwrite');t.objectStore('state').put(value,key);t.oncomplete=res;t.onerror=()=>rej(t.error)});
const read=()=>dbGet(profileKeys[activeProfile()]);
const write=()=>TankCloud.save(state);
const cleanProfile=(role)=>({...baseline(),role,page:'inicio'});
const cloneState=x=>JSON.parse(JSON.stringify(x));
// Declaración local de apertura: NO es una carga de almacén.
// Preservar el registro original para auditoría, y jamás sumar un Excel sobre una apertura provisional.
const provisionalFor=(vehicle)=>state?.provisionalOpenings?.[vehicle]||null;
function provisionalPanel(){
 if(state.role!=='reparto')return '';
 const vehicle=state.vehicle,active=provisionalFor(vehicle),today=localDay(now());
 const pastOperations=(state.visits||[]).some(v=>v.vehicle===vehicle&&localDay(v.started)===today)||
  (state.openVisit?.vehicle===vehicle)||
  Object.values(state.receivedLoads||{}).some(m=>m.vehicle===vehicle&&localDay(m.receivedAt||m.time)===today);
 if(active){
  const latest=(state.pendingLoads||[]).filter(m=>m.vehicle===vehicle&&m.reason?.includes('provisional'));
  return card(`<h3>Existencias provisionales · ${vehicle==='camion'?'Camión':'Furgoneta'}</h3><div class="notice">Pendientes de revisión por Gerencia. No se suman automáticamente las cargas recibidas.</div><p class="compact">Declaradas el ${showTime(active.at)} · Apertura: ${active.amounts.map((n,i)=>`T${i+1}: ${fmt(n)} L`).join(' · ')}</p><p class="hint">Cargas pendientes de conciliación: ${latest.length}. Se mantienen las descargas y los litros restantes actuales.</p>`);
 }
 const fields=state.tanks[vehicle].map((v,i)=>`<label class="field">Tanque ${i+1} · máximo 1.000 L<input id="provTank${i}" type="number" inputmode="decimal" min="0" max="1000" step="0.01" value="${v}" required></label>`).join('');
 return card(`<h3>Inicio excepcional sin archivo de cargas</h3><p class="hint">Úsalo únicamente cuando aún no hayas recibido las cargas de Gerencia. Sustituye el saldo local de apertura; NO registra una carga. Quedará pendiente de revisión.</p>${pastOperations?'<div class="notice">Ya existen operaciones de hoy para este vehículo. No se puede modificar su apertura.</div>':`<form id="provisionalForm" class="form">${fields}<label class="check"><input id="provisionalConfirm" type="checkbox" required> Confirmo que he comprobado estos litros en el vehículo.</label><button class="btn" type="submit">Guardar apertura provisional</button></form>`}`);
}
async function saveProvisional(){
 if(state.role!=='reparto'||provisionalFor(state.vehicle))return toast('Ya existe una apertura provisional para este vehículo');
 if(TankCloud.connected())return toast('En modo conectado las existencias las fija Gerencia. La declaración provisional no altera el saldo compartido.');
 const v=state.vehicle,day=localDay(now());
 if(state.openVisit?.vehicle===v||(state.visits||[]).some(x=>x.vehicle===v&&localDay(x.started)===day)||Object.values(state.receivedLoads||{}).some(m=>m.vehicle===v&&localDay(m.receivedAt||m.time)===day))return toast('Ya hay operaciones de hoy; no se puede cambiar la apertura');
 const amounts=state.tanks[v].map((_,i)=>{const field=el('provTank'+i);return field?.value.trim()===''?NaN:litres(field?.value)});
 if(!el('provisionalConfirm')?.checked||amounts.some(n=>!Number.isFinite(n)||n<0||n>1000))return toast('Revisa todos los litros y confirma la declaración');
 if(!confirm('¿Declarar estas existencias de forma PROVISIONAL? Quedarán pendientes de Gerencia; no representan una carga validada.'))return;
 state.provisionalOpenings??={};state.provisionalHistory??=[];
 const record={id:uid(),vehicle:v,date:day,at:now(),previous:state.tanks[v].slice(),amounts:amounts.slice(),status:'pendiente'};
 state.provisionalOpenings[v]=record;state.provisionalHistory.push(record);
 state.tanks[v]=amounts.slice();
 state.log.push({title:'Apertura provisional',desc:`${v}: ${amounts.map((n,i)=>`T${i+1} ${fmt(n)} L`).join(', ')} · Pendiente de Gerencia`,at:record.at});
 invalidateDraft('reparto');await persist();toast('Existencias provisionales registradas. Pendientes de Gerencia.');
}

function migrateLegacy(old){
 const reparto=cleanProfile('reparto'),almacen=cleanProfile('almacen'),gerencia=cleanProfile('gerencia');
 if(!old)return {reparto,almacen,gerencia};
 // Reparto hereda los saldos realmente visibles de la v0.7 y sus visitas.
 Object.assign(reparto,{vehicle:old.vehicle||'camion',tanks:cloneState(old.tanks||reparto.tanks),visits:cloneState(old.visits||[]),openVisit:cloneState(old.openVisit||null),log:cloneState(old.log||[]).filter(x=>!/carga/i.test(x.title||'')),receivedLoads:cloneState(old.receivedLoads||{}),pendingLoads:cloneState(old.pendingLoads||[]),lastHandoff:cloneState(old.lastHandoff||null),sentJournals:cloneState(Object.fromEntries(Object.entries(old.sentJournals||{}).filter(([k])=>k.endsWith('|reparto')))),preparedJournals:cloneState(Object.fromEntries(Object.entries(old.preparedJournals||{}).filter(([k])=>k.endsWith('|reparto'))))});
 // En la v0.7 las cargas se sumaban en el mismo espacio. Ya están incluidas
 // en los saldos legados del repartidor, por eso se registran sus IDs como aplicados.
 for(const l of old.loads||[])if(l.id&&!reparto.receivedLoads[l.id])reparto.receivedLoads[l.id]={id:l.id,legacyApplied:true,receivedAt:now()};
 const loads=cloneState(old.loads||[]);
 // Reconstruir el saldo local de Almacén desde saldos ficticios + sus cargas,
 // nunca copiando el saldo de Reparto (que incluye descargas).
 const stock=cloneState(cleanProfile('almacen').tanks);
 for(const l of loads){const ix=Number(l.index),v=l.vehicle;if(!stock[v]||!Number.isInteger(ix)||ix<0||ix>=stock[v].length)continue;const current=stock[v][ix],loss=Number(l.merma||0),litres=Number(l.amount||0);if(Number.isFinite(loss)&&Number.isFinite(litres)&&loss>=0&&litres>0)stock[v][ix]=Math.max(0,Math.min(1000,current-loss+litres));}
 Object.assign(almacen,{vehicle:old.vehicle||'camion',tanks:stock,cisterna:Number.isFinite(old.cisterna)?old.cisterna:18000,loads,log:cloneState(old.log||[]).filter(x=>/carga|merma/i.test(x.title||'')),sentJournals:cloneState(Object.fromEntries(Object.entries(old.sentJournals||{}).filter(([k])=>k.endsWith('|almacen')))),preparedJournals:cloneState(Object.fromEntries(Object.entries(old.preparedJournals||{}).filter(([k])=>k.endsWith('|almacen'))))});
 gerencia.manager=cloneState(old.manager||{journals:{},movements:{},incidents:[],lastResult:null});
 return {reparto,almacen,gerencia};
}
async function ensureProfiles(){
 const marker=await dbGet('migration-v08-done');
 if(marker)return;
 const legacy=await dbGet('app');
 const parts=migrateLegacy(legacy);
 // Una única transacción: o se migran los tres perfiles y el marcador o ninguno.
 await new Promise((res,rej)=>{const t=db.transaction('state','readwrite'),o=t.objectStore('state');
  o.put(parts.almacen,profileKeys.almacen);o.put(parts.reparto,profileKeys.reparto);o.put(parts.gerencia,profileKeys.gerencia);
  o.put({at:now(),legacyPreserved:!!legacy},'migration-v08-done');t.oncomplete=res;t.onerror=()=>rej(t.error);
 });
}
async function changeProfile(next){
 if(await TankCloud.switchRole(next))return;
 if(!profileKeys[next])return;
 await write();const nextState=await dbGet(profileKeys[next]);
 if(!nextState)throw new Error('No se encontró el espacio de este perfil');
 state=nextState;state.role=next;state.page='inicio';editingId=null;await write();await dbPut('active-role-v08',next);render();
 toast('Datos locales de '+roleNames[next]+' cargados. Perfil de demostración, sin contraseña.');
}
const persist=async()=>{await write();render()};
const toast=t=>{if(TankCloud.connected())t=t.replaceAll('ficticia','').replaceAll(' (DEMO)','').replaceAll('Genera un nuevo lote Excel para Gerencia.','Se sincronizará automáticamente.');const e=el('toast');e.textContent=t;e.style.display='block';clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>e.style.display='none',3500)};
const card=(body)=>`<div class="card">${body}</div>`;
const action=(text,act,secondary=false)=>`<button class="btn ${secondary?'secondary':''}" data-act="${act}">${text}</button>`;
const roleNames={almacen:'Almacén',reparto:'Reparto',gerencia:'Gerencia'};
function navbar(){el('roleButton').textContent=roleNames[state.role]+' ▾';document.querySelectorAll('[data-profile]').forEach(b=>{b.classList.toggle('selected',b.dataset.profile===state.role);b.setAttribute('aria-pressed',String(b.dataset.profile===state.role))});const allowed=state.role==='almacen'?['inicio','carga','historial','admin']:state.role==='reparto'?['inicio','visita','historial','recibir-plan','admin']:['inicio','carga','visita','historial','gerencia','clientes','planificacion','admin'];document.querySelectorAll('[data-page]').forEach(b=>{b.hidden=!allowed.includes(b.dataset.page);b.classList.toggle('active',b.dataset.page===state.page)})}
function home(){
 if(!TankCloud.connected())return '<div class="card"><h3>Conectar Control de Tanques</h3><p>Activa la sincronización con tu cuenta. Los datos de prueba anteriores se conservan en este dispositivo.</p><button class="btn" data-cloud="settings">Conectar cuenta</button></div>'+legacyHome();
 if(!TankCloud.member()?.active)return TankCloud.panel();
 const tanks=state.tanks[state.vehicle],problems=state.cloudStockProblems||[];
 return '<div class="home-logo-preview"><img src="logo-control-tanques.png" alt="Control de Tanques Mahou"></div>'+`<h2 class="heading">${roleNames[state.role].replace(' (vista de prueba)','')}</h2>`+
 (!state.cloudStockReady?card('<h3>Existencias iniciales pendientes</h3><p>Gerencia debe indicar los litros comprobados antes de registrar movimientos. No se usarán los saldos ficticios anteriores.</p>'+(state.role==='gerencia'?action('Establecer existencias','go-gerencia'):'')):'')+
 (problems.length?'<div class="notice error">Hay movimientos incompatibles con las existencias. Gerencia debe revisar la conciliación antes de continuar.</div>':'')+
 (state.role!=='reparto'?card('<h3>Cisterna principal</h3><strong class="big">'+fmt(state.cisterna)+' L</strong>'):'')+
 `<label class="field">Vehículo<select id="vehicle"><option value="camion" ${state.vehicle==='camion'?'selected':''}>Camión</option><option value="furgoneta" ${state.vehicle==='furgoneta'?'selected':''}>Furgoneta</option></select></label>`+
 card('<h3>Existencias del vehículo</h3>'+tanks.map((n,i)=>`<div class="row"><b>Tanque ${i+1}</b><strong>${fmt(n)} / 1.000 L</strong></div>`).join('')+`<p>Total: <strong>${fmt(tanks.reduce((a,b)=>a+b,0))} L</strong></p><p class="hint">Saldo con los movimientos recibidos y los pendientes de este móvil. Los de otros móviles sin conexión llegarán cuando se conecten.</p>`)+
 (state.role==='almacen'?action('Nueva carga','go-carga'):state.role==='reparto'?action(state.openVisit?'Continuar descarga':'Nueva descarga','go-visita'):card(action('Saldos y movimientos','go-gerencia')+action('Clientes','go-clientes')+action('Planificación','go-planificacion')));
}
function legacyHome(){const tanks=state.tanks[state.vehicle];let txt=`<div class="home-logo-preview"><img src="logo-control-tanques.png" alt="Control de Tanques Mahou" loading="eager"></div><h2 class="heading">${state.role==='almacen'?'Almacén':state.role==='reparto'?'Mi vehículo':'Panel de pruebas'}</h2><div class="notice">Datos ficticios guardados localmente por perfil. Cada perfil usa su propio registro; NO existe autenticación real.</div>`;
if(state.role==='almacen'||state.role==='gerencia')txt+=card(`<h3>Cisterna principal</h3><div class="big mono">${state.role==='almacen'&&state.stockAdjustment?.cisternKnown===false?'Pendiente de confirmar':fmt(state.cisterna)+' L'}</div><p class="muted tiny">Capacidad nominal 25.000 L · saldo de demostración</p>`);
txt+=`<label class="field">Vehículo<select id="vehicle" class="select"><option value="camion" ${state.vehicle==='camion'?'selected':''}>Camión</option><option value="furgoneta" ${state.vehicle==='furgoneta'?'selected':''}>Furgoneta</option></select></label>`;
txt+=card(`<h3>Existencias ${state.vehicle==='camion'?'del camión':'de la furgoneta'}</h3>${tanks.map((v,i)=>`<div class="tank-line"><div class="row"><b>Tanque ${i+1}</b><strong class="mono">${fmt(v)} / 1.000 L</strong></div><div class="meter"><div style="width:${v/10}%"></div></div></div>`).join('')}<div class="divider"></div><div class="row"><b>Total disponible</b><strong class="big mono">${fmt(tanks.reduce((a,b)=>a+b,0))} L</strong></div>`);
if(state.role==='almacen')txt+=action('Nueva carga de prueba','go-carga');
if(state.role==='reparto'){txt+=provisionalFor(state.vehicle)?'<div class="notice">Existencias PROVISIONALES · pendientes de Gerencia.</div>':'';txt+=action(state.openVisit?'Continuar descarga':'Nueva descarga de prueba','go-visita');}
if(state.role==='gerencia')txt+=card('<h3>Gerencia · importación de pruebas</h3><p>Puedes importar Excel de jornada sin modificar las existencias de demostración.</p>'+action('Abrir importaciones','go-gerencia')+'<p class="hint">La sincronización entre PC y móvil y los permisos reales siguen pendientes.</p>');
return txt}
function loadPage(){let tanks=state.tanks[state.vehicle];return `<h2 class="heading">Carga individual</h2><div class="notice">Operación de prueba local. Un tanque por registro. Puedes cargar de nuevo tras enviar un lote. Si la cisterna es desconocida, la conciliación queda pendiente. Confirma que el contador físico se ha puesto a cero.</div><form id="loadForm" class="form"><label class="field">Vehículo<select id="loadVehicle"><option value="camion" ${state.vehicle==='camion'?'selected':''}>Camión</option><option value="furgoneta" ${state.vehicle==='furgoneta'?'selected':''}>Furgoneta</option></select></label><label class="field">Tanque del vehículo<select id="loadTank">${tanks.map((v,i)=>`<option value="${i}">Tanque ${i+1} · ${fmt(v)} L disponibles</option>`).join('')}</select></label><label class="field">Destino del sobrante<select id="residual"><option value="mantener">Conservar el sobrante</option><option value="desechar">Desechar sobrante como merma</option></select></label><label class="field">Lectura final del contador (litros cargados)<input id="loadLiters" inputmode="decimal" type="number" min="0.01" step="0.01" required placeholder="Ej. 200" /></label><label class="check"><input type="checkbox" id="zeroLoad" required /> He puesto el contador de carga a cero antes de iniciar esta operación.</label><button class="btn" type="submit">Confirmar carga de prueba</button><button class="btn secondary" type="button" data-act="leave-load">Salir sin registrar carga</button></form><p class="hint">La v1 registra los movimientos y conserva los saldos locales. El Excel diario se genera desde Más → Enviar jornada. El tiempo real queda pendiente.</p>`}
function plannedEntriesForVehicle(){
 return Object.values(state.receivedPlans||{}).filter(p=>p.vehicle===state.vehicle).flatMap(p=>p.entries||[]);
}
function visitSelectionPage(){
 const entries=plannedEntriesForVehicle(),done=new Set((state.visits||[]).map(v=>v.planEntryId).filter(Boolean));
 const dates=[...new Set(entries.map(e=>e.date))].sort();
 const selected=dates.includes(state.deliveryDate)?state.deliveryDate:(dates.find(d=>d>=localDay(now()))||dates[dates.length-1]||localDay(now()));
 state.deliveryDate=selected;
 const pending=entries.filter(e=>e.date===selected&&!done.has(e.id));
 const completed=entries.filter(e=>e.date===selected&&done.has(e.id));
 return `<h2 class="heading">Descarga · ${state.vehicle==='camion'?'Camión':'Furgoneta'}</h2>
 ${card(`<label class="field">Fecha de reparto<select id="deliveryDate">${dates.length?dates.map(d=>`<option value="${esc(d)}" ${d===selected?'selected':''}>${esc(d)}</option>`).join(''):`<option value="${esc(selected)}">${esc(selected)}</option>`}</select></label><p class="compact">${pending.length} clientes pendientes · ${fmt(pending.reduce((a,b)=>a+b.liters,0))} L previstos</p>`)}
 ${pending.map(e=>card(`<div class="row"><b>${esc(e.client)}</b><b>${fmt(e.liters)} L</b></div><p class="tiny muted">${esc(e.town||'')} · ${esc(e.worker||'')}</p><button type="button" class="btn secondary" data-act="start-planned-visit" data-id="${esc(e.id)}">Iniciar descarga</button>`)).join('')||'<div class="empty">No hay clientes pendientes para esta fecha.</div>'}
 ${card(`<h3>Entrega fuera de planificación</h3><p class="hint">Para urgencias, adelantos de ruta o segundas visitas. No altera la planificación original.</p><form id="extraVisitForm" class="form"><label class="field">Cliente<input id="extraClient" required maxlength="120" placeholder="Nombre del establecimiento" /></label><label class="field">Motivo<select id="extraReason"><option value="adelanto">Adelanto de reparto</option><option value="urgencia">Urgencia</option><option value="segunda-visita">Segunda visita</option><option value="otro">Otro</option></select></label><label class="check"><input type="checkbox" id="extraZero" required /> Contador puesto a cero al llegar</label><button class="btn secondary" type="submit">Iniciar descarga no planificada</button></form>`)}
 ${completed.length?`<p class="hint">${completed.length} cliente(s) atendido(s), retirados de pendientes. Puedes consultarlos en Historial.</p>`:''}
 <p class="hint">Esta versión utiliza los clientes de la planificación importada. El catálogo completo de consulta y las ubicaciones editables en Reparto siguen pendientes.</p>`;
}
async function beginDelivery(entry,client,reason){
 if(!TankCloud.canOperate())return;
 if(state.role!=='reparto'||state.openVisit)return toast('Ya hay una descarga abierta');
 state.openVisit={id:uid(),client,vehicle:state.vehicle,started:now(),reading:0,segment:0,resets:[],corrections:[],lastSource:0,discharges:[],planEntryId:entry?.id||null,plannedLiters:entry?.liters||0,plannedDate:entry?.date||null,unplannedReason:reason||null};
 await persist();
}
function visitPage(){
 const v=state.openVisit, available=state.tanks[state.vehicle];
 if(!v)return visitSelectionPage();
 const editing=v.discharges.find(d=>d.id===editingId);
 return `<h2 class="heading">Descarga en curso${v.reopened?' · Reabierta':''}</h2>${card(`<h3>${esc(v.client)}</h3><p class="muted tiny">Inicio: ${showTime(v.started)}</p><div class="row"><span>Descargas registradas</span><b>${v.discharges.length}</b></div><div class="row"><span>Contador del tramo actual</span><b>${fmt(v.reading)} L</b></div><p class="hint">Reinicios excepcionales: ${(v.resets||[]).length}</p>`)}
 ${v.planEntryId?`<p class="hint">Previsto: ${fmt(v.plannedLiters)} L · Al finalizar desaparecerá de pendientes, aunque se entreguen menos litros.</p>`:`<p class="hint">Entrega no planificada · ${esc(v.unplannedReason||'')}</p>`}${editing?editForm(v,editing):`<form id="dischargeForm" class="form"><label class="field">Tanque de origen del vehículo<select id="sourceTank">${available.map((liters,i)=>`<option value="${i}" ${v.lastSource===i?'selected':''}>Tanque ${i+1} · ${fmt(liters)} L restantes</option>`).join('')}</select></label><label class="field">Tanque del cliente (obligatorio en cada descarga)<select id="destTank" required><option value="">Seleccionar depósito…</option><option value="1">Tanque cliente 1 · 500 L</option><option value="2">Tanque cliente 2 · 500 L</option><option value="3">Tanque cliente 3 · 250 L</option></select></label><label class="field">Nueva lectura acumulada del contador<input type="number" min="0" step="0.01" inputmode="decimal" id="reading" placeholder="Anterior: ${fmt(v.reading)} L" required /></label><p class="hint">El contador es único para todos los tanques. Cada lectura debe superar la anterior dentro del mismo tramo.</p><button class="btn" type="submit">Registrar descarga</button></form>${v.discharges.length?card(`<h3>Reinicio excepcional del contador</h3><p class="hint">Úsalo solo si has puesto a cero físicamente el contador durante esta visita. No modifica litros ya registrados.</p>${action('Registrar puesta a cero','reset-meter',true)}`):''}`}
 <h3 class="spaced">Descargas de esta visita</h3>${v.discharges.map((d,i)=>card(`<div class="row"><b>Descarga ${i+1}</b><b>${fmt(d.liters)} L</b></div><p class="tiny muted">Vehículo T${d.source+1} → Cliente T${d.dest} · Lectura ${fmt(d.reading)} L${d.segment?' · Tramo '+(d.segment+1):''}</p><button class="linklike" type="button" data-act="edit-discharge" data-id="${esc(d.id)}">Corregir descarga</button>`)).join('')}
 ${!editing?action(v.discharges.length?'Guardar y salir · continuar después':'Salir sin iniciar descarga','leave-visit',true):''}
 ${v.discharges.length&&!editing?action('Finalizar visita','finish-visit',true):''}
 <p class="hint">Las correcciones y los reinicios se anotan en el historial local. Puedes generar el Excel diario desde Más → Enviar jornada. Solo datos de prueba.</p>`;
}
function editForm(v,d){
 return card(`<h3>Corregir descarga</h3><p class="hint">La lectura puede afectar a los litros de la descarga siguiente del mismo tramo. Se revisarán las existencias de todos los tanques antes de guardar.</p><form id="editForm" class="form"><label class="field">Tanque del cliente<select id="editDest" required><option value="1" ${d.dest==='1'?'selected':''}>Tanque cliente 1 · 500 L</option><option value="2" ${d.dest==='2'?'selected':''}>Tanque cliente 2 · 500 L</option><option value="3" ${d.dest==='3'?'selected':''}>Tanque cliente 3 · 250 L</option></select></label><label class="field">Lectura acumulada corregida (L)<input id="editReading" inputmode="decimal" type="number" min="0.01" step="0.01" required value="${d.reading}"></label><label class="field">Motivo de corrección<select id="editReason"><option value="Tanque del cliente incorrecto">Tanque del cliente incorrecto</option><option value="Lectura del contador incorrecta">Lectura del contador incorrecta</option><option value="Otro error de registro">Otro error de registro</option></select></label><button class="btn" type="submit">Guardar corrección</button><button class="btn secondary" type="button" data-act="cancel-edit">Cancelar</button></form>`);
}
function reopenList(){
 const eligible=state.visits.filter(canReopen);
 return `${eligible.length?`<h3 class="spaced">Visitas cerradas · pendientes de envío</h3>${eligible.slice().reverse().map(v=>card(`<div class="row"><div><b>${esc(v.client)}</b><p class="tiny muted">${showTime(v.ended)} · ${v.discharges.length} descargas</p></div><button class="btn small secondary" type="button" data-act="reopen-visit" data-id="${esc(v.id)}">Reabrir</button></div>`)).join('')}`:''}`;
}
function canReopen(v){
 if(!v||!v.ended||state.openVisit||v.sentAt)return false;
 const laterVisit=state.visits.some(x=>x.id!==v.id&&x.vehicle===v.vehicle&&x.started>v.ended);
 const laterLoad=state.loads.some(x=>x.vehicle===v.vehicle&&x.at>v.ended);
 return !laterVisit&&!laterLoad;
}
function testVisitBlockReason(v){
 if(state.role!=='reparto')return 'Solo disponible en Reparto';
 if(!v||!v.ended)return 'La visita no está cerrada';
 if(v.sentAt)return 'La visita ya fue enviada. Requiere anulación comunicada a Gerencia, no borrado local';
 if(state.openVisit)return 'Hay una visita abierta';
 if((state.visits||[]).some(x=>x.id!==v.id&&x.vehicle===v.vehicle&&x.started>v.ended))return 'Hay visitas posteriores en este vehículo';
 if((state.loads||[]).some(x=>x.vehicle===v.vehicle&&x.at>v.ended))return 'Hay cargas posteriores en este vehículo';
 if((state.stockTransfers?.[v.vehicle]?.receivedAt||'')>v.ended)return 'Hay un inventario posterior recibido';
 if(!Array.isArray(v.discharges)||!v.discharges.length)return 'No hay descargas detalladas que restaurar';
 if(!state.tanks?.[v.vehicle])return 'No se encuentran los tanques del vehículo';
 if(!v.discharges.every(d=>Number.isInteger(Number(d.source))&&Number(d.source)>=0&&Number(d.source)<state.tanks[v.vehicle].length&&Number(d.liters)>0))return 'Los datos antiguos de descarga requieren revisión';
 const amounts=state.tanks[v.vehicle].slice();
 for(const d of v.discharges)amounts[Number(d.source)]+=Number(d.liters);
 if(amounts.some(x=>!Number.isFinite(x)||x>1000.001||x<0))return 'Restaurar litros superaría la capacidad de un tanque';
 return '';
}
function canDeleteTestVisit(v){return !testVisitBlockReason(v)}
async function deleteTestVisit(id){
 if(TankCloud.connected())return toast('En modo conectado no se borran visitas ni descargas. Conserva el historial o solicita anulación a Gerencia.');
 const v=(state.visits||[]).find(x=>x.id===id);
 if(!canDeleteTestVisit(v))return toast('No se puede eliminar: hay operaciones posteriores, envío o visita abierta');
 const amounts=state.tanks[v.vehicle].slice();
 for(const d of v.discharges)amounts[Number(d.source)]=litres(amounts[Number(d.source)]+Number(d.liters));
 if(amounts.some(x=>x>1000||x<0))return toast('No se puede restaurar el saldo: revisa las operaciones anteriores');
 if(!confirm(`¿Eliminar la visita de prueba a ${v.client} (${fmt(v.discharges.reduce((s,d)=>s+Number(d.liters),0))} L)?\nSe devolverán sus litros a los tanques y se conservará una anotación de auditoría. No se podrá deshacer.`))return;
 invalidateDraft('reparto');state.tanks[v.vehicle]=amounts;state.visits=state.visits.filter(x=>x.id!==id);
 state.log=state.log.filter(x=>!(x.title==='Visita cerrada'&&x.at===v.ended&&x.desc?.startsWith(v.client+' ·')));
 state.log.push({title:'Visita de prueba eliminada',desc:`${v.client} · ${v.vehicle} · ${fmt(v.discharges.reduce((s,d)=>s+Number(d.liters),0))} L restituidos · Referencia ${v.id}`,at:now()});
 await persist();toast('Visita ficticia eliminada; existencias restauradas');
}
async function cancelSentVisit(id){
 const v=(state.visits||[]).find(x=>x.id===id);
 // Conectado: visitas sincronizadas también se anulan (sin sentAt de Excel).
 const synced=TankCloud.connected();
 if(state.role!=='reparto'||!v||v.cancelledAt)return toast('Esta visita no admite anulación');
 if(!v.sentAt&&!synced)return toast('Esta visita no admite anulación');
 if(!Array.isArray(v.discharges)||!v.discharges.length)return toast('Visita sin detalle de descargas');
 const reason=prompt('Motivo de la anulación (obligatorio):','Visita ficticia de prueba');
 if(reason===null)return;
 if(!reason.trim())return toast('Indica un motivo');
 const liters=v.discharges.reduce((sum,d)=>sum+Number(d.liters||0),0);
 const how=synced
  ?'Se sincronizará la anulación. El historial y los litros descontados se conservan hasta que Gerencia concilie con un ajuste.'
  :'Se enviará a Gerencia en un Excel nuevo. El historial original se conserva. NO se modificarán automáticamente los saldos del vehículo.';
 if(!confirm(`¿Registrar anulación de ${v.client} (${fmt(liters)} L)?\n${how}`))return;
 const at=now();v.cancelledAt=at;v.cancelReason=reason.trim().slice(0,200);
 state.cancellations??=[];
 for(const d of v.discharges)state.cancellations.push({id:uid(),visitId:v.id,dischargeId:d.id,vehicle:v.vehicle,client:v.client,liters:Number(d.liters),at,reason:v.cancelReason});
 state.log.push({title:'Anulación pendiente de comunicar',at,desc:`${v.client} · ${fmt(liters)} L · ${v.cancelReason}. Saldos sin cambios hasta conciliación.`});
 invalidateDraft('reparto');await persist();
 toast(synced?'Anulación registrada. Se sincronizará sin restaurar existencias.':'Anulación registrada. Genera un nuevo lote Excel para Gerencia.');
}
function historyPage(){
 const today=localDay(now());
 const movements=[...state.log].filter(m=>state.role==='gerencia'||localDay(m.at)===today).reverse();
 const visitCards=state.role==='reparto'?(state.visits||[]).filter(v=>localDay(v.started)===today).map(v=>{
  const reason=testVisitBlockReason(v);
  const liters=(v.discharges||[]).reduce((sum,d)=>sum+Number(d.liters||0),0);
  const deleteBtn=TankCloud.connected()?'<div class="notice">Modo conectado: las visitas sincronizadas no se borran desde el historial.</div>':reason?`<div class="notice">No se puede eliminar automáticamente: ${esc(reason)}. No se han cambiado los datos.</div>`:`<button class="btn danger" type="button" data-act="delete-test-visit" data-id="${esc(v.id)}">Eliminar esta visita de prueba</button>`;
  const canCancel=!v.cancelledAt&&(v.sentAt||TankCloud.connected());
  return card(`<h3>${esc(v.client||'Visita sin cliente')}</h3><p class="compact">${esc(v.vehicle||'Vehículo desconocido')} · ${fmt(liters)} L · ${v.ended?showTime(v.ended):'Sin cierre'}</p>${v.cancelledAt?`<div class="notice">Anulación registrada (${showTime(v.cancelledAt)}). ${v.cancellationSentAt?'Comunicada en un lote Excel':TankCloud.connected()?'Pendiente de sincronizar':'Pendiente de exportar a Gerencia'}. Historial y saldos conservados.</div>`:canCancel?`<div class="notice">${TankCloud.connected()?'Visita sincronizada: anulación sin restaurar existencias (conciliación Gerencia).':'Visita enviada: requiere anulación comunicable a Gerencia, no borrado local.'}</div><button class="btn danger" type="button" data-act="cancel-sent-visit" data-id="${esc(v.id)}">Registrar anulación${TankCloud.connected()?'':' y comunicar a Gerencia'}</button>`:deleteBtn}`);
}).join(''):'';
 return `<h2 class="heading">Historial local</h2><div class="notice">Almacén y Reparto muestran solo operaciones de hoy. Los registros anteriores permanecen guardados y accesibles desde Gerencia. Los lotes pendientes de días anteriores siguen disponibles para exportación.</div>${state.role==='reparto'?`<h3 class="heading">Visitas registradas · Revisión de pruebas</h3>${visitCards||'<div class="empty">No hay visitas cerradas guardadas en este perfil.</div>'}`:''}${movements.length?movements.map(m=>card(`<div class="row"><b>${esc(m.title)}</b><span class="tag">${showTime(m.at)}</span></div><p class="compact">${esc(m.desc)}</p>`)).join(''):'<div class="empty">Todavía no hay movimientos registrados.</div>'}`;
}
const updatePanel=()=>card(`<h3>Actualizaciones</h3><div class="row"><span>Versión instalada</span><b class="mono">${APP_VERSION}</b></div><p class="update-info">La app busca nuevas versiones al abrirse o regresar a primer plano si hay conexión. No se eliminan los datos locales.</p>${action('Buscar actualizaciones','check-update',true)}${updateAvailable?`<div class="update-ready"><h4>Nueva versión disponible</h4><p class="compact">Puedes instalar la nueva versión sin borrar los movimientos de prueba.</p>${action('Actualizar ahora','apply-update')}</div>`:''}<p class="update-info" id="updateStatus">${navigator.onLine?'Para buscar una nueva versión, toca el botón.':'Sin conexión: se mantiene la versión instalada.'}</p>`);
function stockAdjustmentPanel(){
 if(state.role!=='gerencia')return '';
 if(TankCloud.connected()&&!TankCloud.canAdjustStock())return card('<h3>Ajuste de existencias</h3><p class="notice">Solo Gerencia autorizada puede ajustar el inventario compartido.</p>');
 const current=state.stockAdjustment;
 return card(`<h3>Ajuste de existencias · Gerencia</h3><p class="hint">Nueva referencia de saldos sin borrar el historial. No es una carga. Se registra fecha, motivo y queda auditado. La cisterna puede quedar pendiente.</p>${current?`<div class="notice">Último ajuste: ${showTime(current.at)} · ${esc(current.reason)}. Cisterna: ${current.cisternKnown?'conocida':'pendiente de confirmar'}.</div>`:''}<form id="stockAdjustForm" class="form"><label class="field">Camión · Tanque 1<input id="stockC1" type="number" min="0" max="1000" step="0.01" inputmode="decimal" required value="${state.tanks.camion[0]}"></label><label class="field">Camión · Tanque 2<input id="stockC2" type="number" min="0" max="1000" step="0.01" inputmode="decimal" required value="${state.tanks.camion[1]}"></label><label class="field">Camión · Tanque 3<input id="stockC3" type="number" min="0" max="1000" step="0.01" inputmode="decimal" required value="${state.tanks.camion[2]}"></label><label class="field">Furgoneta · Tanque 1<input id="stockF1" type="number" min="0" max="1000" step="0.01" inputmode="decimal" required value="${state.tanks.furgoneta[0]}"></label><label class="field">Cisterna principal (opcional; vacío = desconocida)<input id="stockCistern" type="number" min="0" max="25000" step="0.01" inputmode="decimal" placeholder="Pendiente de confirmar" value="${state.stockAdjustment&&!state.stockAdjustment.cisternKnown?'':state.cisterna}"></label><label class="field">Motivo del ajuste<input id="stockReason" maxlength="160" required value="Inicio de control con existencias comprobadas"></label><label class="check"><input id="stockVerified" type="checkbox" required> Confirmo que he comprobado los saldos y guardado una copia JSON.</label><button class="btn" type="submit">Guardar ajuste de existencias</button></form>`);
}
async function saveStockAdjustment(){
 if(state.role!=='gerencia')return toast('Solo Gerencia puede ajustar existencias');
 if(TankCloud.connected()&&!TankCloud.canAdjustStock())return toast('Solo Gerencia autorizada puede ajustar el inventario');
 const val=id=>{const raw=el(id)?.value.trim();return raw===''?NaN:litres(raw)};
 const camion=[val('stockC1'),val('stockC2'),val('stockC3')],furgoneta=[val('stockF1')];
 const raw=el('stockCistern')?.value.trim()||'',known=raw!=='';const cisterna=known?litres(raw):null;
 const reason=el('stockReason')?.value.trim()||'';
 if([...camion,...furgoneta].some(n=>!Number.isFinite(n)||n<0||n>1000)||known&&(!Number.isFinite(cisterna)||cisterna<0||cisterna>25000)||!reason||!el('stockVerified')?.checked)return toast('Revisa los litros, motivo y confirmación');
 if(!confirm('¿Guardar este nuevo punto de partida? Se conservan las operaciones anteriores; las existencias visibles serán las declaradas. Quedará auditado.'))return;
 const record={id:uid(),at:now(),reason,previous:{tanks:cloneState(state.tanks),cisterna:state.cisterna,cisternKnown:state.stockAdjustment?.cisternKnown!==false},next:{camion,furgoneta,cisterna},cisternKnown:known};
 state.stockAdjustmentHistory??=[];state.stockAdjustmentHistory.push(record);state.stockAdjustment=record;
 state.tanks={camion,furgoneta};if(known)state.cisterna=cisterna;
 state.log.push({title:'Ajuste de existencias · Gerencia',desc:`Camión ${camion.map(fmt).join('/')} L · Furgoneta ${fmt(furgoneta[0])} L · Cisterna ${known?fmt(cisterna)+' L':'pendiente'} · ${reason}`,at:record.at});
 invalidateDraft('gerencia');await persist();toast('Ajuste guardado; historial anterior conservado');
}
function receivedPlanPanel(){
 const vehicle=state.vehicle,all=Object.values(state.receivedPlans||{}),plans=all.filter(p=>p.vehicle===vehicle),entries=plans.flatMap(p=>p.entries).sort((a,b)=>a.date.localeCompare(b.date)||a.client.localeCompare(b.client,'es'));
 const dates=[...new Set(entries.map(x=>x.date))];
 return `<h2 class="heading">Recibir planificación · Reparto</h2><div class="notice">Importa el Excel semanal enviado por Gerencia. No modifica los litros de los tanques ni registra descargas. Solo pruebas locales.</div>
 ${card(`<label class="field">Vehículo<select id="planReceiveVehicle"><option value="camion" ${vehicle==='camion'?'selected':''}>Camión · Iván</option><option value="furgoneta" ${vehicle==='furgoneta'?'selected':''}>Furgoneta · Nacho</option></select></label><label class="field">Excel de planificación .xlsx<input id="receivePlanFile" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label><p class="hint">La importación del mismo archivo no duplica entregas. Una versión más reciente sustituye la anterior del mismo vehículo y semana.</p>`)}
 ${card(`<h3>Planificación recibida · ${vehicle==='camion'?'Camión':'Furgoneta'}</h3><p class="compact">${plans.length} semanas · ${entries.length} entregas · ${fmt(entries.reduce((s,x)=>s+x.liters,0))} L previstos</p>${dates.map(date=>`<h3 class="spaced">${esc(date)}</h3>${entries.filter(x=>x.date===date).map(x=>`<div class="plan-received-item"><div class="row"><b>${esc(x.client)}</b><b>${fmt(x.liters)} L</b></div><p class="compact muted">${esc(x.town||'')} · ${esc(x.worker||'')}</p>${x.address?`<p class="tiny muted">${esc(x.address)}</p>`:''}</div>`).join('')}`).join('')||'<div class="empty">Todavía no se ha recibido una planificación para este vehículo.</div>'}`)}
 <p class="hint">Abre Descarga para atender los clientes pendientes. Finalizar una visita la retira de pendientes sin borrar su historial.</p>`;
}
async function receivePlanFile(file){
 if(state.role!=='reparto')return;
 if(!file.name.toLowerCase().endsWith('.xlsx'))return toast('Selecciona un Excel .xlsx');
 try{
  const plan=CDTPlanImport.parse(await file.arrayBuffer());
  if(plan.vehicle!==state.vehicle)return toast('El archivo es de otro vehículo. Selecciónalo antes de importar.');
  const key=plan.week+'|'+plan.vehicle,old=state.receivedPlans?.[key];
  if(old&&plan.version<old.version)return toast('Ya hay una versión más reciente de esta planificación');
  if(old&&plan.version===old.version){
   if(JSON.stringify(old.entries)===JSON.stringify(plan.entries))return toast('Esta planificación ya estaba importada; no se ha duplicado');
   return toast('Misma versión con datos diferentes. Solicita un Excel actualizado a Gerencia.');
  }
  if(old&&!confirm('Sustituir la planificación anterior de esta semana por la versión '+plan.version+'? No se modifican existencias.'))return;
  state.receivedPlans??={};state.receivedPlans[key]={...plan,importedAt:now(),filename:file.name};
  await persist();toast('Planificación recibida: '+plan.entries.length+' entregas');
 }catch(err){console.error(err);toast('No se pudo importar: '+err.message)}
}

// v0.9.18: inventarios por vehículo transferidos como fotografía completa, NUNCA como carga sumable.
function stockTransferPanel(){
 const received=state.stockTransfers||{};
 const status=Object.entries(received).map(([vehicle,r])=>`<p class="compact">${esc(vehicle)} · ${r.amounts.map((n,i)=>`T${i+1}: ${fmt(n)} L`).join(' · ')} · ${showTime(r.at)}</p>`).join('');
 if(state.role==='almacen')return card(`<h3>Regenerar existencias para Gerencia</h3><p class="hint">Genera un Excel con los saldos actuales, incluidos remanentes. No crea cargas nuevas. La jornada original puede seguir exportándose desde Enviar jornada.</p><label class="field">Vehículo<select id="stockExportVehicle"><option value="camion">Camión</option><option value="furgoneta">Furgoneta</option></select></label>${action('Exportar existencias actuales','export-stock')}`);
 if(state.role==='gerencia')return card(`<h3>Recibir existencias de Almacén</h3><p class="hint">Importa una fotografía completa de cada tanque; no suma las cargas otra vez. Revisa los saldos antes de confirmarlos. Los movimientos archivados permanecen independientes.</p><label class="field">Excel de existencias<input id="stockTransferFile" type="file" accept=".xlsx"></label>${status||'<p class="hint">Aún no hay inventarios recibidos.</p>'}<label class="field">Vehículo para Reparto<select id="stockExportVehicle"><option value="camion">Camión</option><option value="furgoneta">Furgoneta</option></select></label>${action('Enviar existencias a Reparto','export-stock')}`);
 return card(`<h3>Recibir existencias del vehículo</h3><p class="hint">Importa el inventario enviado por Gerencia. Reemplaza el saldo ficticio, no suma cargas. Si hay descargas registradas, elimina primero las visitas ficticias desde Historial o concilia las operaciones válidas.</p><label class="field">Excel de existencias<input id="stockTransferFile" type="file" accept=".xlsx"></label>${status||'<p class="hint">Existencias todavía sin verificar en este perfil.</p>'}`);
}
async function shareStockFile(vehicle){
 if(state.role==='reparto')return toast('Solo Almacén y Gerencia pueden emitir inventarios');
 let amounts,origin;
 if(state.role==='almacen'){amounts=state.tanks[vehicle].slice();origin='almacen'}
 else{const r=state.stockTransfers?.[vehicle];if(!r)return toast('Primero importa existencias de Almacén para ese vehículo');amounts=r.amounts.slice();origin='gerencia'}
 const id=origin==='almacen'?`CDT-${vehicle}-${amounts.join('-')}-${(state.loads||[]).filter(x=>x.vehicle===vehicle).map(x=>x.id).sort().join('-')}`:state.stockTransfers[vehicle].id;
 const stamp=origin==='almacen'?now():state.stockTransfers[vehicle].at;
 const tabs=[['Inventario',[['Campo','Valor'],['Formato','CDT-EXISTENCIAS-v1'],['Entorno','SOLO DEMOSTRACIÓN'],['Origen',origin],['Vehículo',vehicle],['ID inventario',id],['Fecha UTC',stamp]]],['Tanques',[['Tanque','Litros'],...amounts.map((n,i)=>[i+1,n])]]];
 const blob=SheetXLSX.generate(tabs),name=`control-tanques-existencias-${vehicle}.xlsx`,file=new File([blob],name,{type:blob.type});
 try{if(navigator.canShare?.({files:[file]})&&navigator.share)await navigator.share({files:[file],title:'Existencias · '+vehicle});else{const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),30000)}toast('Excel de existencias generado; no se ha registrado ninguna carga')}catch(e){if(e.name!=='AbortError')toast('No se pudo compartir el archivo')}
}
async function receiveStockFile(file){
 if(!file.name.toLowerCase().endsWith('.xlsx'))return toast('Selecciona un Excel');
 try{
  const r=CDTTransfer.parseStock(await file.arrayBuffer());
  if(state.role==='almacen')return toast('Almacén es el origen de existencias');
  if(state.role==='gerencia'&&r.source!=='almacen'||state.role==='reparto'&&r.source!=='gerencia')return toast('El archivo no procede del perfil esperado');
  if(state.role==='reparto'&&r.vehicle!==state.vehicle)return toast('Selecciona primero el vehículo indicado en el Excel');
  const prior=state.stockTransfers?.[r.vehicle];
  if(prior?.id===r.id&&JSON.stringify(prior.amounts)===JSON.stringify(r.amounts))return toast('Inventario ya recibido; no se ha duplicado');
  if(prior&&Date.parse(r.at)<Date.parse(prior.at))return toast('Archivo anterior al inventario recibido. No se sustituye');
  if(state.role==='reparto'&&((state.visits||[]).some(v=>v.vehicle===r.vehicle)||(state.openVisit?.vehicle===r.vehicle)))return toast('Hay descargas registradas: no se puede reemplazar el saldo sin conciliación');
  const old=state.tanks[r.vehicle];
  if(!confirm(`¿Sustituir saldos de ${r.vehicle}?\nActual: ${old.map(fmt).join(' / ')} L\nRecibido: ${r.amounts.map(fmt).join(' / ')} L\nNo se sumarán cargas ni se borrará el historial.`))return;
  state.stockTransfers??={};state.stockTransfers[r.vehicle]={...r,receivedAt:now()};
  state.tanks[r.vehicle]=r.amounts.slice();
  state.log.push({title:'Inventario recibido (DEMO)',desc:`${r.vehicle}: ${r.amounts.map(fmt).join(' / ')} L. ID ${r.id}`,at:now()});
  await persist();toast('Existencias recibidas y guardadas. No se han duplicado cargas');
 }catch(e){console.error(e);toast('Excel no válido: '+e.message)}
}

function adminPage(){
 if(!TankCloud.connected())return TankCloud.panel()+legacyAdminPage();
 if(!TankCloud.member()?.active)return TankCloud.panel();
 return '<h2 class="heading">Más</h2>'+TankCloud.panel()+updatePanel()+
 (state.role==='gerencia'?card('<h3>Gerencia</h3>'+action('Saldos y movimientos','go-gerencia')+action('Clientes','go-clientes')+action('Planificación','go-planificacion')):'')+
 (state.role==='gerencia'?stockAdjustmentPanel():'')+
 card('<h3>Copia de seguridad</h3><p>Descarga los perfiles de esta cuenta y la cola de sincronización. No borra datos. Si hay pendientes o la cuenta está desactivada, descarga una copia antes de cerrar sesión.</p>'+action('Descargar copia JSON','backup',true));
}
function legacyAdminPage(){return '<div class="notice">DEMO: inicia sesión con una cuenta de pruebas autorizada.</div>';}

// v0.4 · Excel local por día y perfil. No hay identificación auténtica ni control de permisos todavía.
const localDay=iso=>{if(!iso)return '';const d=new Date(iso);if(Number.isNaN(d.getTime()))return '';return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')};
let journalDate=localDay(new Date().toISOString());
let journalWorker='Operario de prueba';
const journalRole=()=>state.role==='almacen'?'almacen':state.role==='reparto'?'reparto':null;
const journalKey=(date,role)=>`${date}|${role}`;
// Cada envío es un lote inmutable; los movimientos ya enviados no se vuelven a incluir.
function currentBatchKey(date,role){
 const base=journalKey(date,role),sent=state.sentJournals||{},prepared=state.preparedJournals||{};
 if(prepared[base]&&!sent[base])return base;
 if(!sent[base])return base;
 let n=2;
 while(sent[`${base}|${n}`])n++;
 return `${base}|${n}`;
}
function latestSentKey(date,role){const base=journalKey(date,role),keys=Object.keys(state.sentJournals||{}).filter(k=>k===base||k.startsWith(base+'|'));return keys.sort((a,b)=>Number((b.split('|')[2]||1))-Number((a.split('|')[2]||1)))[0]||base;}

function invalidateDraft(role){if(!state.preparedJournals)return;for(const k of Object.keys(state.preparedJournals))if(k.split('|')[1]===role)delete state.preparedJournals[k];}
function journalSources(date,role){
 const loads=role==='almacen'?state.loads.filter(l=>localDay(l.at)===date&&!l.sentAt):[];
 const visits=role==='reparto'?state.visits.filter(v=>localDay(v.started)===date&&!v.sentAt):[];
 const cancellations=role==='reparto'?(state.cancellations||[]).filter(c=>localDay(c.at)===date&&!c.sentAt):[];
 return {loads,visits,cancellations};
}
function journalSnapshot(date,role){
 const {loads,visits,cancellations}=journalSources(date,role);
 const movements=[];
 if(role==='almacen')for(const l of loads)movements.push([l.id,'CARGA',l.vehicle,l.index+1,'', '',l.amount,l.merma||0, l.at]);
 else for(const v of visits)for(const d of v.discharges)movements.push([d.id,'DESCARGA',v.vehicle,d.source+1,v.client,Number(d.dest),d.liters,0,d.at]);
 const corrections=[...visits.flatMap(v=>(v.corrections||[]).map(c=>[c.id,v.id,c.dischargeId,c.reason,JSON.stringify(c.previous),JSON.stringify(c.next),c.at])),...cancellations.map(c=>[c.id,c.visitId,c.dischargeId,'ANULACION_CDT',JSON.stringify({vehicle:c.vehicle,client:c.client,liters:c.liters}),JSON.stringify({reason:c.reason}),c.at])];
 const resets=visits.flatMap(v=>(v.resets||[]).map(r=>[r.id,v.id,r.afterDischargeId,r.readingBefore,r.at]));
 const meta={id:uid(),date,role,worker:journalWorker,vehicle:state.vehicle,createdAt:now(),demo:true};
 const provisional=role==='reparto'?(state.provisionalHistory||[]).filter(p=>p.date===date).map(p=>({id:p.id,vehicle:p.vehicle,at:p.at,amounts:p.amounts,status:p.status})):[];
 return {meta,provisional,movements,loads:loads.map(l=>[l.id,l.vehicle,l.index+1,l.amount,l.merma||0,l.at]),visits:visits.map(v=>[v.id,v.vehicle,v.client,v.started,v.ended,v.discharges.length]),discharges:visits.flatMap(v=>v.discharges.map(d=>[d.id,v.id,v.vehicle,v.client,d.source+1,d.dest,d.segment||0,d.reading,d.liters,d.at])),corrections,resets,cancellationIds:cancellations.map(c=>c.id)};
}
function journalTabs(s){
 const m=s.meta;
 return [
 ['Jornada',[['Campo','Valor'],['ID de jornada',m.id],['Fecha',m.date],['Perfil',m.role],['Operario (demo)',m.worker],['Vehículo orientativo',m.vehicle],['Entorno','SOLO DEMOSTRACIÓN'],['Formato','CDT-v0.4'],['Exportación UTC',m.createdAt]]],
 ['Movimientos',[['ID','Tipo','Vehículo','Tanque origen','Cliente','Tanque destino','Litros','Merma (L)','Fecha y hora'],...s.movements]],
 ['Cargas',[['ID','Vehículo','Tanque','Litros cargados','Merma','Fecha y hora'],...s.loads]],
 ['Visitas',[['ID','Vehículo','Cliente','Inicio','Fin','Nº descargas'],...s.visits]],
 ['Descargas',[['ID','ID visita','Vehículo','Cliente','Tanque origen','Tanque cliente','Tramo contador','Lectura acumulada','Litros','Fecha y hora'],...s.discharges]],
 ['Correcciones',[['ID','ID visita','ID descarga','Motivo','Valor anterior','Valor corregido','Fecha y hora'],...s.corrections]],
 ['Reinicios',[['ID','ID visita','Tras descarga','Lectura anterior','Fecha y hora'],...s.resets]],
 ['Control',[['Parámetro','Valor'],['Formato','CDT-v0.4'],['ID jornada',m.id],['Fecha',m.date],['Perfil',m.role],['Duplicados','Usar IDs únicos, no sumar dos veces'],['Control de tiempos','No implementado; NO usar con datos reales'],['Aperturas provisionales',JSON.stringify(s.provisional||[])],['Revisión provisional',(s.provisional||[]).length?'PENDIENTE DE GERENCIA':'NINGUNA']]]
 ];
}
function journalPage(){
 const role=journalRole();if(!role)return `<h2 class="heading">Enviar jornada</h2><div class="notice">Cambia a Almacén o Reparto para exportar la jornada de ese perfil. Gerencia tendrá su propio sistema de importación en la siguiente fase.</div>${action('Volver a Más','go-admin',true)}`;
 const sent=state.sentJournals?.[latestSentKey(journalDate,role)];const batchKey=currentBatchKey(journalDate,role);const {loads,visits,cancellations}=journalSources(journalDate,role),items=role==='almacen'?loads.length:visits.reduce((n,v)=>n+v.discharges.length,0)+cancellations.length,liters=role==='almacen'?loads.reduce((n,v)=>n+v.amount,0):visits.reduce((n,v)=>n+v.discharges.reduce((t,d)=>t+d.liters,0),0);
 return `<h2 class="heading">Envíos manuales por lotes</h2><div class="notice">Puedes enviar varias veces en un mismo día, sin recordatorios. Cada lote incluye solo movimientos pendientes. Exportación Excel local · SOLO DATOS DE PRUEBA. No hay envío automático ni recepción confirmada.</div><label class="field">Fecha de la jornada<input type="date" id="journalDate" value="${esc(journalDate)}"></label><label class="field">Operario (etiqueta de prueba)<input id="journalWorker" value="${esc(journalWorker)}" maxlength="70" placeholder="Operario de prueba"></label>${card(`<div class="row"><b>Perfil</b><b>${role==='almacen'?'Almacén':'Reparto'}</b></div><div class="row"><span>Movimientos</span><b>${items}</b></div><div class="row"><span>Litros</span><b>${fmt(liters)} L</b></div><div class="row"><span>Estado</span><b>${items?'Movimientos nuevos pendientes':sent?'Último lote enviado':'Sin movimientos'}</b></div>`)}${sent?card(`<h3>Último lote enviado</h3><p class="hint">Puedes reenviar el último Excel sin generar identificadores nuevos.</p>${action('Reenviar mismo Excel','resend-xlsx')}`):''}${items?`${state.openVisit&&localDay(state.openVisit.started)===journalDate?`<div class="notice">Hay una visita abierta. Solo se exportarán movimientos ya finalizados o anulaciones pendientes.</div>`:''}${action('Generar y compartir Excel','make-xlsx')}<p class="hint">Después de comprobar que has compartido el archivo, podrás marcar la jornada como enviada. Si cancelas el envío, déjala editable.</p>${state.preparedJournals?.[batchKey]?action('Confirmar envío de este lote','mark-sent',true):''}`:''}<p class="hint">El archivo conserva las operaciones, correcciones y reinicios. No borra nada del móvil. Las horas guardadas son marcas de eventos; todavía NO existe control real de duración ni cifrado.</p>${action('Volver a Más','go-admin',true)}`;
}
async function sendJournal(resend){
 const role=journalRole();if(!role)return toast('Selecciona perfil Almacén o Reparto');
 const key=resend?latestSentKey(journalDate,role):currentBatchKey(journalDate,role);
 if(!resend&&(()=>{const x=journalSources(journalDate,role);return role==='almacen'?!x.loads.length:!x.visits.length&&!x.cancellations.length})())return toast('No hay movimientos cerrados para esa jornada');
 let snapshot;
 if(resend){snapshot=state.sentJournals?.[key];if(!snapshot)return toast('No hay una jornada enviada para reenviar');}
 else{state.preparedJournals??={};snapshot=state.preparedJournals[key]||journalSnapshot(journalDate,role);state.preparedJournals[key]=snapshot;await write();}
 const file=`control-tanques-DEMO-${role}-${journalDate}-lote-${key.split('|')[2]||1}.xlsx`;
 const blob=SheetXLSX.generate(journalTabs(snapshot));const xfile=typeof File==='function'?new File([blob],file,{type:blob.type}):null;
 try{if(xfile&&navigator.canShare?.({files:[xfile]})&&navigator.share){await navigator.share({files:[xfile],title:'Jornada de prueba · Control de Tanques'});toast('Compartir completado; confirma después si realmente se envió');}
 else{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=file;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);toast('Excel descargado. Compártelo desde Archivos.');}}
 catch(err){if(err.name==='AbortError')toast('No se completó el compartir. Puedes intentarlo de nuevo.');else {console.error(err);toast('No se pudo compartir. Inténtalo de nuevo.')}}
 render();
}
async function markJournalSent(){
 const role=journalRole(),key=currentBatchKey(journalDate,role),draft=state.preparedJournals?.[key];
 if(!draft)return toast('Genera primero el Excel');
 if(!confirm('¿Has enviado o guardado el archivo correctamente? Este lote quedará registrado como enviado. Los siguientes movimientos podrán enviarse en otros lotes. El sistema NO puede comprobar la recepción en Gerencia.'))return;
 state.sentJournals??={};state.sentJournals[key]=structuredClone(draft);
 for(const v of state.visits)if(role==='reparto'&&draft.visits.some(row=>row[0]===v.id))v.sentAt=now();
 for(const l of state.loads)if(role==='almacen'&&draft.loads.some(row=>row[0]===l.id))l.sentAt=now();
 for(const c of state.cancellations||[])if(role==='reparto'&&(draft.cancellationIds||[]).includes(c.id))c.sentAt=now();
 for(const v of state.visits||[])if(v.cancelledAt&&(state.cancellations||[]).filter(c=>c.visitId===v.id).every(c=>c.sentAt))v.cancellationSentAt=now();
 delete state.preparedJournals[key];await persist();toast('Lote enviado. Puedes generar otros lotes hoy sin duplicar movimientos');
}


// Gerencia v0.6: archivo local de prueba y conciliación cronológica, sin sincronización central.
// No modifica los saldos de los trabajadores ni constituye base sincronizada.
function managerState(){state.manager??={journals:{},movements:{},incidents:[],lastResult:null};return state.manager}
// Solo vista informativa: los saldos de Inicio y los movimientos importados nunca se sobrescriben.
// La apertura se declara ANTES de la primera operación importada (no es un inventario actual).
const vehicleTanks={camion:3,furgoneta:1};
function parseOpening(g){
 const o=g.opening;
 if(!o||!Array.isArray(o.camion)||!Array.isArray(o.furgoneta)||o.camion.length!==3||o.furgoneta.length!==1||
  ![o.cisterna,...o.camion,...o.furgoneta].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=25000))return null;
 if(o.cisterna>25000||[...o.camion,...o.furgoneta].some(n=>n>1000))return null;
 return o;
}
function reconcileManager(g){
 const opening=parseOpening(g), imported=Object.values(g.movements||{}).filter(m=>!g.cancellations?.[m.id]);
 const sorted=imported.slice().sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)||String(a.id).localeCompare(String(b.id)));
 const results={}, problems=[];
 if(!opening){
  for(const m of sorted)results[m.id]={status:'pendiente',reason:'Indicar existencias iniciales para conciliar'};
  return {ready:false,results,problems:[],accepted:0,pending:sorted.length,balances:null};
 }
 const balances={cisterna:opening.cisterna,camion:opening.camion.slice(),furgoneta:opening.furgoneta.slice()};
 const blocked={cisterna:false,camion:false,furgoneta:false};
 let accepted=0,pending=0;
 // Todos los movimientos guardados se vuelven a calcular a cada importación.
 for(const m of sorted){
  let reason='';const v=m.vehicle,t=Number(m.tank)-1;
  const qty=Number(m.litres),loss=Number(m.loss||0);
  if(!['camion','furgoneta'].includes(v)||!Number.isInteger(t)||t<0||t>=vehicleTanks[v]||
       !Number.isFinite(qty)||qty<=0||!Number.isFinite(loss)||loss<0||!Number.isFinite(Date.parse(m.time)))reason='Movimiento incompleto o inválido';
  else if(blocked[v]||(m.type==='CARGA'&&blocked.cisterna))reason='Pendiente de resolver un movimiento anterior del vehículo o cisterna';
  else if(m.type==='CARGA'){
   // La merma de la carga debe corresponder al sobrante previo completo, o ser cero.
   const previous=balances[v][t];
   if(qty>balances.cisterna+1e-6)reason='Cisterna sin saldo suficiente o recepción de fábrica no registrada';
   else if(loss>0&&Math.abs(loss-previous)>1e-6)reason='Merma diferente del sobrante teórico del tanque';
   else if(previous-loss+qty>1000+1e-6)reason='Capacidad del tanque superada';
   else{balances.cisterna=Number((balances.cisterna-qty).toFixed(6));balances[v][t]=Number((previous-loss+qty).toFixed(6))}
  }else if(m.type==='DESCARGA'){
   if(qty>balances[v][t]+1e-6)reason='Descarga superior al saldo disponible; puede faltar una carga';
   else balances[v][t]=Number((balances[v][t]-qty).toFixed(6));
  }else reason='Tipo de movimiento desconocido';
  if(reason){
   results[m.id]={status:'pendiente',reason};problems.push({id:m.id,vehicle:v,tank:t+1,reason});pending++;
   // No seguir aprobando otros movimientos que dependan de stock ya dudoso.
   if(['camion','furgoneta'].includes(v))blocked[v]=true;
   if(m.type==='CARGA')blocked.cisterna=true;
  }else{results[m.id]={status:'conciliado'};accepted++}
 }
 return {ready:true,results,problems,accepted,pending,balances};
}
function reconciliationPanel(g){
 const r=reconcileManager(g),o=parseOpening(g),tanks=r.balances;
 const quantity=(id,label,value,max)=>`<label class="field">${label}<input inputmode="decimal" type="number" step="0.01" min="0" max="${max}" id="${id}" value="${value===null?'':esc(value)}" placeholder="Litros iniciales"></label>`;
 const openingCard=card(`<h3>Existencias iniciales de prueba</h3><p class="hint">Introduce cantidades existentes ANTES de la primera operación de todos los Excel importados. No son los litros actuales del móvil. No alteran el Inicio ni los movimientos. Si no conoces los saldos, deja pendiente la conciliación.</p><form id="openingForm" class="form">${quantity('openingCisterna','Cisterna principal (máx. 25.000 L)',o?.cisterna??null,25000)}<h4>Camión</h4>${[0,1,2].map(i=>quantity('openingCamion'+i,`Tanque ${i+1} (máx. 1.000 L)`,o?.camion[i]??null,1000)).join('')}<h4>Furgoneta</h4>${quantity('openingFurgoneta','Tanque 1 (máx. 1.000 L)',o?.furgoneta[0]??null,1000)}<button class="btn" type="submit">Guardar saldos iniciales y recalcular</button></form>${o?action('Quitar saldos iniciales de pruebas','clear-opening',true):''}`);
 const overview=card(`<h3>Conciliación cronológica</h3><div class="row"><span>Movimientos conciliados</span><b>${r.accepted}</b></div><div class="row"><span>Movimientos pendientes</span><b>${r.pending}</b></div><p class="hint">Orden cronológico de los archivos importados. Al recibir más Excel se recalcula todo. Las cantidades no son saldos oficiales hasta comprobar los registros de apertura, cargas y recepciones de fábrica.</p>${!r.ready?'<div class="notice">Introduce los saldos iniciales para activar la simulación de conciliación.</div>':''}`);
 const balanceCard=tanks?card(`<h3>Saldo calculado · No oficial</h3><div class="row"><span>Cisterna principal</span><b>${fmt(tanks.cisterna)} L</b></div>${['camion','furgoneta'].map(v=>`<h4>${v==='camion'?'Camión':'Furgoneta'} ${r.problems.some(p=>p.vehicle===v)?'· Pendiente':''}</h4>${tanks[v].map((n,i)=>`<div class="row"><span>Tanque ${i+1}</span><b>${fmt(n)} L</b></div>`).join('')}`).join('')}<p class="hint">Si hay incidencias, los saldos afectados solo reflejan movimientos anteriores validados, no el inventario actual.</p>`):'';
 const problemCard=r.problems.length?card(`<h3>Movimientos pendientes</h3>${r.problems.slice(0,15).map(x=>`<p class="compact"><b>${esc(x.vehicle||'')}, tanque ${Number(x.tank)||'—'}</b> · ${esc(x.reason)} <span class="muted mono">${esc(String(x.id).slice(0,10))}</span></p>`).join('')}${r.problems.length>15?`<p class="hint">Y ${r.problems.length-15} incidencias más.</p>`:''}`):'';
 const movements=Object.values(g.movements||{}).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)||String(a.id).localeCompare(String(b.id)));
 const detailCard=card(`<h3>Detalle de conciliación por movimiento</h3><p class="hint">Registro de auditoría local de pruebas. No confirma recepciones reales ni modifica existencias del operario.</p>${movements.length?movements.map(m=>{
  const result=r.results[m.id]||{status:'pendiente',reason:'Sin evaluar'};
  const validTime=Number.isFinite(Date.parse(m.time))?new Date(m.time).toLocaleString('es-ES'):'Fecha no válida';
  const status=result.status==='conciliado'?'Conciliado':'Pendiente';
  const vehicle=m.vehicle==='camion'?'Camión':m.vehicle==='furgoneta'?'Furgoneta':String(m.vehicle||'—');
  return `<div class="audit-movement"><div class="row"><b>${esc(String(m.type||'Movimiento'))} · ${esc(vehicle)} · Tanque ${esc(String(m.tank??'—'))}</b><strong>${esc(status)}</strong></div><div class="row"><span>${esc(validTime)}</span><b>${fmt(Number(m.litres)||0)} L</b></div>${result.reason?`<p class="hint">${esc(result.reason)}</p>`:''}<p class="hint mono">ID: ${esc(String(m.id||'—'))}</p></div>`;
 }).join(''):'<p class="hint">Todavía no hay movimientos importados.</p>'}`);
 return overview+openingCard+balanceCard+problemCard+detailCard;
}
async function saveOpening(){
 const n=id=>{const field=el(id);if(!field||field.value.trim()==='')return NaN;return Number(field.value)};
 const opening={cisterna:n('openingCisterna'),camion:[0,1,2].map(i=>n('openingCamion'+i)),furgoneta:[n('openingFurgoneta')]};
 if(!Number.isFinite(opening.cisterna)||opening.cisterna<0||opening.cisterna>25000||
    [...opening.camion,...opening.furgoneta].some(x=>!Number.isFinite(x)||x<0||x>1000))return toast('Indica litros válidos en todos los campos');
 if(!confirm(TankCloud.connected()?'¿Compartir estos saldos de apertura y recalcular los movimientos de todos los dispositivos?':'¿Guardar los saldos iniciales de pruebas?'))return;
 managerState().opening=opening;await persist();toast('Conciliación de pruebas recalculada');
}

// Fase v0.7: intercambio de cargas en Excel (demostración local, sin autenticación).
const handoffMarker='CDT-TRASPASO-v0.7';
function handoffSummary(){const a=state.receivedLoads||{};return `Cargas recibidas en este dispositivo: ${Object.keys(a).length}. Pendientes: ${(state.pendingLoads||[]).length}.`}
function handoffRows(vehicle){
 const g=managerState(),recon=reconcileManager(g);
 const loads=Object.values(g.movements||{}).filter(m=>m.type==='CARGA'&&m.vehicle===vehicle&&recon.results[m.id]?.status==='conciliado').sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)||a.id.localeCompare(b.id));
 const stamp=now(),tag=uid();
 return {loads,tabs:[['Traspaso',[['Campo','Valor'],['Formato',handoffMarker],['Entorno','SOLO DEMOSTRACIÓN'],['Vehículo',vehicle],['ID traspaso',tag],['Generado UTC',stamp],['Nº cargas',loads.length]]],['Cargas',[['ID carga','Vehículo','Tanque','Litros cargados','Merma','Fecha y hora','ID jornada'],...loads.map(m=>[m.id,m.vehicle,m.tank,m.litres,m.loss||0,m.time,m.journalId])]] ]};
}
async function exportHandoff(){
 if(state.role!=='gerencia')return;
 const vehicle=el('handoffVehicle')?.value||'camion',r=handoffRows(vehicle);
 if(!r.loads.length)return toast('No hay cargas conciliadas para ese vehículo. Importa primero un Excel de Almacén y revisa los saldos iniciales.');
 const filename=`control-tanques-DEMO-cargas-${vehicle}-${new Date().toISOString().slice(0,10)}.xlsx`;
 const blob=SheetXLSX.generate(r.tabs),file=new File([blob],filename,{type:blob.type});
 try{if(navigator.canShare?.({files:[file]})&&navigator.share)await navigator.share({files:[file],title:'Cargas para reparto · DEMO'});
 else{const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),30000)}toast('Archivo de traspaso preparado. Envía solo al repartidor correcto.');}
 catch(err){if(err.name!=='AbortError'){console.error(err);toast('Error al compartir el archivo')}else toast('Envío cancelado')}
}
async function receiveHandoff(file){
 if(state.role!=='reparto')return toast('Selecciona Reparto');
 if(state.openVisit)return toast('Finaliza la visita antes de importar cargas');
 try{
  const parsed=CDTTransfer.parse(await file.arrayBuffer());
  if(parsed.vehicle!==state.vehicle)return toast('El archivo corresponde a otro vehículo. Cambia de vehículo antes de importar.');
  state.receivedLoads??={};state.pendingLoads??=[];
  let added=0,duplicates=0,pending=0;
  for(const m of parsed.loads){
   if(state.receivedLoads[m.id]||(state.loads||[]).some(l=>l.id===m.id)){duplicates++;continue}
   if(provisionalFor(m.vehicle)){
    if(!state.pendingLoads.some(x=>x.id===m.id))state.pendingLoads.push({...m,reason:'Apertura provisional: requiere conciliación de Gerencia; no sumar al saldo declarado'});
    pending++;continue;
   }
   const t=m.tank-1,previous=state.tanks[m.vehicle][t];
   const proposed=previous-m.loss+m.litres;
   if(m.loss>0&&Math.abs(m.loss-previous)>0.001||proposed<0||proposed>1000){
    if(!state.pendingLoads.some(x=>x.id===m.id))state.pendingLoads.push({...m,reason:'No coincide el saldo local o la capacidad del tanque; requiere revisión de Gerencia'});
    pending++;continue;
   }
   state.tanks[m.vehicle][t]=Number(proposed.toFixed(4));state.receivedLoads[m.id]={...m,receivedAt:now()};
   state.pendingLoads=state.pendingLoads.filter(x=>x.id!==m.id);
   state.log.push({title:'Carga de Gerencia (demo)',desc:`${m.vehicle}, tanque ${m.tank}: +${fmt(m.litres)} L, merma ${fmt(m.loss)} L. ID ${m.id}`,at:now()});added++;
  }
  state.lastHandoff={file:file.name,added,duplicates,pending,at:now()};
  await persist();toast(`Cargas: ${added} aplicadas, ${duplicates} repetidas, ${pending} pendientes`);
 }catch(err){console.error(err);toast(err.message||'Archivo de cargas inválido')}
}
function managerPage(){
 if(!TankCloud.connected())return legacyManagerPage();
 const g=cloneState(managerState()),adjustment=state.stockAdjustment;
 let info='';
 if(adjustment){g.opening=adjustment.next;g.movements=Object.fromEntries(Object.entries(g.movements).filter(([,m])=>m.time>adjustment.at));info=card('<h3>Último ajuste de existencias</h3><p>'+showTime(adjustment.at)+' · '+esc(adjustment.reason)+'</p><p class="hint">El saldo se calcula desde este ajuste. El historial anterior se conserva.</p>');}
 let panel=reconciliationPanel(g);
 if(adjustment)panel=panel.replace(/<form id="openingForm"[\s\S]*?<\/form>/,'');
 const visits=(state.visits||[]).concat(state.openVisit?[state.openVisit]:[]);
 const audit=card('<h3>Visitas y correcciones</h3>'+visits.slice().sort((a,b)=>b.started.localeCompare(a.started)).map(v=>'<details><summary>'+esc(v.client)+' · '+showTime(v.started)+'</summary><p>'+esc(v.vehicle)+' · '+(v.ended?'Fin: '+showTime(v.ended):'En curso')+'</p><p>Correcciones: '+(v.corrections||[]).length+' · Reinicios: '+(v.resets||[]).length+'</p>'+(v.corrections||[]).map(c=>'<p>'+esc(c.reason)+' · '+showTime(c.at)+' · '+fmt(c.previous?.liters)+' → '+fmt(c.next?.liters)+' L</p>').join('')+'</details>').join(''));
 return '<h2 class="heading">Gerencia · Saldos y movimientos</h2><p class="hint">Movimientos recibidos automáticamente. Las visitas en curso también descuentan las descargas ya registradas.</p>'+info+audit+panel.replaceAll('de prueba','').replaceAll('ficticios','iniciales').replaceAll('Excel importados','movimientos registrados').replaceAll('archivos importados','movimientos sincronizados').replaceAll('No alteran el Inicio ni los movimientos.','Se comparten con todos los dispositivos.').replaceAll('No oficial','calculado');
}
function legacyManagerPage(){
 const g=managerState(),journals=Object.values(g.journals),movements=Object.values(g.movements);
 const last=g.lastResult;
 return `<h2 class="heading">Gerencia · Importar jornadas</h2><div class="notice">DEMOSTRACIÓN LOCAL. Sin autenticación ni sincronización real. Conciliación de saldos ficticios, separada de Inicio. Solo Excel CDT-v0.4.</div>
 ${card(`<h3>Seleccionar Excel de jornada</h3><label class="field">Archivo .xlsx<input id="managerFile" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label><p class="hint">Al seleccionar el Excel, importa automáticamente los movimientos válidos. Un ID repetido nunca se contabiliza dos veces.</p>`)}
 ${last?card(`<h3>Último resultado de importación</h3><div class="row"><span>Archivo</span><b>${esc(last.file)}</b></div><div class="row"><span>Importados</span><b>${last.added}</b></div><div class="row"><span>Duplicados</span><b>${last.duplicates}</b></div><div class="row"><span>Anulaciones nuevas</span><b>${last.annulled||0}</b></div><div class="row"><span>Incidencias</span><b>${last.issues}</b></div><p class="hint">${esc(last.note)}</p>`):''}
 ${card(`<h3>Archivo general local (pruebas)</h3><div class="row"><span>Jornadas registradas</span><b>${journals.length}</b></div><div class="row"><span>Movimientos únicos</span><b>${movements.length}</b></div><div class="row"><span>Descargas anuladas</span><b>${Object.keys(g.cancellations||{}).length}</b></div><div class="row"><span>Litros de cargas importadas</span><b>${fmt(movements.filter(x=>x.type==='CARGA').reduce((s,x)=>s+x.litres,0))} L</b></div><div class="row"><span>Litros de descargas importadas</span><b>${fmt(movements.filter(x=>x.type==='DESCARGA').reduce((s,x)=>s+x.litres,0))} L</b></div><div class="row"><span>Incidencias acumuladas</span><b>${g.incidents.length}</b></div><p class="hint">Los totales son movimientos archivados. La conciliación se muestra separada y no modifica Inicio.</p>`)}
 ${journals.some(j=>(j.provisional||[]).length)?card(`<h3>Existencias provisionales · Pendientes de Gerencia</h3>${journals.flatMap(j=>(j.provisional||[]).map(p=>`<p class="compact"><b>${esc(j.date)} · ${esc(p.vehicle)}</b> · ${p.amounts.map((n,i)=>`T${i+1} ${fmt(n)} L`).join(' · ')}<br><span class="muted">Declaración del repartidor, NO conciliada con cargas.</span></p>`)).join('')}<p class="hint">La conciliación de saldos no valida por sí sola estas declaraciones; verificar contra cargas originales antes de aprobar.</p>`):''}
 ${g.incidents.length?card(`<h3>Incidencias recientes</h3>${g.incidents.slice(-8).reverse().map(x=>`<p class="compact">${esc(x.file)} · ${esc(x.id)}: ${esc(x.reason)}</p>`).join('')}`):''}
 ${journals.length?card(`<h3>Jornadas importadas</h3>${journals.slice().reverse().slice(0,12).map(j=>`<div class="row"><span>${esc(j.date)} · ${esc(j.role)}</span><b>${esc(j.worker)}</b></div>`).join('')}`):''}
 ${Object.values(g.cancellations||{}).length?card(`<h3>Anulaciones recibidas · auditoría</h3>${Object.values(g.cancellations).slice(-12).reverse().map(c=>`<p class="compact"><b>${esc(c.client)}</b> · ${fmt(c.liters)} L · ${esc(c.vehicle)} · ${esc(c.reason)} · Ref. ${esc(c.dischargeId)}${g.movements[c.dischargeId]?' · Original localizado':' · Original pendiente'}</p>`).join('')}<p class="hint">Se conserva el movimiento original. La conciliación excluye las descargas anuladas; los saldos de Inicio no cambian automáticamente.</p>`):''}
 ${stockTransferPanel()}${reconciliationPanel(g)}
 ${card(`<h3>Comunicar cargas al repartidor · Pruebas</h3><p class="hint">Se exportan únicamente cargas conciliadas de Almacén. No incluye duraciones ni datos reales. Si no hay cargas conciliadas, no se generará archivo.</p><label class="field">Vehículo<select id="handoffVehicle"><option value="camion">Camión</option><option value="furgoneta">Furgoneta</option></select></label>${action('Generar Excel de cargas','export-handoff')}`)}
 ${action('Descargar copia JSON','backup',true)}`;
}
// Comparación canónica: no depende del orden de las propiedades ni de metadatos adicionales.
// journalId identifica la exportación/jornada, no el contenido físico del movimiento.
// Los cambios reales en campos del movimiento siguen generando incidencia.
const MOVEMENT_FIELDS=['id','type','vehicle','tank','client','dest','litres','loss','time','date','role'];
function movementDifferences(a,b){
 return MOVEMENT_FIELDS.filter(k=>{
  const x=a[k],y=b[k];
  if(k==='litres'||k==='loss'||k==='tank')return !(Number.isFinite(Number(x))&&Number.isFinite(Number(y))&&Math.abs(Number(x)-Number(y))<0.000001);
  return String(x??'')!==String(y??'');
 });
}
async function importManagerFile(file){
 if(state.role!=='gerencia'){toast('Selecciona la vista Gerencia (demo)');return}
 if(!file.name.toLowerCase().endsWith('.xlsx')){toast('Selecciona un archivo XLSX');return}
 try{
  const parsed=CDTImport.parse(await file.arrayBuffer()),g=managerState();
  g.cancellations??={};let annulled=0,annulDuplicates=0;
  const already=g.journals[parsed.meta.id];let added=0,duplicates=0,issues=0;
  const accepted=[];const notices=[...parsed.issues.map(x=>({file:file.name,id:x.id,reason:x.reason}))];
  for(const m of parsed.movements){
   const prior=g.movements[m.id];
   if(prior){const changed=movementDifferences(prior,m);if(changed.length){issues++;notices.push({file:file.name,id:m.id,reason:'ID existente con contenido diferente (campos: '+changed.join(', ')+')'})}else duplicates++;}
   else{accepted.push(m);added++;}
  }
  issues+=parsed.issues.length;
  for(const c of parsed.cancellations||[]){
   const previous=g.cancellations[c.dischargeId];
   if(previous){if(previous.id===c.id)annulDuplicates++;else{issues++;notices.push({file:file.name,id:c.id,reason:'Anulación diferente para la misma descarga'})}continue;}
   g.cancellations[c.dischargeId]={...c,sourceFile:file.name,receivedAt:now()};annulled++;
   if(!g.movements[c.dischargeId]){issues++;notices.push({file:file.name,id:c.id,reason:'Anulación recibida antes del movimiento original: pendiente de conciliación'})}
  }
  // Se guarda un lote completo de movimientos validados y resumen en una sola escritura IndexedDB.
  for(const m of accepted)g.movements[m.id]=m;
  if(!already)g.journals[parsed.meta.id]={...parsed.meta,source:file.name,firstImport:now(),rows:parsed.summary.rows,provisional:parsed.provisional||[]};
  g.incidents.push(...notices);
  g.lastResult={file:file.name,added,duplicates,issues,annulled,annulDuplicates,note:already?'Esta jornada ya existía. Solo se incorporaron IDs que faltaban.':'Registro local de prueba actualizado.'};
  await persist();toast(`Excel leído: ${added} nuevos, ${annulled} anulaciones, ${duplicates+annulDuplicates} repetidos, ${issues} incidencias`);
 }catch(err){console.error('Importación',err);toast(err.message||'No se pudo importar el Excel');}
}


// Catálogo local de Gerencia: no se transmite aún a Reparto.
let editingCustomer=null;
// Coordenadas de enlaces Google Maps comunes; enlaces cortos se abren directamente en Google Maps.
function customerCoordinates(raw){
 try{
  const u=new URL(raw); if(!['https:','http:'].includes(u.protocol))return null;
  const q=u.searchParams.get('q')||u.searchParams.get('query')||'';
  const patterns=[/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/, /[?&](?:q|query)=(-?\d{1,2}\.\d+)%2C(-?\d{1,3}\.\d+)/i, /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/];
  for(const candidate of [u.href,q])for(const pat of patterns){const m=candidate.match(pat);if(m){const lat=Number(m[1]),lng=Number(m[2]);if(Math.abs(lat)<=90&&Math.abs(lng)<=180)return `${lat},${lng}`;}}
 }catch{}return null;
}
let locationCustomerId=null;
function openCustomerLocation(id){
 const c=(state.customers||[]).find(x=>x.id===id);if(!c)return;
 if(!c.direccion&&!c.ubicacionUrl)return toast('Añade primero una dirección o enlace de ubicación al cliente');
 locationCustomerId=id;const sheet=document.getElementById('navigationSheet');if(sheet){sheet.hidden=false;document.getElementById('navigationClient').textContent=c.nombre;}
}
function closeNavigationSheet(){locationCustomerId=null;const sheet=el('navigationSheet');if(sheet)sheet.hidden=true;}
function navigateCustomerWith(provider){
 const c=(state.customers||[]).find(x=>x.id===locationCustomerId);if(!c)return closeNavigationSheet();
 const raw=String(c.ubicacionUrl||'').trim(),address=String(c.direccion||'').trim(),coords=customerCoordinates(raw),dest=coords||[address,c.poblacion].filter(Boolean).join(', ');
 let url='';
 if(provider==='google'){
  try{const u=new URL(raw);if(u.protocol==='https:'&&(/(^|\.)google\.[a-z.]+$/.test(u.hostname)||['maps.app.goo.gl','goo.gl'].includes(u.hostname)))url=u.href;}catch{}
  url||='https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(dest);
 }else if(dest){url=provider==='waze'?'https://waze.com/ul?q='+encodeURIComponent(dest)+'&navigate=yes':'https://maps.apple.com/?daddr='+encodeURIComponent(dest);}
 else {toast('Para Waze o Apple Maps añade dirección o coordenadas al cliente');return;}
 closeNavigationSheet();window.location.href=url;
}
const WEEKDAYS=['Lunes','Martes','Miércoles','Jueves','Viernes'];
let customerSearch='';
function normalizeCustomer(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toLocaleLowerCase('es');}
function customerPage(){
 if(state.role!=='gerencia')return '<div class="notice">Solo Gerencia puede editar clientes.</div>';
 const customers=state.customers||[];
 const c=customers.find(x=>x.id===editingCustomer)||{};
 const days=Array.isArray(c.reparto)?c.reparto:[];
 const count250=Number(c.tanques250??0),count500=Number(c.tanques500??0);
 const opts=WEEKDAYS.map(d=>`<option value="${d}" ${c.cierre===d?'selected':''}>${d}</option>`).join('');
 return `<h2 class="heading">Clientes · Gerencia</h2><div class="notice">Catálogo local de prueba. Los datos se conservan en este dispositivo y en la copia JSON. Todavía NO se envían al repartidor.</div>`+
 card(`<h3>${c.id?'Editar cliente':'Nuevo cliente'}</h3><form id="customerForm" class="form customer-form">
 <label class="field">Nombre<input id="customerName" maxlength="120" required value="${esc(c.nombre||'')}"></label>
 <label class="field">Población<input id="customerTown" maxlength="100" required value="${esc(c.poblacion||'')}"></label>
 <label class="field">Dirección (opcional)<input id="customerAddress" maxlength="250" autocomplete="street-address" placeholder="Calle, número, localidad" value="${esc(c.direccion||'')}"></label>
 <label class="field">Enlace de Google Maps (opcional)<input id="customerMapUrl" type="url" inputmode="url" maxlength="1200" placeholder="https://maps.app.goo.gl/…" value="${esc(c.ubicacionUrl||'')}"></label>
 <p class="hint">Puedes introducir una dirección, un enlace o ambos. El enlace exacto se usará primero en Google Maps.</p>
 <div class="customer-tanks"><label class="field">Tanques de 250 L<input id="customerTanks250" type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="30" step="1" required value="${count250}"></label><label class="field">Tanques de 500 L<input id="customerTanks500" type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="30" step="1" required value="${count500}"></label></div>
 <p class="customer-capacity" id="customerCapacity">Capacidad instalada: ${fmt(count250*250+count500*500)} L</p>
 ${c.id&&c.tanques250==null&&c.tanques500==null?'<p class="hint">Ficha anterior: revisa y especifica las capacidades de los tanques antes de guardar.</p>':''}
 <label class="field">Tipo de válvula<select id="customerValve"><option value="automatica" ${c.valvula==='automatica'?'selected':''}>Automática</option><option value="manual" ${c.valvula!=='automatica'?'selected':''}>Manual</option></select></label>
 <label class="field">Permiso municipal de aparcamiento<select id="customerPermit"><option value="si" ${c.permiso==='si'?'selected':''}>Sí</option><option value="no" ${c.permiso==='no'?'selected':''}>No</option></select></label>
 <label class="field">Día de cierre<select id="customerClosed"><option value="ninguno" ${!c.cierre||c.cierre==='ninguno'?'selected':''}>Ninguno</option>${opts}</select></label>
 <div class="customer-days"><b>Días habituales de reparto</b><div class="customer-days-grid">${WEEKDAYS.map(d=>`<label class="check"><input type="checkbox" name="customerDay" value="${d}" ${days.includes(d)?'checked':''}> ${d}</label>`).join('')}</div></div>
 <button class="btn" type="submit">${c.id?'Guardar cambios':'Guardar cliente'}</button>${c.id?action('Cancelar edición','cancel-customer',true):''}</form>`)+
 `<h3 class="spaced">Clientes guardados (${customers.length})</h3><label class="field">Buscar cliente<input id="customerSearch" type="search" placeholder="Nombre o población" value="${esc(customerSearch)}"></label><div id="customerList">`+
 (customers.length?customers.slice().sort((a,b)=>a.nombre.localeCompare(b.nombre,'es')).map(x=>{
 const hasCounts=x.tanques250!=null&&x.tanques500!=null;
 const tankText=hasCounts?`${x.tanques250} × 250 L · ${x.tanques500} × 500 L · Capacidad: ${fmt(x.tanques250*250+x.tanques500*500)} L`:`${x.tanques||'?'} tanque(s) · Capacidades pendientes de revisar`;
 return `<div class="card customer-item" data-search="${esc(normalizeCustomer(x.nombre+' '+x.poblacion))}"><div class="customer-info"><strong>${esc(x.nombre)}</strong> · ${esc(x.poblacion)} · ${tankText}</div><div class="customer-meta">${x.valvula==='manual'?'Manual':x.valvula==='automatica'?'Automática':'Válvula pendiente'} · ${x.permiso==='si'?'Con permiso':'Sin permiso'} · Reparto: ${esc((x.reparto||[]).map(d=>({Lunes:'Lu',Martes:'Ma',Miércoles:'Mi',Jueves:'Ju',Viernes:'Vi',Sábado:'Sa',Domingo:'Do'}[d]||d)).join(', ')||'Sin asignar')}</div><div class="customer-buttons"><button class="btn secondary small customer-map" data-act="map-customer" data-id="${esc(x.id)}" aria-label="Abrir ubicación de ${esc(x.nombre)}" title="Ubicación">📍</button><button class="btn secondary small" data-act="edit-customer" data-id="${esc(x.id)}">Editar</button><button class="btn danger small" data-act="delete-customer" data-id="${esc(x.id)}">Eliminar</button></div></div>`;
 }).join(''):'<div class="empty">Todavía no hay clientes registrados.</div>')+'</div>';
}
async function saveCustomer(){
 if(state.role!=='gerencia')return;
 const nombre=el('customerName').value.trim(),poblacion=el('customerTown').value.trim(),tanques250=Number(el('customerTanks250').value),tanques500=Number(el('customerTanks500').value);
 const direccion=el('customerAddress').value.trim(),ubicacionUrl=el('customerMapUrl').value.trim();
 if(ubicacionUrl){try{const u=new URL(ubicacionUrl);if(u.protocol!=='https:'||!(/(^|\.)google\.[a-z.]+$/.test(u.hostname)||['maps.app.goo.gl','goo.gl'].includes(u.hostname)))throw Error();}catch{return toast('Introduce un enlace válido de Google Maps (https://…)');}}
 const reparto=[...document.querySelectorAll('input[name="customerDay"]:checked')].map(x=>x.value);
 if(!nombre||!poblacion||![tanques250,tanques500].every(n=>Number.isInteger(n)&&n>=0&&n<=30)||tanques250+tanques500<1||!reparto.length)return toast('Indica al menos un tanque y un día de reparto; revisa los datos');
 const customers=state.customers??[];
 const previous=customers.find(x=>x.id===editingCustomer);
 const same=customers.filter(x=>x.id!==previous?.id&&normalizeCustomer(x.nombre)===normalizeCustomer(nombre)&&normalizeCustomer(x.poblacion)===normalizeCustomer(poblacion));
 const similar=customers.filter(x=>x.id!==previous?.id&&!same.includes(x)&&normalizeCustomer(x.nombre)===normalizeCustomer(nombre));
 if(same.length&&!confirm(`Ya existe ${same.length===1?'un cliente':'más de un cliente'} con el mismo nombre y población: ${same.map(x=>x.nombre+' ('+x.poblacion+')').join(', ')}.\n\n¿Quieres crear o guardar igualmente este registro?`))return;
 if(!same.length&&similar.length&&!confirm(`Hay un cliente con el mismo nombre en otra población: ${similar.map(x=>x.nombre+' ('+x.poblacion+')').join(', ')}.\n\n¿Quieres continuar?`))return;
 const record={id:previous?.id||uid(),nombre,poblacion,direccion,ubicacionUrl,tanques250,tanques500,tanques:tanques250+tanques500,valvula:el('customerValve').value,permiso:el('customerPermit').value,cierre:el('customerClosed').value,reparto,updatedAt:now()};
 if(previous){delete previous.prevision;Object.assign(previous,record)}else customers.push(record);
 // Guardar la colección en el perfil de Gerencia, incluso cuando antes no existía.
 state.customers=customers;
 try {
  await write();
  const verified=await dbGet(profileKeys.gerencia);
  if(!verified?.customers?.some(x=>x.id===record.id))throw new Error('No se pudo verificar el cliente guardado');
  editingCustomer=null;render();toast('Cliente guardado en Gerencia (DEMO)');
 }catch(err){console.error('Guardado de cliente',err);toast('Error al guardar el cliente. No se ha confirmado el registro.');}

}

// Plan semanal local: no altera movimientos, clientes ni existencias.
let planWeek=weekMonday(new Date()),planDay=0,planVehicleChoice='camion',planEditing=null,planStep=1,planSelected=new Set(),planShowAll=false,planSearch='',planDraft={};
function weekMonday(date){const d=new Date(date.getFullYear(),date.getMonth(),date.getDate());d.setDate(d.getDate()-(d.getDay()+6)%7);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');}
function planDate(offset){const d=new Date(planWeek+'T12:00:00');d.setDate(d.getDate()+offset);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');}
function resetPlanSelection(){planSelected=new Set();planDraft={};planStep=1;planSearch='';planShowAll=false;planEditing=null;}
function moveWeek(delta){const d=new Date(planWeek+'T12:00:00');d.setDate(d.getDate()+delta*7);planWeek=weekMonday(d);resetPlanSelection();render();}
function weeklyPlan(){state.weeklyPlans??={};return state.weeklyPlans[planWeek]??={entries:[],sent:{}};}
function plannedCustomers(){const day=WEEKDAYS[planDay];return (state.customers||[]).slice().sort((a,b)=>a.nombre.localeCompare(b.nombre,'es')).sort((a,b)=>Number((b.reparto||[]).includes(day))-Number((a.reparto||[]).includes(day)));}
function plannerPage(){
 if(state.role!=='gerencia')return '<div class="notice">Solo Gerencia.</div>';
 const plan=weeklyPlan(),entries=plan.entries,customers=state.customers||[],editing=entries.find(x=>x.id===planEditing),days=['Lu','Ma','Mi','Ju','Vi'],date=planDate(planDay),daily=entries.filter(x=>x.date===date),all=plannedCustomers(),usual=all.filter(c=>(c.reparto||[]).includes(WEEKDAYS[planDay]));
 const list=all.filter(c=>(planShowAll||(c.reparto||[]).includes(WEEKDAYS[planDay])||planSelected.has(c.id))&&normalizeCustomer(c.nombre+' '+c.poblacion).includes(normalizeCustomer(planSearch)));
 const picked=all.filter(c=>planSelected.has(c.id));
 const totals={camion:daily.filter(x=>x.vehicle==='camion').reduce((s,x)=>s+Number(x.liters),0),furgoneta:daily.filter(x=>x.vehicle==='furgoneta').reduce((s,x)=>s+Number(x.liters),0)};
 return `<h2 class="heading">Planificación · Gerencia</h2><div class="notice">Elige primero el vehículo, selecciona clientes y después introduce los litros. Las previsiones no modifican las existencias. Datos locales de prueba.</div>
 <div class="card"><label class="field">Vehículo para esta planificación<select id="planVehicleChoice"><option value="camion" ${planVehicleChoice==='camion'?'selected':''}>Camión · Iván</option><option value="furgoneta" ${planVehicleChoice==='furgoneta'?'selected':''}>Furgoneta · Nacho</option></select></label><div class="row"><button class="btn small secondary" data-act="prev-week">‹</button><b>Semana ${esc(planDate(0))} – ${esc(planDate(4))}</b><button class="btn small secondary" data-act="next-week">›</button></div><div class="plan-days">${days.map((d,i)=>`<button class="${i===planDay?'chosen':''}" data-act="select-plan-day" data-day="${i}">${d}<small>${entries.filter(x=>x.date===planDate(i)).length}</small></button>`).join('')}</div></div>
 ${card(planStep===1?`<h3>1 · ${planVehicleChoice==='camion'?'Camión':'Furgoneta'} · Seleccionar clientes · ${esc(date)}</h3><p class="hint">${usual.length} clientes habituales para ${WEEKDAYS[planDay]}. Puedes incluir otros establecimientos sin modificar su ficha.</p><label class="field">Buscar cliente<input id="planSearch" type="search" placeholder="Nombre o población" value="${esc(planSearch)}"></label><label class="check"><input type="checkbox" id="planShowAll" ${planShowAll?'checked':''}> Mostrar todo el catálogo (${all.length})</label><div class="plan-bulk-buttons"><button type="button" class="btn small secondary" data-act="plan-select-visible">Marcar visibles</button><button type="button" class="btn small secondary" data-act="plan-clear-visible">Desmarcar visibles</button></div><div class="plan-customer-list" id="planCustomerList">${list.map(c=>`<label class="plan-customer" data-search="${esc(normalizeCustomer(c.nombre+' '+c.poblacion))}" data-usual="${(c.reparto||[]).includes(WEEKDAYS[planDay])?'yes':'no'}"><input type="checkbox" class="plan-pick" value="${esc(c.id)}" ${planSelected.has(c.id)?'checked':''}><span><b>${esc(c.nombre)}</b><small>${esc(c.poblacion)} · ${(c.reparto||[]).includes(WEEKDAYS[planDay])?'Habitual del día':'Fuera del día habitual'}</small></span></label>`).join('')||'<div class="empty">No hay clientes en este filtro. Activa «Mostrar todo el catálogo».</div>'}</div><p class="compact"><b id="planSelectedCount">${planSelected.size}</b> seleccionados</p><button class="btn" data-act="plan-next" ${planSelected.size?'':'disabled'}>Continuar · introducir litros →</button>`:
 `<h3>2 · Introducir litros · ${esc(date)}</h3><p class="hint">Vehículo: <b>${planVehicleChoice==='camion'?'Camión · Iván':'Furgoneta · Nacho'}</b>. Todos los clientes seleccionados se asignarán a este vehículo. Puedes cambiar su vehículo posteriormente desde Editar.</p><div class="plan-entry-list">${picked.map(c=>{const existing=daily.find(x=>x.customerId===c.id),draft=planDraft[c.id]||{},liters=draft.liters??existing?.liters??'',vehicle=planVehicleChoice,cap=Number(c.tanques250||0)*250+Number(c.tanques500||0)*500;return `<div class="plan-entry" data-customer="${esc(c.id)}"><b>${esc(c.nombre)}</b><small>${esc(c.poblacion)}${cap?' · Capacidad '+fmt(cap)+' L':''}${existing?' · Ya planificado':''}</small><div class="plan-entry-fields"><label>Litros<input class="plan-liters" data-customer="${esc(c.id)}" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0" value="${esc(liters)}"></label></div></div>`}).join('')}</div><div class="plan-bulk-buttons"><button class="btn secondary" data-act="plan-back">← Volver</button><button class="btn" data-act="plan-save-bulk">Guardar planificación</button></div>`)}
 <h3 class="spaced">Entregas del ${esc(date)} (${daily.length})</h3>${daily.sort((a,b)=>a.vehicle.localeCompare(b.vehicle)).map(x=>{const c=customers.find(y=>y.id===x.customerId);return card(`<div class="row"><b>${esc(c?.nombre||x.customerName||'Cliente eliminado')}</b><b>${fmt(x.liters)} L</b></div><p class="compact muted">${x.vehicle==='camion'?'Camión · Iván':'Furgoneta · Nacho'} · ${esc(c?.poblacion||'')}</p><div class="customer-buttons"><button class="btn small secondary" data-act="edit-plan" data-id="${esc(x.id)}">Editar</button><button class="btn small danger" data-act="delete-plan" data-id="${esc(x.id)}">Quitar</button></div>`)}).join('')||'<div class="empty">Sin entregas para este día.</div>'}
 ${editing?card(`<h3>Modificar entrega</h3><form id="planForm" class="form"><label class="field">Cliente<select id="planCustomer"><option value="${esc(editing.customerId)}">${esc(editing.customerName)}</option></select></label><input type="hidden" id="planDate" value="${esc(editing.date)}"><label class="field">Vehículo<select id="planVehicle"><option value="camion" ${editing.vehicle==='camion'?'selected':''}>Camión</option><option value="furgoneta" ${editing.vehicle==='furgoneta'?'selected':''}>Furgoneta</option></select></label><label class="field">Litros<input id="planLiters" type="number" inputmode="decimal" min="0.01" step="0.01" required value="${esc(editing.liters)}"></label><button class="btn" type="submit">Guardar modificación</button><button type="button" class="btn secondary" data-act="cancel-plan-edit">Cancelar</button></form>`):''}
 ${card(`<h3>Resumen del día</h3><p class="compact">Camión: <b>${fmt(totals.camion)} L</b> · Furgoneta: <b>${fmt(totals.furgoneta)} L</b></p><h3>Resumen semanal</h3><p class="compact">${entries.length} entregas · ${fmt(entries.reduce((a,x)=>a+Number(x.liters),0))} L previstos</p><p class="hint">Los Excel siguen siendo semanales por vehículo. Si cambias una planificación exportada, deberás enviar una nueva versión.</p><button class="btn" data-act="export-plan" data-vehicle="camion">Excel camión · Iván</button><button class="btn secondary" data-act="export-plan" data-vehicle="furgoneta">Excel furgoneta · Nacho</button>`)}
 `;
}
async function saveBulkPlan(){
 if(state.role!=='gerencia'||!planSelected.size)return toast('Selecciona algún cliente');
 const date=planDate(planDay),plan=weeklyPlan(),customers=state.customers||[],updates=[];
 for(const id of planSelected){const c=customers.find(x=>x.id===id),draft=planDraft[id]||{},existing=plan.entries.find(x=>x.date===date&&x.customerId===id);if(!c)continue;const raw=draft.liters??existing?.liters??'',liters=Number(raw),vehicle=planVehicleChoice;if(String(raw).trim()===''||!Number.isFinite(liters)||liters<=0)return toast('Introduce litros válidos para '+c.nombre);if(!['camion','furgoneta'].includes(vehicle))return toast('Revisa vehículo de '+c.nombre);updates.push({c,existing,liters,vehicle});}
 const impacted=new Set(updates.flatMap(x=>[x.vehicle,x.existing?.vehicle]).filter(Boolean));
 if([...impacted].some(v=>plan.sent[v])&&!confirm('Hay planificaciones exportadas. Los cambios requerirán enviar Excel actualizado. ¿Continuar?'))return;
 for(const x of updates){if(x.existing)Object.assign(x.existing,{liters:x.liters,vehicle:x.vehicle,updatedAt:now(),customerName:x.c.nombre});else plan.entries.push({id:uid(),customerId:x.c.id,customerName:x.c.nombre,date,vehicle:x.vehicle,liters:x.liters,createdAt:now()});}
 for(const v of impacted)if(plan.sent[v])plan.sent[v].needsResend=true;
 state.weeklyPlans[planWeek]=plan;await persist();resetPlanSelection();toast('Planificación guardada: '+updates.length+' clientes');
}
async function savePlan(){
 const customerId=el('planCustomer').value,date=el('planDate').value,vehicle=el('planVehicle').value,liters=Number(el('planLiters').value),plan=weeklyPlan(),c=(state.customers||[]).find(x=>x.id===customerId),prev=plan.entries.find(x=>x.id===planEditing);
 if(!c||!Array.from({length:5},(_,i)=>planDate(i)).includes(date)||!['camion','furgoneta'].includes(vehicle)||!Number.isFinite(liters)||liters<=0)return toast('Revisa cliente, día, vehículo y litros');
 const duplicates=plan.entries.filter(x=>x.customerId===customerId&&x.id!==prev?.id);
 if(!prev&&duplicates.length&&!confirm(`${c.nombre} ya aparece ${duplicates.length} vez/veces esta semana:\n${duplicates.map(x=>x.date+' · '+(x.vehicle==='camion'?'Camión':'Furgoneta')+' · '+fmt(x.liters)+' L').join('\n')}\n\n¿Añadir otra visita?`))return;
 const affected=new Set([vehicle,prev?.vehicle].filter(Boolean));if([...affected].some(v=>plan.sent[v])&&!confirm('Este plan ya fue exportado para un repartidor. Si guardas el cambio tendrás que enviar un Excel actualizado. ¿Continuar?'))return;
 if(prev)Object.assign(prev,{customerId,customerName:c.nombre,date,vehicle,liters,updatedAt:now()});else plan.entries.push({id:uid(),customerId,customerName:c.nombre,date,vehicle,liters,createdAt:now()});
 for(const v of affected)if(plan.sent[v])plan.sent[v].needsResend=true;
 state.weeklyPlans[planWeek]=plan;planEditing=null;await persist();toast('Entrega guardada en la planificación');
}
async function deletePlan(id){const plan=weeklyPlan(),entry=plan.entries.find(x=>x.id===id);if(!entry)return;if(!confirm('¿Quitar esta entrega del plan?'))return;if(plan.sent[entry.vehicle]&&!confirm('Este plan ya fue enviado. Tendrás que comunicar la cancelación con un Excel actualizado. ¿Continuar?'))return;plan.entries=plan.entries.filter(x=>x.id!==id);if(plan.sent[entry.vehicle])plan.sent[entry.vehicle].needsResend=true;state.weeklyPlans[planWeek]=plan;planEditing=null;await persist();}
async function exportPlan(vehicle){const plan=weeklyPlan(),entries=plan.entries.filter(x=>x.vehicle===vehicle).sort((a,b)=>a.date.localeCompare(b.date)),customers=state.customers||[];if(!entries.length)return toast('No hay entregas asignadas a este vehículo');
 const version=(plan.sent[vehicle]?.version||0)+1,rows=[['ID entrega','Fecha','Vehículo','Repartidor','Cliente','Población','Litros previstos','Dirección','Enlace Maps'],...entries.map(x=>{const c=customers.find(y=>y.id===x.customerId)||{};return [x.id,x.date,x.vehicle,vehicle==='camion'?'Iván':'Nacho',c.nombre||x.customerName,c.poblacion||'',x.liters,c.direccion||'',c.ubicacionUrl||''];})];
 const blob=SheetXLSX.generate([['Plan semanal', [['Semana',planWeek],['Vehículo',vehicle],['Versión',version],['Estado','DEMO · sin recepción confirmada'],['Generado',now()]]],['Entregas',rows]]),filename=`control-tanques-DEMO-plan-${planWeek}-${vehicle}-v${version}.xlsx`;
 try{const file=new File([blob],filename,{type:blob.type});if(navigator.canShare?.({files:[file]})&&navigator.share)await navigator.share({files:[file],title:'Plan semanal de reparto · DEMO'});else{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000)}plan.sent[vehicle]={version,at:now(),needsResend:false};state.weeklyPlans[planWeek]=plan;await persist();toast('Excel generado. Comprueba que se ha enviado al repartidor.');}catch(err){if(err.name!=='AbortError'){console.error(err);toast('No se pudo generar o compartir el Excel');}}
}
function render(){navbar();const pages={inicio:home,carga:loadPage,visita:visitPage,historial:historyPage,admin:adminPage,'recibir-plan':receivedPlanPanel,jornada:journalPage,gerencia:managerPage,clientes:customerPage,planificacion:plannerPage};el('screen').innerHTML=(pages[state.page]||home)();TankCloud.decorate();}
async function navigate(page){if(TankCloud.connected()){const role=TankCloud.member()?.role;if(!TankCloud.member()?.active&&page!=='admin')return;if(['gerencia','clientes','planificacion'].includes(page)&&role!=='gerencia')return;if(page==='carga'&&!TankCloud.permitted('almacen'))return;if(page==='visita'&&!TankCloud.permitted('reparto'))return;}if(editingId)editingId=null;if(state.openVisit && page==='carga')return toast('Finaliza primero la visita en curso');state.page=page;await persist()}
async function processLoad(form){if(!TankCloud.canOperate())return;const vehicle=el('loadVehicle').value,index=Number(el('loadTank').value),amount=litres(el('loadLiters').value),old=litres(state.tanks[vehicle][index]),discard=el('residual').value==='desechar',merma=discard?old:0;const remaining=discard?0:old;if(!el('zeroLoad').checked||!Number.isFinite(amount)||amount<=0||litres(amount+remaining)>1000||(state.stockAdjustment?.cisternKnown!==false&&amount>state.cisterna))return toast('Revisa la cantidad, capacidad, cisterna y confirmación del contador');if(!confirm(`Registrar ${fmt(amount)} L al ${vehicle}, tanque ${index+1}${merma?` y merma de ${fmt(merma)} L`:''}?`))return;
invalidateDraft('almacen');state.tanks[vehicle][index]=litres(remaining+amount);if(state.stockAdjustment?.cisternKnown!==false)state.cisterna=litres(state.cisterna-amount);const at=now();state.loads.push({id:uid(),vehicle,index,amount,merma,at,cisternPending:state.stockAdjustment?.cisternKnown===false});state.log.push({title:'Carga',desc:`${vehicle} · Tanque ${index+1} · ${fmt(amount)} L${merma?` · Merma ${fmt(merma)} L`:''}`,at});toast('Carga guardada');await persist()}
async function startVisit(){if(!TankCloud.canOperate())return;if(state.openVisit)return toast('Ya hay una visita abierta');if(!el('zeroVisit').checked)return toast('Confirma la puesta a cero del contador');state.openVisit={id:uid(),client:el('client').value,vehicle:state.vehicle,started:now(),reading:0,segment:0,resets:[],corrections:[],lastSource:0,discharges:[]};await persist()}
async function discharge(){if(!TankCloud.canOperate())return;const v=state.openVisit;if(!v)return;const source=Number(el('sourceTank').value),dest=el('destTank').value,reading=litres(el('reading').value),raw=el('reading').value;const qty=litres(reading-v.reading);if(!dest||raw.trim()===''||!Number.isFinite(reading)||qty<=0||qty>state.tanks[v.vehicle][source])return toast('Lectura inválida o litros insuficientes en el tanque');if(!confirm(`Registrar ${fmt(qty)} L desde tanque ${source+1} a tanque cliente ${dest}?`))return;invalidateDraft('reparto');state.tanks[v.vehicle][source]=litres(state.tanks[v.vehicle][source]-qty);v.lastSource=source;v.reading=reading;v.discharges.push({id:uid(),source,dest,reading,liters:qty,segment:v.segment||0,at:now()});await persist();toast(`Registrados ${fmt(qty)} L. Selecciona otra vez el tanque del cliente.`)}
function calcRevised(v,id,nextReading){
 const array=v.discharges.map(d=>({...d})); const at=array.findIndex(d=>d.id===id);
 if(at<0)throw Error('No se encontró la descarga');
 array[at].reading=nextReading;
 for(let i=0;i<array.length;i++){
  const previous=i>0&&Number(array[i-1].segment||0)===Number(array[i].segment||0)?array[i-1].reading:0;
  const qty=litres(Number(array[i].reading)-Number(previous));
  if(!Number.isFinite(qty)||qty<=0)throw Error(`La lectura deja inválida la descarga ${i+1}. Comprueba la lectura siguiente.`);
  array[i].liters=qty;
 }
 const oldTotal=Array(state.tanks[v.vehicle].length).fill(0),newTotal=[...oldTotal];
 for(const d of v.discharges)oldTotal[d.source]+=d.liters;
 for(const d of array)newTotal[d.source]+=d.liters;
 const revisedStock=state.tanks[v.vehicle].map((n,i)=>litres(n+oldTotal[i]-newTotal[i]));
 if(revisedStock.some(n=>n<0||n>1000))throw Error('La corrección dejaría existencias inválidas en un tanque.');
 return {array,revisedStock};
}
async function saveCorrection(){
 const v=state.openVisit,d=v?.discharges.find(d=>d.id===editingId);if(!d)return;
 const text=el('editReading').value,readNew=Number(text),destNew=el('editDest').value,reason=el('editReason').value;
 if(text.trim()===''||!Number.isFinite(readNew)||readNew<=0)return toast('Introduce una lectura válida');
 if(readNew===d.reading&&destNew===d.dest)return toast('No hay cambios que guardar');
 try{
  const {array,revisedStock}=calcRevised(v,d.id,readNew);
  const previous={source:d.source,dest:d.dest,reading:d.reading,liters:d.liters};
  const after=array.find(x=>x.id===d.id);after.dest=destNew;
  if(!confirm('Guardar corrección y actualizar existencias? Se conservará el registro original.'))return;
  invalidateDraft('reparto');state.tanks[v.vehicle]=revisedStock;
  v.discharges=array;
  v.reading=(v.resets||[]).at(-1)?.afterDischargeId===array.at(-1)?.id?0:(array.at(-1)?.reading||0);
  const audit={id:uid(),dischargeId:d.id,reason,at:now(),previous,next:{source:after.source,dest:after.dest,reading:after.reading,liters:after.liters}};
  v.corrections??=[];v.corrections.push(audit);
  state.log.push({title:'Corrección de descarga',at:audit.at,desc:`${v.client}: cliente T${previous.dest} → T${destNew}, lectura ${fmt(previous.reading)} → ${fmt(readNew)} L; motivo: ${reason}`});
  editingId=null;await persist();toast('Corrección guardada con historial');
 }catch(err){toast(err.message)}
}
async function resetMeter(){
 const v=state.openVisit;
 if(!v||!v.discharges.length)return toast('No hay descargas que separar');
 if((v.resets||[]).at(-1)?.afterDischargeId===v.discharges.at(-1).id)return toast('El contador ya figura reiniciado. Registra primero otra descarga.');
 if(!confirm('¿Has puesto a cero físicamente el contador de descarga? Solo confirma si realmente ha ocurrido.'))return;
 invalidateDraft('reparto');v.resets??=[];v.resets.push({id:uid(),at:now(),afterDischargeId:v.discharges.at(-1).id,readingBefore:v.reading});
 v.segment=(v.segment||0)+1;v.reading=0;
 state.log.push({title:'Reinicio excepcional del contador',at:now(),desc:`${v.client} · Inicio del tramo ${v.segment+1}`});
 await persist();toast('Contador reiniciado para el siguiente tramo');
}
async function reopenVisit(id){
 const v=state.visits.find(x=>x.id===id);
 if(!canReopen(v))return toast('Solo se puede reabrir la última visita sin movimientos posteriores del vehículo.');
 if(!confirm(`¿Reabrir la visita a ${v.client}?`))return;
 invalidateDraft('reparto');state.visits=state.visits.filter(x=>x.id!==id);
 v.reopened=true;delete v.ended;
 v.segment=v.discharges.at(-1)?.segment||0;
 v.reading=v.resets?.at(-1)?.afterDischargeId===v.discharges.at(-1)?.id?0:(v.discharges.at(-1)?.reading||0);
 v.resets??=[];v.corrections??=[];
 state.openVisit=v;state.vehicle=v.vehicle;state.page='visita';
 editingId=null;
 state.log.push({title:'Visita reabierta',at:now(),desc:`${v.client} · Correcciones permitidas antes del envío de jornada`});
 await persist();
}
async function finishVisit(){const v=state.openVisit;if(!v?.discharges.length)return toast('Registra al menos una descarga');if(!confirm(`Finalizar visita a ${v.client} con ${v.discharges.length} descargas?`))return;invalidateDraft('reparto');v.ended=now();state.visits.push(v);state.log.push({title:'Visita cerrada',desc:`${v.client} · ${v.discharges.length} descargas · ${fmt(v.discharges.reduce((s,d)=>s+d.liters,0))} L${v.planEntryId?' · Previsto '+fmt(v.plannedLiters)+' L': ' · No planificada ('+(v.unplannedReason||'otro')+')'}`,at:v.ended});state.openVisit=null;editingId=null;await persist();toast('Visita ficticia guardada')}
async function backup(){const profiles={};for(const [role,key] of Object.entries(profileKeys))profiles[role]=await dbGet(key);const bytes=new Blob([JSON.stringify({app:'control-de-tanques',phase:'v0.10',exported:now(),profiles,sync:TankCloud.connected()?TankCloud.meta():null},null,2)],{type:'application/json'});const url=URL.createObjectURL(bytes);const a=document.createElement('a');a.href=url;a.download=`control-tanques-DEMO-perfiles-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),15000)}
async function handleActions(e){if(TankCloud.connected()&&['reset','clear-opening','make-xlsx','mark-sent','resend-xlsx','prepare-real','save-reconciliation','export-handoff','export-stock'].includes(e.target.closest('[data-act]')?.dataset.act))return toast('En modo conectado se utiliza sincronización automática');const page=e.target.closest('[data-page]');if(page){await navigate(page.dataset.page);return}const act=e.target.closest('[data-act]')?.dataset.act;if(act==='cancel-sent-visit')return cancelSentVisit(e.target.closest('[data-id]')?.dataset.id);if(act==='delete-test-visit')return deleteTestVisit(e.target.closest('[data-id]')?.dataset.id);if(act==='go-admin')return navigate('admin');if(act==='go-recibir-plan')return navigate('recibir-plan');if(act==='clear-opening'){if(confirm('¿Quitar los saldos iniciales ficticios? Los Excel importados y sus identificadores se conservarán.')){delete managerState().opening;await persist();}return;}if(act==='go-gerencia')return navigate('gerencia');if(act==='go-clientes')return navigate('clientes');if(act==='go-planificacion')return navigate('planificacion');if(act==='plan-select-visible'||act==='plan-clear-visible'){document.querySelectorAll('.plan-pick').forEach(n=>{if(n.closest('.plan-customer').hidden)return;if(act==='plan-select-visible')planSelected.add(n.value);else planSelected.delete(n.value)});return render()}if(act==='plan-next'){if(!planSelected.size)return toast('Selecciona clientes');planStep=2;return render()}if(act==='plan-back'){planStep=1;return render()}if(act==='plan-save-bulk')return saveBulkPlan();if(act==='prev-week')return moveWeek(-1);if(act==='next-week')return moveWeek(1);if(act==='select-plan-day'){planDay=Number(e.target.closest('[data-day]').dataset.day);resetPlanSelection();return render()}if(act==='edit-plan'){planEditing=e.target.closest('[data-id]').dataset.id;return render()}if(act==='cancel-plan-edit'){planEditing=null;return render()}if(act==='delete-plan')return deletePlan(e.target.closest('[data-id]').dataset.id);if(act==='export-plan')return exportPlan(e.target.closest('[data-vehicle]').dataset.vehicle);if(act==='close-nav-sheet')return closeNavigationSheet();if(act==='choose-nav')return navigateCustomerWith(e.target.closest('[data-provider]').dataset.provider);if(act==='cancel-customer'){editingCustomer=null;return render()}if(act==='map-customer')return openCustomerLocation(e.target.closest('[data-id]')?.dataset.id);if(act==='edit-customer'){editingCustomer=e.target.closest('[data-id]')?.dataset.id;return render()}if(act==='delete-customer'){const id=e.target.closest('[data-id]')?.dataset.id;const c=(state.customers||[]).find(x=>x.id===id);if(c&&confirm('¿Eliminar el cliente '+c.nombre+' del catálogo local?')){state.customers=state.customers.filter(x=>x.id!==id);if(editingCustomer===id)editingCustomer=null;await persist()}return;}if(act==='export-handoff')return exportHandoff();if(act==='export-stock')return shareStockFile(el('stockExportVehicle')?.value||state.vehicle);if(act==='go-jornada')return navigate('jornada');if(act==='make-xlsx')return sendJournal(false);if(act==='resend-xlsx')return sendJournal(true);if(act==='mark-sent')return markJournalSent();if(act==='leave-load')return navigate('inicio');if(act==='leave-visit'){const v=state.openVisit;if(!v)return navigate('inicio');if(!(v.discharges||[]).length){if((v.resets||[]).length||(v.corrections||[]).length)return toast('Hay modificaciones registradas: revisa la visita antes de salir');state.openVisit=null;await persist();toast('Entrada descartada: no se registraron descargas');return navigate('inicio')}await persist();toast('Visita conservada. Podrás continuarla después.');return navigate('inicio')}if(act==='go-carga')return navigate('carga');if(act==='go-visita')return navigate('visita');if(act==='start-planned-visit'){const id=e.target.closest('[data-id]')?.dataset.id;const entry=plannedEntriesForVehicle().find(x=>x.id===id);if(!entry)return toast('No se encontró la entrega');if((state.visits||[]).some(v=>v.planEntryId===id))return toast('Entrega ya atendida');if(!confirm('¿Has puesto a cero el contador al llegar a '+entry.client+'?'))return;return beginDelivery(entry,entry.client,null);}if(act==='finish-visit')return finishVisit();if(act==='reset-meter')return resetMeter();if(act==='cancel-edit'){editingId=null;return render()}if(act==='edit-discharge'){editingId=e.target.closest('[data-id]')?.dataset.id;return render()}if(act==='reopen-visit')return reopenVisit(e.target.closest('[data-id]')?.dataset.id);if(act==='backup')return backup();if(act==='check-update')return checkForUpdates(true);if(act==='apply-update')return applyUpdate();if(act==='reset'){if(confirm('¿Reiniciar solamente el perfil '+roleNames[state.role]+'? Antes guarda una copia JSON. Los otros perfiles y la copia anterior se mantienen.')){const role=state.role;state=cleanProfile(role);await persist()}}}
async function handleChange(e){if(e.target.id==='vehicle'||e.target.id==='loadVehicle'){state.vehicle=e.target.value;await persist()}if(e.target.id==='planVehicleChoice'){planVehicleChoice=e.target.value;resetPlanSelection();render();}if(e.target.id==='planShowAll'){planShowAll=e.target.checked;render()}if(e.target.classList.contains('plan-pick')){if(e.target.checked)planSelected.add(e.target.value);else planSelected.delete(e.target.value);const counter=el('planSelectedCount');if(counter)counter.textContent=planSelected.size;const next=document.querySelector('[data-act=plan-next]');if(next)next.disabled=!planSelected.size;}if(e.target.id==='deliveryDate'){state.deliveryDate=e.target.value;await persist()}if(e.target.id==='planReceiveVehicle'){state.vehicle=e.target.value;await persist()}if(e.target.id==='receivePlanFile'&&e.target.files?.[0])await receivePlanFile(e.target.files[0]);if(e.target.id==='chooseRole'){await changeProfile(e.target.value)}if(e.target.id==='loadVehicle')render();if(e.target.id==='journalDate'){journalDate=e.target.value;render()}if(e.target.id==='journalWorker'){journalWorker=e.target.value.trim();}if(e.target.id==='managerFile'&&e.target.files?.[0])await importManagerFile(e.target.files[0]);if(e.target.id==='handoffFile'&&e.target.files?.[0])await receiveHandoff(e.target.files[0]);if(e.target.id==='stockTransferFile'&&e.target.files?.[0])await receiveStockFile(e.target.files[0]);}
document.addEventListener('focusin',e=>{if(e.target?.id==='customerTanks250'||e.target?.id==='customerTanks500')e.target.select();});
document.addEventListener('input',e=>{if(e.target?.id==='planSearch'){planSearch=e.target.value;document.querySelectorAll('.plan-customer').forEach(n=>n.hidden=!n.dataset.search.includes(normalizeCustomer(planSearch)));}if(e.target?.classList.contains('plan-liters')){planDraft[e.target.dataset.customer]??={};planDraft[e.target.dataset.customer].liters=e.target.value;}if(e.target?.id==='customerSearch'){customerSearch=e.target.value;document.querySelectorAll('#customerList .customer-item').forEach(item=>{item.hidden=!item.dataset.search.includes(normalizeCustomer(customerSearch));});}if(e.target?.id==='customerTanks250'||e.target?.id==='customerTanks500'){const a=Number(el('customerTanks250')?.value||0),b=Number(el('customerTanks500')?.value||0);const output=el('customerCapacity');if(output)output.textContent='Capacidad instalada: '+fmt(a*250+b*500)+' L';}});
async function handleSubmit(e){if(!['loadForm','visitForm','dischargeForm','editForm','openingForm','provisionalForm','stockAdjustForm','customerForm','planForm','extraVisitForm'].includes(e.target.id))return;e.preventDefault();if(formBusy)return toast('Espera a que termine la operación anterior');formBusy=true;try{if(e.target.id==='extraVisitForm'){if(!el('extraZero')?.checked)return toast('Confirma la puesta a cero');const client=el('extraClient')?.value.trim();if(!client)return toast('Indica el cliente');return beginDelivery(null,client,el('extraReason')?.value||'otro');}if(e.target.id==='customerForm')return saveCustomer();if(e.target.id==='planForm')return savePlan();if(e.target.id==='stockAdjustForm')return saveStockAdjustment();if(e.target.id==='openingForm')return saveOpening();if(e.target.id==='provisionalForm')return saveProvisional();if(e.target.id==='loadForm')await processLoad(e.target);if(e.target.id==='visitForm')await startVisit();if(e.target.id==='dischargeForm')await discharge();if(e.target.id==='editForm')await saveCorrection()}finally{formBusy=false}}
async function init(){try{db=await openDB();await ensureProfiles();const previous=await dbGet('app');const rememberedRole=await dbGet('active-role-v08');const startingRole=profileKeys[rememberedRole]?rememberedRole:(profileKeys[previous?.role]?previous.role:'reparto');state=await dbGet(profileKeys[startingRole])||cleanProfile(startingRole);state.role=startingRole;await write();document.addEventListener('click',e=>handleActions(e).catch(err=>{console.error(err);toast('No se pudo guardar: '+err.message)}));document.addEventListener('change',e=>handleChange(e).catch(err=>{console.error(err);toast('No se pudo guardar: '+err.message)}));document.addEventListener('submit',e=>handleSubmit(e).catch(err=>{console.error(err);toast('No se pudo guardar: '+err.message)}));el('roleButton').addEventListener('click',()=>{const picker=el('rolePicker');picker.hidden=!picker.hidden;el('roleButton').setAttribute('aria-expanded',String(!picker.hidden));});el('rolePicker').addEventListener('click',async e=>{const button=e.target.closest('[data-profile]');if(!button)return;el('rolePicker').hidden=true;el('roleButton').setAttribute('aria-expanded','false');if(button.dataset.profile!==state.role)await changeProfile(button.dataset.profile)});document.addEventListener('click',e=>{if(!e.target.closest('.role-switch')){el('rolePicker').hidden=true;el('roleButton').setAttribute('aria-expanded','false')}});render();TankCloud.init().catch(err=>{console.error(err);toast('La conexión no está disponible. Tus datos locales siguen guardados.');});setupUpdates().catch(console.warn)}catch(err){el('screen').innerHTML='<div class="notice error">No se puede abrir el almacenamiento local. Comprueba que no estás en navegación privada o que Safari permite datos de sitios web.</div>';console.error(err)}}init();


// Actualizaciones GitHub Pages: version.json + service worker. Estado IndexedDB intacto.
function setUpdateStatus(message){const node=el('updateStatus');if(node)node.textContent=message}
function hasActiveOperation(){return Boolean(state?.openVisit)}
async function checkForUpdates(manual=false){
  if(updating)return;
  if(!navigator.onLine){if(manual)toast('Sin conexión: no se pueden buscar actualizaciones');setUpdateStatus('Sin conexión. Tus datos locales siguen disponibles.');return}
  lastUpdateCheck=Date.now();
  try{
    const resp=await fetch(`./version.json?t=${Date.now()}`,{cache:'no-store'});
    if(!resp.ok)throw new Error('No se pudo consultar version.json');
    const remote=await resp.json();
    if(!/^\d+\.\d+\.\d+$/.test(remote.version))throw new Error('Versión remota inválida');
    const compare=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]-y[i]}return 0};
    remoteVersion=remote.version;
    updateAvailable=compare(remote.version,APP_VERSION)>0;
    if(updateAvailable){setUpdateStatus(`Disponible: v${remote.version}`);toast(`Nueva versión ${remote.version} disponible`);}
    else {setUpdateStatus(`Tienes la versión más reciente (v${APP_VERSION}).`);if(manual)toast('Ya tienes la última versión')}
    if(state?.page==='admin'){render();setUpdateStatus(updateAvailable?`Nueva versión ${remote.version} disponible`:`Tienes la versión más reciente (v${APP_VERSION}).`)}
  }catch(err){console.warn('Error al comprobar actualización:',err);if(manual)toast('No se ha podido comprobar la versión. Inténtalo después.');setUpdateStatus('No se pudo comprobar la versión. La aplicación sigue funcionando.');}
}
async function applyUpdate(){
  if(!updateAvailable){toast('No hay ninguna actualización pendiente');return}
  if(hasActiveOperation()&&!confirm('Tienes una visita abierta. Es preferible terminarla antes de actualizar. ¿Continuar igualmente?'))return;
  if(!confirm('¿Aplicar la actualización ahora? Tus registros locales se conservarán.'))return;
  if(!navigator.onLine){toast('Necesitas conexión para actualizar');return}
  updating=true;toast('Preparando actualización…');
  try{
    if('serviceWorker' in navigator){
      const reg=await navigator.serviceWorker.getRegistration('./');
      if(reg){
        const waitForControl=new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
        await reg.update();
        if(reg.waiting){reg.waiting.postMessage({type:'SKIP_WAITING'});await Promise.race([waitForControl,new Promise(r=>setTimeout(r,5000))])}
      }
    }
    // Invalidar la caché de recursos de la versión anterior antes de recargar.
    // The new service worker removes old shells only after fully caching this release.
    const next=new URL(location.href); next.searchParams.set("app_version", remoteVersion || APP_VERSION); location.replace(next.href);
  }catch(err){console.error(err);updating=false;toast('No se completó la actualización. Vuelve a intentarlo.');}
}
async function setupUpdates(){
  if('serviceWorker' in navigator&&window.isSecureContext){
    try{await navigator.serviceWorker.register('./sw.js')}catch(err){console.warn('Service worker no disponible:',err)}
  }
  // Usar siempre versión remota no cacheada. Evitar consultas continuas.
  setTimeout(()=>checkForUpdates(false),1800);
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible'&&Date.now()-lastUpdateCheck>UPDATE_CHECK_MS)checkForUpdates(false);
  });
}
