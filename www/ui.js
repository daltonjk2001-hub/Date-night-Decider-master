/* Date Night Decider v3.4.3 Hotfix 1 · delegated actions / accessibility */
'use strict';

const DELEGATED_ACTION_ALLOWLIST = new Set([
  'switchGame','setAllCategories','applyPackFilter','applyCategoryFilter','applyTheme','saveFeedbackSettings',
  'startP2PServer','joinP2PServer','copyInviteLink','leaveLiveRoom','restorePurchases','exportBackup','clearAllData',
  'openLegalModal','handleSwipe','surpriseMe','restartMatcherAfterNoMatch','requestPackAdjustment','startSelectedDate',
  'completeCurrentDate','openCurrentCardMap','downloadCalendarEvent','closeModal','actionFromPreviewModal','closeStorePreview',
  'setRating','saveLoggedDate','closeLogDateModal','generateAndDownloadCalendar','closeCalendarModal',
  'switchLiveRoomTab','generateNewHostCode','confirmStartHost','confirmJoinRoom','closeLiveRoomModal',
  'handleConfirmYes','closeConfirmModal','switchLegalTab','closeLegalModal','renderLibrary','importBackupFile','triggerImportPicker'
]);

function runDelegatedAction(element, event, kind) {
  const actionName = element.getAttribute(`data-${kind}-action`);
  if (!actionName || !DELEGATED_ACTION_ALLOWLIST.has(actionName)) return;
  if (element.dataset.stopPropagation === 'true') event.stopPropagation();
  let args = [];
  const rawArgs = element.getAttribute(`data-${kind}-args`);
  if (rawArgs) {
    try { args = JSON.parse(rawArgs); }
    catch (_) { console.error('Invalid delegated action arguments.'); return; }
  }
  args = args.map(value => value === '$this' ? element : value === '$event' ? event : value === '$value' ? element.value : value);
  try {
    if (actionName === 'triggerImportPicker') {
      document.getElementById(element.dataset.target || 'importBackup')?.click();
      return;
    }
    const action = window[actionName];
    if (typeof action !== 'function') {
      console.error(`App action is unavailable: ${actionName}`);
      return;
    }
    const result = action(...args);
    if (result && typeof result.catch === 'function') result.catch(error => console.error(`Action ${actionName} failed:`, error));
  } catch (error) {
    console.error(`Action ${actionName} failed:`, error);
  }
}

function installDelegatedActions() {
  if (document.documentElement.dataset.actionsInstalled === 'true') return;
  document.documentElement.dataset.actionsInstalled = 'true';
  document.addEventListener('click', event => {
    const element = event.target && event.target.closest ? event.target.closest('[data-click-action]') : null;
    if (element) runDelegatedAction(element, event, 'click');
  });
  document.addEventListener('change', event => {
    const element = event.target && event.target.closest ? event.target.closest('[data-change-action]') : null;
    if (element) runDelegatedAction(element, event, 'change');
  });
  document.addEventListener('input', event => {
    const element = event.target && event.target.closest ? event.target.closest('[data-input-action]') : null;
    if (element) runDelegatedAction(element, event, 'input');
  });
}

let activeFocusModal = null;
let focusBeforeModal = null;
const MODAL_CLOSE_ACTIONS = {
  decisionModal: 'closeModal', storePreviewModal: 'closeStorePreview', logDateModal: 'closeLogDateModal',
  calendarModal: 'closeCalendarModal', liveRoomModal: 'closeLiveRoomModal', confirmModal: 'closeConfirmModal',
  legalModal: 'closeLegalModal'
};
function visibleModals() {
  return [...document.querySelectorAll('.modal-overlay.show')];
}
function focusableModalElements(modal) {
  return [...modal.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter(item => item.getAttribute('aria-hidden') !== 'true' && item.offsetParent !== null);
}
function closeTopModal() {
  const modal = visibleModals().at(-1);
  if (!modal) return;
  const actionName = MODAL_CLOSE_ACTIONS[modal.id];
  if (actionName && typeof window[actionName] === 'function') window[actionName]();
  else modal.classList.remove('show');
}
function installModalAccessibility() {
  if (document.documentElement.dataset.modalAccessInstalled === 'true') return;
  document.documentElement.dataset.modalAccessInstalled = 'true';
  const observer = new MutationObserver(records => {
    for (const record of records) {
      const modal = record.target;
      if (!(modal instanceof HTMLElement) || !modal.classList.contains('modal-overlay')) continue;
      if (modal.classList.contains('show')) {
        const opened = visibleModals().at(-1);
        if (opened !== activeFocusModal) {
          activeFocusModal = opened;
          focusBeforeModal = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          const focusable = opened ? focusableModalElements(opened) : [];
          if (focusable.length) window.setTimeout(() => focusable[0].focus(), 0);
        }
      } else if (modal === activeFocusModal) {
        activeFocusModal = visibleModals().at(-1) || null;
        if (activeFocusModal) {
          const focusable = focusableModalElements(activeFocusModal);
          if (focusable.length) window.setTimeout(() => focusable[0].focus(), 0);
        } else if (focusBeforeModal && document.contains(focusBeforeModal)) {
          window.setTimeout(() => focusBeforeModal.focus(), 0);
          focusBeforeModal = null;
        }
      }
    }
  });
  document.querySelectorAll('.modal-overlay').forEach(modal => observer.observe(modal, { attributes: true, attributeFilter: ['class'] }));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && visibleModals().length) {
      event.preventDefault();
      closeTopModal();
      return;
    }
    if (event.key !== 'Tab') return;
    const modal = visibleModals().at(-1);
    if (!modal) return;
    const items = focusableModalElements(modal);
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}

installDelegatedActions();
installModalAccessibility();
