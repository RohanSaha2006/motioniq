// storage.js — IndexedDB session persistence
'use strict';

const Storage = (() => {
  const DB_NAME = 'motioniq_db';
  const DB_VER  = 1;
  const STORE   = 'sessions';
  let db = null;

  function init() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { resolve(); return; }
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = e => { db = e.target.result; resolve(); };
      req.onerror   = e => { console.warn('IDB open failed', e.target.error); resolve(); };
    });
  }

  function saveSession(data) {
    return new Promise((resolve, reject) => {
      if (!db) { reject('DB unavailable'); return; }
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).add({ ...data, savedAt: Date.now() });
      req.onsuccess = () => resolve(req.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  function getSessions() {
    return new Promise((resolve) => {
      if (!db) { resolve([]); return; }
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result || []).slice().reverse());
      req.onerror   = () => resolve([]);
    });
  }

  function deleteSession(id) {
    return new Promise((resolve, reject) => {
      if (!db) { reject('DB unavailable'); return; }
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  function clearAll() {
    return new Promise((resolve, reject) => {
      if (!db) { reject('DB unavailable'); return; }
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  function _download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a   = Object.assign(document.createElement('a'), { href: url, download: name });
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  function exportJSON(sessions) {
    _download(
      new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' }),
      `motioniq_${Date.now()}.json`
    );
  }

  function exportCSV(sessions) {
    const keys = ['id','startTime','endTime','duration','distance','maxSpeed','avgSpeed',
                  'activity','motionEvents','peakAcceleration','movingTime','stationaryTime','gpsPoints'];
    const rows = [
      keys.join(','),
      ...sessions.map(s => keys.map(k => JSON.stringify(s[k] ?? '')).join(','))
    ];
    _download(
      new Blob([rows.join('\n')], { type: 'text/csv' }),
      `motioniq_${Date.now()}.csv`
    );
  }

  return { init, saveSession, getSessions, deleteSession, clearAll, exportJSON, exportCSV };
})();
