/* Date Night Decider v3.4.3 Hotfix 8 · Hardened IndexedDB Engine */
'use strict';

let db = null;
let useMemoryFallback = false;
let storageFailed = false;
let storageErrorMessage = '';
let isResetInProgress = false;
const internalResetTransactions = new WeakSet();
let observedStateGeneration = null;
const activeDatabaseMutations = new Set();
const lockedTransactions = new WeakSet();
const DND_RESET_MARKER = 'app_reset_pending';
const DND_RESET_JOURNAL_KEY = 'dnd_reset_journal_v1';
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
  'categories', 'history', 'unlocks', 'p2pSessions'
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
  if (isResetInProgress) throw new ResetInProgressError();

  if (hasPendingResetMarker()) {
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

  const lockManager =
    typeof navigator !== 'undefined' ? navigator.locks : null;

  if (!lockManager || typeof lockManager.request !== 'function') {
    throw new Error(
      'Persistent writes are unavailable because Web Locks coordination is unsupported; write blocked.'
    );
  }

  const execute = () => {
    // Re-check admission after lock acquisition: a reset or generation change
    // may have happened while this write was waiting.
    guardDatabaseMutation();
    return operation();
  };

  const pending = lockManager.request(
    DND_WRITE_LOCK,
    { mode: 'exclusive' },
    execute
  );

  return trackDatabaseMutation(pending);
}

async function withDatabaseTransaction(tables, callback) {
  if (!db) throw new Error('Database is not initialized.');
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new Error('A database transaction requires an explicit non-empty table list.');
  }
  return withDatabaseWrite(() => db.transaction('rw', ...tables, async () => {
    const Dexie = window.Dexie;
    const transaction = Dexie && Dexie.currentTransaction;

    // Block writes if the active Dexie transaction cannot be verified.
    if (!transaction || transaction.db !== db) {
      throw new Error('Unable to verify active database transaction; write blocked.');
    }

    lockedTransactions.add(transaction);
    try {
      return await callback(transaction);
    } finally {
      lockedTransactions.delete(transaction);
    }
  }));
}

function installDatabaseWriteGuards(database) {
  for (const table of database.tables) {
    for (const methodName of DND_MUTATION_METHODS) {
      const original = table[methodName];
      if (typeof original !== 'function' || original.__dndGuarded) continue;

      const guarded = function(...args) {
        const transaction = window.Dexie && window.Dexie.currentTransaction;
        if (transaction && transaction.db === database && internalResetTransactions.has(transaction)) {
          return original.apply(this, args);
        }

        guardDatabaseMutation();
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

async function clearPersistentStorage(options = {}) {
  const beforeClear = options && typeof options.beforeClear === 'function'
    ? options.beforeClear : null;
  const diagnostics = {
    resetCompleted: false,
    indexedDbCleared: false,
    localStorageCleared: false,
    sessionStorageCleared: false,
    markerEstablished: false,
    lockAcquired: false,
    missingRequiredTables: [],
    errors: []
  };

  const lockManager = typeof navigator !== 'undefined' ? navigator.locks : null;
  if (!lockManager || typeof lockManager.request !== 'function') {
    diagnostics.errors.push('Critical: Destructive reset requires exclusive Web Locks support. No data was cleared.');
    return diagnostics;
  }
  if (isResetInProgress) {
    diagnostics.errors.push('A reset is already in progress. No second reset was started.');
    return diagnostics;
  }
  if (!db || !db.isOpen()) {
    diagnostics.errors.push('Critical: Database is not initialized or open. No data was cleared.');
    return diagnostics;
  }

  const checkRequiredTables = () => {
    const tables = db.tables.filter(table => APP_TABLE_NAMES.has(table.name));
    const present = new Set(tables.map(table => table.name));
    const missing = REQUIRED_TABLE_NAMES.filter(name => !present.has(name));
    return { tables, missing };
  };
  const initialCheck = checkRequiredTables();
  if (initialCheck.missing.length) {
    diagnostics.missingRequiredTables = initialCheck.missing;
    diagnostics.errors.push('Required database stores are missing: ' + initialCheck.missing.join(', '));
    return diagnostics;
  }

  // Snapshot the durable state before waiting for the shared exclusive lock.
  // Another tab may finish a reset while this request is queued.
  let generationAtRequestStart;
  let resetPendingAtRequestStart;
  try {
    generationAtRequestStart = readResetGeneration();
    resetPendingAtRequestStart = hasPendingResetMarker();
  } catch (err) {
    diagnostics.errors.push(
      'Could not verify reset state before starting: ' + (err.message || err)
    );
    return diagnostics;
  }

  // Close local writer admission before requesting the exclusive lock.
  // Do not wait on tracked promises before requesting the lock.
  setResetState(true);

  let markerMayBePending = false;
  try {
    return await lockManager.request(DND_WRITE_LOCK, { mode: 'exclusive' }, async () => {
      diagnostics.lockAcquired = true;
      try {
        if (!db || !db.isOpen()) throw new Error('Database became unavailable before reset began.');
        const tableCheck = checkRequiredTables();
        if (tableCheck.missing.length) {
          diagnostics.missingRequiredTables = tableCheck.missing;
          throw new Error('Required database stores are missing: ' + tableCheck.missing.join(', '));
        }

        const existingMarker = localStorage.getItem(DND_RESET_MARKER);
        const existingJournalText = localStorage.getItem(DND_RESET_JOURNAL_KEY);
        markerMayBePending = existingMarker !== null || existingJournalText !== null;
        diagnostics.markerEstablished = markerMayBePending;

        const currentGeneration = readResetGeneration();

        let existingJournalParsed = null;
        if (existingJournalText !== null) {
          try {
            existingJournalParsed = JSON.parse(existingJournalText);
          } catch (_) {
            // The ordinary journal validation below will fail closed.
          }
        }

        const existingJournalIsComplete =
          isCompletedResetJournal(existingJournalText);

        markerMayBePending =
          existingMarker !== null ||
          (existingJournalText !== null && !existingJournalIsComplete);
        diagnostics.markerEstablished = markerMayBePending;

        if (existingJournalIsComplete &&
            currentGeneration !== existingJournalParsed.targetGeneration) {
          throw new Error(
            'Completed reset journal does not match the stored generation; recovery is blocked.'
          );
        }

        // The reset already finished, but removal of the legacy marker may
        // have failed. Finalize it without another clear or generation change.
        if (existingMarker === 'true' && existingJournalIsComplete) {
          observedStateGeneration = currentGeneration;
          diagnostics.indexedDbCleared = true;
          diagnostics.localStorageCleared = true;
          diagnostics.sessionStorageCleared = true;

          if (!finalizeRecoveryMarker()) {
            throw new Error(
              'Completed reset journal is valid, but the legacy marker could not be finalized.'
            );
          }

          setResetState(false);
          diagnostics.resetCompleted = true;
          diagnostics.resetAlreadyCompleted = true;
          return diagnostics;
        }


        // If another reset completed while this request was waiting, coalesce
        // this request with that completed operation instead of clearing again.
        if (existingMarker === null &&
            (existingJournalText === null || existingJournalIsComplete) &&
            (currentGeneration !== generationAtRequestStart ||
             resetPendingAtRequestStart)) {
          observedStateGeneration = currentGeneration;
          setResetState(false);
          diagnostics.resetCompleted = true;
          diagnostics.resetAlreadyCompleted = true;
          return diagnostics;
        }

        // Transitional compatibility: an earlier local build stored its JSON
        // journal in the legacy marker key. A normal legacy marker is "true".
        let sourceJournalText = existingJournalText;

        if (existingMarker === null && existingJournalIsComplete) {
          localStorage.removeItem(DND_RESET_JOURNAL_KEY);
          if (localStorage.getItem(DND_RESET_JOURNAL_KEY) !== null) {
            throw new Error('Could not retire the previous completed reset journal.');
          }
          sourceJournalText = null;
        }

        if (sourceJournalText === null &&
            existingMarker !== null && existingMarker !== 'true') {
          sourceJournalText = existingMarker;
        }

        let journal;
        if (sourceJournalText === null) {
          // With no journal, this is either a new reset or an old "true"
          // marker. Legacy markers cannot reveal whether the old generation
          // was already advanced, so the documented migration policy is to
          // establish a fresh target from the currently stored generation.
          const baseGeneration = currentGeneration;
          const targetGeneration = baseGeneration + 1;
          if (!Number.isSafeInteger(targetGeneration) || targetGeneration < 1) {
            throw new Error('Persistent reset generation cannot be advanced safely.');
          }
          journal = {
            version: 1,
            resetId: 'reset-' + generateCollisionResistantSyncId(),
            baseGeneration,
            targetGeneration,
            phase: 'prepared'
          };
        } else {
          let parsed;
          try {
            parsed = JSON.parse(sourceJournalText);
          } catch (_) {
            throw new Error('Persistent reset journal is malformed; recovery is blocked.');
          }

          if (!parsed || parsed.version !== 1 ||
              !Number.isSafeInteger(parsed.targetGeneration) ||
              parsed.targetGeneration < 1) {
            throw new Error('Persistent reset journal is invalid; recovery is blocked.');
          }

          // Earlier experimental journals had only version and targetGeneration.
          // Infer their base only for that legacy format; new journals must state it.
          const baseGeneration = Number.isSafeInteger(parsed.baseGeneration)
            ? parsed.baseGeneration
            : parsed.targetGeneration - 1;

          if (baseGeneration < 0 ||
              parsed.targetGeneration !== baseGeneration + 1) {
            throw new Error('Persistent reset journal generation pair is invalid; recovery is blocked.');
          }

          const allowedPhases = new Set([
            'prepared',
            'generation-committed',
            'indexeddb-cleared',
            'localstorage-cleared',
            'sessionstorage-cleared',
            'complete'
          ]);

          journal = {
            version: 1,
            resetId: typeof parsed.resetId === 'string' && parsed.resetId.length > 0
              ? parsed.resetId
              : 'reset-' + generateCollisionResistantSyncId(),
            baseGeneration,
            targetGeneration: parsed.targetGeneration,
            phase: allowedPhases.has(parsed.phase) ? parsed.phase : 'prepared'
          };
        }

        const targetGeneration = journal.targetGeneration;
        if (currentGeneration !== journal.baseGeneration &&
            currentGeneration !== targetGeneration) {
          throw new Error('Persistent reset journal does not match the stored generation; recovery is blocked.');
        }

        // Keep the legacy marker format so older open tabs also fail closed.
        // Persist and verify the detailed journal separately.
        if (existingMarker !== 'true') {
          localStorage.setItem(DND_RESET_MARKER, 'true');
          markerMayBePending = true;
          if (localStorage.getItem(DND_RESET_MARKER) !== 'true') {
            throw new Error('Legacy-compatible recovery marker verification failed.');
          }
        }

        const serializedJournal = JSON.stringify(journal);
        localStorage.setItem(DND_RESET_JOURNAL_KEY, serializedJournal);
        markerMayBePending = true;
        if (localStorage.getItem(DND_RESET_JOURNAL_KEY) !== serializedJournal) {
          throw new Error('Persistent reset journal verification failed after writing.');
        }
        diagnostics.markerEstablished = true;

        // Reuse the same journal target on retry.
        if (currentGeneration !== targetGeneration) {
          localStorage.setItem(DND_GENERATION_KEY, String(targetGeneration));
          if (readResetGeneration() !== targetGeneration) {
            throw new Error('Persistent reset generation verification failed.');
          }
        }

        journal.phase = 'generation-committed';
        const committed = JSON.stringify(journal);
        localStorage.setItem(DND_RESET_JOURNAL_KEY, committed);
        if (localStorage.getItem(DND_RESET_JOURNAL_KEY) !== committed) {
          throw new Error('Committed reset journal could not be verified.');
        }

        if (beforeClear) {
          await beforeClear({
            resetId: journal.resetId,
            targetGeneration
          });
        }

        await db.transaction('rw', tableCheck.tables, async () => {
          const transaction = window.Dexie && window.Dexie.currentTransaction;
          if (!transaction || transaction.db !== db) {
            throw new Error('Could not verify the internal reset transaction.');
          }
          internalResetTransactions.add(transaction);
          try {
            for (const table of tableCheck.tables) await table.clear();
          } finally {
            internalResetTransactions.delete(transaction);
          }
        });
        diagnostics.indexedDbCleared = true;

        const preservedKeys = new Set([DND_RESET_MARKER, DND_RESET_JOURNAL_KEY, DND_GENERATION_KEY]);
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
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && !preservedKeys.has(key) &&
              (key.startsWith('dnd_') || key.startsWith('DateNight_'))) {
            throw new Error('Namespaced localStorage key remains after clearing: ' + key);
          }
        }
        diagnostics.localStorageCleared = true;

        clearCurrentTabSessionStorage();
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key && (key.startsWith('dnd_') || key.startsWith('DateNight_'))) {
            throw new Error('Namespaced sessionStorage key remains after clearing: ' + key);
          }
        }
        diagnostics.sessionStorageCleared = true;

        // Record the new generation before removing the marker; all following
        // steps are synchronous, so no ordinary task can write in between.
        observedStateGeneration = targetGeneration;
        // Persist completion before removing the legacy marker. A restart
        // can then finalize this same reset without clearing data twice.
        journal.phase = 'complete';
        const completedJournalText = JSON.stringify(journal);
        localStorage.setItem(DND_RESET_JOURNAL_KEY, completedJournalText);
        if (localStorage.getItem(DND_RESET_JOURNAL_KEY) !== completedJournalText) {
          throw new Error('Completed reset journal could not be verified.');
        }

        if (!finalizeRecoveryMarker()) {
          throw new Error('Reset data was cleared, but the recovery marker could not be finalized.');
        }
        setResetState(false);
        diagnostics.resetCompleted = true;
      } catch (err) {
        diagnostics.errors.push('Reset incomplete; recovery remains required: ' + (err.message || err));
        if (!hasPendingResetMarker()) setResetState(false);
      }
      return diagnostics;
    });
  } catch (err) {
    diagnostics.errors.push('Could not acquire the exclusive reset lock: ' + (err.message || err));
    if (!hasPendingResetMarker()) setResetState(false);
    return diagnostics;
  }
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
    const journalText = localStorage.getItem(DND_RESET_JOURNAL_KEY);
    if (!isCompletedResetJournal(journalText)) return false;

    localStorage.removeItem(DND_RESET_MARKER);
    return localStorage.getItem(DND_RESET_MARKER) === null &&
      localStorage.getItem(DND_RESET_JOURNAL_KEY) === journalText;
  } catch (err) {
    console.error('Failed to finalize recovery marker:', err);
    return false;
  }
}

function isCompletedResetJournal(journalText) {
  if (typeof journalText !== 'string') return false;

  try {
    const journal = JSON.parse(journalText);
    return Boolean(
      journal &&
      journal.version === 1 &&
      typeof journal.resetId === 'string' &&
      journal.resetId.length > 0 &&
      Number.isSafeInteger(journal.baseGeneration) &&
      journal.baseGeneration >= 0 &&
      Number.isSafeInteger(journal.targetGeneration) &&
      journal.targetGeneration === journal.baseGeneration + 1 &&
      journal.phase === 'complete'
    );
  } catch (_) {
    return false;
  }
}

function hasPendingResetMarker() {
  try {
    if (localStorage.getItem(DND_RESET_MARKER) !== null) return true;

    const journalText = localStorage.getItem(DND_RESET_JOURNAL_KEY);
    if (journalText === null) return false;

    return !isCompletedResetJournal(journalText);
  } catch (_) {
    return true;
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
