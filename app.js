// app.js — Main application coordinator
'use strict';

const App = (() => {
  /* ── State ──────────────────────────────────────────── */
  const S = { WELCOME: 0, PERMISSION: 1, IDLE: 2, TRACKING: 3, PAUSED: 4, STOPPED: 5 };
  let state = S.WELCOME;

  let sessionStart  = 0;
  let sessionEnd    = 0;
  let pausedMs      = 0;
  let pauseStart    = 0;
  let timerInterval = null;

  let speedoCv  = null, speedoCtx = null;
  let rafId     = null;
  let renderSpd = 0;   // smoothed display speed

  let _pendingSession = null;

  /* ── Bootstrap ──────────────────────────────────────── */
  function init() {
    // PWA service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./service-worker.js')
        .catch(e => console.warn('SW registration failed:', e));
    }

    // Storage (IndexedDB) — non-blocking
    Storage.init().catch(e => console.warn('Storage:', e));

    // Init sub-modules (no tracking yet)
    Sensor.init();
    GPS.init(_onGPSUpdate);

    // Populate capability cards + settings
    _showCapabilities();
    _setText('settings-protocol', location.protocol + '//' + location.host || 'file://');
    _setText('settings-ua', navigator.userAgent.substring(0, 100));

    // Wire up every button
    _bind('btn-init',             _onInitClick);
    _bind('btn-retry',            _onInitClick);
    _bind('btn-continue',         _onContinue);
    _bind('btn-start',            startTracking);
    _bind('btn-pause',            pauseTracking);
    _bind('btn-stop',             stopTracking);
    _bind('btn-resume',           resumeTracking);
    _bind('btn-stop2',            stopTracking);
    _bind('btn-new-session',      newSession);
    _bind('btn-save-session',     _saveSession);
    _bind('btn-discard-session',  _discardSession);
    _bind('btn-export-json',      () => Storage.getSessions().then(s => Storage.exportJSON(s)));
    _bind('btn-export-csv',       () => Storage.getSessions().then(s => Storage.exportCSV(s)));
    _bind('btn-clear-history',    _clearHistory);

    // Tab navigation
    document.querySelectorAll('.nav-item').forEach(btn =>
      btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

    window.addEventListener('resize', () => { if (speedoCv) _initGauge(); });

    _showScreen('welcome');
  }

  /* ── Capability detection ───────────────────────────── */
  function _showCapabilities() {
    const caps = [
      { name: 'GPS / Geolocation',     ok: 'geolocation' in navigator },
      { name: 'Accelerometer',         ok: typeof DeviceMotionEvent !== 'undefined' },
      { name: 'Gyroscope / Orient',    ok: typeof DeviceOrientationEvent !== 'undefined' },
      { name: 'IndexedDB',             ok: typeof indexedDB !== 'undefined' },
      { name: 'Service Worker (PWA)',   ok: 'serviceWorker' in navigator },
      { name: 'Offline Cache API',     ok: 'caches' in window },
    ];
    const list = document.getElementById('caps-list');
    if (list) {
      list.innerHTML = caps.map(c =>
        `<div class="cap-item ${c.ok ? 'cap-ok' : 'cap-na'}">
           <span class="cap-dot">${c.ok ? '✓' : '✗'}</span>${c.name}
         </div>`
      ).join('');
    }
    const found = caps.filter(c => c.ok).map(c => c.name).join(', ');
    _setText('settings-sensors', found || 'None detected');
  }

  /* ── Permission flow ────────────────────────────────── */
  async function _onInitClick() {
    _showScreen('permission');
    _setPermBadge('gps',    'pending', 'Requesting…');
    _setPermBadge('motion', 'pending', 'Requesting…');
    _hide('perm-error');
    _hide('btn-retry');
    _hide('btn-continue');

    const gpsOk    = await _requestGPS();
    const motionSt = await Sensor.requestPermissions();

    const motionOk =
      motionSt.motion === 'granted' ||
      motionSt.motion === 'unavailable';   // no motion sensor is still usable

    if (motionSt.motion === 'granted') {
      _setPermBadge('motion', 'granted', 'Granted');
    } else if (motionSt.motion === 'unavailable') {
      _setPermBadge('motion', 'na', 'Not Available');
    } else {
      _setPermBadge('motion', 'denied', motionSt.motion === 'denied' ? 'Denied' : 'Error');
    }

    if (!gpsOk) {
      const err = document.getElementById('perm-error');
      if (err) {
        err.innerHTML = `
          <b>⚠️ Location access required</b><br><br>
          To fix this in Chrome on Android:<br>
          1. Tap the <b>ⓘ</b> icon in the address bar<br>
          2. Tap <b>Permissions → Location → Allow</b><br>
          3. Reload the page, then tap Initialize again<br><br>
          <b>Important:</b> Open this file directly in Chrome,<br>
          not inside WhatsApp, Gmail or another app's browser.`;
        err.style.display = '';
      }
      _show('btn-retry');
    } else {
      _show('btn-continue');
    }
  }

  function _requestGPS() {
    return new Promise(resolve => {
      if (!navigator.geolocation) {
        _setPermBadge('gps', 'na', 'Not Supported');
        return resolve(false);
      }
      navigator.geolocation.getCurrentPosition(
        ()    => { _setPermBadge('gps', 'granted', 'Granted'); resolve(true); },
        err   => {
          const t = err.code === 1 ? 'Denied' : err.code === 2 ? 'Unavailable' : 'Timeout';
          _setPermBadge('gps', 'denied', t);
          resolve(false);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  function _onContinue() {
    _showScreen('app');
    state = S.IDLE;
    _initGauge();
    _setCtrl('idle');
    _setBadge('idle');
    _renderHistory();
  }

  /* ── Screen & tab helpers ───────────────────────────── */
  function _showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + name).classList.add('active');
  }

  function switchTab(name) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    const tc  = document.getElementById('tab-' + name);
    const btn = document.querySelector(`[data-tab="${name}"]`);
    if (tc)  tc.classList.add('active');
    if (btn) btn.classList.add('active');
    if (name === 'history') _renderHistory();
  }

  /* ── Speedometer canvas ─────────────────────────────── */
  function _initGauge() {
    speedoCv  = document.getElementById('speedometer');
    speedoCtx = speedoCv.getContext('2d');
    const dpr = devicePixelRatio || 1;
    const sz  = Math.min(speedoCv.parentElement.clientWidth, 320);
    speedoCv.width        = sz * dpr;
    speedoCv.height       = Math.round(sz * 0.68) * dpr;
    speedoCv.style.width  = sz + 'px';
    speedoCv.style.height = Math.round(sz * 0.68) + 'px';
    if (!rafId) _gaugeLoop();
  }

  function _gaugeLoop() {
    const target  = state === S.TRACKING ? GPS.getSpeed() : 0;
    renderSpd    += (target - renderSpd) * 0.12;
    _drawGauge(renderSpd);
    rafId = requestAnimationFrame(_gaugeLoop);
  }

  function _drawGauge(spd) {
    if (!speedoCtx || !speedoCv) return;
    const W   = speedoCv.width, H = speedoCv.height;
    const dpr = devicePixelRatio || 1;
    speedoCtx.clearRect(0, 0, W, H);

    const cx  = W / 2;
    const cy  = H * 0.7;
    const R   = Math.min(W * 0.44, H * 0.82);
    const MAX = 180;

    // Arc: 215° → 325° clockwise (270° sweep opening at bottom)
    const a0    = 215 * Math.PI / 180;
    const sweep = 250 * Math.PI / 180;
    const spdA  = s => a0 + (Math.max(0, Math.min(MAX, s)) / MAX) * sweep;

    // Background track
    speedoCtx.beginPath();
    speedoCtx.arc(cx, cy, R, a0, a0 + sweep);
    speedoCtx.strokeStyle = '#0d1e32';
    speedoCtx.lineWidth   = 14 * dpr;
    speedoCtx.lineCap     = 'round';
    speedoCtx.stroke();

    // Speed arc
    if (spd > 0.5) {
      const col = spd < 30 ? '#10b981' : spd < 80 ? '#0ea5e9' : spd < 130 ? '#f59e0b' : '#ef4444';
      speedoCtx.beginPath();
      speedoCtx.arc(cx, cy, R, a0, spdA(spd));
      speedoCtx.strokeStyle = col;
      speedoCtx.lineWidth   = 14 * dpr;
      speedoCtx.lineCap     = 'round';
      speedoCtx.shadowColor = col;
      speedoCtx.shadowBlur  = 14 * dpr;
      speedoCtx.stroke();
      speedoCtx.shadowBlur  = 0;
    }

    // Tick marks & labels
    for (let v = 0; v <= MAX; v += 10) {
      const angle  = spdA(v);
      const major  = v % 30 === 0;
      const len    = major ? 13 : 7;
      const r1     = R + 2, r2 = R - len;
      speedoCtx.beginPath();
      speedoCtx.moveTo(cx + r1 * Math.cos(angle) * dpr / dpr, cy + r1 * Math.sin(angle) * dpr / dpr);
      speedoCtx.moveTo(cx + r1 * Math.cos(angle), cy + r1 * Math.sin(angle));
      speedoCtx.lineTo(cx + r2 * Math.cos(angle), cy + r2 * Math.sin(angle));
      speedoCtx.strokeStyle = major ? '#1e4060' : '#0f2035';
      speedoCtx.lineWidth   = (major ? 2 : 1) * dpr;
      speedoCtx.stroke();

      if (major) {
        const lr = R - 24 * dpr;
        speedoCtx.fillStyle    = '#1e4060';
        speedoCtx.font         = `${Math.round(8 * dpr)}px monospace`;
        speedoCtx.textAlign    = 'center';
        speedoCtx.textBaseline = 'middle';
        speedoCtx.fillText(v, cx + lr * Math.cos(angle), cy + lr * Math.sin(angle));
      }
    }

    // Needle
    const angle = spdA(spd);
    speedoCtx.save();
    speedoCtx.translate(cx, cy);
    speedoCtx.rotate(angle);
    speedoCtx.shadowColor = '#0ea5e9';
    speedoCtx.shadowBlur  = 8 * dpr;
    speedoCtx.beginPath();
    speedoCtx.moveTo(-14 * dpr, 0);
    speedoCtx.lineTo((R - 18) * dpr / dpr, 0);
    speedoCtx.lineTo(R - 18, 0);
    speedoCtx.moveTo(-14, 0);
    speedoCtx.lineTo(R - 18, 0);
    speedoCtx.strokeStyle = '#0ea5e9';
    speedoCtx.lineWidth   = 2.5 * dpr;
    speedoCtx.lineCap     = 'round';
    speedoCtx.stroke();
    speedoCtx.restore();

    // Centre cap
    speedoCtx.beginPath();
    speedoCtx.arc(cx, cy, 7 * dpr, 0, Math.PI * 2);
    speedoCtx.fillStyle  = '#0ea5e9';
    speedoCtx.shadowColor = '#0ea5e9';
    speedoCtx.shadowBlur  = 10 * dpr;
    speedoCtx.fill();
    speedoCtx.shadowBlur  = 0;
  }

  /* ── GPS update callback ────────────────────────────── */
  function _onGPSUpdate({ speed, lat, lon }) {
    _setText('speed-display', Math.round(speed));

    const st   = GPS.getStats();
    const avg  = st.speedHistory.length
      ? st.speedHistory.reduce((a, b) => a + b) / st.speedHistory.length : 0;
    const df   = Analytics.formatDistance(st.distanceM);

    _setText('stat-maxspd', Math.round(st.maxSpeed));
    _setText('stat-avgspd', Math.round(avg));
    _setText('stat-dist', df.val);
    _setText('stat-dist-unit', df.unit);

    // Activity
    const ac = Analytics.classifyActivity(speed, Sensor.getCurrent().mag);
    _setText('act-icon',    ac.icon);
    _setText('act-name',    ac.name + (ac.confidence ? ' · ' + ac.confidence : ''));
    _setText('act-signals', ac.signals.join(' · '));

    // Journey tab quick numbers
    _setText('j-distance', df.val + ' ' + df.unit);
    _setText('j-maxspd',   Math.round(st.maxSpeed) + ' km/h');
    _setText('j-avgspd',   Math.round(avg) + ' km/h');
    if (st.speedHistory.length > 2) {
      const sd = Math.sqrt(
        st.speedHistory.reduce((a, b) => a + (b - avg) ** 2, 0) / st.speedHistory.length
      );
      _setText('j-speedvar', '±' + sd.toFixed(1) + ' km/h');
    }
  }

  /* ── Session timer ──────────────────────────────────── */
  function _startTimer() {
    timerInterval = setInterval(() => {
      const elapsed = Date.now() - sessionStart - pausedMs;
      _setText('stat-duration', Analytics.formatDuration(elapsed));
      _setText('j-duration',    Analytics.formatDuration(elapsed));
      const st = GPS.getStats();
      _setText('j-moving',      Analytics.formatDuration(st.movingMs));
      _setText('j-stationary',  Analytics.formatDuration(st.stationaryMs));
    }, 1000);
  }

  function _stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  /* ── Session control ────────────────────────────────── */
  function startTracking() {
    if (state !== S.IDLE) return;
    state        = S.TRACKING;
    sessionStart = Date.now();
    pausedMs     = 0;
    GPS.reset(); Sensor.reset();
    GPS.start(); Sensor.start();
    _startTimer();
    _setCtrl('tracking');
    _setBadge('tracking');
  }

  function pauseTracking() {
    if (state !== S.TRACKING) return;
    state      = S.PAUSED;
    pauseStart = Date.now();
    GPS.pause(); Sensor.pause();
    _stopTimer();
    _setCtrl('paused');
    _setBadge('paused');
  }

  function resumeTracking() {
    if (state !== S.PAUSED) return;
    state     = S.TRACKING;
    pausedMs += Date.now() - pauseStart;
    pauseStart = 0;
    GPS.resume(); Sensor.resume();
    _startTimer();
    _setCtrl('tracking');
    _setBadge('tracking');
  }

  function stopTracking() {
    if (state !== S.TRACKING && state !== S.PAUSED) return;
    if (state === S.PAUSED) pausedMs += Date.now() - pauseStart;
    state      = S.STOPPED;
    sessionEnd = Date.now();
    GPS.stop(); Sensor.stop();
    _stopTimer();
    _setCtrl('stopped');
    _setBadge('stopped');
    _showSummary();
  }

  function newSession() {
    state       = S.IDLE;
    renderSpd   = 0;
    _setText('speed-display',       '0');
    _setText('stat-maxspeed',       '0');
    _setText('stat-avgspeed',       '0');
    _setText('stat-distance',       '0');
    _setText('stat-distance-unit',  'm');
    _setText('stat-dur',             '0:00');
    _setText('j-distance',          '0 m');
    _setText('j-gpspts',            '0');
    _setText('activity-icon',       '🧍');
    _setText('activity-name',       'Stationary');
    _setText('activity-signals',    'Not tracking');
    _setText('gps-quality',         'GPS: Waiting…');
    GPS.reset(); Sensor.reset();
    _setCtrl('idle');
    _setBadge('idle');
    _hide('session-summary');
  }

  /* ── Session summary ────────────────────────────────── */
  function _showSummary() {
    const gst      = GPS.getStats();
    const duration = sessionEnd - sessionStart - pausedMs;
    const stats    = Analytics.calcSessionStats({
      speedHistory:  gst.speedHistory,
      distanceM:     gst.distanceM,
      peakAccel:     Sensor.getPeak(),
      motionEvents:  Sensor.getEventCount(),
      startTime:     sessionStart,
      endTime:       sessionEnd,
      movingMs:      gst.movingMs,
      stationaryMs:  gst.stationaryMs,
    });
    const act = Analytics.classifyActivity(stats.maxSpeed, Sensor.getPeak());
    const df  = Analytics.formatDistance(stats.distance);

    document.getElementById('summary-content').innerHTML = `
      <div class="summary-grid">
        <div class="sum-item"><div class="sum-val">${Analytics.formatDuration(duration)}</div><div class="sum-key">Duration</div></div>
        <div class="sum-item"><div class="sum-val">${df.val} ${df.unit}</div><div class="sum-key">Distance</div></div>
        <div class="sum-item"><div class="sum-val">${stats.maxSpeed} km/h</div><div class="sum-key">Max Speed</div></div>
        <div class="sum-item"><div class="sum-val">${stats.avgSpeed} km/h</div><div class="sum-key">Avg Speed</div></div>
        <div class="sum-item"><div class="sum-val">${act.icon} ${act.name}</div><div class="sum-key">Activity</div></div>
        <div class="sum-item"><div class="sum-val">${stats.peakAcceleration} m/s²</div><div class="sum-key">Peak Accel</div></div>
        <div class="sum-item"><div class="sum-val">${Analytics.formatDuration(gst.movingMs)}</div><div class="sum-key">Moving</div></div>
        <div class="sum-item"><div class="sum-val">${stats.motionEvents}</div><div class="sum-key">Motion Events</div></div>
      </div>`;

    _pendingSession = {
      startTime:        stats.startTime,
      endTime:          stats.endTime,
      duration,
      distance:         stats.distance,
      maxSpeed:         stats.maxSpeed,
      avgSpeed:         stats.avgSpeed,
      activity:         act.name,
      motionEvents:     stats.motionEvents,
      peakAcceleration: stats.peakAcceleration,
      movingTime:       gst.movingMs,
      stationaryTime:   gst.stationaryMs,
      gpsPoints:        gst.positions.length,
    };
    _show('session-summary');
  }

  function _saveSession() {
    if (!_pendingSession) return;
    Storage.saveSession(_pendingSession)
      .then(() => { _pendingSession = null; _hide('session-summary'); newSession(); _renderHistory(); })
      .catch(e  => { alert('Could not save: ' + e); });
  }

  function _discardSession() {
    _pendingSession = null;
    _hide('session-summary');
    newSession();
  }

  /* ── History tab ────────────────────────────────────── */
  async function _renderHistory() {
    const sessions = await Storage.getSessions();
    const list     = document.getElementById('history-list');
    const empty    = document.getElementById('history-empty');
    if (!list) return;

    if (sessions.length === 0) {
      list.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';

    list.innerHTML = sessions.map(s => {
      const df   = Analytics.formatDistance(s.distance || 0);
      const date = new Date(s.startTime).toLocaleDateString();
      const time = new Date(s.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `
        <div class="history-item">
          <div class="hi-top">
            <span class="hi-date">${date} · ${time}</span>
            <button class="btn-x" onclick="App.deleteSession(${s.id})">✕</button>
          </div>
          <div class="hi-stats">
            <span>${df.val} ${df.unit}</span>
            <span>${s.maxSpeed || 0} km/h max</span>
            <span>${Analytics.formatDuration(s.duration || 0)}</span>
          </div>
          <div class="hi-act">${s.activity || '—'}</div>
        </div>`;
    }).join('');
  }

  function deleteSession(id) {
    Storage.deleteSession(id).then(() => _renderHistory());
  }

  async function _clearHistory() {
    if (!confirm('Delete ALL saved sessions? This cannot be undone.')) return;
    await Storage.clearAll();
    _renderHistory();
  }

  /* ── UI helpers ─────────────────────────────────────── */
  function _setCtrl(which) {
    ['idle', 'tracking', 'paused', 'stopped'].forEach(s => {
      const el = document.getElementById('ctrl-' + s);
      if (el) el.style.display = s === which ? '' : 'none';
    });
  }

  function _setBadge(which) {
    const badge = document.getElementById('session-badge');
    if (!badge) return;
    const map = {
      idle:     ['● IDLE',     'badge-idle'],
      tracking: ['● TRACKING', 'badge-tracking'],
      paused:   ['⏸ PAUSED',   'badge-paused'],
      stopped:  ['■ STOPPED',  'badge-stopped'],
    };
    const [text, cls] = map[which] || map.idle;
    badge.textContent = text;
    badge.className   = 'session-badge ' + cls;
  }

  function _setPermBadge(which, state, text) {
    const el = document.getElementById('badge-' + which);
    if (!el) return;
    el.className   = 'perm-badge perm-' + state;
    el.textContent = text.toUpperCase();
  }

  function _bind(id, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  }

  function _show(id)  { const el = document.getElementById(id); if (el) el.style.display = ''; }
  function _hide(id)  { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
  function _setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

  // Public aliases for inline onclick handlers in HTML
  const onInitClick     = _onInitClick;
  const onPermsContinue = _onContinue;
  function backToWelcome() { _showScreen('welcome'); }
  function saveSession()   { _saveSession(); }
  function discardSession(){ _discardSession(); }
  function exportJSON()    { Storage.getSessions().then(s => Storage.exportJSON(s)); }
  function exportCSV()     { Storage.getSessions().then(s => Storage.exportCSV(s)); }
  function clearHistory()  { if (confirm('Delete all sessions?')) Storage.clearAll().then(_renderHistory); }

  return { init, switchTab, startTracking, pauseTracking, resumeTracking, stopTracking,
           newSession, deleteSession, onInitClick, onPermsContinue,
           backToWelcome, saveSession, discardSession, exportJSON, exportCSV, clearHistory };
})();

window.App = App;
document.addEventListener('DOMContentLoaded', () => App.init());
