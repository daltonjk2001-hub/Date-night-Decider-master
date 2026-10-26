/* Date Night Decider v3.4.3 Hotfix 1 · IndexedDB Engine with Versioning & Safety */
'use strict';

let db = null;
let useMemoryFallback = false;
let storageFailed = false;
let storageErrorMessage = '';

const APP_TABLE_NAMES = new Set([
  'settings',
  'customDeck',
  'deletedBuiltins',
  'categories',
  'history',
  'unlocks',
  'p2pSessions'
]);

const REQUIRED_TABLE_NAMES = [
  'settings',
  'customDeck',
  'deletedBuiltins',
  'categories',
  'history',
  'unlocks'
];

let isResetInProgress = false;

export function setResetState(inProgress) {
  isResetInProgress = inProgress;
}

export function getResetState() {
  return isResetInProgress;
}

export class ResetInProgressError extends Error {
  constructor(message = 'Database mutation rejected: Application reset in progress.') {
    super(message);
    this.name = 'ResetInProgressError';
  }
}

/**
 * Universal Write Barrier Interceptor: Must wrap every actual database mutation path.
 * Excludes volatile state clearing functions intentionally.
 */
export function guardDatabaseMutation() {
  if (isResetInProgress) {
    throw new ResetInProgressError();
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
  const explanation = reason || storageErrorMessage || 'IndexedDB is unavailable or disabled.[span_0](start_span)'[span_0](end_span);
  banner.hidden = false;
  banner.className = 'storage-warning-banner storage-failure-alert';
  banner.textContent = `STORAGE FAILURE: ${explanation} Unsaved work CANNOT be preserved on this device. Your scrapbook entries and preferences will NOT be saved to disk. Please enable browser storage or check site permissions.`[span_1](start_span)[span_1](end_span);
}

function enterStorageError(reason) {
  storageFailed = true;
  useMemoryFallback = false; 
  storageErrorMessage = String(reason || 'Persistent storage is unavailable.');
  console.error('Date Night Decider IndexedDB Storage Failure:', storageErrorMessage);
  renderStorageWarning(storageErrorMessage);
}

async function createPreMigrationBackup() {
  try {
    if (!window.indexedDB) return;
    const req = window.indexedDB.open('DateNightDatabase');
    req.onsuccess = function() {
      const idb = req.result;
      if (!idb.objectStoreNames.contains('history')) {
        idb.close();
        return;
      }
      try {
        const tx = idb.transaction(['history', 'settings'], 'readonly');
        const histStore = tx.objectStore('history');
        const histReq = histStore.getAll ? histStore.getAll() : null;
        if (histReq) {
          histReq.onsuccess = function() {
            if (Array.isArray(histReq.result) && histReq.result.length > 0) {
              try {
                localStorage.setItem('DateNight_PreMigration_Backup_History', JSON.stringify(histReq.result));
              } catch (_) {}
            }
          };
        }
      } catch (_) {}
      idb.close();
    };
  } catch (err) {
    console.warn('Pre-migration backup check failed:', err);
  }
}

/**
 * Executes schema-aware IndexedDB clearing and namespace-scoped localStorage removal
 * while preserving the crash recovery marker until final reset completion.
 */
export async function clearPersistentStorage() {
  const diagnostics = {
    indexedDbCleared: false,
    localStorageCleared: false,
    markerEstablished: false,
    missingRequiredTables: [],
    errors: []
  };

  // Preflight: Establish and verify crash-recovery marker BEFORE destructive writes.
  try {
    localStorage.setItem('app_reset_pending', 'true');
    const verification = localStorage.getItem('app_reset_pending');
    if (verification !== 'true') {
      throw new Error('Recovery marker verification failed post-write.');
    }
    diagnostics.markerEstablished = true;
  } catch (err) {
    diagnostics.errors.push(`Critical: Failed to establish app_reset_pending preflight marker: ${err.message}`);
    return diagnostics;
  }

  // Domain A: Dynamic Schema Introspection & Atomic Transaction Clear
  try {
    if (!db) {
      throw new Error('Database instance is not initialized.');
    }
    const candidateTables = db.tables.filter(table => APP_TABLE_NAMES.has(table.name));
    const presentTableNames = new Set(candidateTables.map(table => table.name));

    const missingRequired = REQUIRED_TABLE_NAMES.filter(
      name => !presentTableNames.has(name)
    );

    if (missingRequired.length > 0) {
      diagnostics.missingRequiredTables = missingRequired;
      throw new Error(`Required database stores missing: ${missingRequired.join(', ')}`);
    }

    await db.transaction('rw', candidateTables, async () => {
      for (const table of candidateTables) {
        await table.clear();
      }
    });

    diagnostics.indexedDbCleared = true;
  } catch (err) {
    diagnostics.errors.push(`IndexedDB clear failed: ${err.message}`);
    diagnostics.indexedDbCleared = false;
  }

  // Domain B: Namespace-Scoped LocalStorage Clear (Retaining app_reset_pending marker)
  try {
    const APP_PREFIX = 'dnd_';
    const keysToRemove = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(APP_PREFIX)) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }

    diagnostics.localStorageCleared = true;
  } catch (err) {
    diagnostics.errors.push(`LocalStorage clear failed: ${err.message}`);
    diagnostics.localStorageCleared = false;
  }

  return diagnostics;
}

export function finalizeRecoveryMarker() {
  try {
    localStorage.removeItem('app_reset_pending');
    if (localStorage.getItem('app_reset_pending') !== null) {
      throw new Error('Recovery marker removal verification failed.');
    }
    return true;
  } catch (err) {
    console.error('Failed to clear app_reset_pending flag:', err);
    return false;
  }
}

if (typeof window.Dexie !== 'function') {
  enterStorageError('Dexie library did not load.[span_2](start_span)'[span_2](end_span));
} else {
  try {
    createPreMigrationBackup();
    db = new window.Dexie('DateNightDatabase');

    db.version(1).stores({
      settings: 'key',
      customDeck: '++id, id',
      deletedBuiltins: 'id',
      categories: 'id',
      history: '++id, date, syncId',
      unlocks: 'id'
    });

    db.version(2).stores({
      settings: 'key',
      customDeck: '++id, id',
      deletedBuiltins: 'id',
      categories: 'id',
      history: '++id, date, syncId',
      unlocks: 'id'
    }).upgrade(async tx => {
      try {
        const historyTable = tx.table('history');
        const records = await historyTable.toArray();
        for (const record of records) {
          if (!record.syncId) {
            record.syncId = (typeof crypto !== 'undefined' && crypto.randomUUID)
              ? crypto.randomUUID()
              : `migrated-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            await historyTable.put(record);
          }
        }
      } catch (err) {
        console.error('Error during Version 2 migration:', err);
      }
    });

    db.version(3).stores({
      settings: 'key',
      customDeck: '++id, id',
      deletedBuiltins: 'id',
      categories: 'id',
      history: '++id, date, syncId',
      unlocks: 'id',
      p2pSessions: 'id, date'
    });

    db.open().catch(err => {
      console.error('Dexie open error:', err);
      enterStorageError('Database open failed: ' + (err.message || err));
    });
  } catch (err) {
    enterStorageError('IndexedDB initialization exception: ' + (err.message || err));
  }
}
