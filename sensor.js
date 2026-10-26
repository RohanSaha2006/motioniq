// sensor.js — Accelerometer, gyroscope and orientation handling
'use strict';

const Sensor = (() => {
  const N = 150;  // rolling-buffer length

  // Circular buffers for accelerometer (includes gravity)
  const bufAX = new Float32Array(N);
  const bufAY = new Float32Array(N);
  const bufAZ = new Float32Array(N);
  let   headA = 0;

  // Circular buffers for orientation angles (alpha/beta/gamma) used as gyro proxy
  const bufOA = new Float32Array(N);
  const bufOB = new Float32Array(N);
  const bufOG = new Float32Array(N);
  let   headO = 0;

  let active = false;
  let motionHandler = null;
  let orientHandler = null;
  let rafId = null;

  // Aggregate stats
  let peakAccel      = 0;
  let motionEvents   = 0;
  let lastEventTime  = 0;

  // Live readings (read by app.js)
  let cur = { ax: 0, ay: 0, az: 0, mag: 0, oa: 0, ob: 0, og: 0 };

  // Canvas refs
  let cvA = null, ctxA = null;
  let cvO = null, ctxO = null;

  /* ── Initialise canvas elements ───────────────────────── */
  function init() {
    cvA  = document.getElementById('accel-graph');
    ctxA = cvA.getContext('2d');
    cvO  = document.getElementById('gyro-graph');
    ctxO = cvO.getContext('2d');
    _resize();
    window.addEventListener('resize', _resize);
  }

  function _resize() {
    [cvA, cvO].forEach(cv => {
      if (!cv) return;
      const dpr = devicePixelRatio || 1;
      const w   = cv.parentElement.clientWidth || 300;
      cv.width        = w * dpr;
      cv.height       = 100 * dpr;
      cv.style.width  = w + 'px';
      cv.style.height = '100px';
    });
  }

  /* ── Permission request ───────────────────────────────── */
  async function requestPermissions() {
    const result = { motion: 'unavailable', orientation: 'unavailable' };

    // Motion
    if (typeof DeviceMotionEvent !== 'undefined') {
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        try {
          result.motion = await DeviceMotionEvent.requestPermission(); // 'granted' | 'denied'
        } catch { result.motion = 'error'; }
      } else {
        result.motion = 'granted'; // Android — no explicit permission needed
      }
    }

    // Orientation
    if (typeof DeviceOrientationEvent !== 'undefined') {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
          result.orientation = await DeviceOrientationEvent.requestPermission();
        } catch { result.orientation = 'error'; }
      } else {
        result.orientation = 'granted';
      }
    }

    return result;
  }

  /* ── Start ────────────────────────────────────────────── */
  function start() {
    if (active) return;
    active = true;

    motionHandler = _onMotion;
    orientHandler = _onOrient;
    window.addEventListener('devicemotion',      motionHandler, { passive: true });
    window.addEventListener('deviceorientation', orientHandler, { passive: true });

    _drawLoop();
  }

  function stop() {
    active = false;
    if (motionHandler) { window.removeEventListener('devicemotion', motionHandler);      motionHandler = null; }
    if (orientHandler) { window.removeEventListener('deviceorientation', orientHandler); orientHandler = null; }
    if (rafId)         { cancelAnimationFrame(rafId); rafId = null; }
  }

  const pause  = stop;
  const resume = start;

  function reset() {
    peakAccel    = 0;
    motionEvents = 0;
    headA = 0; headO = 0;
    bufAX.fill(0); bufAY.fill(0); bufAZ.fill(0);
    bufOA.fill(0); bufOB.fill(0); bufOG.fill(0);
  }

  /* ── Event handlers ───────────────────────────────────── */
  function _onMotion(e) {
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (!a) return;

    const ax = a.x ?? 0, ay = a.y ?? 0, az = a.z ?? 0;
    const mag = Math.sqrt(ax * ax + ay * ay + az * az);

    cur.ax = ax; cur.ay = ay; cur.az = az; cur.mag = mag;

    bufAX[headA] = ax;
    bufAY[headA] = ay;
    bufAZ[headA] = az;
    headA = (headA + 1) % N;

    // Peak
    if (mag > peakAccel) peakAccel = mag;

    // Motion events: notable spike away from resting gravity (~9.8)
    const now = Date.now();
    if (mag > 14 && now - lastEventTime > 400) {
      motionEvents++;
      lastEventTime = now;
    }

    // Update Motion tab numbers
    _setText('ax-x',   ax.toFixed(2));
    _setText('ax-y',   ay.toFixed(2));
    _setText('ax-z',   az.toFixed(2));
    _setText('ax-mag', mag.toFixed(2));
    _setText('accel-status', e.accelerationIncludingGravity
      ? 'Live · includes gravity (~9.8 m/s² when flat)'
      : 'Live · gravity removed by browser');

    // Analytics panel
    _setText('an-peak',   peakAccel.toFixed(2) + ' m/s²');
    _setText('an-events', motionEvents);
    const intensity = mag < 10.5 ? 'Very Low' : mag < 12 ? 'Low' : mag < 15 ? 'Medium' : mag < 20 ? 'High' : 'Very High';
    _setText('an-avgintens', intensity);
  }

  function _onOrient(e) {
    const oa = e.alpha ?? 0;   // Z-axis rotation (compass)
    const ob = e.beta  ?? 0;   // X-axis tilt (front/back)
    const og = e.gamma ?? 0;   // Y-axis tilt (left/right)

    cur.oa = oa; cur.ob = ob; cur.og = og;

    bufOA[headO] = oa;
    bufOB[headO] = ob;
    bufOG[headO] = og;
    headO = (headO + 1) % N;

    _setText('gy-a',      oa.toFixed(1));
    _setText('gy-b',      ob.toFixed(1));
    _setText('gy-g',      og.toFixed(1));
    _setText('gyro-status', 'Live · device orientation angles');
    _setText('an-tilt',   `Tilt β:${ob.toFixed(0)}°  γ:${og.toFixed(0)}°`);
  }

  /* ── Draw loop ─────────────────────────────────────────── */
  function _drawLoop() {
    if (!active) return;
    _drawGraph(ctxA, cvA, [bufAX, bufAY, bufAZ], headA, ['#0ea5e9', '#10b981', '#f59e0b'], 25);
    _drawGraph(ctxO, cvO, [bufOA, bufOB, bufOG], headO, ['#0ea5e9', '#10b981', '#f59e0b'], 90);
    rafId = requestAnimationFrame(_drawLoop);
  }

  function _drawGraph(ctx, cv, bufs, head, colors, range) {
    if (!ctx) return;
    const W = cv.width, H = cv.height, dpr = devicePixelRatio || 1;

    ctx.fillStyle = '#07111f';
    ctx.fillRect(0, 0, W, H);

    // Zero line
    ctx.save();
    ctx.strokeStyle = '#1a3050';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    const toY = v => H / 2 - (Math.max(-range, Math.min(range, v)) / range) * (H * 0.44);

    bufs.forEach((buf, bi) => {
      ctx.beginPath();
      ctx.strokeStyle = colors[bi];
      ctx.lineWidth   = 1.8 * dpr;
      ctx.lineJoin    = 'round';
      for (let i = 0; i < N; i++) {
        const idx = (head + i) % N;
        const x   = (i / (N - 1)) * W;
        const y   = toY(buf[idx]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
  }

  /* ── Helpers ─────────────────────────────────────────── */
  function _setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function getCurrent()    { return { ...cur }; }
  function getPeak()       { return peakAccel; }
  function getEventCount() { return motionEvents; }

  return { init, requestPermissions, start, stop, pause, resume, reset, getCurrent, getPeak, getEventCount };
})();
