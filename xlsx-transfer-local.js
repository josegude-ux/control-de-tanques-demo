// Importador estricto del archivo de traspaso de cargas (solo archivos sin compresión emitidos por esta app).
'use strict';
const CDTTransfer=(()=>{
 const decoder=new TextDecoder('utf-8');
 function filesFrom(buffer){const b=new Uint8Array(buffer),d=new DataView(buffer),files={};let pos=0,n=0;
  if(b.byteLength>2000000)throw Error('Archivo demasiado grande');
  while(pos+30<=b.length&&d.getUint32(pos,true)===0x04034b50){
   const method=d.getUint16(pos+8,true),flags=d.getUint16(pos+6,true),size=d.getUint32(pos+18,true),nl=d.getUint16(pos+26,true),xl=d.getUint16(pos+28,true);
   if(method!==0||flags&8||size>700000||nl>180||++n>12)throw Error('Archivo XLSX de traspaso no compatible');
   const start=pos+30+nl+xl,end=start+size;if(end>b.length)throw Error('Excel incompleto');
   const name=decoder.decode(b.slice(pos+30,pos+30+nl));
   if(!/^(\[Content_Types\]\.xml|_rels\/\.rels|xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/worksheets\/sheet[12]\.xml)$/.test(name)||files[name])throw Error('Estructura Excel no reconocida');
   files[name]=decoder.decode(b.slice(start,end));pos=end;
  }return files;
 }
 function rows(xml){if(!xml)throw Error('Falta una hoja Excel');const doc=new DOMParser().parseFromString(xml,'application/xml');
  if(doc.querySelector('parsererror'))throw Error('XML inválido');const all=[...doc.getElementsByTagName('row')];if(all.length>2500)throw Error('Demasiadas cargas');
  return all.map(r=>[...r.getElementsByTagName('c')].map(c=>String(c.getElementsByTagName('t')[0]?.textContent??c.getElementsByTagName('v')[0]?.textContent??'')));
 }
 function parse(buffer){const fs=filesFrom(buffer),meta=rows(fs['xl/worksheets/sheet1.xml']),data=rows(fs['xl/worksheets/sheet2.xml']);
  const m=Object.fromEntries(meta.slice(1).map(x=>[x[0],x[1]]));
  if(meta[0]?.[0]!=='Campo'||data[0]?.[0]!=='ID carga'||m.Formato!=='CDT-TRASPASO-v0.7'||m.Entorno!=='SOLO DEMOSTRACIÓN'||!['camion','furgoneta'].includes(m['Vehículo'])||!m['ID traspaso'])throw Error('No es un traspaso CDT válido');
  if(Number(m['Nº cargas'])!==data.length-1)throw Error('Número de cargas inconsistente');const seen=new Set();
  const loads=data.slice(1).map(r=>{const [id,vehicle,tankRaw,litresRaw,lossRaw,time,journalId]=r,tank=Number(tankRaw),litres=Number(litresRaw),loss=Number(lossRaw);
   if(!id||id.length>100||seen.has(id)||vehicle!==m['Vehículo']||!Number.isInteger(tank)||tank<1||tank>(vehicle==='camion'?3:1)||!Number.isFinite(litres)||litres<=0||litres>1000||!Number.isFinite(loss)||loss<0||loss>1000||!Number.isFinite(Date.parse(time))||!journalId)throw Error('Carga incorrecta o repetida en archivo');
   seen.add(id);return {id,vehicle,tank,litres,loss,time,journalId};
  });return {vehicle:m['Vehículo'],loads,id:m['ID traspaso']};
 }
 function parseStock(buffer){
  const fs=filesFrom(buffer),meta=rows(fs['xl/worksheets/sheet1.xml']),data=rows(fs['xl/worksheets/sheet2.xml']);
  const m=Object.fromEntries(meta.slice(1).map(r=>[r[0],r[1]]));
  if(m.Formato!=='CDT-EXISTENCIAS-v1'||m.Entorno!=='SOLO DEMOSTRACIÓN'||!['almacen','gerencia'].includes(m.Origen)||!['camion','furgoneta'].includes(m['Vehículo'])||!m['ID inventario']||!Number.isFinite(Date.parse(m['Fecha UTC'])))throw Error('No es un Excel de existencias CDT válido');
  if(data.length!==(m['Vehículo']==='camion'?4:2)||data[0]?.[0]!=='Tanque')throw Error('Tanques incompletos');
  const amounts=data.slice(1).map((r,i)=>{const n=Number(r[1]);if(Number(r[0])!==i+1||r[1]===''||!Number.isFinite(n)||n<0||n>1000)throw Error('Saldo de tanque inválido');return n});
  return {id:m['ID inventario'],vehicle:m['Vehículo'],source:m.Origen,at:m['Fecha UTC'],amounts};
 }
 return {parse,parseStock};
})();
