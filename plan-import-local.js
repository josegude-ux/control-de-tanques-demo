'use strict';
// Solo Excel de planificación generado por esta app; no interpreta Excel arbitrarios.
const CDTPlanImport=(()=>{
 function parse(buffer){
  const bytes=new Uint8Array(buffer),view=new DataView(buffer),dec=new TextDecoder(),files=new Map();let p=0;
  if(bytes.length>5000000)throw Error('Archivo demasiado grande');
  const u16=i=>view.getUint16(i,true),u32=i=>view.getUint32(i,true);
  while(p+4<=bytes.length&&u32(p)===0x04034b50){
   if(p+30>bytes.length)throw Error('Excel incompleto');
   const flags=u16(p+6),method=u16(p+8),size=u32(p+18),nl=u16(p+26),ex=u16(p+28),start=p+30+nl+ex,end=start+size;
   if(flags&8||method!==0)throw Error('Formato no compatible: importa el Excel original exportado por Gerencia');
   if(end>bytes.length||nl>180||size>1000000)throw Error('Archivo inválido');
   const name=dec.decode(bytes.slice(p+30,p+30+nl));
   if(files.has(name))throw Error('Archivo duplicado');
   if(name.startsWith('xl/worksheets/sheet'))files.set(name,dec.decode(bytes.slice(start,end)));
   p=end;
  }
  function rows(name){const xml=files.get(name);if(!xml)throw Error('Falta hoja de planificación');const doc=new DOMParser().parseFromString(xml,'application/xml');if(doc.querySelector('parsererror'))throw Error('Excel mal formado');const rs=[...doc.getElementsByTagName('row')];if(rs.length>2000)throw Error('Demasiadas entregas');return rs.map(row=>[...row.getElementsByTagName('c')].map(c=>String(c.getElementsByTagName('t')[0]?.textContent??c.getElementsByTagName('v')[0]?.textContent??'')));}
  const meta=rows('xl/worksheets/sheet1.xml'),data=rows('xl/worksheets/sheet2.xml');
  const dict=Object.fromEntries(meta.map(r=>[r[0],r[1]]));
  if(meta[0]?.[0]!=='Semana'||meta[1]?.[0]!=='Vehículo'||data[0]?.join('|')!=='ID entrega|Fecha|Vehículo|Repartidor|Cliente|Población|Litros previstos|Dirección|Enlace Maps')throw Error('No es una planificación CDT compatible');
  const vehicle=dict['Vehículo'],week=dict['Semana'],version=Number(dict['Versión']);
  if(!['camion','furgoneta'].includes(vehicle)||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(week)||!Number.isSafeInteger(version)||version<1)throw Error('Datos de planificación incorrectos');
  const seen=new Set();const entries=data.slice(1).filter(r=>r.some(Boolean)).map(r=>{const [id,date,v,worker,client,town,amount,address,maps]=r;const liters=Number(amount);
   if(!id||id.length>120||seen.has(id)||v!==vehicle||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)||!date.startsWith(week.slice(0,4))||!client||!Number.isFinite(liters)||liters<=0||liters>3000)throw Error('Una entrega contiene datos inválidos o duplicados');
   seen.add(id);return {id,date,vehicle:v,worker,client,town,liters,address,maps};});
  if(!entries.length)throw Error('Planificación sin entregas');
  return {week,vehicle,version,entries};
 }
 return {parse};
})();
