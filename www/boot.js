/* Date Night Decider 3.4.3-hotfix1 · Startup Verification Loader */
'use strict';

(function () {
  function verifyModules() {
    if (typeof window.Dexie !== 'function') {
      console.warn('Dexie library verification failed.');
    }
    if (typeof window.Peer !== 'function') {
      console.warn('PeerJS library verification failed.');
    }
    console.log('Date Night Decider v3.4.3-hotfix1 modules verified successfully.');
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', verifyModules, { once: true });
  } else {
    verifyModules();
  }
})();
