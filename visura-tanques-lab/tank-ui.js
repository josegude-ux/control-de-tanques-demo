'use strict';
globalThis.LabTankUI = (() => {
  const D = globalThis.LabTankDomain, repo = D.repository();
  let data, tab = 'panel', selected = '', error = '', busy = false, filter = 'pending', requestId = crypto.randomUUID();
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const liters = n => Number(n).toLocaleString('es-ES', { maximumFractionDigits: 2 });
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const actor = () => ({ role: state.role === 'reparto' ? 'conductor' : state.role, name: state.role === 'reparto' ? (document.getElementById('labDriver')?.value || 'Conductor LAB') : state.role + ' simulado' });
  const management = () => state.role === 'gerencia' || state.role === 'almacen';
  const button = (label, act, attrs = '', secondary = false) => `<button type="button" class="btn ${secondary ? 'secondary' : ''}" data-lab-act="${act}" ${attrs}>${label}</button>`;
  const field = (name, label, type = 'text', value = '', attrs = '') => `<label class="field">${label}<input name="${name}" type="${type}" value="${escape(value)}" ${attrs}></label>`;
  const number = (name, label, value = '', attrs = '') => field(name, label, 'number', value, `step="0.01" inputmode="decimal" required ${attrs}`);
  const reason = () => field('reason', 'Motivo', 'text', '', 'required maxlength="160"');
  const submit = text => `<button class="btn" type="submit" ${busy ? 'disabled' : ''}>${text}</button>`;
  function tabs() {
    const items = [['panel', 'Existencias'], ...(state.role === 'gerencia' ? [['config', 'Configuración']] : []), ...(state.role === 'almacen' ? [['load', 'Carga / recarga']] : []), ...(globalThis.LabTankPhase2 ? [['work', 'Jornada']] : []), ...(management() && globalThis.LabTankPhase2 ? [['incidents', `Incidencias${pending() ? ' · ' + pending() : ''}`]] : []), ['history', 'Historial']];
    return `<div class="lab-tabs" role="tablist">${items.map(([id, label]) => `<button type="button" role="tab" aria-selected="${tab === id}" data-lab-act="tab" data-tab="${id}">${label}</button>`).join('')}</div>`;
  }
  function pending() { return data?.incidents.filter(i => i.status === 'pending').length || 0; }
  function tankList(v) { return `<div class="lab-tanks">${v.tanks.map((n, i) => `<div class="tank-line"><div class="row"><b>T${i + 1}</b><strong class="mono">${liters(n)} / ${liters(v.capacity)} L</strong></div><meter min="0" max="${v.capacity}" value="${n}" aria-label="Tanque ${i + 1}"></meter></div>`).join('')}</div>`; }
  function panel() {
    const m = D.active(data);
    const vehicles = state.role === 'reparto' ? data.vehicles.filter(v => v.driver === 'Conductor LAB') : data.vehicles;
    return `<h2 class="heading">Existencias · LAB</h2><div class="statgrid"><div class="stat"><span>Nodriza primaria${m ? ' · ' + escape(m.code) : ''}</span><strong>${m ? liters(m.balance) : 'Sin alta'}${m ? ' L' : ''}</strong><small>Nominal: 25.000 L</small></div><div class="stat"><span>${escape(data.beer)}</span><strong>${data.vehicles.length} vehículos</strong><small>Registro local compartido entre perfiles simulados</small></div></div>${management() && globalThis.LabTankPhase2 ? `<div class="row spaced"><h3>Incidencias pendientes</h3><b class="big" data-lab-pending="panel">${pending()}</b></div>` : ''}${state.role === 'gerencia' && data.notifications.length ? `<h3>Notificaciones · Gerencia simulada</h3>${data.notifications.slice(-5).reverse().map(n => `<p class="compact">${escape(n.message)} · ${escape(n.at)}</p>`).join('')}` : ''}<div class="lab-vehicles">${vehicles.map(v => `<article class="card"><h3>${escape(v.name)} · ${escape(v.code)}</h3><p class="compact">${v.active ? 'Activo' : 'Inactivo'} · ${v.verified ? 'Verificado' : 'Sin verificar'} · ${escape(v.driver || 'Sin conductor')} · ${v.enabledDay === today() ? 'Habilitado hoy' : 'Sin habilitación de hoy'}</p>${tankList(v)}</article>`).join('') || '<p class="empty">No hay vehículos configurados para esta vista.</p>'}</div>`;
  }
  function configuration() {
    if (state.role !== 'gerencia') return '<p>Solo Gerencia simulada.</p>';
    const m = D.active(data);
    return `<h2 class="heading">Configuración · Gerencia simulada</h2><section class="lab-section"><h3>${m ? 'Cerrar y reemplazar nodriza' : 'Alta de nodriza primaria'}</h3>${m ? `<p>Cierre de ${escape(m.code)}: merma calculada de <b>${liters(m.balance)} L</b>.</p>` : ''}<form data-lab-form="mother">${field('code', 'Código físico único', 'text', '', 'required maxlength="160"')}${number('liters', 'Litros iniciales confirmados (0–25.000 L)', '', 'min="0" max="25000"')}${m ? reason() : ''}<label class="check"><input name="confirmed" type="checkbox" required> Confirmo los litros comprobados${m ? ' y el cierre con merma del sobrante' : ''}.</label>${submit(m ? 'Cerrar y activar reemplazo' : 'Activar nodriza')}</form></section><section class="lab-section"><h3>Nuevo vehículo · tanques vacíos</h3><form data-lab-form="vehicle">${field('code', 'Código del vehículo', 'text', '', 'required maxlength="160"')}${field('name', 'Nombre del vehículo', 'text', '', 'required maxlength="160"')}${field('count', 'Número de tanques (1–100, límite LAB)', 'number', 3, 'min="1" max="100" step="1" required')}${number('capacity', 'Capacidad común por tanque (L)', 1000, 'min="0.01"')}${submit('Añadir vehículo')}</form></section><section class="lab-section"><h3>Vehículos configurados</h3>${data.vehicles.map(v => `<form data-lab-form="configure" data-vehicle="${escape(v.id)}"><h4>${escape(v.name)}</h4>${field('count', 'Número de tanques', 'number', v.tanks.length, 'min="1" max="100" step="1" required')}${number('capacity', 'Capacidad común por tanque (L)', v.capacity, 'min="0.01"')}${reason()}${submit('Guardar configuración')}</form>`).join('') || '<p>Sin vehículos.</p>'}</section><section class="lab-section"><h3>Nodrizas · códigos reservados</h3>${data.mothers.map(m => `<p>${escape(m.code)} · ${m.active ? 'Activa' : 'Cerrada'} · apertura ${liters(m.opening)} L${m.active ? '' : ' · merma ' + liters(m.loss) + ' L'}</p>`).join('')}</section>`;
  }
  function vehicleSelect() { return `<label class="field">Vehículo<select id="labVehicle">${data.vehicles.map(v => `<option value="${escape(v.id)}" ${selected === v.id ? 'selected' : ''}>${escape(v.name)}${v.active ? '' : ' · inactivo'}</option>`).join('')}</select></label>`; }
  function loadPage() {
    if (state.role !== 'almacen') return '<p>Solo Almacén simulado.</p>';
    const v = data.vehicles.find(v => v.id === selected), m = D.active(data);
    return `<h2 class="heading">Carga / recarga · Almacén simulado</h2>${vehicleSelect()}${!v || !m ? '<p class="empty">Gerencia debe dar de alta la nodriza y un vehículo.</p>' : `<p>Nodriza ${escape(m.code)} · ${liters(m.balance)} L disponibles</p><form data-lab-form="load">${v.tanks.map((n, i) => number('tank-' + i, `T${i + 1} · saldo ${liters(n)} L · libre ${liters(D.round(v.capacity - n))} L`, 0, 'min="0"')).join('')}<p class="compact">Total a transferir: <b id="labLoadTotal">0 L</b></p>${submit('Confirmar transferencia local')}</form>`}`;
  }
  function history() { return `<h2 class="heading">Historial · dominio LAB</h2>${button('Descargar checkpoint JSON', 'checkpoint', '', true)}${data.history.slice().reverse().map(h => `<article class="audit-movement"><b>${escape(h.type)}</b> · ${escape(h.actor.name)}<p class="tiny">${escape(h.at)} · ID ${escape(h.id)}</p><pre>${escape(JSON.stringify(h.details, null, 2))}</pre></article>`).join('') || '<p class="empty">Sin operaciones.</p>'}`; }
  function render() {
    if (state.page !== 'tanques-lab') return;
    if (!data) { el('screen').innerHTML = '<p>Abriendo registro local LAB…</p>'; return; }
    const allowed = ['panel', 'history', ...(state.role === 'gerencia' ? ['config'] : []), ...(state.role === 'almacen' ? ['load'] : []), ...(globalThis.LabTankPhase2 ? ['work', ...(management() ? ['incidents'] : [])] : [])];
    if (!allowed.includes(tab)) tab = 'panel';
    if (!data.vehicles.some(v => v.id === selected)) selected = data.vehicles[0]?.id || '';
    const views = { panel, config: configuration, load: loadPage, history, work: () => globalThis.LabTankPhase2.renderWork(data, state.role, selected, vehicleSelect(), field, reason, submit, button), incidents: () => globalThis.LabTankPhase2.renderIncidents(data, filter, button) };
    el('screen').innerHTML = `<div class="notice">DOMINIO LAB · Datos ficticios locales · Perfil ${escape(actor().role)} simulado, sin autenticación ni seguridad real.</div>${tabs()}${error ? `<div class="notice error" role="alert">${escape(error)}</div>` : ''}${views[tab]()}`;
    const menu = document.getElementById('labMenuCount'); if (menu) { menu.hidden = !management() || !pending(); menu.textContent = pending(); }
  }
  async function refresh() { try { data = await repo.read(); error = ''; } catch (e) { error = 'No se puede leer el registro: ' + e.message; } render(); }
  async function open() { state.page = 'tanques-lab'; await refresh(); }
  async function execute(command) {
    if (busy) return;
    busy = true;
    try {
      const P = globalThis.LabTankPhase2;
      data = await repo.execute({ ...command, id: requestId }, actor(), new Date().toISOString(), P?.extend, P?.reject);
      requestId = crypto.randomUUID(); error = ''; toast('Operación ficticia guardada');
    } catch (e) { error = e.message; try { data = await repo.read(); } catch { error += ' · No se pudo releer el registro'; } }
    finally { busy = false; render(); }
  }
  function checkpoint() {
    const payload = { order: 'VISURA-14-WORK-TANQUES-001', distribution: 'VISURA-00-DIST-F2-001', environment: 'LAB FICTIONAL LOCAL ONLY', baseline: '1fb3f81722af7270b11827761f6bba1fcb4b4087', exportedAt: new Date().toISOString(), state: data };
    const u = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })), a = document.createElement('a'); a.href = u; a.download = 'VISURA-LAB-checkpoint-r' + data.revision + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000);
  }
  document.addEventListener('click', e => {
    const node = e.target.closest('[data-lab-act]'); if (!node) return;
    const action = node.dataset.labAct;
    if (action === 'open') open();
    if (action === 'legacy') { state.page = 'inicio'; window.render(); }
    if (action === 'tab') { tab = node.dataset.tab; requestId = crypto.randomUUID(); error = ''; refresh(); }
    if (action === 'checkpoint') checkpoint();
    if (action === 'resolve') { requestId = crypto.randomUUID(); const reason = document.querySelector(`[data-resolution="${CSS.escape(node.dataset.id)}"]`)?.value; execute({ type: 'resolve', incident: node.dataset.id, reason }); }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'labVehicle') { selected = e.target.value; requestId = crypto.randomUUID(); render(); }
    if (e.target.id === 'labIncidentFilter') { filter = e.target.value; render(); }
  });
  document.addEventListener('input', e => {
    if (e.target.closest('[data-lab-form]')) requestId = crypto.randomUUID();
    if (e.target.name?.startsWith('tank-')) { const total = [...document.querySelectorAll('[name^="tank-"]')].reduce((s, n) => s + Number(n.value || 0), 0); const output = document.getElementById('labLoadTotal'); if (output) output.textContent = liters(total) + ' L'; }
  });
  document.addEventListener('submit', e => {
    const form = e.target.closest('[data-lab-form]'); if (!form) return;
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(form)), type = form.dataset.labForm;
    let command = { ...raw, type, vehicle: form.dataset.vehicle || selected };
    if (type === 'mother') command = { ...command, liters: Number(raw.liters), confirmed: raw.confirmed === 'on', expectedMother: D.active(data)?.id || null };
    if (type === 'vehicle' || type === 'configure') command = { ...command, count: Number(raw.count), capacity: Number(raw.capacity) };
    if (type === 'load') command = { type, vehicle: selected, mother: D.active(data)?.id || null, lines: Object.entries(raw).filter(([key, value]) => key.startsWith('tank-') && Number(value) !== 0).map(([key, value]) => ({ tank: Number(key.slice(5)), liters: Number(value) })) };
    if (globalThis.LabTankPhase2) command = globalThis.LabTankPhase2.command(command, raw, today());
    execute(command);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state?.page === 'tanques-lab') refresh(); });
  return { open, render, refresh, pending };
})();