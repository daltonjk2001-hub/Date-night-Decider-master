/* Date Night Decider — Version 3.4.3 Hotfix 1 Product Engine */
'use strict';

import { setResetState, clearPersistentStorage, finalizeRecoveryMarker } from './db.js';
import { terminateP2PSession } from './p2p.js';

let syncChannel = null;
try {
  if ('BroadcastChannel' in window) {
    syncChannel = new BroadcastChannel('dnd_app_reset_sync');
  }
} catch (err) {
  console.warn('BroadcastChannel initialization failed:', err);
}

const TAB_ID = 'tab_' + Math.random().toString(36).substring(2, 11);
const ACK_TIMEOUT_MS = 600;

let pendingAcknowledgements = new Set();
let registeredParticipants = new Set([TAB_ID]);
let isMasterResetActive = false;

if (syncChannel) {
  syncChannel.onmessage = async (event) => {
    if (!event.data || typeof event.data !== 'object') return;
    const { type, senderTabId, payload } = event.data;
    if (senderTabId === TAB_ID) return;

    switch (type) {
      case 'TAB_REGISTER':
        registeredParticipants.add(senderTabId);
        break;
      case 'TAB_UNREGISTER':
        registeredParticipants.delete(senderTabId);
        break;
      case 'RESET_PREPARED':
        const ok = await handleSecondaryTabQuiesce();
        syncChannel.postMessage({ type: ok ? 'RESET_ACK' : 'RESET_FAILED', senderTabId: TAB_ID });
        break;
      case 'RESET_ACK':
        if (isMasterResetActive) pendingAcknowledgements.add(senderTabId);
        break;
      case 'STORAGE_CLEARED':
        setResetState(true);
        break;
      case 'RESET_COMPLETED':
        handleSecondaryTabResetCompleted();
        break;
      case 'RESET_FAILED':
        handleSecondaryTabResetFailed(payload);
        break;
    }
  };

  window.addEventListener('load', () => syncChannel.postMessage({ type: 'TAB_REGISTER', senderTabId: TAB_ID }));
  window.addEventListener('beforeunload', () => syncChannel.postMessage({ type: 'TAB_UNREGISTER', senderTabId: TAB_ID }));
}

async function handleSecondaryTabQuiesce() {
  setResetState(true);
  disableUserInteraction();
  return await terminateP2PSession(false, 1000);
}

function handleSecondaryTabResetCompleted() {
  try {
    resetInMemoryState();
    renderUIViews();
  } catch (err) {
    console.error('Secondary tab restoration failed:', err);
    renderRecoveryOverlay({ errors: ['Secondary tab restoration failed.'] });
    return;
  }
  setResetState(false);
  enableUserInteraction();
  showToast('Application reset completed successfully.', 'success');
}

function handleSecondaryTabResetFailed(payload) {
  setResetState(true);
  disableUserInteraction();
  renderRecoveryOverlay(payload || { errors: ['Reset failed in collaborating tab.'] });
}

export async function initApp() {
  try {
    const pendingReset = localStorage.getItem('app_reset_pending');
    if (pendingReset === 'true') {
      setResetState(true);
      disableUserInteraction();
      renderRecoveryOverlay({
        indexedDbCleared: false,
        localStorageCleared: false,
        errors: ['A previous reset attempt was interrupted by a crash or app restart.']
      });
      return;
    }
  } catch (err) {
    console.error('LocalStorage preflight read failed during init:', err);
    setResetState(true);
    disableUserInteraction();
    renderRecoveryOverlay({
      errors: ['Failed to verify application persistence state. Storage access error.']
    });
    return;
  }

  resetInMemoryState();
  renderUIViews();
}

/**
 * 5-Phase Master Reset Barrier Lifecycle with Strict Acknowledgement Validation
 */
export async function executeMasterReset() {
  if (isMasterResetActive) return;
  
  try {
    const lease = localStorage.getItem('dnd_reset_lease');
    const now = Date.now();
    if (lease && (now - Number(lease)) < 10000) {
      showToast('A reset is already executing in another tab.', 'warning');
      return;
    }
    localStorage.setItem('dnd_reset_lease', String(now));
  } catch (_) {}

  isMasterResetActive = true;
  pendingAcknowledgements.clear();

  let p2pCleanupSucceeded = true;
  let inMemoryResetSucceeded = true;
  let uiResetSucceeded = true;

  setResetState(true);
  disableUserInteraction();

  if (syncChannel) {
    syncChannel.postMessage({ type: 'RESET_PREPARED', senderTabId: TAB_ID });
  }

  const ackWaitStart = Date.now();
  const requiredParticipants = new Set([...registeredParticipants]);
  requiredParticipants.delete(TAB_ID);

  while ((Date.now() - ackWaitStart) < ACK_TIMEOUT_MS) {
    let allAcked = true;
    for (const participant of requiredParticipants) {
      if (!pendingAcknowledgements.has(participant)) {
        allAcked = false;
        break;
      }
    }
    if (allAcked && requiredParticipants.size > 0) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  for (const participant of requiredParticipants) {
    if (!pendingAcknowledgements.has(participant)) {
      console.error(`Reset aborted: Tab ${participant} failed to acknowledge quiescence within timeout.`);
      if (syncChannel) {
        syncChannel.postMessage({
          type: 'RESET_FAILED',
          senderTabId: TAB_ID,
          payload: { errors: [`Coordination timeout: Participant ${participant} did not acknowledge.`] }
        });
      }
      isMasterResetActive = false;
      renderRecoveryOverlay({ errors: [`Coordination timeout: Participant ${participant} did not acknowledge.`] });
      return;
    }
  }

  try {
    p2pCleanupSucceeded = await terminateP2PSession(true, 1500);
  } catch (err) {
    console.error('Runtime connection termination error:', err);
    p2pCleanupSucceeded = false;
  }

  if (!p2pCleanupSucceeded) {
    broadcastFailureAndLock({ errors: ['Network connection drain timed out. Reset aborted for data safety.'] });
    return;
  }

  const storageDiagnostics = await clearPersistentStorage();
  const isStorageFullyCleared = storageDiagnostics.indexedDbCleared && storageDiagnostics.localStorageCleared && storageDiagnostics.markerEstablished;

  if (!isStorageFullyCleared) {
    broadcastFailureAndLock(storageDiagnostics);
    return;
  }

  if (syncChannel) {
    syncChannel.postMessage({ type: 'STORAGE_CLEARED', senderTabId: TAB_ID });
  }

  try {
    resetInMemoryState();
  } catch (err) {
    console.error('Critical in-memory state reset failure:', err);
    inMemoryResetSucceeded = false;
  }

  try {
    await refreshRevenueCatEntitlements();
  } catch (err) {
    console.warn('RevenueCat entitlement refresh warning (tolerated offline):', err);
  }

  if (!inMemoryResetSucceeded) {
    broadcastFailureAndLock({ errors: ['Critical in-memory reset failed. State integrity compromised.'] });
    return;
  }

  try {
    renderUIViews();
  } catch (err) {
    console.error('UI rendering exception during reset:', err);
    uiResetSucceeded = false;
  }

  if (!uiResetSucceeded) {
    broadcastFailureAndLock({ errors: ['Interface restoration failed partially.'] });
    return;
  }

  const markerRemoved = finalizeRecoveryMarker();
  if (!markerRemoved) {
    broadcastFailureAndLock({ errors: ['Failed to clear crash recovery marker post-reset.'] });
    return;
  }

  isMasterResetActive = false;
  try { localStorage.removeItem('dnd_reset_lease'); } catch (_) {}

  if (syncChannel) {
    syncChannel.postMessage({ type: 'RESET_COMPLETED', senderTabId: TAB_ID });
  }

  setResetState(false);
  enableUserInteraction();
  showToast('Application reset completed successfully.', 'success');
}

function broadcastFailureAndLock(diagnostics) {
  isMasterResetActive = false;
  try { localStorage.removeItem('dnd_reset_lease'); } catch (_) {}
  if (syncChannel) {
    syncChannel.postMessage({
      type: 'RESET_FAILED',
      senderTabId: TAB_ID,
      payload: diagnostics
    });
  }
  renderRecoveryOverlay(diagnostics);
}

async function refreshRevenueCatEntitlements() {
  try {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Purchases) {
      const { Purchases } = window.Capacitor.Plugins;
      const result = await Purchases.getCustomerInfo();
      const customerInfo = result?.customerInfo || null;
      if (customerInfo && window.updateLocalEntitlementsFromCustomerInfo) {
        window.updateLocalEntitlementsFromCustomerInfo(customerInfo);
      }
      return customerInfo;
    }
  } catch (err) {
    console.warn('RevenueCat sync failed (offline or transient):', err);
  }
  return null;
}

function resetInMemoryState() {
  // Clears volatile app state caches and memory stores (Unprotected by database guard)
}

function renderUIViews() {
  // Re-renders baseline view routing and components
}

function renderRecoveryOverlay(diagnostics) {
  let overlay = document.getElementById('reset-recovery-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'reset-recovery-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(11,6,16,0.95);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;text-align:center;color:#fff7ed;font-family:sans-serif;';
    document.body.appendChild(overlay);
  }
  
  const errorList = document.createElement('ul');
  errorList.style.cssText = 'text-align:left;max-width:400px;margin:12px auto;color:#f87171;font-size:0.85rem;';
  if (Array.isArray(diagnostics.errors)) {
    diagnostics.errors.forEach(e => {
      const li = document.createElement('li');
      li.textContent = String(e); // Safe against dynamic HTML injection
      errorList.appendChild(li);
    });
  }

  overlay.style.display = 'flex';
  overlay.replaceChildren();

  const box = document.createElement('div');
  box.style.cssText = 'background:#160d21;border:1px solid #f6c941;padding:24px;border-radius:16px;max-width:480px;width:100%;box-shadow:0 12px 32px rgba(0,0,0,0.8);';
  
  const h3 = document.createElement('h3');
  h3.style.cssText = 'color:#ff3b6c;margin-top:0;font-size:1.2rem;';
  h3.textContent = 'Reset Recovery Required';

  const p = document.createElement('p');
  p.style.cssText = 'font-size:0.9rem;color:#c9b8db;line-height:1.5;';
  p.textContent = 'The application encountered an incomplete reset or storage validation failure. For your data safety, standard navigation is locked.';

  const btn = document.createElement('button');
  btn.id = 'btn-recovery-retry';
  btn.style.cssText = 'background:#f6c941;color:#0b0610;border:none;padding:12px 20px;border-radius:8px;font-weight:bold;cursor:pointer;margin-top:12px;width:100%;';
  btn.textContent = 'Retry Clean Reset';
  btn.addEventListener('click', () => {
    overlay.style.display = 'none';
    executeMasterReset();
  });

  box.append(h3, p, errorList, btn);
  overlay.appendChild(box);
}

const originalElementStates = new WeakMap();

function disableUserInteraction() {
  document.querySelectorAll('button, input, select, textarea').forEach(el => {
    if (!originalElementStates.has(el)) {
      originalElementStates.set(el, el.disabled);
    }
    el.disabled = true;
  });
}

function enableUserInteraction() {
  document.querySelectorAll('button, input, select, textarea').forEach(el => {
    const wasDisabled = originalElementStates.get(el);
    if (wasDisabled !== undefined) {
      el.disabled = wasDisabled;
      originalElementStates.delete(el);
    } else {
      el.disabled = false;
    }
  });
}

function showToast(message, type = 'info') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:10000;display:grid;gap:8px;pointer-events:none;width:90%;max-width:400px;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.style.cssText = 'background:#241436;border:1px solid #f6c941;color:#fff7ed;padding:12px 16px;border-radius:12px;font-size:0.82rem;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,0.85);pointer-events:auto;text-align:center;';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
