/* Date Night Decider v3.4.3 Hotfix 1 · IndexedDB Engine with Versioning & Safety */
'use strict';

let db = null;
let useMemoryFallback = false;
let storageFailed = false;
let storageErrorMessage = '';

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
  banner.textContent = `STORAGE FAILURE: ${explanation} Unsaved work CANNOT be preserved on this device. Your scrapbook entries and preferences will NOT be saved to disk. Please enable browser storage or check site permissions.`;
}

function enterStorageError(reason) {
  storageFailed = true;
  useMemoryFallback = false; // Eliminate silent memory fallback per P0 requirements
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

if (typeof window.Dexie !== 'function') {
  enterStorageError('Dexie library did not load.');
} else {
  try {
    createPreMigrationBackup();
    db = new window.Dexie('DateNightDatabase');

    // Schema Version 1
    db.version(1).stores({
      settings: 'key',
      customDeck: '++id, id',
      deletedBuiltins: 'id',
      categories: 'id',
      history: '++id, date, syncId',
      unlocks: 'id'
    });

    // Schema Version 2 - Migration Callback
    db.version(2).stores({
      settings: 'key',
      customDeck: '++id, id',
      deletedBuiltins: 'id',
      categories: 'id',
      history: '++id, date, syncId',
      unlocks: 'id'
    }).upgrade(async tx => {
      console.log('Migrating DateNightDatabase to Schema Version 2...');
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

    // Schema Version 3 - Explicit Migration and Session Store
    db.version(3).stores({
      settings: 'key',
      customDeck: '++id, id',
      deletedBuiltins: 'id',
      categories: 'id',
      history: '++id, date, syncId',
      unlocks: 'id',
      p2pSessions: 'id, date'
    }).upgrade(async tx => {
      console.log('Migrating DateNightDatabase to Schema Version 3...');
      // Safe non-destructive upgrade callback
    });

    db.open().catch(err => {
      console.error('Dexie open error:', err);
      enterStorageError('Database open failed: ' + (err.message || err));
    });
  } catch (err) {
    enterStorageError('IndexedDB initialization exception: ' + (err.message || err));
  }
}
