// analytics.js — Activity classification and session statistics
'use strict';

const Analytics = (() => {

  /**
   * Classify activity from GPS speed and accelerometer magnitude.
   * Returns { name, icon, confidence, signals[] }
   */
  function classifyActivity(speedKmh, accelMag) {
    let name, icon, confidence, signals = [];

    if (speedKmh >= 60) {
      name = 'Vehicle';  icon = '🚗';
      confidence = speedKmh > 90 ? 'High' : 'Moderate';
      signals.push(`GPS ${speedKmh.toFixed(1)} km/h`);
    } else if (speedKmh >= 20) {
      name = 'Cycling';  icon = '🚴';
      confidence = 'Moderate';
      signals.push(`GPS ${speedKmh.toFixed(1)} km/h`);
      if (accelMag > 12) signals.push('Moderate vibration');
    } else if (speedKmh >= 7) {
      name = 'Running';  icon = '🏃';
      confidence = accelMag > 13 ? 'High' : 'Moderate';
      signals.push(`GPS ${speedKmh.toFixed(1)} km/h`);
      if (accelMag > 13) signals.push('High motion intensity');
    } else if (speedKmh >= 1) {
      name = 'Walking';  icon = '🚶';
      confidence = 'Moderate';
      signals.push(`GPS ${speedKmh.toFixed(1)} km/h`);
    } else {
      // Speed < 1 km/h — rely on accelerometer
      if (accelMag > 11.5) {
        name = 'Moving (no GPS fix)'; icon = '🔄';
        confidence = 'Low';
        signals.push('Motion detected · GPS speed < 1 km/h');
      } else {
        name = 'Stationary'; icon = '🧍';
        confidence = 'High';
        signals.push('GPS speed < 1 km/h · Low motion');
      }
    }

    return { name, icon, confidence, signals };
  }

  /**
   * Compute final session statistics from accumulated data.
   */
  function calcSessionStats(opts) {
    const {
      speedHistory = [], distanceM = 0, peakAccel = 0,
      motionEvents = 0, startTime, endTime,
      movingMs = 0, stationaryMs = 0
    } = opts;

    const duration  = endTime - startTime;
    const n         = speedHistory.length;
    const avgSpeed  = n ? speedHistory.reduce((a, b) => a + b, 0) / n : 0;
    const maxSpeed  = n ? Math.max(...speedHistory) : 0;

    let speedVariation = 0;
    if (n > 1) {
      const variance = speedHistory.reduce((a, b) => a + (b - avgSpeed) ** 2, 0) / n;
      speedVariation = Math.sqrt(variance);
    }

    return {
      startTime:      new Date(startTime).toISOString(),
      endTime:        new Date(endTime).toISOString(),
      duration,
      distance:       Math.round(distanceM * 10) / 10,
      maxSpeed:       Math.round(maxSpeed * 10) / 10,
      avgSpeed:       Math.round(avgSpeed * 10) / 10,
      speedVariation: Math.round(speedVariation * 10) / 10,
      peakAcceleration: Math.round(peakAccel * 100) / 100,
      motionEvents,
      movingTime:     movingMs,
      stationaryTime: stationaryMs,
    };
  }

  /** Format milliseconds → "m:ss" or "h:mm:ss" */
  function formatDuration(ms) {
    if (!ms || ms < 0) return '0:00';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}:${pad(m % 60)}:${pad(s % 60)}`;
    return `${m}:${pad(s % 60)}`;
  }

  /** Format metres → { val, unit } */
  function formatDistance(m) {
    if (m >= 1000) return { val: (m / 1000).toFixed(2), unit: 'km' };
    return { val: Math.round(m).toString(), unit: 'm' };
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  return { classifyActivity, calcSessionStats, formatDuration, formatDistance };
})();
