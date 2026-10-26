/* Date Night Decider device bridge.
 * Safe browser fallbacks are built in. Capacitor plugins are optional and are
 * only called when their public API is present; this file contains no secrets.
 */
'use strict';

(function installDeviceAdapter(window) {
  if (!window || window.DeviceAdapter) return;

  function getAppPlugin() {
    const capacitor = window.Capacitor;
    if (!capacitor) return null;
    return (capacitor.Plugins && capacitor.Plugins.App) || capacitor.App || null;
  }

  function getSplashPlugin() {
    const capacitor = window.Capacitor;
    if (!capacitor) return null;
    return (capacitor.Plugins && capacitor.Plugins.SplashScreen) || capacitor.SplashScreen || null;
  }

  async function shareText(title, text, url) {
    const safeTitle = typeof title === 'string' ? title.slice(0, 160) : 'Date Night Decider';
    const safeText = typeof text === 'string' ? text.slice(0, 4000) : '';
    const safeUrl = typeof url === 'string' ? url.slice(0, 2048) : '';

    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        const shareData = { title: safeTitle, text: safeText };
        if (safeUrl) shareData.url = safeUrl;
        await navigator.share(shareData);
        return { success: true, method: 'share' };
      } catch (error) {
        if (error && error.name === 'AbortError') {
          return { success: false, canceled: true, method: 'share' };
        }
        console.warn('[Date Night Decider] System sharing is unavailable; trying clipboard.', error);
      }
    }

    if (typeof navigator !== 'undefined' && navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
      try {
        const clipboardText = [safeText, safeUrl].filter(Boolean).join('\n');
        await navigator.clipboard.writeText(clipboardText);
        return { success: true, method: 'clipboard' };
      } catch (error) {
        console.warn('[Date Night Decider] Clipboard access was denied.', error);
      }
    }

    return { success: false, method: 'unavailable' };
  }

  function registerBackButtonHandler(callback) {
    if (typeof callback !== 'function') return () => {};

    const appPlugin = getAppPlugin();
    if (appPlugin && typeof appPlugin.addListener === 'function') {
      let disposed = false;
      let listenerHandle = null;
      Promise.resolve()
        .then(() => appPlugin.addListener('backButton', () => {
          try { callback(); }
          catch (error) { console.error('[Date Night Decider] Back-button handler failed.', error); }
        }))
        .then(handle => {
          listenerHandle = handle;
          if (disposed && listenerHandle && typeof listenerHandle.remove === 'function') {
            return listenerHandle.remove();
          }
          return undefined;
        })
        .catch(error => console.warn('[Date Night Decider] Native back-button listener is unavailable.', error));

      return () => {
        disposed = true;
        if (listenerHandle && typeof listenerHandle.remove === 'function') {
          Promise.resolve(listenerHandle.remove()).catch(error => console.warn('Could not remove back-button listener.', error));
        }
      };
    }

    // Browser fallback: Escape closes the active dialog without interfering
    // with text fields or relying on platform-specific back-key behavior.
    const onKeydown = event => {
      if (event.key !== 'Escape') return;
      try { callback(); }
      catch (error) { console.error('[Date Night Decider] Escape-key handler failed.', error); }
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  }

  async function hideSplashScreen() {
    const splashPlugin = getSplashPlugin();
    if (!splashPlugin || typeof splashPlugin.hide !== 'function') return false;
    try {
      await splashPlugin.hide();
      return true;
    } catch (error) {
      console.warn('[Date Night Decider] Native splash screen could not be hidden.', error);
      return false;
    }
  }

  async function triggerHaptic(type = 'light', enabled = true) {
    if (enabled === false) return false;

    try {
      const capacitor = window.Capacitor;
      const haptics = capacitor &&
        ((capacitor.Plugins && capacitor.Plugins.Haptics) ||
         capacitor.Haptics);

      if (haptics && type === 'success' &&
          typeof haptics.notification === 'function') {
        await haptics.notification({ type: 'SUCCESS' });
        return true;
      }

      if (haptics && typeof haptics.impact === 'function') {
        const style =
          type === 'heavy' ? 'HEAVY' :
          (type === 'medium' || type === 'success') ? 'MEDIUM' :
          'LIGHT';

        await haptics.impact({ style });
        return true;
      }

      if (haptics && typeof haptics.vibrate === 'function') {
        await haptics.vibrate({
          duration: type === 'heavy' ? 40 : 15
        });
        return true;
      }

      if (window.navigator &&
          typeof window.navigator.vibrate === 'function') {
        const pattern = type === 'success'
          ? [15, 25, 15]
          : type === 'heavy' ? 40 : 10;

        return Boolean(window.navigator.vibrate(pattern));
      }
    } catch (error) {
      console.warn(
        '[Date Night Decider] Haptic feedback is unavailable.',
        error
      );
    }

    return false;
  }

  function isNativePlatform() {
    const capacitor = window.Capacitor;
    if (!capacitor) return false;
    try {
      if (typeof capacitor.isNativePlatform === 'function') return Boolean(capacitor.isNativePlatform());
      return Boolean(capacitor.isNative);
    } catch (_) {
      return false;
    }
  }

  window.DeviceAdapter = Object.freeze({
    triggerHaptic,
    shareText,
    registerBackButtonHandler,
    hideSplashScreen,
    isNativePlatform
  });
})(window);
