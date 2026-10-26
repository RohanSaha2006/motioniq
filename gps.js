// gps.js — Geolocation tracking, Haversine, journey map
'use strict';

const GPS = (() => {
  const ACCURACY_MAX  = 50;    // metres — reject noisier fixes
  const SPEED_MAX_KMH = 300;   // sanity cap

  let watchId    = null;
  let active     = false;
  let updateCb   = null;         // callback(speed, lat, lon)

  // Journey data
  let positions  = [];           // { lat, lon, ts }
  let lastPos    = null;

  // Session stats
  let totalDist  = 0;            // metres
  let speedHist  = [];           // km/h readings
  let maxSpeed   = 0;
  let movingMs   = 0;
  let stationaryMs = 0;
  let lastTick   = null;

  let curSpeed   = 0;

  // Canvas
  let mapCv  = null;
  let mapCtx = null;

  /* ── Init ─────────────────────────────────────────────── */
  function init(cb) {
    updateCb = cb;
    mapCv    = document.getElementById('journey-map');
    mapCtx   = mapCv.getContext('2d');
    _resizeMap();
    window.addEventListener('resize', _resizeMap);
    _clearMap();
  }

  function _resizeMap() {
    if (!mapCv) return;
    const dpr = devicePixelRatio || 1;
    const w   = mapCv.parentElement.clientWidth || 300;
    const h   = Math.min(Math.round(w * 0.7), 280);
    mapCv.width        = w * dpr;
    mapCv.height       = h * dpr;
    mapCv.style.width  = w + 'px';
    mapCv.style.height = h + 'px';
    _redrawMap();
  }

  /* ── Start / stop ─────────────────────────────────────── */
  function start() {
    if (!navigator.geolocation) { console.warn('Geolocation not supported'); return false; }
    if (active) return true;
    active   = true;
    lastTick = Date.now();
    watchId  = navigator.geolocation.watchPosition(_onPosition, _onError,
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    return true;
  }

  function stop() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    active = false;
  }

  const pause  = stop;
  const resume = start;

  function reset() {
    positions    = [];
    lastPos      = null;
    totalDist    = 0;
    speedHist    = [];
    maxSpeed     = 0;
    movingMs     = 0;
    stationaryMs = 0;
    lastTick     = null;
    curSpeed     = 0;
    _clearMap();
    _setText('map-placeholder', 'Route will appear once you start moving.');
    document.getElementById('map-placeholder').style.display = '';
  }

  /* ── Position handler ─────────────────────────────────── */
  function _onPosition(pos) {
    const { latitude: lat, longitude: lon, speed, heading, altitude, accuracy } = pos.coords;
    const now = Date.now();

    _setText('gps-quality', `GPS: ${accuracy <= 10 ? 'Excellent' : accuracy <= 25 ? 'Good' : accuracy <= 50 ? 'Fair' : 'Poor'} (±${Math.round(accuracy)} m)`);

    // Filter low-accuracy fixes during tracking
    if (accuracy > ACCURACY_MAX) {
      _setText('gps-quality', `GPS: Poor fix (±${Math.round(accuracy)} m) — filtered`);
      _updateRawFields(lat, lon, altitude, heading, accuracy);
      return;
    }

    // Speed from native reading (m/s → km/h)
    let kmh = 0;
    let src = '';
    if (speed != null && speed >= 0) {
      kmh = speed * 3.6;
      src = 'GPS native';
    } else if (lastPos) {
      const dt = (pos.timestamp - lastPos.ts) / 1000;
      if (dt > 0) {
        const d  = haversine(lastPos.lat, lastPos.lon, lat, lon);
        kmh = (d / dt) * 3.6;
        src = 'Calculated (Haversine)';
      }
    }
    if (kmh > SPEED_MAX_KMH) kmh = curSpeed;   // ignore impossible jump
    kmh = Math.max(0, kmh);

    curSpeed = kmh;
    if (kmh > maxSpeed) maxSpeed = kmh;
    speedHist.push(kmh);
    if (speedHist.length > 1000) speedHist.shift();

    // Distance — guard against GPS drift jumps
    if (lastPos) {
      const d       = haversine(lastPos.lat, lastPos.lon, lat, lon);
      const elapsed = (pos.timestamp - lastPos.ts) / 1000;
      const implied = elapsed > 0 ? (d / elapsed) * 3.6 : 0;
      if (implied < SPEED_MAX_KMH && d < 500) {
        if (kmh > 0.5) totalDist += d;
      }
    }

    // Moving / stationary time
    const tick = now - (lastTick || now);
    lastTick   = now;
    if (kmh > 1) movingMs += tick; else stationaryMs += tick;

    // Record
    const p = { lat, lon, ts: pos.timestamp };
    positions.push(p);
    lastPos = p;
    if (positions.length > 2000) positions = positions.slice(-2000);

    // Update UI fields
    _updateRawFields(lat, lon, altitude, heading, accuracy);
    _setText('gps-source', src || 'GPS native');

    // Journey tab stats
    const df = Analytics.formatDistance(totalDist);
    _setText('j-distance', df.val + ' ' + df.unit);
    _setText('j-maxspd',   Math.round(maxSpeed) + ' km/h');
    const avg = speedHist.length ? speedHist.reduce((a, b) => a + b) / speedHist.length : 0;
    _setText('j-avgspd',   Math.round(avg) + ' km/h');
    _setText('j-gpspts',   positions.length.toString());

    _redrawMap();

    if (updateCb) updateCb({ speed: kmh, lat, lon });
  }

  function _onError(err) {
    const msgs = { 1: 'Permission denied', 2: 'GPS unavailable', 3: 'GPS timeout' };
    _setText('gps-quality', 'GPS: ' + (msgs[err.code] || 'Error'));
    curSpeed = 0;
    if (updateCb) updateCb({ speed: 0, lat: null, lon: null });
  }

  function _updateRawFields(lat, lon, alt, heading, acc) {
    _setText('gps-lat',      lat.toFixed(6) + '°');
    _setText('gps-lon',      lon.toFixed(6) + '°');
    _setText('gps-alt',      alt != null ? Math.round(alt) + ' m' : 'N/A');
    _setText('gps-accuracy', '±' + Math.round(acc) + ' m');
    if (heading != null && !isNaN(heading)) {
      const dirs = ['N','NE','E','SE','S','SW','W','NW'];
      const dir  = dirs[Math.round(heading / 45) % 8];
      _setText('gps-heading', Math.round(heading) + '° ' + dir);
    } else {
      _setText('gps-heading', 'N/A');
    }
  }

  /* ── Haversine ───────────────────────────────────────── */
  function haversine(lat1, lon1, lat2, lon2) {
    const R  = 6371e3;
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180;
    const dl = (lon2 - lon1) * Math.PI / 180;
    const a  = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* ── Journey map (canvas, offline, no tiles) ─────────── */
  function _clearMap() {
    if (!mapCtx || !mapCv) return;
    mapCtx.fillStyle = '#07111f';
    mapCtx.fillRect(0, 0, mapCv.width, mapCv.height);
  }

  function _redrawMap() {
    if (!mapCtx || !mapCv) return;
    if (positions.length < 2) { _clearMap(); return; }

    const ph = document.getElementById('map-placeholder');
    if (ph) ph.style.display = 'none';

    const W   = mapCv.width, H = mapCv.height;
    const dpr = devicePixelRatio || 1;

    mapCtx.fillStyle = '#07111f';
    mapCtx.fillRect(0, 0, W, H);

    // Bounding box
    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;
    positions.forEach(p => {
      if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon; if (p.lon > maxLon) maxLon = p.lon;
    });

    const pad    = 0.15;
    const latRng = Math.max(maxLat - minLat, 0.0002);
    const lonRng = Math.max(maxLon - minLon, 0.0002);
    minLat -= latRng * pad; maxLat += latRng * pad;
    minLon -= lonRng * pad; maxLon += lonRng * pad;

    const toX = lon => ((lon - minLon) / (maxLon - minLon)) * W;
    const toY = lat => (1 - (lat - minLat) / (maxLat - minLat)) * H;

    // Grid lines (subtle)
    mapCtx.strokeStyle = '#0d1e35';
    mapCtx.lineWidth   = 1;
    for (let i = 1; i < 4; i++) {
      const x = (i / 4) * W, y = (i / 4) * H;
      mapCtx.beginPath(); mapCtx.moveTo(x, 0); mapCtx.lineTo(x, H); mapCtx.stroke();
      mapCtx.beginPath(); mapCtx.moveTo(0, y); mapCtx.lineTo(W, y); mapCtx.stroke();
    }

    // Route
    mapCtx.beginPath();
    mapCtx.strokeStyle = '#0ea5e9';
    mapCtx.lineWidth   = 3 * dpr;
    mapCtx.lineJoin    = 'round';
    mapCtx.lineCap     = 'round';
    positions.forEach((p, i) => {
      const x = toX(p.lon), y = toY(p.lat);
      i === 0 ? mapCtx.moveTo(x, y) : mapCtx.lineTo(x, y);
    });
    mapCtx.stroke();

    // Start dot (green)
    const s0 = positions[0];
    mapCtx.beginPath();
    mapCtx.arc(toX(s0.lon), toY(s0.lat), 7 * dpr, 0, Math.PI * 2);
    mapCtx.fillStyle = '#00e87a';
    mapCtx.fill();

    // Current dot (cyan glow)
    const sc = positions[positions.length - 1];
    mapCtx.shadowColor = '#0ea5e9';
    mapCtx.shadowBlur  = 14 * dpr;
    mapCtx.beginPath();
    mapCtx.arc(toX(sc.lon), toY(sc.lat), 8 * dpr, 0, Math.PI * 2);
    mapCtx.fillStyle = '#0ea5e9';
    mapCtx.fill();
    mapCtx.shadowBlur = 0;
  }

  function _setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  /* ── Accessors ──────────────────────────────────────── */
  function getSpeed()     { return curSpeed; }
  function getDistance()  { return totalDist; }
  function getMaxSpeed()  { return maxSpeed; }
  function getStats() {
    return {
      distanceM:    totalDist,
      speedHistory: speedHist.slice(),
      maxSpeed,
      movingMs,
      stationaryMs,
      positions:    positions.slice(),
    };
  }

  return { init, start, stop, pause, resume, reset, haversine,
           getSpeed, getDistance, getMaxSpeed, getStats };
})();
