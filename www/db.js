/* Date Night Decider v3.4.3 Hotfix 1 · Hardened IndexedDB Engine */
'use strict';

let db = null;
let useMemoryFallback = false;
let storageFailed = false;
let storageErrorMessage = '';
let isResetInProgress = false;
let internalStorageMutationDepth = 0;
let observedStateGeneration = null;
const activeDatabaseMutations = new Set();
const lockedTransactions = new WeakSet();
const DND_RESET_MARKER = 'app_reset_pending';
const DND_GENERATION_KEY = 'dnd_state_generation';
const DND_WRITE_LOCK = 'dnd-database-access-v1';
const DND_MUTATION_METHODS = [
  'add', 'put', 'update', 'delete',
  'bulkAdd', 'bulkPut', 'bulkUpdate', 'bulkDelete', 'clear'
];

let resolveDbReady;
const dbReady = new Promise(resolve => { resolveDbReady = resolve; });
window.dbReady = dbReady;

const APP_TABLE_NAMES = new Set([
  'settings', 'customDeck', 'deletedBuiltins', 'categories',
  'history', 'unlocks', 'p2pSessions'
]);

const REQUIRED_TABLE_NAMES = [
  'settings', 'customDeck', 'deletedBuiltins',
  'categories', 'history', 'unlocks'
];

function setResetState(inProgress) {
  isResetInProgress = Boolean(inProgress);
}

function getResetState() {
  return isResetInProgress;
}

class ResetInProgressError extends Error {
  constructor(message = 'Database mutation rejected: application reset is in progress.') {
    super(message);
    this.name = 'ResetInProgressError';
  }
}

function generateCollisionResistantSyncId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'sync-' + Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2) + '-' +
    Math.random().toString(36).slice(2);
}

function readResetGeneration() {
  const raw = localStorage.getItem(DND_GENERATION_KEY);
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Persistent reset generation is invalid.');
  }
  return value;
}

function guardDatabaseMutation() {
  if (internalStorageMutationDepth > 0) return;
  if (isResetInProgress) throw new ResetInProgressError();

  let marker;
  try {
    marker = localStorage.getItem(DND_RESET_MARKER);
  } catch (_) {
    throw new Error('Database mutation rejected because storage state could not be verified.');
  }
  if (marker === 'true') {
    throw new ResetInProgressError('Database mutation rejected: reset recovery is required.');
  }

  const currentGeneration = readResetGeneration();
  if (observedStateGeneration !== null && currentGeneration !== observedStateGeneration) {
    // A suspended or outdated tab must not repopulate a database after reset.
    if (window && window.location && typeof window.location.reload === 'function') {
      window.setTimeout(() => window.location.reload(), 0);
    }
    throw new ResetInProgressError('This tab has stale application state and must reload before saving.');
  }
}

function captureCurrentGeneration() {
  if (isResetInProgress || hasPendingResetMarker()) {
    throw new ResetInProgressError('Cannot initialize application state during reset recovery.');
  }
  observedStateGeneration = readResetGeneration();
  return observedStateGeneration;
}

function isCurrentGeneration() {
  if (observedStateGeneration === null) return true;
  try {
    return !hasPendingResetMarker() && readResetGeneration() === observedStateGeneration;
  } catch (_) {
    return false;
  }
}

function trackDatabaseMutation(promise) {
  const tracked = Promise.resolve(promise);
  activeDatabaseMutations.add(tracked);
  tracked.then(
    () => activeDatabaseMutations.delete(tracked),
    () => activeDatabaseMutations.delete(tracked)
  );
  return tracked;
}

async function withDatabaseWrite(operation) {
  guardDatabaseMutation();
  const generationAtStart = readResetGeneration();

  const execute = async () => {
    guardDatabaseMutation();
    if (readResetGeneration() !== generationAtStart) {
      throw new ResetInProgressError('Database mutation rejected because a reset occurred while the write was waiting.');
    }
    return operation();
  };

  let pending;
  if (navigator.locks && typeof navigator.locks.request === 'function') {
    pending = navigator.locks.request(DND_WRITE_LOCK, { mode: 'shared' }, execute);
  } else {
    // Ordinary persistence can run in older webviews. The destructive reset
    // path separately fails closed unless cross-context exclusive locks exist.
    pending = execute();
  }
  return trackDatabaseMutation(pending);
}

async function withDatabaseTransaction(tables, callback) {
  if (!db) throw new Error('Database is not initialized.');
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new Error('A database transaction requires an explicit non-empty table list.');
  }
  return withDatabaseWrite(() => db.transaction('rw', ...tables, async () => {
    const transaction = window.Dexie && window.Dexie.currentTransaction;
    if (transaction && transaction.db === db) lockedTransactions.add(transaction);
    try {
      return await callback(transaction);
    } finally {
      if (transaction) lockedTransactions.delete(transaction);
    }
  }));
}

function installDatabaseWriteGuards(database) {
  for (const table of database.tables) {
    for (const methodName of DND_MUTATION_METHODS) {
      const original = table[methodName];
      if (typeof original !== 'function' || original.__dndGuarded) continue;

      const guarded = function(...args) {
        if (internalStorageMutationDepth > 0) return original.apply(this, args);
        guardDatabaseMutation();

        const transaction = window.Dexie && window.Dexie.currentTransaction;
        if (transaction && transaction.db === database) {
          if (!lockedTransactions.has(transaction)) {
            throw new Error('Database writes inside transactions must use DNDStorage.withDatabaseTransaction().');
          }
          return original.apply(this, args);
        }

        return withDatabaseWrite(() => original.apply(this, args));
      };
      guarded.__dndGuarded = true;
      table[methodName] = guarded;
    }
  }
}

async function waitForPendingDatabaseMutations(timeoutMs = 2000) {
  const start = Date.now();
  while (activeDatabaseMutations.size > 0 && Date.now() - start < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (activeDatabaseMutations.size > 0) {
    throw new Error('Timed out waiting for outstanding database mutations to settle.');
  }
}

function renderStorageWarning(reason) {
  const banner = document.getElementById('storageWarningBanner');
  if (!banner) return;
  if (!storageFailed) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  const explanation = reason || storageErrorMessage || 'IndexedDB is unavailable or disabled.';
  banner.hidden = false;
  banner.className = 'storage-warning-banner storage-failure-alert';
  banner.textContent = 'STORAGE FAILURE: ' + explanation +
    ' Unsaved work cannot be preserved on this device.';
}

function enterStorageError(reason) {
  storageFailed = true;
  useMemoryFallback = false;
  storageErrorMessage = String(reason || 'Persistent storage is unavailable.');
  console.error('Date Night Decider IndexedDB Storage Failure:', storageErrorMessage);
  renderStorageWarning(storageErrorMessage);
}

async function createPreMigrationBackup() {
  // Do not create a brand-new database just to make a backup. If database
  // enumeration is unavailable, an IndexedDB versionchange transaction still
  // provides atomic rollback if the migration fails.
  if (!window.indexedDB || typeof window.indexedDB.databases !== 'function') {
    console.warn('Pre-migration backup skipped: indexedDB.databases() is unavailable.');
    return false;
  }

  let nativeDb = null;
  try {
    const databases = await window.indexedDB.databases();
    const metadata = databases.find(item => item && item.name === 'DateNightDatabase');
    if (!metadata || !metadata.version || metadata.version >= 3) return false;

    nativeDb = await new Promise((resolve, reject) => {
      const request = window.indexedDB.open('DateNightDatabase');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open database for backup.'));
      request.onblocked = () => reject(new Error('Database backup was blocked by another open connection.'));
    });

    const storeNames = [
      'settings', 'customDeck', 'deletedBuiltins', 'categories',
      'history', 'unlocks', 'p2pSessions'
    ].filter(name => nativeDb.objectStoreNames.contains(name));
    if (!storeNames.length) return false;

    const transaction = nativeDb.transaction(storeNames, 'readonly');
    const transactionDone = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('Backup transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Backup transaction was aborted.'));
    });
    const snapshot = {
      backupVersion: 1,
      databaseName: 'DateNightDatabase',
      databaseVersion: nativeDb.version,
      createdAt: new Date().toISOString(),
      stores: {}
    };
    const reads = storeNames.map(name => new Promise((resolve, reject) => {
      const request = transaction.objectStore(name).getAll();
      request.onsuccess = () => { snapshot.stores[name] = request.result; resolve(); };
      request.onerror = () => reject(request.error || new Error('Backup read failed for store ' + name + '.'));
    }));

    await Promise.all([transactionDone, ...reads]);
    localStorage.setItem('DateNight_PreMigration_Backup_v1', JSON.stringify(snapshot));
    return true;
  } catch (err) {
    console.warn('Pre-migration backup could not be verified; relying on atomic IndexedDB migration rollback:', err);
    return false;
  } finally {
    if (nativeDb) {
      try { nativeDb.close(); } catch (_) {}
    }
  }
}

async function clearPersistentStorage() {
  const diagnostics = {
    indexedDbCleared: false,
    localStorageCleared: false,
    sessionStorageCleared: false,
    markerEstablished: false,
    missingRequiredTables: [],
    errors: []
  };

  setResetState(true);
  try {
    localStorage.setItem(DND_RESET_MARKER, 'true');
    if (localStorage.getItem(DND_RESET_MARKER) !== 'true') {
      throw new Error('Recovery marker verification failed after writing.');
    }
    const nextGeneration = readResetGeneration() + 1;
    localStorage.setItem(DND_GENERATION_KEY, String(nextGeneration));
    if (readResetGeneration() !== nextGeneration) {
      throw new Error('Persistent reset generation verification failed.');
    }
    diagnostics.markerEstablished = true;
  } catch (err) {
    diagnostics.errors.push('Critical: Could not establish reset recovery state: ' + err.message);
    return diagnostics;
  }

  try {
    await waitForPendingDatabaseMutations();
    if (!db || !db.isOpen()) throw new Error('Database instance is not initialized or open.');

    const candidateTables = db.tables.filter(table => APP_TABLE_NAMES.has(table.name));
    const presentTableNames = new Set(candidateTables.map(table => table.name));
    const missingRequired = REQUIRED_TABLE_NAMES.filter(name => !presentTableNames.has(name));
    if (missingRequired.length) {
      diagnostics.missingRequiredTables = missingRequired;
      throw new Error('Required database stores are missing: ' + missingRequired.join(', '));
    }

    internalStorageMutationDepth++;
    try {
      await db.transaction('rw', candidateTables, async () => {
        for (const table of candidateTables) await table.clear();
      });
    } finally {
      internalStorageMutationDepth--;
    }
    diagnostics.indexedDbCleared = true;
  } catch (err) {
    diagnostics.errors.push('IndexedDB clear failed: ' + err.message);
  }

  try {
    const preservedKeys = new Set([DND_RESET_MARKER, DND_GENERATION_KEY]);
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || preservedKeys.has(key)) continue;
      if (key.startsWith('dnd_') || key.startsWith('DateNight_') ||
          key === 'DateNight_PreMigration_Backup_v1' ||
          key === 'DateNight_PreMigration_Backup_History') {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) localStorage.removeItem(key);
    diagnostics.localStorageCleared = true;
  } catch (err) {
    diagnostics.errors.push('LocalStorage clear failed: ' + err.message);
  }

  try {
    clearCurrentTabSessionStorage();
    diagnostics.sessionStorageCleared = true;
  } catch (err) {
    diagnostics.errors.push('SessionStorage clear failed: ' + err.message);
  }

  return diagnostics;
}

function clearCurrentTabSessionStorage() {
  const keysToRemove = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key && (key.startsWith('dnd_') || key.startsWith('DateNight_'))) keysToRemove.push(key);
  }
  for (const key of keysToRemove) sessionStorage.removeItem(key);
  return true;
}

function finalizeRecoveryMarker() {
  try {
    localStorage.removeItem(DND_RESET_MARKER);
    return localStorage.getItem(DND_RESET_MARKER) === null;
  } catch (err) {
    console.error('Failed to clear recovery marker:', err);
    return false;
  }
}

function hasPendingResetMarker() {
  try {
    return localStorage.getItem(DND_RESET_MARKER) === 'true';
  } catch (_) {
    return true; // Fail closed when recovery state cannot be verified.
  }
}

function exposeStorageAPI() {
  window.db = db;
  window.DNDStorage = {
    get db() { return db; },
    dbReady,
    setResetState,
    getResetState,
    guardDatabaseMutation,
    captureCurrentGeneration,
    isCurrentGeneration,
    withDatabaseWrite,
    withDatabaseTransaction,
    waitForPendingDatabaseMutations,
    clearPersistentStorage,
    finalizeRecoveryMarker,
    clearCurrentTabSessionStorage,
    hasPendingResetMarker,
    generateCollisionResistantSyncId,
    isStorageFailed: () => storageFailed,
    getStorageError: () => storageErrorMessage
  };
}

if (typeof window.Dexie !== 'function') {
  enterStorageError('Dexie library did not load.');
  exposeStorageAPI();
  resolveDbReady(null);
} else {
  try {
    db = new window.Dexie('DateNightDatabase');
    db.version(1).stores({
      settings: 'key', customDeck: '++id, id', deletedBuiltins: 'id',
      categories: 'id', history: '++id, date, syncId', unlocks: 'id'
    });

    db.version(2).stores({
      settings: 'key', customDeck: '++id, id', deletedBuiltins: 'id',
      categories: 'id', history: '++id, date, syncId', unlocks: 'id'
    }).upgrade(async tx => {
      const historyTable = tx.table('history');
      const records = await historyTable.toArray();
      for (const record of records) {
        if (!record.syncId) {
          record.syncId = generateCollisionResistantSyncId();
          await historyTable.put(record);
        }
      }
    });

    db.version(3).stores({
      settings: 'key', customDeck: '++id, id', deletedBuiltins: 'id',
      categories: 'id', history: '++id, date, syncId', unlocks: 'id',
      p2pSessions: 'id, date'
    });

    exposeStorageAPI();
    Promise.resolve()
      .then(createPreMigrationBackup)
      .catch(err => {
        console.warn('Pre-migration backup failed; atomic migration rollback remains enabled:', err);
      })
      .then(() => db.open())
      .then(() => {
        installDatabaseWriteGuards(db);
        exposeStorageAPI();
        resolveDbReady(db);
      })
      .catch(err => {
        enterStorageError('Database open failed: ' + (err.message || err));
        exposeStorageAPI();
        resolveDbReady(null);
      });
  } catch (err) {
    enterStorageError('IndexedDB initialization exception: ' + (err.message || err));
    exposeStorageAPI();
    resolveDbReady(null);
  }
}
