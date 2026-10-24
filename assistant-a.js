'use strict';
/* Control de Tanques · Experiencia A (solo DEMO staging)
   Cambia únicamente la presentación de las operaciones existentes.
   El guardado, validaciones de stock, permisos y sincronización siguen en app.js/TankCloud. */
(() => {
  if (window.TankConfig?.env !== 'staging') return;

  const wizard = {
    loadStep: 0,
    dischargeStep: 0,
    visitMode: '',
    loadDraft: {},
    dischargeDraft: {},
    lastVehicle: null,
    openVisitId: null,
    dischargeCount: 0,
    loadCount: 0,
    completedLoad: false,
    completedVisit: false,
    completedDischarge: false
  };
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const litresText = number => Number(number || 0).toLocaleString('es-ES', { maximumFractionDigits: 2 });
  const vehicleName = value => value === 'furgoneta' ? 'Furgoneta' : 'Camión';
  const value = id => document.getElementById(id)?.value ?? '';
  const select = id => document.getElementById(id);
  const notify = message => {
    if (typeof toast === 'function') toast(message);
    else window.alert(message);
  };
  const roleName = () => ({ reparto: 'Reparto', almacen: 'Almacén', gerencia: 'Gerencia' })[state.role] || state.role;

  const newPanel = (html, className = 'assistant-head') => {
    const node = document.createElement('section');
    node.className = className;
    node.innerHTML = html;
    return node;
  };
  const heading = (label, title, desc, step = -1) => '<div class="assistant-eyebrow">' + escapeHTML(label) + '</div>' +
    '<h2>' + escapeHTML(title) + '</h2><p>' + escapeHTML(desc) + '</p>' +
    (step >= 0 ? '<div class="assistant-progress" aria-label="Paso ' + (step + 1) +
      ' de 3">' + [0,1,2].map(index => '<span class="' + (index <= step ? 'is-active' : '') + '"></span>').join('') +
      '</div><div class="assistant-count">Paso ' + (step + 1) + ' de 3</div>' : '');

  function saveFormValues(formId, draft) {
    const form = select(formId);
    if (!form) return;
    for (const control of form.querySelectorAll('input[id],select[id]')) {
      draft[control.id] = control.type === 'checkbox' ? control.checked : control.value;
    }
  }
  function restoreFormValues(formId, draft) {
    const form = select(formId);
    if (!form) return;
    for (const control of form.querySelectorAll('input[id],select[id]')) {
      if (!Object.prototype.hasOwnProperty.call(draft, control.id)) continue;
      if (control.type === 'checkbox') control.checked = !!draft[control.id];
      else if (control.tagName === 'SELECT') {
        if ([...control.options].some(opt => opt.value === String(draft[control.id]))) control.value = draft[control.id];
      } else control.value = draft[control.id];
    }
  }
  function remember() {
    saveFormValues('loadForm', wizard.loadDraft);
    saveFormValues('dischargeForm', wizard.dischargeDraft);
  }
  function synchronizeWizard() {
    if (!state) return;
    if (wizard.lastVehicle !== state.vehicle) {
      wizard.lastVehicle = state.vehicle;
      wizard.loadStep = 0;
      wizard.dischargeStep = 0;
      wizard.loadDraft = {};
      wizard.dischargeDraft = {};
    }
    if (wizard.openVisitId !== (state.openVisit?.id || null)) {
      if (wizard.openVisitId && !state.openVisit) wizard.completedVisit = true;
      wizard.openVisitId = state.openVisit?.id || null;
      wizard.dischargeStep = 0;
      wizard.dischargeDraft = {};
    }
    if (state.openVisit) {
      const count = state.openVisit.discharges?.length || 0;
      if (wizard.dischargeCount !== count) {
        if (count > wizard.dischargeCount && wizard.openVisitId) wizard.completedDischarge = true;
        wizard.dischargeCount = count;
        wizard.dischargeStep = 0;
        wizard.dischargeDraft = {};
      }
    } else wizard.dischargeCount = 0;
    if ((state.loads?.length || 0) > wizard.loadCount && wizard.loadStep === 2) {
      wizard.completedLoad = true;
      wizard.loadStep = 0;
      wizard.loadDraft = {};
    }
    wizard.loadCount = state.loads?.length || 0;
  }
  function heroHome() {
    if (!TankCloud.connected() || !TankCloud.member()?.active) return;
    if (state.role === 'gerencia') {
      const banner = newPanel(heading('Asistente A', 'Gerencia', 'La gestión de inventario y planificación mantiene sus controles completos.'), 'assistant-head');
      select('screen')?.prepend(banner);
      return;
    }
    const screen = select('screen');
    if (!screen) return;
    const vehicle = state.vehicle;
    const stocks = state.tanks?.[vehicle] || [];
    const currentTotal = stocks.reduce((sum, n) => sum + Number(n || 0), 0);
    const isReparto = state.role === 'reparto';
    const stockRows = stocks.map((n, i) =>
      '<div class="assistant-stockrow"><span>Tanque ' + (i + 1) + '</span><strong>' + litresText(n) + ' L</strong></div>'
    ).join('');
    const ready = state.cloudStockReady && !(state.cloudStockProblems || []).length;
    const warning = !ready ? '<div class="assistant-warning">Gerencia debe verificar las existencias antes de operar.</div>' : '';
    const completed = wizard.completedLoad || wizard.completedVisit ?
      '<div class="assistant-success" role="status">Operación registrada en este dispositivo. Comprueba arriba el estado de sincronización.</div>' : '';
    wizard.completedLoad = false;
    wizard.completedVisit = false;
    screen.classList.add('assistant-a');
    screen.innerHTML =
      '<section class="assistant-landing">' +
        heading('CONTROL DE TANQUES · ASISTENTE A', 'Hola, ' + roleName(), 'Una tarea cada vez, con comprobaciones antes de guardar.') +
        completed + warning +
        '<label class="assistant-vehicle">Vehículo<select id="vehicle" aria-label="Seleccionar vehículo">' +
        '<option value="camion"' + (vehicle === 'camion' ? ' selected' : '') + '>Camión</option>' +
        '<option value="furgoneta"' + (vehicle === 'furgoneta' ? ' selected' : '') + '>Furgoneta</option></select></label>' +
        '<div class="assistant-tank-summary"><div class="assistant-total-label">Disponible · ' + vehicleName(vehicle) +
        '</div><div class="assistant-total">' + litresText(currentTotal) + ' <small>L</small></div>' + stockRows + '</div>' +
        (state.openVisit ? '<p class="assistant-current">Tienes una visita abierta: ' + escapeHTML(state.openVisit.client) + '.</p>' : '') +
        '<button type="button" class="assistant-primary" data-guide="start" ' + (!ready ? 'disabled' : '') + '>' +
        (isReparto ? (state.openVisit ? 'Continuar descarga' : 'Empezar una descarga') : 'Empezar una carga') +
        ' <span aria-hidden="true">→</span></button>' +
        '<p class="assistant-hint">Los registros se conservan localmente mientras no haya cobertura. La confirmación remota depende de la sincronización.</p>' +
      '</section>';
  }
  function makeActions(step, primaryText = 'Continuar') {
    return '<div class="assistant-nav">' +
      (step > 0 ? '<button type="button" data-guide="back">← Anterior</button>' :
       '<button type="button" data-guide="home">Cancelar</button>') +
      (step < 2 ? '<button type="button" class="assistant-next" data-guide="next">' + escapeHTML(primaryText) + ' →</button>' : '') +
    '</div>';
  }
  function hideExcept(nodes, visible) {
    nodes.forEach((node, index) => { node.hidden = !visible.includes(index); });
  }
  function decorateLoad() {
    const screen = select('screen');
    const form = select('loadForm');
    if (!screen || !form) return;
    restoreFormValues('loadForm', wizard.loadDraft);
    const step = wizard.loadStep;
    screen.classList.add('assistant-a', 'assistant-form-screen');
    if (wizard.completedLoad) {
      screen.innerHTML = '<section class="assistant-landing assistant-completed">' +
       heading('CARGA COMPLETADA', 'Carga registrada', 'La operación está guardada en este dispositivo. Revisa arriba el estado de la sincronización.') +
       '<div class="assistant-success" role="status">Registro guardado correctamente</div>' +
       '<button type="button" class="assistant-primary" data-guide="home">Volver al inicio →</button>' +
       '<button type="button" class="assistant-secondary" data-guide="more-load">Registrar otra carga</button></section>';
      wizard.completedLoad = false;
      return;
    }
    screen.prepend(newPanel(heading('CARGA · ' + vehicleName(state.vehicle),
      ['Elige el destino', 'Indica los litros', 'Revisa y confirma'][step],
      ['Selecciona el vehículo y el tanque donde vas a cargar.',
       'Introduce la lectura de carga y cómo tratar el sobrante.',
       'Comprueba el resumen antes de registrar el movimiento.'][step], step)));
    const labels = [...form.querySelectorAll(':scope > label.field')];
    hideExcept(labels, step === 0 ? [0,1] : step === 1 ? [2,3] : []);
    const check = form.querySelector(':scope > label.check');
    if (check) check.hidden = step !== 2;
    const submit = form.querySelector('button[type="submit"]');
    if (submit) {
      submit.hidden = step !== 2;
      submit.textContent = 'Confirmar y registrar carga';
      submit.classList.add('assistant-submit');
    }
    const leave = form.querySelector('[data-act="leave-load"]');
    if (leave) leave.hidden = true;
    const info = form.previousElementSibling;
    if (info?.classList.contains('notice')) info.hidden = true;
    const residual = value('residual') === 'desechar' ? 'Desechar como merma' : 'Conservar el sobrante';
    if (step === 2) {
      form.prepend(newPanel('<strong>Resumen de carga</strong>' +
       '<div class="assistant-review-row">Vehículo <b>' + escapeHTML(vehicleName(value('loadVehicle'))) + '</b></div>' +
       '<div class="assistant-review-row">Tanque <b>' + (Number(value('loadTank')) + 1) + '</b></div>' +
       '<div class="assistant-review-row">Lectura <b>' + escapeHTML(value('loadLiters')) + ' L</b></div>' +
       '<div class="assistant-review-row">Sobrante <b>' + residual + '</b></div>', 'assistant-review'));
    }
    form.after(newPanel(makeActions(step), 'assistant-controls'));
    if (step === 2) select('zeroLoad')?.focus({ preventScroll: true });
  }
  function decorateSelection() {
    const screen = select('screen');
    if (!screen) return;
    screen.classList.add('assistant-a','assistant-selection');
    const mode = wizard.visitMode;
    if (wizard.completedVisit) {
      screen.prepend(newPanel('<div class="assistant-success" role="status">Visita finalizada. Revisa el indicador de sincronización.</div>', 'assistant-confirmation'));
      wizard.completedVisit = false;
    }
    const extra = select('extraVisitForm')?.closest('.card');
    const planned = [...screen.querySelectorAll('[data-act="start-planned-visit"]')].map(node => node.closest('.card'));
    const dateBox = select('deliveryDate')?.closest('.card');
    screen.prepend(newPanel(heading('DESCARGA · ' + vehicleName(state.vehicle),
      !mode ? '¿Qué entrega vas a realizar?' : mode === 'plan' ? 'Selecciona el cliente' : 'Entrega extraordinaria',
      !mode ? 'Primero elige si está prevista en la ruta.' :
        mode === 'plan' ? 'Busca el cliente de la planificación recibida.' :
        'Anota el establecimiento y el motivo. Después registrarás los litros.'), 'assistant-head'));
    if (!mode) {
      screen.querySelectorAll(':scope > .card, :scope > .empty, :scope > .hint, :scope > .spaced').forEach(node => { node.hidden = true; });
      screen.prepend(newPanel(
        '<button type="button" data-guide="planned" class="assistant-choice">📋 <span><strong>Entrega de la ruta</strong><small>Cliente previsto en la planificación</small></span> →</button>' +
        '<button type="button" data-guide="extra" class="assistant-choice">＋ <span><strong>Entrega no planificada</strong><small>Urgencia, adelanto o segunda visita</small></span> →</button>',
        'assistant-choices'));
    } else {
      if (dateBox) dateBox.hidden = mode !== 'plan';
      for (const item of planned) if (item) item.hidden = mode !== 'plan';
      if (extra) extra.hidden = mode !== 'extra';
      const back = newPanel('<button type="button" class="assistant-textbutton" data-guide="choose-type">← Cambiar tipo de entrega</button>', 'assistant-controls');
      screen.insertBefore(back, screen.children[1]);
    }
  }
  function decorateDischarge() {
    const screen = select('screen');
    if (!screen) return;
    screen.classList.add('assistant-a','assistant-form-screen');
    if (editingId) {
      screen.prepend(newPanel(heading('DESCARGA · CORRECCIÓN', 'Modificar una descarga',
        'Los cambios serán anotados en el historial.'), 'assistant-head'));
      return;
    }
    const form = select('dischargeForm');
    if (!form) return;
    restoreFormValues('dischargeForm', wizard.dischargeDraft);
    if (wizard.completedDischarge) {
      screen.prepend(newPanel('<div class="assistant-success" role="status">Descarga registrada. Puedes añadir otra o finalizar la visita.</div>', 'assistant-confirmation'));
      wizard.completedDischarge = false;
    }
    const step = wizard.dischargeStep;
    screen.prepend(newPanel(heading('DESCARGA · ' + escapeHTML(state.openVisit?.client),
       ['Tanque de origen','Tanque del cliente','Lectura y confirmación'][step],
       ['¿Desde qué tanque del vehículo se suministra?',
        'Indica el tanque del establecimiento que recibe la cerveza.',
        'Anota la lectura acumulada del contador y confirma los litros entregados.'][step], step), 'assistant-head'));
    const fields = [...form.querySelectorAll(':scope > label.field')];
    hideExcept(fields, step === 0 ? [0] : step === 1 ? [1] : [2]);
    const submit = form.querySelector('button[type=submit]');
    if (submit) {
      submit.hidden = step !== 2;
      submit.textContent = 'Confirmar descarga';
      submit.classList.add('assistant-submit');
    }
    if (step === 2) {
      const previous = Number(state.openVisit?.reading || 0);
      const reading = Number(value('reading'));
      const qty = Number.isFinite(reading) && reading > previous ? litresText(reading - previous) : '—';
      form.prepend(newPanel('<strong>Resumen de entrega</strong>' +
       '<div class="assistant-review-row">Tanque vehículo <b>T' + (Number(value('sourceTank'))+1) + '</b></div>' +
       '<div class="assistant-review-row">Tanque cliente <b>T' + escapeHTML(value('destTank')) + '</b></div>' +
       '<div class="assistant-review-row">Lectura anterior <b>' + litresText(previous) + ' L</b></div>' +
       '<div class="assistant-review-row">Lectura actual <b id="assistantReadingPreview">' + (reading || '—') + ' L</b></div>' +
       '<div class="assistant-review-row assistant-review-em">Litros de esta descarga <b id="assistantLitresPreview">' + qty + ' L</b></div>',
       'assistant-review'));
    }
    form.after(newPanel(makeActions(step), 'assistant-controls'));
  }
  function decorate() {
    synchronizeWizard();
    if (!TankCloud.connected() || !TankCloud.member()?.active) return;
    const screen = select('screen');
    if (!screen) return;
    screen.classList.remove('assistant-a','assistant-form-screen','assistant-selection');
    if (state.page === 'inicio') heroHome();
    if (state.page === 'carga' && state.role === 'almacen') decorateLoad();
    if (state.page === 'visita' && state.role === 'reparto') {
      if (state.openVisit) decorateDischarge();
      else decorateSelection();
    }
  }

  const previousRender = render;
  render = function () {
    remember();
    previousRender();
    decorate();
  };
  function proceed() {
    if (state.page === 'carga') {
      const step = wizard.loadStep;
      if (step === 0 && (!value('loadVehicle') || value('loadTank') === '')) return notify('Selecciona vehículo y tanque.');
      if (step === 1) {
        const n = Number(value('loadLiters'));
        if (!value('loadLiters') || !Number.isFinite(n) || n <= 0)
          return notify('Indica una lectura válida de litros cargados.');
      }
      saveFormValues('loadForm', wizard.loadDraft);
      wizard.loadStep = Math.min(2,step+1);
    } else if (state.page === 'visita' && state.openVisit) {
      const step = wizard.dischargeStep;
      if (step === 1 && !value('destTank')) return notify('Selecciona un tanque del cliente.');
      if (step === 2) return;
      saveFormValues('dischargeForm', wizard.dischargeDraft);
      wizard.dischargeStep = Math.min(2,step+1);
    }
    render();
  }
  function back() {
    if (state.page === 'carga') {
      saveFormValues('loadForm', wizard.loadDraft);
      wizard.loadStep = Math.max(0,wizard.loadStep-1);
    } else if (state.page === 'visita' && state.openVisit) {
      saveFormValues('dischargeForm', wizard.dischargeDraft);
      wizard.dischargeStep = Math.max(0,wizard.dischargeStep-1);
    }
    render();
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-guide]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const act = button.dataset.guide;
    if (act === 'start') { navigate(state.role === 'almacen' ? 'carga' : 'visita'); return; }
    if (act === 'home') { navigate('inicio'); return; }
    if (act === 'more-load') { wizard.loadStep = 0; wizard.loadDraft = {}; render(); return; }
    if (act === 'next') { proceed(); return; }
    if (act === 'back') { back(); return; }
    if (act === 'planned' || act === 'extra') { wizard.visitMode = act === 'planned' ? 'plan' : 'extra'; render(); return; }
    if (act === 'choose-type') { wizard.visitMode = ''; render(); }
  }, true);
  document.addEventListener('input', event => {
    if (event.target.id !== 'reading') return;
    const old = Number(state.openVisit?.reading || 0);
    const n = Number(event.target.value);
    const summary = select('assistantReadingPreview');
    const litres = select('assistantLitresPreview');
    if (summary) summary.textContent = Number.isFinite(n) && event.target.value ? litresText(n) + ' L' : '—';
    if (litres) litres.textContent = Number.isFinite(n) && event.target.value && n > old ? litresText(n-old)+' L' : '—';
  });
  // En caso de carga anticipada del script, recuperar el estado visual en el siguiente render.
  if (typeof state !== 'undefined' && state) decorate();
})();
