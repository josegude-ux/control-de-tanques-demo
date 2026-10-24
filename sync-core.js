/* Pure record/queue logic; shared with the Node regression tests. */
(function(root){
 const copy=x=>JSON.parse(JSON.stringify(x));
 const litres=n=>{const v=Math.round(Number(n)*100)/100;return Number.isFinite(v)?v:NaN;};
 const stable=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
 const signature=r=>stable({kind:r.kind,vehicle:r.vehicle||null,payload:r.payload,deleted:!!r.deleted});
 /** Origen de descarga válido (índice 0..n). null/undefined NO se convierte en tanque 1. */
 function validSource(d){
  if(d==null||d.affectsStock===false)return false;
  const s=d.source;
  return Number.isInteger(s)&&s>=0;
 }
 function extract(s){
  const out={};
  const add=(kind,id,payload,vehicle=null,deleted=false)=>{const key=kind+':'+id;out[key]={key,kind,payload:copy(payload),vehicle,deleted};};
  if(s.role==='almacen'){
   for(const l of s.loads||[]){
    if(!Number.isInteger(l.index)||l.index<0)continue;
    add('movement',l.id,{id:l.id,type:'CARGA',vehicle:l.vehicle,tank:l.index+1,litres:litres(l.amount),loss:litres(l.merma||0),time:l.at,cisternPending:!!l.cisternPending},l.vehicle);
   }
  }
  if(s.role==='reparto'){
   for(const v of [...s.visits||[],...s.openVisit?[s.openVisit]:[]]){
    // Anulación conserva descargas en el saldo hasta conciliación de Gerencia (no tombstone automático).
    add('visit',v.id,v,v.vehicle);
    for(const d of v.discharges||[]){
     // Origen pendiente (p.ej. BARALLETE 240,61 L): no emitir movement de stock ni asignar tanque.
     if(!validSource(d))continue;
     // La tabla movement es visible a toda la flota para calcular saldos.
     // Datos identificativos del cliente y tanque de destino permanecen SOLO en visit,
     // que RLS limita a su repartidor y a Gerencia.
     add('movement',d.id,{id:d.id,type:'DESCARGA',vehicle:v.vehicle,tank:d.source+1,litres:litres(d.liters),loss:0,time:d.at,visitId:v.id,cancelled:!!v.cancelledAt},v.vehicle,false);
    }
   }
   // Solo provisionales del vehículo asignado (evita reenviar los de otro móvil).
   for(const p of s.provisionalHistory||[]){
    if(s.vehicle&&p.vehicle&&p.vehicle!==s.vehicle)continue;
    add('provisional',p.id,p,p.vehicle);
   }
  }
  if(s.role==='gerencia'){
   for(const c of s.customers||[])add('customer',c.id,c);
   // Planificación por vehículo (API): plan:SEMANA|camion|furgoneta. No emitir plan:SEMANA agregado.
   for(const [week,p] of Object.entries(s.weeklyPlans||{})){
    if(String(week).includes('|'))continue;
    for(const vehicle of ['camion','furgoneta']){
     const entries=(p.entries||[]).filter(e=>e.vehicle===vehicle);
     const sent={};if(p.sent&&p.sent[vehicle])sent[vehicle]=p.sent[vehicle];
     add('plan',week+'|'+vehicle,{week,vehicle,entries,sent},vehicle);
    }
   }
   if(s.manager?.opening)add('opening','global',s.manager.opening);
   // Ajustes de existencias: solo Gerencia (auditoría vía sync + tanques_audit).
   for(const a of s.stockAdjustmentHistory||[])add('adjustment',a.id,a);
  }
  return out;
 }
 function empty(){return {rows:{},pending:{},last:{},conflicts:{},lastSync:null};}
 function capture(meta,s,user,opts={}){
  const current=extract(s),before=meta.last[s.role]||{};
  const forbidDelete=!!opts.forbidSyncedDelete;
  for(const key of new Set([...Object.keys(before),...Object.keys(current)])){
   let r=current[key];
   if(r&&before[key]===signature(r))continue;
   if(!r){
    if(!before[key])continue;
    const prev=meta.pending[key]||meta.rows[key];
    if(!prev)continue;
    if(forbidDelete&&meta.rows[key]&&(prev.kind==='movement'||prev.kind==='visit')){
     throw Error('No se pueden borrar movimientos o visitas ya sincronizados. Conserva el historial o solicita anulación a Gerencia.');
    }
    r={...prev,deleted:true};
   }
   const pending=meta.pending[key],remote=meta.rows[key];
   meta.pending[key]={...copy(r),owner_id:remote?.owner_id||user,base:pending?.base??remote?.revision??0};
  }
  meta.last[s.role]=Object.fromEntries(Object.entries(current).map(([k,r])=>[k,signature(r)]));
 }
 function receive(meta,rows){
  for(const r of rows){
   const p=meta.pending[r.key];
   if(p){
    if(signature(p)===signature(r)){delete meta.pending[r.key];delete meta.conflicts[r.key];}
    else if(r.revision!==p.base)meta.conflicts[r.key]=r;
   }
   meta.rows[r.key]=r;
  }
 }
 /**
  * La lectura RLS es una instantánea completa. Eliminar filas que han dejado
  * de ser visibles (p.ej. baja, cambio de rol/vehículo), pero NUNCA eliminar
  * operaciones locales pendientes: requieren conciliación o revisión.
  */
 function reconcileSnapshot(meta,rows){
  const visible=new Set(rows.map(r=>r.key));
  receive(meta,rows);
  let removed=0;
  for(const key of Object.keys(meta.rows)){
   if(visible.has(key))continue;
   delete meta.rows[key];
   delete meta.conflicts[key];
   removed++;
  }
  return removed;
 }
 function acknowledge(meta,sent,rows){
  const byKey=Object.fromEntries(sent.map(r=>[r.key,r]));
  for(const r of rows){
   const p=meta.pending[r.key];meta.rows[r.key]=r;
   if(p&&signature(p)===signature(byKey[r.key]))delete meta.pending[r.key];
   else if(p)p.base=r.revision; // Edited while the request was in flight.
   delete meta.conflicts[r.key];
  }
 }
 /** Cliente conservador: nunca enviar pendientes incompatibles con el perfil vigente.
  * La autorización definitiva se vuelve a comprobar siempre en Supabase. */
 /** Compatibilidad entre el filtro de permisos y las pruebas de roles.
  * No sustituye la autorización final del servidor. */
 function allowedPending(row,member,uid){
  if(!row||!member?.active)return false;
  if(member.role==='gerencia')return true;
  if(uid&&row.owner_id&&row.owner_id!==uid)return false;
  const p=row.payload||{};
  if(member.role==='almacen')return row.kind==='movement'&&p.type==='CARGA';
  if(member.role==='reparto'){
   if(!member.vehicle||row.vehicle!==member.vehicle)return false;
   return row.kind==='visit'||row.kind==='provisional'
    ||(row.kind==='movement'&&p.type==='DESCARGA');
  }
  return false;
 }
 function permittedPending(row,member,uid){
  return !!uid&&allowedPending(row,member,uid);
 }
 /**
  * Vista segura para una cuenta: aplica RLS a las filas remotas (ya filtradas
  * por Supabase) y excluye del estado visible las operaciones locales que
  * perdieron autorización. No borra NUNCA las operaciones de la cola real.
  */
 function visibleMeta(meta,member,uid){
  const pending={};
  for(const [key,row] of Object.entries(meta.pending||{})){
   if(permittedPending(row,member,uid))pending[key]=row;
  }
  return {...meta,pending};
 }
 function batch(meta,limit=500,options={}){
  const groups=new Map();for(const r of Object.values(meta.pending)){
   const group=r.kind==='visit'?'visit:'+r.payload.id:r.payload.visitId?'visit:'+r.payload.visitId:r.key;
   if(!groups.has(group))groups.set(group,[]);groups.get(group).push(r);
  }
  const out=[];for(const group of groups.values()){
   // No enviar parcialmente una visita si cualquiera de sus movimientos está en conflicto.
   if(options.skipConflicts&&group.some(r=>Object.hasOwn(meta.conflicts||{},r.key)))continue;
   if(options.allowRecord&&group.some(r=>!options.allowRecord(r)))continue;
   if(group.length>limit)throw Error('Una visita supera el límite de cambios; conserva la copia y solicita revisión');
   if(out.length+group.length>limit)continue;
   out.push(...group);
  }return copy(out);
 }
 function resolve(meta,key,useLocal){
  const p=meta.pending[key],r=meta.rows[key];if(!p||!r)return;
  const visitId=p.kind==='visit'?p.payload.id:(p.payload.visitId||r.payload.visitId);
  const keys=visitId?Object.keys(meta.pending).filter(k=>k==='visit:'+visitId||meta.pending[k].payload.visitId===visitId):[key];
  for(const k of keys){
   if(useLocal)meta.pending[k].base=meta.rows[k]?.revision||0;
   else delete meta.pending[k];
   delete meta.conflicts[k];
  }
 }
 /** Solo la vista descarta pendientes retenidos por cambios de permisos; la cola durable sigue intacta. */
 function visiblePending(meta,member,user){
  if(!member)return meta.pending;
  return Object.fromEntries(Object.entries(meta.pending).filter(([,r])=>permittedPending(r,member,user)));
 }
 function effective(meta,member=null,user=null){
  return Object.values({...meta.rows,...visiblePending(meta,member,user)}).filter(r=>!r.deleted);
 }
 /** Filas para stock: los movements soft-deleted siguen contando hasta ajuste de Gerencia. */
 function stockRecords(meta,member=null,user=null){
  const merged={...meta.rows,...visiblePending(meta,member,user)};
  return Object.values(merged).filter(r=>{
   if(r.kind==='movement')return true; // incluir deleted
   return !r.deleted;
  });
 }
 function hydrate(meta,s,user,member=null){
  const rows=effective(meta,member,user),get=k=>rows.filter(r=>r.kind===k).map(r=>copy(r.payload));
  // Cargas: Almacén ve todas; Reparto no las materializa en su perfil (solo saldos vía balances).
  const loads=get('movement').filter(m=>m.type==='CARGA'&&Number.isInteger(m.tank)&&m.tank>=1)
   .map(m=>({id:m.id,vehicle:m.vehicle,index:m.tank-1,amount:litres(m.litres),merma:litres(m.loss),at:m.time,cisternPending:m.cisternPending}));
  s.loads=s.role==='reparto'?[]:loads;
  // Visitas: Gerencia todas; Reparto solo las propias (no las de otro vehículo/conductor).
  const visits=rows.filter(r=>r.kind==='visit'&&(s.role==='gerencia'||r.owner_id===user)).map(r=>copy(r.payload));
  s.visits=visits.filter(v=>v.ended);const open=visits.filter(v=>!v.ended&&!v.cancelledAt);
  s.openVisit=open.find(v=>v.id===s.openVisit?.id)||open[0]||null;
  s.customers=get('customer');
  // Planes: filas por vehículo (plan:SEMANA|vehiculo) o legado plan:SEMANA (solo Gerencia vía RLS).
  s.weeklyPlans={};s.receivedPlans={};
  for(const r of rows.filter(x=>x.kind==='plan')){
   const id=r.key.slice(5),p=copy(r.payload);
   if(id.includes('|')){
    const vehicle=r.vehicle||p.vehicle||id.slice(id.lastIndexOf('|')+1);
    const week=p.week||id.slice(0,id.lastIndexOf('|'));
    const entries=(p.entries||[]).filter(e=>!e.vehicle||e.vehicle===vehicle);
    s.weeklyPlans[week]??={entries:[],sent:{}};
    s.weeklyPlans[week].entries.push(...entries);
    if(p.sent)Object.assign(s.weeklyPlans[week].sent,p.sent);
    s.receivedPlans[week+'|'+vehicle]={...p,week,vehicle,entries};
   }else{
    s.weeklyPlans[id]=p.entries?p:{entries:[],sent:{},...p};
    for(const vehicle of ['camion','furgoneta'])
     s.receivedPlans[id+'|'+vehicle]={...p,week:id,vehicle,entries:(p.entries||[]).filter(e=>e.vehicle===vehicle)};
   }
  }
  s.stockAdjustmentHistory=get('adjustment').sort((a,b)=>a.at.localeCompare(b.at));s.stockAdjustment=s.stockAdjustmentHistory.at(-1)||null;
  let provis=get('provisional');
  if(s.role==='reparto'&&s.vehicle)provis=provis.filter(p=>p.vehicle===s.vehicle);
  s.provisionalHistory=provis;s.provisionalOpenings={};for(const p of s.provisionalHistory)s.provisionalOpenings[p.vehicle]=p;
  const opening=get('opening')[0];
  s.manager??={journals:{},movements:{},incidents:[]};s.manager.opening=opening;
  // Movimientos de flota completa para conciliación Gerencia; saldos compartidos.
  s.manager.movements=Object.fromEntries(get('movement').map(m=>[m.id,m]));s.manager.cancellations={};
  return s;
 }
 function balances(meta,member=null,user=null){
  const rows=stockRecords(meta,member,user),opening=rows.find(r=>r.kind==='opening')?.payload;
  const changes=rows.filter(r=>r.kind==='adjustment').map(r=>r.payload).sort((a,b)=>a.at.localeCompare(b.at));
  const latest=changes.at(-1);const base=latest?.next||opening;
  if(!base)return {ready:false,problems:[],balances:null};
  const b={cisterna:base.cisterna==null?null:litres(base.cisterna),camion:base.camion.map(litres),furgoneta:base.furgoneta.map(litres)};
  const movements=rows.filter(r=>r.kind==='movement').map(r=>r.payload)
   .filter(m=>m&&m.affectsStock!==false&&Number.isInteger(m.tank)&&m.tank>=1)
   .filter(m=>!latest||m.time>latest.at)
   .sort((a,b)=>a.time.localeCompare(b.time)||a.id.localeCompare(b.id));
  const problems=[];
  for(const m of movements){
   const t=m.tank-1,qty=litres(m.litres),loss=litres(m.loss||0);
   if(!b[m.vehicle]||!Number.isInteger(t)||t<0||t>=b[m.vehicle].length||!Number.isFinite(qty)||qty<=0){problems.push(m.id);continue;}
   b[m.vehicle][t]=litres(b[m.vehicle][t]+(m.type==='CARGA'?qty-loss:-qty));
   if(m.type==='CARGA'&&b.cisterna!=null)b.cisterna=litres(b.cisterna-qty);
   if(b[m.vehicle][t]<-0.001||b[m.vehicle][t]>1000.001||(b.cisterna!=null&&b.cisterna<-0.001))problems.push(m.id);
  }
  for(const v of ['camion','furgoneta'])b[v]=b[v].map(n=>litres(n));
  if(b.cisterna!=null)b.cisterna=litres(b.cisterna);
  return {ready:true,problems,balances:b};
 }
 /** Mira si un lote pendiente dejaría stock inválido (espejo de la validación servidor Fase A). */
 function stockOk(meta){const r=balances(meta);return !r.ready||!r.problems.length;}
 /** Reintento exponencial acotado: protege Supabase ante fallos persistentes sin perder la cola. */
 function retryDelay(consecutiveFailures){
  const n=Math.max(0,Math.min(7,Math.floor(Number(consecutiveFailures)||0)));
  if(n===0)return 2000;
  return Math.min(120000,2000*Math.pow(2,n-1));
 }
 /** Gate serial para save/sync: evita carreras sobre meta. */
 function createGate(){
  let chain=Promise.resolve();
  return function exclusive(fn){
   const run=chain.then(()=>fn(),()=>fn());
   chain=run.then(()=>{},()=>{});
   return run;
  };
 }
 /**
  * Política de reintento tras sync anticipado.
  * busy → no tocar timer (lo reprograma el finally del sync en curso).
  * offline + activos + pendientes → reintentar.
  * desactivado + pendientes → no descartar; no empujar.
  */
 function retryAfterGate({busy,online,active,stopped,editingTab,pendingCount}){
  if(stopped||!editingTab)return {action:'idle',ms:null,keepPending:true};
  if(busy)return {action:'defer',ms:null,keepPending:true};
  if(!active)return {action:'hold',ms:null,keepPending:true,reason:'deactivated'};
  if(!online)return {action:'idle',ms:null,keepPending:true,reason:'offline-wait-event'};
  if(pendingCount>0)return {action:'retry',ms:2000,keepPending:true};
  return {action:'idle',ms:15000,keepPending:true};
 }
 const api={copy,litres,signature,validSource,extract,empty,capture,receive,reconcileSnapshot,acknowledge,visibleMeta,batch,resolve,effective,stockRecords,hydrate,balances,stockOk,retryDelay,allowedPending,permittedPending,createGate,retryAfterGate};
 root.TankSyncCore=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
