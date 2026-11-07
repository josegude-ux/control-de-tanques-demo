'use strict';
// Pure local model. No remote services, authentication or legacy balance imports.
globalThis.LabTankDomain = (() => {
  const CAPACITY = 25000;
  const copy = value => JSON.parse(JSON.stringify(value));
  const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
  const text = value => typeof value === 'string' ? value.trim() : '';
  const code = value => text(value).normalize('NFKC').toUpperCase();
  function fail(message, kind = 'invalid') { const e = new Error(message); e.kind = kind; throw e; }
  function amount(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || Math.abs(value - round(value)) > 1e-8) fail('Litros inválidos; máximo dos decimales');
    return value;
  }
  function required(value, label) { const result = text(value); if (!result || result.length > 160) fail('Indique ' + label); return result; }
  function role(actor, allowed) { if (!allowed.includes(actor?.role)) fail('Perfil simulado no autorizado', 'permission'); }
  function initial() { return { version: 1, revision: 0, beer: 'Cerveza única LAB', mothers: [], vehicles: [], history: [], requests: {}, incidents: [], notifications: [] }; }
  function active(s) { return s.mothers.find(m => m.active); }
  function vehicle(s, id) { const v = s.vehicles.find(v => v.id === id); if (!v) fail('Vehículo no encontrado'); return v; }
  function tank(v, index) { if (!Number.isInteger(index) || index < 0 || index >= v.tanks.length) fail('Tanque no encontrado'); return index; }
  function invariant(s) {
    if (s.mothers.filter(m => m.active).length > 1) fail('Más de una nodriza activa');
    if (new Set(s.mothers.map(m => m.code)).size !== s.mothers.length) fail('Código de nodriza repetido');
    for (const m of s.mothers) { if (m.capacity !== CAPACITY) fail('Capacidad de nodriza inválida'); amount(m.balance, 0, CAPACITY); if (!m.active && m.balance !== 0) fail('Nodriza cerrada con saldo'); }
    if (new Set(s.vehicles.map(v => v.code)).size !== s.vehicles.length) fail('Código de vehículo repetido');
    for (const v of s.vehicles) { amount(v.capacity, 0.01); if (!v.tanks.length) fail('Vehículo sin tanques'); v.tanks.forEach(n => amount(n, 0, v.capacity)); }
    return s;
  }
  const fingerprint = c => JSON.stringify(c, Object.keys(c).sort());
  // Nested payload keys must also participate in idempotency.
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  function apply(input, command, actor, at, extension) {
    invariant(input);
    const id = required(command.id, 'ID de operación');
    if (!Number.isFinite(Date.parse(at))) fail('Fecha inválida');
    const signature = JSON.stringify(canonical({ command, actor }));
    const previous = input.requests[id];
    if (previous) { if (previous.signature !== signature) fail('ID ya utilizado con otros datos', 'conflict'); return copy(input); }
    const s = copy(input), c = copy(command);
    let details;
    if (c.type === 'mother') {
      role(actor, ['gerencia']);
      const physicalCode = code(required(c.code, 'código físico'));
      if (s.mothers.some(m => m.code === physicalCode)) fail('Código físico utilizado; no se puede reutilizar');
      amount(c.liters, 0, CAPACITY);
      if (c.confirmed !== true) fail('Confirme los litros iniciales');
      const current = active(s);
      if ((current?.id || null) !== (c.expectedMother || null)) fail('La nodriza activa ha cambiado; revise el reemplazo', 'conflict');
      const loss = current?.balance || 0;
      if (current) { required(c.reason, 'motivo de cierre'); current.active = false; current.closedAt = at; current.loss = loss; current.balance = 0; }
      s.mothers.push({ id, code: physicalCode, capacity: CAPACITY, balance: c.liters, opening: c.liters, active: true, openedAt: at });
      details = { code: physicalCode, opening: c.liters, closed: current?.id || null, loss, reason: c.reason || '' };
    } else if (c.type === 'vehicle') {
      role(actor, ['gerencia']);
      const physicalCode = code(required(c.code, 'código de vehículo'));
      if (s.vehicles.some(v => v.code === physicalCode)) fail('Código de vehículo utilizado');
      const name = required(c.name, 'nombre');
      if (!Number.isInteger(c.count) || c.count < 1 || c.count > 100) fail('Número de tanques: entre 1 y 100 (límite LAB)');
      amount(c.capacity, 0.01);
      s.vehicles.push({ id, code: physicalCode, name, capacity: c.capacity, tanks: Array(c.count).fill(0), active: true, verified: false, driver: '', enabledDay: null });
      details = { code: physicalCode, count: c.count, capacity: c.capacity };
    } else if (c.type === 'configure') {
      role(actor, ['gerencia']);
      const v = vehicle(s, c.vehicle);
      if (!Number.isInteger(c.count) || c.count < 1 || c.count > 100) fail('Número de tanques: entre 1 y 100 (límite LAB)');
      amount(c.capacity, 0.01); required(c.reason, 'motivo');
      if (v.tanks.slice(c.count).some(n => n > 0) || v.tanks.some(n => n > c.capacity)) fail('Configuración incompatible con los saldos; vacíe o ajuste primero');
      details = { vehicle: v.id, before: copy(v), count: c.count, capacity: c.capacity, reason: c.reason };
      v.tanks = Array.from({ length: c.count }, (_, i) => v.tanks[i] || 0); v.capacity = c.capacity; v.verified = false; v.enabledDay = null;
    } else if (c.type === 'load') {
      role(actor, ['almacen']);
      const v = vehicle(s, c.vehicle), m = active(s);
      if (!v.active) fail('Vehículo inactivo');
      if (!m) fail('Dé de alta una nodriza');
      if (c.mother !== m.id) fail('La nodriza activa ha cambiado; revise la carga', 'conflict');
      if (!Array.isArray(c.lines) || !c.lines.length) fail('Seleccione al menos un tanque');
      const seen = new Set(); let total = 0;
      for (const line of c.lines) {
        tank(v, line.tank); if (seen.has(line.tank)) fail('Tanque repetido'); seen.add(line.tank);
        amount(line.liters, 0.01); total = round(total + line.liters);
        if (round(v.tanks[line.tank] + line.liters) > v.capacity) fail('Se supera la capacidad del tanque');
      }
      if (total > m.balance) fail('Saldo insuficiente de nodriza', 'negative');
      details = { vehicle: v.id, mother: m.id, lines: c.lines, total, before: { mother: m.balance, tanks: copy(v.tanks) } };
      m.balance = round(m.balance - total); for (const line of c.lines) v.tanks[line.tank] = round(v.tanks[line.tank] + line.liters);
    } else if (extension) { details = extension(s, c, actor, at); }
    else fail('Operación desconocida');
    invariant(s); s.revision++;
    s.history.push({ id, type: c.type, actor: copy(actor), at, details: copy(details) });
    s.requests[id] = { signature, revision: s.revision };
    return s;
  }
  function frozen(value) { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; }
  // One read + one write in a single IndexedDB transaction. Concurrent tabs serialize.
  function repository(factory = globalThis.indexedDB) {
    let opened;
    function open() { return opened ||= new Promise((resolve, reject) => { const r = factory.open('visura-lab-tanks-v1', 1); r.onupgradeneeded = () => r.result.createObjectStore('domain'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
    async function read() { const db = await open(); return new Promise((resolve, reject) => { const t = db.transaction('domain', 'readonly'), r = t.objectStore('domain').get('state'); r.onsuccess = () => { try { resolve(frozen(invariant(r.result || initial()))); } catch (e) { reject(e); } }; r.onerror = () => reject(r.error); }); }
    async function execute(command, actor, at, extension, onReject) {
      const db = await open(); return new Promise((resolve, reject) => {
        const t = db.transaction('domain', 'readwrite'), store = t.objectStore('domain'), r = store.get('state'); let result, failure;
        r.onsuccess = () => { try { const old = r.result || initial(); try { result = apply(old, command, actor, at, extension); } catch (e) { if (e.kind !== 'negative' || !onReject) throw e; result = onReject(old, command, actor, at, e); failure = e; } store.put(result, 'state'); } catch (e) { failure = e; t.abort(); } };
        t.oncomplete = () => failure ? reject(failure) : resolve(frozen(result));
        t.onabort = () => reject(failure || t.error || new Error('No se guardó la operación'));
        t.onerror = () => { failure ||= t.error; };
      });
    }
    return { read, execute };
  }
  return { CAPACITY, initial, apply, invariant, active, vehicle, tank, amount, role, fail, required, round, copy, frozen, repository };
})();