// IoTDeck dashboard: devices, widgets, live updates, and control.
(() => {
  // ---------- DOM helpers (no innerHTML with user data) ----------

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    appendChildren(el, children);
    return el;
  }

  function s(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) el.setAttribute(key, String(value));
    appendChildren(el, children);
    return el;
  }

  function appendChildren(el, children) {
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  const $ = (id) => document.getElementById(id);

  // ---------- State ----------

  const state = {
    user: null,
    devices: new Map(), // id -> { id, name, latest, lastSeen, online }
    widgets: [],
    cards: new Map(), // widget id -> element
    history: new Map(), // `${deviceId}` -> [{ ts, data }]
    sockets: new Map(), // deviceId -> WebSocket
    filter: null, // deviceId or null
  };

  // ---------- API ----------

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
    if (res.status === 401) {
      location.replace('/');
      throw new Error('Signed out');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Request failed');
    return body;
  }

  // ---------- Formatting ----------

  function timeAgo(ts) {
    if (!ts) return 'never';
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 5) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 48) return `${hr}h ago`;
    return `${Math.round(hr / 24)}d ago`;
  }

  function formatValue(v) {
    if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (typeof v === 'boolean') return v ? 'On' : 'Off';
    if (v === undefined || v === null) return '—';
    return String(v);
  }

  function isOnline(device) {
    return Boolean(device.lastSeen) && Date.now() - device.lastSeen < 2 * 60 * 1000;
  }

  // ---------- Toast ----------

  let toastTimer;
  function toast(message, kind = 'ok') {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', kind === 'error');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  // ---------- Modals ----------

  function openModal(id) {
    const modal = $(id);
    modal.classList.add('open');
    const firstInput = modal.querySelector('input, select');
    if (firstInput) setTimeout(() => firstInput.focus(), 30);
  }

  function closeModal(modal) {
    modal.classList.remove('open');
  }

  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal(backdrop);
    });
  });
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.closest('.modal-backdrop')));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-backdrop.open').forEach(closeModal);
  });

  // ---------- Rendering: sidebar, stats, filters ----------

  function renderSidebar() {
    const list = $('device-list');
    list.replaceChildren();
    const devices = [...state.devices.values()];
    if (devices.length === 0) {
      list.append(h('p', { class: 'hint', style: 'padding:8px 12px;' }, 'No devices yet. Add one to get started.'));
      return;
    }
    for (const device of devices) {
      const online = isOnline(device);
      const selected = state.filter === device.id;
      const item = h(
        'div',
        {
          class: 'device-item',
          role: 'button',
          tabindex: '0',
          'aria-pressed': String(selected),
          style: selected ? 'background:var(--surface-hover);border-color:var(--border-strong);' : null,
          onclick: () => {
            state.filter = state.filter === device.id ? null : device.id;
            renderAll();
          },
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              state.filter = state.filter === device.id ? null : device.id;
              renderAll();
            }
          },
        },
        h('span', { class: `status-dot ${online ? 'online pulse' : ''}`, 'aria-hidden': 'true' }),
        h(
          'span',
          { class: 'meta' },
          h('span', { class: 'name', text: device.name }),
          h('span', { class: 'sub', text: `${online ? 'Online' : 'Offline'} · ${timeAgo(device.lastSeen)}` }),
        ),
        h('span', {
          class: 'widget-remove',
          role: 'button',
          title: 'Delete device',
          'aria-label': `Delete ${device.name}`,
          style: 'opacity:0.0;',
          onclick: (e) => {
            e.stopPropagation();
            removeDevice(device);
          },
          text: '×',
        }),
      );
      item.addEventListener('mouseenter', () => (item.querySelector('.widget-remove').style.opacity = '1'));
      item.addEventListener('mouseleave', () => (item.querySelector('.widget-remove').style.opacity = '0'));
      list.append(item);
    }
  }

  function renderStats() {
    const devices = [...state.devices.values()];
    $('stat-devices').textContent = String(devices.length);
    $('stat-online').textContent = String(devices.filter(isOnline).length);
    $('stat-widgets').textContent = String(state.widgets.length);
    const online = devices.filter(isOnline).length;
    $('subtitle').textContent =
      devices.length === 0
        ? 'Connect a device to see live data here.'
        : `${online} of ${devices.length} device${devices.length === 1 ? '' : 's'} online`;
  }

  function renderFilters() {
    const row = $('filter-row');
    row.replaceChildren();
    if (!state.filter) return;
    const device = state.devices.get(state.filter);
    row.append(
      h(
        'span',
        { class: 'hint', style: 'align-self:center;' },
        `Showing ${device ? device.name : 'device'}`,
      ),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { state.filter = null; renderAll(); } }, 'Show all'),
    );
  }

  // ---------- Widgets ----------

  function renderGrid() {
    const grid = $('grid');
    grid.replaceChildren();
    state.cards.clear();

    const visible = state.widgets.filter((w) => !state.filter || w.deviceId === state.filter);

    if (state.widgets.length === 0) {
      grid.append(
        h(
          'div',
          { class: 'empty' },
          h('h3', { text: 'Build your first dashboard' }),
          h('p', {
            text: 'Widgets show live values from your devices and let you control them. Add one to see data arrive in real time.',
          }),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: openWidgetModal }, 'Add a widget'),
        ),
      );
      return;
    }

    if (visible.length === 0) {
      grid.append(h('div', { class: 'empty' }, h('p', { text: 'This device has no widgets yet.' })));
      return;
    }

    for (const widget of visible) {
      const card = buildWidgetCard(widget);
      state.cards.set(widget.id, card);
      grid.append(card);
      updateWidgetCard(card, widget);
    }
  }

  function buildWidgetCard(widget) {
    const body = widgetBody(widget.type);
    const remove = h(
      'button',
      { class: 'widget-remove', type: 'button', 'aria-label': 'Remove widget', title: 'Remove', onclick: () => removeWidget(widget) },
      '×',
    );
    return h(
      'article',
      { class: 'card widget', 'data-id': widget.id, 'data-type': widget.type },
      h(
        'div',
        { class: 'widget-head' },
        h(
          'div',
          null,
          h('div', { class: 'widget-title', 'data-role': 'title', text: widget.title }),
          h('div', { class: 'widget-device', 'data-role': 'device' }),
        ),
        remove,
      ),
      body,
      h('div', { class: 'updated', 'data-role': 'updated' }),
    );
  }

  function widgetBody(type) {
    if (type === 'value') {
      return h(
        'div',
        { class: 'big-value' },
        h('span', { 'data-role': 'value' }),
        h('span', { class: 'unit', 'data-role': 'unit' }),
      );
    }

    if (type === 'gauge') {
      const arc = 2 * Math.PI * 80 * 0.75;
      return h(
        'div',
        null,
        s(
          'svg',
          { class: 'gauge', viewBox: '0 0 200 200', role: 'img', 'aria-label': 'Gauge' },
          s('circle', {
            class: 'track',
            cx: 100, cy: 100, r: 80, fill: 'none', 'stroke-width': 14, 'stroke-linecap': 'round',
            'stroke-dasharray': `${arc} ${2 * Math.PI * 80}`, transform: 'rotate(135 100 100)',
          }),
          s('circle', {
            class: 'fill', 'data-role': 'fill',
            cx: 100, cy: 100, r: 80, fill: 'none', stroke: 'url(#gaugeGrad)', 'stroke-width': 14, 'stroke-linecap': 'round',
            'stroke-dasharray': `${arc} ${2 * Math.PI * 80}`, 'stroke-dashoffset': arc, transform: 'rotate(135 100 100)',
          }),
          s('text', { class: 'gauge-value', x: 100, y: 108, 'data-role': 'gv' }),
          s('text', { class: 'gauge-unit', x: 100, y: 130, 'data-role': 'gu' }),
        ),
      );
    }

    if (type === 'line') {
      return h(
        'div',
        null,
        s(
          'svg',
          { class: 'spark', viewBox: '0 0 300 86', preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Trend' },
          s('path', { class: 'area', 'data-role': 'area', d: '' }),
          s('path', { class: 'line', 'data-role': 'line', d: '' }),
        ),
        h('div', { class: 'big-value', style: 'font-size:28px;margin-top:10px;' }, h('span', { 'data-role': 'value' }), h('span', { class: 'unit', 'data-role': 'unit' })),
      );
    }

    if (type === 'toggle') {
      return h(
        'div',
        { class: 'control' },
        h('span', { class: 'state-label', 'data-role': 'state' }),
        h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'false', 'data-role': 'switch' }),
      );
    }

    // button
    return h('button', { class: 'pulse-btn', type: 'button', 'data-role': 'pulse' }, 'Trigger');
  }

  function updateWidgetCard(card, widget) {
    const device = state.devices.get(widget.deviceId);
    const raw = device && device.latest ? device.latest[widget.field] : undefined;
    const deviceEl = card.querySelector('[data-role="device"]');
    deviceEl.textContent = device ? `${device.name} · ${widget.field}` : 'Device removed';
    card.querySelector('[data-role="updated"]').dataset.ts = device && device.lastSeen ? String(device.lastSeen) : '';

    const unit = widget.config && widget.config.unit ? widget.config.unit : '';

    if (widget.type === 'value') {
      card.querySelector('[data-role="value"]').textContent = formatValue(raw);
      card.querySelector('[data-role="unit"]').textContent = typeof raw === 'number' ? unit : '';
    }

    if (widget.type === 'gauge') {
      const min = Number(widget.config.min ?? 0);
      const max = Number(widget.config.max ?? 100);
      const num = typeof raw === 'number' ? raw : min;
      const pct = Math.min(1, Math.max(0, (num - min) / (max - min || 1)));
      const arc = 2 * Math.PI * 80 * 0.75;
      card.querySelector('[data-role="fill"]').setAttribute('stroke-dashoffset', String(arc * (1 - pct)));
      card.querySelector('[data-role="gv"]').textContent = formatValue(raw);
      card.querySelector('[data-role="gu"]').textContent = unit;
    }

    if (widget.type === 'line') {
      const points = (state.history.get(widget.deviceId) || [])
        .map((r) => r.data[widget.field])
        .filter((v) => typeof v === 'number');
      card.querySelector('[data-role="value"]').textContent = formatValue(raw);
      card.querySelector('[data-role="unit"]').textContent = typeof raw === 'number' ? unit : '';
      const { line, area } = sparkPaths(points);
      card.querySelector('[data-role="line"]').setAttribute('d', line);
      card.querySelector('[data-role="area"]').setAttribute('d', area);
    }

    if (widget.type === 'toggle') {
      const on = Boolean(raw);
      const sw = card.querySelector('[data-role="switch"]');
      sw.setAttribute('aria-checked', String(on));
      card.querySelector('[data-role="state"]').textContent = raw === undefined ? 'Waiting for data' : on ? 'On' : 'Off';
      if (!sw.dataset.bound) {
        sw.dataset.bound = '1';
        sw.addEventListener('click', () => toggleControl(widget, card));
      }
    }

    if (widget.type === 'button') {
      const btn = card.querySelector('[data-role="pulse"]');
      if (!btn.dataset.bound) {
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => pulseControl(widget, btn));
      }
    }

    const stamp = card.querySelector('[data-role="updated"]');
    stamp.textContent = device && device.lastSeen ? `Updated ${timeAgo(device.lastSeen)}` : 'Waiting for first reading';
  }

  function sparkPaths(values) {
    if (values.length < 2) return { line: '', area: '' };
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const W = 300, H = 86, pad = 8;
    const pts = values.map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = pad + (1 - (v - min) / span) * (H - pad * 2);
      return [x.toFixed(1), y.toFixed(1)];
    });
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ');
    const area = `${line} L${W} ${H} L0 ${H} Z`;
    return { line, area };
  }

  // ---------- Controls ----------

  async function sendCommand(deviceId, field, value) {
    return api(`/api/devices/${deviceId}/command`, {
      method: 'POST',
      body: JSON.stringify({ field, value }),
    });
  }

  async function toggleControl(widget, card) {
    const device = state.devices.get(widget.deviceId);
    const current = card.querySelector('[data-role="switch"]').getAttribute('aria-checked') === 'true';
    const sw = card.querySelector('[data-role="switch"]');
    sw.disabled = true;
    sw.setAttribute('aria-checked', String(!current));
    try {
      const res = await sendCommand(widget.deviceId, widget.field, !current);
      toast(res.delivered ? 'Sent to device' : 'Queued. Device will receive it when online');
    } catch (err) {
      sw.setAttribute('aria-checked', String(current));
      toast(err.message, 'error');
    } finally {
      sw.disabled = false;
    }
  }

  async function pulseControl(widget, btn) {
    btn.disabled = true;
    try {
      const res = await sendCommand(widget.deviceId, widget.field, true);
      toast(res.delivered ? 'Sent to device' : 'Queued. Device will receive it when online');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setTimeout(() => (btn.disabled = false), 800);
    }
  }

  // ---------- Live connections ----------

  function connectDevice(deviceId) {
    if (state.sockets.has(deviceId)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/view/${deviceId}`);
    state.sockets.set(deviceId, ws);

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type !== 'reading' || !msg.data) return;
      const device = state.devices.get(deviceId);
      if (!device) return;
      device.latest = msg.data;
      device.lastSeen = msg.ts;
      const hist = state.history.get(deviceId) || [];
      hist.push({ ts: msg.ts, data: msg.data });
      if (hist.length > 60) hist.splice(0, hist.length - 60);
      state.history.set(deviceId, hist);
      refreshDevice(deviceId);
    });

    ws.addEventListener('close', () => {
      state.sockets.delete(deviceId);
      // Reconnect while the device is still on the dashboard
      if (state.devices.has(deviceId)) setTimeout(() => connectDevice(deviceId), 3000);
    });
  }

  function refreshDevice(deviceId) {
    for (const widget of state.widgets) {
      if (widget.deviceId !== deviceId) continue;
      const card = state.cards.get(widget.id);
      if (card) updateWidgetCard(card, widget);
    }
    renderSidebar();
    renderStats();
  }

  // ---------- Data loading ----------

  async function loadHistory(deviceId) {
    const { readings } = await api(`/api/devices/${deviceId}/readings?limit=60`);
    state.history.set(deviceId, readings);
  }

  async function refreshAll() {
    const [{ devices }, { widgets }] = await Promise.all([api('/api/devices'), api('/api/widgets')]);
    state.devices = new Map(devices.map((d) => [d.id, d]));
    state.widgets = widgets;

    const lineDevices = new Set(widgets.filter((w) => w.type === 'line').map((w) => w.deviceId));
    await Promise.all([...lineDevices].map((id) => loadHistory(id).catch(() => {})));

    for (const widget of widgets) connectDevice(widget.deviceId);
    renderAll();
  }

  function renderAll() {
    renderSidebar();
    renderStats();
    renderFilters();
    renderGrid();
    updateTimestamps();
  }

  function updateTimestamps() {
    document.querySelectorAll('[data-role="updated"][data-ts]').forEach((el) => {
      const ts = Number(el.dataset.ts);
      if (ts) el.textContent = `Updated ${timeAgo(ts)}`;
    });
  }

  // ---------- Add / remove ----------

  function openWidgetModal() {
    if (state.devices.size === 0) {
      toast('Add a device first', 'error');
      openModal('device-modal');
      return;
    }
    const select = $('widget-device');
    select.replaceChildren(
      ...[...state.devices.values()].map((d) => h('option', { value: d.id, text: d.name })),
    );
    if (state.filter) select.value = state.filter;
    populateFieldOptions();
    $('widget-error').textContent = '';
    openModal('widget-modal');
  }

  function populateFieldOptions() {
    const device = state.devices.get($('widget-device').value);
    const list = $('field-options');
    list.replaceChildren(
      ...Object.keys((device && device.latest) || {}).map((k) => h('option', { value: k })),
    );
  }

  function syncWidgetFormType() {
    const type = $('widget-type').value;
    $('gauge-range').hidden = type !== 'gauge';
    $('widget-unit').closest('.field').hidden = type === 'toggle' || type === 'button';
  }

  async function submitWidget(event) {
    event.preventDefault();
    const errorEl = $('widget-error');
    errorEl.textContent = '';
    const type = $('widget-type').value;
    const field = $('widget-field').value.trim();
    const payload = {
      deviceId: $('widget-device').value,
      type,
      field,
      title: $('widget-title-input').value.trim() || field,
      unit: $('widget-unit').value.trim(),
      min: Number($('widget-min').value),
      max: Number($('widget-max').value),
    };
    if (!/^[a-zA-Z0-9_]{1,32}$/.test(field)) {
      errorEl.textContent = 'Field names can use letters, numbers and underscores only.';
      return;
    }
    if (type === 'gauge' && !(payload.max > payload.min)) {
      errorEl.textContent = 'Maximum must be greater than minimum.';
      return;
    }
    try {
      const { widget } = await api('/api/widgets', { method: 'POST', body: JSON.stringify(payload) });
      state.widgets.push(widget);
      if (!state.history.has(widget.deviceId) && widget.type === 'line') await loadHistory(widget.deviceId).catch(() => {});
      connectDevice(widget.deviceId);
      closeModal($('widget-modal'));
      $('widget-form').reset();
      $('widget-min').value = '0';
      $('widget-max').value = '100';
      renderAll();
      toast('Widget added');
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }

  async function removeWidget(widget) {
    try {
      await api(`/api/widgets/${widget.id}`, { method: 'DELETE' });
      state.widgets = state.widgets.filter((w) => w.id !== widget.id);
      renderAll();
      toast('Widget removed');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function removeDevice(device) {
    if (!confirm(`Delete "${device.name}" and all its widgets and history? This can't be undone.`)) return;
    try {
      await api(`/api/devices/${device.id}`, { method: 'DELETE' });
      state.devices.delete(device.id);
      state.widgets = state.widgets.filter((w) => w.deviceId !== device.id);
      const ws = state.sockets.get(device.id);
      state.sockets.delete(device.id);
      if (ws) ws.close();
      if (state.filter === device.id) state.filter = null;
      renderAll();
      toast('Device deleted');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function submitDevice(event) {
    event.preventDefault();
    const name = $('device-name').value.trim();
    const errorEl = $('device-error');
    errorEl.textContent = '';
    if (name.length < 2) {
      errorEl.textContent = 'Use at least 2 characters.';
      return;
    }
    try {
      const { device, key } = await api('/api/devices', { method: 'POST', body: JSON.stringify({ name }) });
      state.devices.set(device.id, { id: device.id, name: device.name, latest: null, lastSeen: null, online: false });
      $('device-step-1').classList.add('hidden');
      $('device-step-2').classList.remove('hidden');
      $('device-key').textContent = key;
      $('device-snippet').textContent = buildSnippet(key);
      renderAll();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }

  function buildSnippet(key) {
    const endpoint = `${location.origin}/ingest`;
    return [
      "// Copy firmware/esp32/IoTDeck.h into your sketch folder.",
      "// Needs the ArduinoJson library (v7) from the Library Manager.",
      "#include \"IoTDeck.h\"",
      "",
      `IoTDeck deck("${key}", "${endpoint}");`,
      "",
      "void setup() {",
      "  deck.begin(\"your-wifi-name\", \"your-wifi-password\");",
      "  deck.setInterval(10000);",
      "}",
      "",
      "void loop() {",
      "  deck.set(\"temperature\", 24.5);  // replace with your sensor reading",
      "  deck.loop();",
      "}",
    ].join("\n");
  }

  function copyText(text, label) {
    navigator.clipboard
      .writeText(text)
      .then(() => toast(`${label} copied`))
      .catch(() => toast('Copy failed. Select the text and copy it manually.', 'error'));
  }

  function resetDeviceModal() {
    $('device-step-1').classList.remove('hidden');
    $('device-step-2').classList.add('hidden');
    $('device-form').reset();
    $('device-error').textContent = '';
    $('device-key').textContent = '';
  }

  // ---------- Boot ----------

  async function boot() {
    try {
      const { user } = await api('/api/me');
      state.user = user;
    } catch {
      return;
    }

    $('user-email').textContent = state.user.email;
    $('avatar').textContent = (state.user.name || state.user.email || '?').trim().charAt(0).toUpperCase();
    $('greeting').textContent = `Hello, ${(state.user.name || 'there').split(' ')[0]}`;

    $('add-device').addEventListener('click', () => { resetDeviceModal(); openModal('device-modal'); });
    $('add-device-2').addEventListener('click', () => { resetDeviceModal(); openModal('device-modal'); });
    $('add-widget').addEventListener('click', openWidgetModal);
    $('device-form').addEventListener('submit', submitDevice);
    $('copy-key').addEventListener('click', () => copyText($('device-key').textContent, 'Key'));
    $('widget-form').addEventListener('submit', submitWidget);
    $('widget-device').addEventListener('change', populateFieldOptions);
    $('widget-type').addEventListener('change', syncWidgetFormType);
    $('logout').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      location.replace('/');
    });

    syncWidgetFormType();
    await refreshAll();
    setInterval(async () => {
      try {
        const { devices } = await api('/api/devices');
        for (const d of devices) {
          const cur = state.devices.get(d.id);
          if (!cur) { state.devices.set(d.id, d); continue; }
          const changed = cur.lastSeen !== d.lastSeen;
          cur.name = d.name;
          cur.lastSeen = d.lastSeen;
          cur.latest = d.latest;
          cur.online = d.online;
          if (changed) refreshDevice(d.id);
        }
        renderSidebar();
        renderStats();
      } catch {}
    }, 5000);
    setInterval(() => { renderSidebar(); renderStats(); updateTimestamps(); }, 5000);
    setInterval(updateTimestamps, 1000);
  }

  boot();
})();
