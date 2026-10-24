// Importador XLSX CDT-v0.4, local y sin dependencias externas.
// Solo admite ZIP con entradas sin compresión (formato emitido por xlsx-local.js).
const CDTImport=(()=>{
 const decoder=new TextDecoder('utf-8');
 function unzip(buffer){
  const b=new Uint8Array(buffer),v=new DataView(buffer),files=new Map();let p=0,n=0;
  if(b.length>5_000_000)throw Error('Excel demasiado grande (máximo 5 MB).');
  const u16=i=>v.getUint16(i,true),u32=i=>v.getUint32(i,true);
  while(p+4<=b.length&&u32(p)===0x04034b50){
   if(++n>40)throw Error('Demasiadas entradas en el archivo');
   if(p+30>b.length)throw Error('ZIP incompleto');
   const flags=u16(p+6),method=u16(p+8),size=u32(p+18),nameLen=u16(p+26),extraLen=u16(p+28);
   if(flags&8||method!==0)throw Error('Excel no compatible: se necesita exportación original de Control de Tanques.');
   const start=p+30+nameLen+extraLen,end=start+size;
   if(end>b.length||nameLen>180||size>1_000_000)throw Error('Entrada ZIP inválida');
   const name=decoder.decode(b.slice(p+30,p+30+nameLen));
   if(!/^(\[Content_Types\]\.xml|_rels\/\.rels|xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/worksheets\/sheet[1-8]\.xml)$/.test(name))throw Error('Archivo no reconocido como Excel de jornada');
   if(files.has(name))throw Error('Entrada ZIP repetida');
   files.set(name,decoder.decode(b.slice(start,end)));p=end;
  }
  if(n<8)throw Error('Excel incompleto');
  return files;
 }
 function rows(xml){
  if(!xml)throw Error('Falta una hoja obligatoria');
  const doc=new DOMParser().parseFromString(xml,'application/xml');
  if(doc.querySelector('parsererror'))throw Error('Hoja Excel inválida');
  const sheetrows=[...doc.getElementsByTagName('row')];
  if(sheetrows.length>4000)throw Error('Demasiadas operaciones en el archivo');
  return sheetrows.map(row=>[...row.getElementsByTagName('c')].map(c=>{
   const inline=c.getElementsByTagName('t')[0];const value=c.getElementsByTagName('v')[0];
   return String(inline?.textContent??value?.textContent??'');
  }));
 }
 const dict=rs=>Object.fromEntries(rs.slice(1).filter(r=>r[0]).map(r=>[r[0],r[1]||'']));
 const equal=(a,b)=>Math.abs(Number(a)-Number(b))<0.001;
 function parse(buffer){
  const files=unzip(buffer);const pages=[];
  for(let i=1;i<=8;i++)pages.push(rows(files.get(`xl/worksheets/sheet${i}.xml`)));
  const [j,m,l,v,d,c,r,ctrl]=pages;
  if(j[0]?.[0]!=='Campo'||m[0]?.[0]!=='ID'||m[0]?.[1]!=='Tipo'||l[0]?.[0]!=='ID'||v[0]?.[0]!=='ID'||d[0]?.[0]!=='ID'||ctrl[0]?.[0]!=='Parámetro')throw Error('Estructura de hojas no válida');
  const meta=dict(j),control=dict(ctrl);
  if(meta.Formato!=='CDT-v0.4'||control.Formato!=='CDT-v0.4'||meta.Entorno!=='SOLO DEMOSTRACIÓN')throw Error('Solo se admiten Excel de pruebas CDT-v0.4');
  const id=meta['ID de jornada'],date=meta.Fecha,role=meta.Perfil;
  if(!id||id.length>100||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)||!['almacen','reparto'].includes(role)||control['ID jornada']!==id||control.Fecha!==date||control.Perfil!==role)throw Error('Metadatos de la jornada inconsistentes');
  const details=role==='almacen'?l.slice(1):d.slice(1);
  if(details.length!==m.length-1)throw Error('No coinciden las filas de Movimientos y detalle');
  const detailIds=new Set(),visitIds=new Set(v.slice(1).map(x=>x[0]));
  const valid=[],issues=[],seen=new Set();
  for(const row of m.slice(1)){
   const [mid,type,vehicle,source,client,dest,litersTxt,lossTxt,time]=row;
   let reason='';const litres=Number(litersTxt),loss=Number(lossTxt),tank=Number(source);
   if(!mid||mid.length>100||seen.has(mid))reason='ID de movimiento ausente o repetido en el Excel';
   else if(type!==(role==='almacen'?'CARGA':'DESCARGA'))reason='Tipo incompatible con el perfil';
   else if(!['camion','furgoneta'].includes(vehicle)||!Number.isInteger(tank)||tank<1||tank>(vehicle==='camion'?3:1))reason='Vehículo o tanque de origen inválido';
   else if(!Number.isFinite(litres)||litres<=0||litres>1000||!Number.isFinite(loss)||loss<0||loss>1000)reason='Cantidad fuera de rango';
   else if(!Number.isFinite(Date.parse(time)))reason='Fecha de operación inválida';
   else if(role==='reparto'&&(!client||!['1','2','3'].includes(dest)||loss!==0))reason='Destino o merma inválidos';
   else if(role==='almacen'&&(client||dest))reason='Carga con destino de cliente';
   if(!reason){
    const found=details.find(x=>x[0]===mid);
    if(!found||detailIds.has(mid))reason='Movimiento sin detalle único';
    else if(role==='almacen'&&!(found[1]===vehicle&&Number(found[2])===tank&&equal(found[3],litres)&&equal(found[4],loss)&&found[5]===time))reason='Detalle de carga inconsistente';
    else if(role==='reparto'&&!(visitIds.has(found[1])&&found[2]===vehicle&&found[3]===client&&Number(found[4])===tank&&String(found[5])===dest&&equal(found[8],litres)&&found[9]===time))reason='Detalle de descarga inconsistente';
    detailIds.add(mid);
   }
   seen.add(mid);
   if(reason)issues.push({id:mid||'(sin ID)',reason});
   else valid.push({id:mid,type,vehicle,tank,client,dest,litres,loss,time,journalId:id,date,role});
  }
  if(valid.length+issues.length!==m.length-1)throw Error('Error interno de validación');
  let provisional=[];try{provisional=JSON.parse(control['Aperturas provisionales']||'[]');if(!Array.isArray(provisional))provisional=[];provisional=provisional.filter(p=>p&&['camion','furgoneta'].includes(p.vehicle)&&Array.isArray(p.amounts)&&p.amounts.length===(p.vehicle==='camion'?3:1)&&p.amounts.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1000)).slice(0,30)}catch(e){provisional=[];}
  const cancellations=[];const cancelIds=new Set();
  for(const row of c.slice(1)){
   if(row[3]!=='ANULACION_CDT')continue;
   const [cid,visitId,dischargeId,,previous,next,at]=row;
   let original,info;try{original=JSON.parse(previous);info=JSON.parse(next)}catch(e){issues.push({id:cid,reason:'Anulación con JSON inválido'});continue}
   if(role!=='reparto'||!cid||cid.length>100||cancelIds.has(cid)||!visitId||!dischargeId||!['camion','furgoneta'].includes(original.vehicle)||!original.client||!Number.isFinite(Number(original.liters))||Number(original.liters)<=0||Number(original.liters)>1000||!info.reason||!Date.parse(at)){
    issues.push({id:cid||'(sin ID)',reason:'Anulación inválida'});continue;
   }
   cancelIds.add(cid);cancellations.push({id:cid,visitId,dischargeId,vehicle:original.vehicle,client:original.client,liters:Number(original.liters),reason:String(info.reason).slice(0,200),at});
  }
  return {cancellations,provisional,meta:{id,date,role,worker:meta['Operario (demo)']||'',createdAt:meta['Exportación UTC']||''},movements:valid,issues,summary:{rows:m.length-1,visits:v.length-1,corrections:c.length-1,resets:r.length-1}};
 }
 return {parse};
})();
