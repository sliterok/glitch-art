// lib/storage.js - IndexedDB persistent history storage for JPEG Glitch Lab

const DB_NAME = 'glitch_art_db';
const DB_VERSION = 1;
const STORE_NAME = 'history';

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not supported in this environment'));
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('favorite', 'favorite', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
  return dbPromise;
}

export async function dbSaveItem(item) {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(item);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('dbSaveItem failed:', err);
  }
}

export async function dbUpdateFavorite(id, favorite) {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const data = getReq.result;
        if (!data) return resolve(false);
        data.favorite = Boolean(favorite);
        const putReq = store.put(data);
        putReq.onsuccess = () => resolve(true);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  } catch (err) {
    console.warn('dbUpdateFavorite failed:', err);
  }
}

export async function dbDeleteItem(id) {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('dbDeleteItem failed:', err);
  }
}

export async function dbDeleteItems(ids) {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const id of ids) {
        store.delete(id);
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('dbDeleteItems failed:', err);
  }
}

export async function dbGetAllHistory() {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const items = req.result || [];
        // Sort descending by createdAt
        items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('dbGetAllHistory failed, returning empty:', err);
    return [];
  }
}

export async function dbTrimUnfavorited(maxUnfavorited = 60) {
  try {
    const db = await openDb();
    const items = await dbGetAllHistory();
    const unfavorited = items.filter((it) => !it.favorite);
    if (unfavorited.length > maxUnfavorited) {
      const toDelete = unfavorited.slice(maxUnfavorited);
      await dbDeleteItems(toDelete.map((it) => it.id));
      return toDelete.map((it) => it.id);
    }
  } catch (err) {
    console.warn('dbTrimUnfavorited failed:', err);
  }
  return [];
}

