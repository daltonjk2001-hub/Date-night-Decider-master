#!/usr/bin/env python3
"""Apply the Date Night Decider reset/storage hardening package to a repository checkout.

Run from any directory with: python path/to/apply_hardening.py /path/to/repo
The script makes timestamped .pre-hardening backups before changing files.
"""
from __future__ import annotations
import argparse
import datetime as _dt
import pathlib
import shutil
import subprocess
import sys
import tempfile


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match for {label}; found {count}. No files were written.")
    return text.replace(old, new, 1)


def replace_region(text: str, start: str, end: str, replacement: str, label: str) -> str:
    first = text.find(start)
    if first < 0:
        raise RuntimeError(f"Could not find start marker for {label}. No files were written.")
    last = text.find(end, first + len(start))
    if last < 0:
        raise RuntimeError(f"Could not find end marker for {label}. No files were written.")
    return text[:first] + replacement.rstrip() + "\n\n" + text[last:]


def apply_patch(repo: pathlib.Path, package: pathlib.Path) -> list[str]:
    expected = ["index.html", "app.js", "db.js", "p2p.js", "ui.js", "service-worker.js"]
    missing = [name for name in expected if not (repo / name).is_file()]
    if missing:
        raise RuntimeError("Repository checkout is missing required files: " + ", ".join(missing))

    # Build every replacement in memory first. A marker mismatch leaves the checkout untouched.
    app = (repo / "app.js").read_text(encoding="utf-8")
    p2p = (repo / "p2p.js").read_text(encoding="utf-8")
    ui = (repo / "ui.js").read_text(encoding="utf-8")
    index = (repo / "index.html").read_text(encoding="utf-8")
    sw = (repo / "service-worker.js").read_text(encoding="utf-8")
    db = (package / "payload" / "db.js").read_text(encoding="utf-8")
    coordinator = (package / "payload" / "app-reset-coordinator.js.txt").read_text(encoding="utf-8")
    asset_test = (package / "payload" / "tests" / "check-local-assets.mjs").read_text(encoding="utf-8")
    workflow = (package / "payload" / ".github" / "workflows" / "source-integrity.yml").read_text(encoding="utf-8")

    # Route the existing user-facing Clear Application Data flow through the coordinator.
    app = replace_region(
        app,
        "async function executeClearAllData({ broadcast = true } = {}) {",
        "function triggerConfetti() {",
        "async function executeClearAllData() {\n  return executeMasterReset();\n}",
        "clear-data entry point"
    )

    # Keep theme application usable during reset without recreating a preference record.
    app = replace_once(app, "async function applyTheme(theme) {", "async function applyTheme(theme, options = {}) {", "applyTheme signature")
    app = replace_once(
        app,
        "  if (!storageFailed && db) {\n    try { await db.settings.put({ key: 'appSettings', value: appSettings }); }\n    catch (err) { console.error('Could not save theme:', err); }\n  }",
        "  if (options.persist !== false && !storageFailed && db) {\n    try { await db.settings.put({ key: 'appSettings', value: appSettings }); }\n    catch (err) { console.error('Could not save theme:', err); }\n  }",
        "non-persistent reset theme"
    )

    # Force multi-table backup imports to hold one shared-write lock for the whole transaction.
    app = replace_once(
        app,
        """await db.transaction(
          'rw',
          db.settings,
          db.customDeck,
          db.deletedBuiltins,
          db.categories,
          db.history,
          db.unlocks,
          async () => {""",
        """await window.DNDStorage.withDatabaseTransaction(
          [db.settings, db.customDeck, db.deletedBuiltins, db.categories, db.history, db.unlocks],
          async () => {""",
        "backup-import transaction guard"
    )

    # Install the complete reset protocol where the old post-clear notification handler lived.
    app = replace_region(
        app,
        "let dataResetChannel = null;",
        "function handleIncomingInviteFromUrl() {",
        coordinator,
        "cross-tab reset coordinator"
    )

    # Do not load stale state before database initialization or while crash recovery is pending.
    app = replace_once(
        app,
        """  loadAppData()
    .then(() => handleIncomingInviteFromUrl())
    .catch(error => console.error('App initialization failed:', error));""",
        """  document.documentElement.dataset.appInitializing = 'true';
  Promise.resolve(window.dbReady).then(async () => {
    if (window.DNDStorage && window.DNDStorage.hasPendingResetMarker()) {
      delete document.documentElement.dataset.appInitializing;
      setResetState(true);
      disableUserInteraction();
      renderRecoveryOverlay({ errors: ['A previous reset was interrupted. Retry recovery before continuing.'] });
      return;
    }
    if (window.DNDStorage && typeof window.DNDStorage.captureCurrentGeneration === 'function') {
      window.DNDStorage.captureCurrentGeneration();
    }
    await loadAppData();
    delete document.documentElement.dataset.appInitializing;
    handleIncomingInviteFromUrl();
  }).catch(error => {
    delete document.documentElement.dataset.appInitializing;
    console.error('App initialization failed:', error);
  });""",
        "database-ready startup gate"
    )

    # Block swipe actions invoked by pointer/keyboard handlers outside delegated button clicks.
    app = replace_once(
        app,
        "function handleSwipe(liked) {",
        "function handleSwipe(liked) {\n  if (document.documentElement.dataset.resetInProgress === 'true' || document.documentElement.dataset.appInitializing === 'true') return;\n  if (window.DNDStorage && (!window.DNDStorage.isCurrentGeneration() || window.DNDStorage.hasPendingResetMarker())) { window.location.reload(); return; }",
        "swipe reset guard"
    )

    # P2P tracking. The data callback body is preserved, but its async branches are awaited and tracked.
    p2p = replace_once(
        p2p,
        "let connectionRecoveryAttempts = 0;",
        "let connectionRecoveryAttempts = 0;\nlet isP2PQuiescing = false;\nconst activeAsyncOperations = new Set();",
        "P2P operation tracker state"
    )

    p2p = replace_once(
        p2p,
        "function sendP2PMessage(payload) {",
        """function trackAsyncOperation(promise) {
  const tracked = Promise.resolve(promise);
  activeAsyncOperations.add(tracked);
  tracked.then(
    () => activeAsyncOperations.delete(tracked),
    () => activeAsyncOperations.delete(tracked)
  );
  return tracked;
}

async function terminateP2PSession(notifyPeer = true, drainTimeoutMs = 1500) {
  isP2PQuiescing = true;
  if (p2HeartbeatTimer) { window.clearInterval(p2HeartbeatTimer); p2HeartbeatTimer = null; }
  if (connectionRecoveryTimer) { window.clearTimeout(connectionRecoveryTimer); connectionRecoveryTimer = null; }
  if (notifyPeer && conn && conn.open) {
    try { conn.send({ type: 'PEER_SESSION_TERMINATED' }); } catch (err) { console.warn('P2P termination notice failed:', err); }
  }
  const startedAt = Date.now();
  while (activeAsyncOperations.size > 0 && Date.now() - startedAt < drainTimeoutMs) {
    await new Promise(resolve => window.setTimeout(resolve, 25));
  }
  const drained = activeAsyncOperations.size === 0;
  // Always attempt transport teardown, even when draining timed out.
  cleanupPeerConnection();
  return drained;
}

function resumeP2PSession() { isP2PQuiescing = false; }
window.terminateP2PSession = terminateP2PSession;
window.resumeP2PSession = resumeP2PSession;
window.cleanupPeerConnection = cleanupPeerConnection;

function sendP2PMessage(payload) {""",
        "P2P shutdown and draining APIs"
    )

    # Find and wrap the existing full incoming-message handler without replacing its gameplay branches.
    handler_start = "  thisConn.on('data', message => {"
    handler_end = "\n  });"
    handler_following = "\n\n  thisConn.on('open', () => {"
    start_idx = p2p.find(handler_start)
    if start_idx < 0:
        raise RuntimeError("Could not find P2P data handler. No files were written.")
    end_idx = p2p.find(handler_end + handler_following, start_idx + len(handler_start))
    if end_idx < 0:
        raise RuntimeError("Could not find P2P data-handler terminator. No files were written.")
    body = p2p[start_idx + len(handler_start):end_idx]
    wrapped = (
        handler_start +
        "\n    if (isP2PQuiescing || (typeof getResetState === 'function' && getResetState())) return;" +
        "\n    const operation = (async () => {" + body +
        "\n    })();\n    trackAsyncOperation(operation.catch(error => { console.error('P2P message handler failed:', error); }));" +
        "\n  });"
    )
    # Preserve the following connection-open handler; remove only the old data-handler close.
    p2p = p2p[:start_idx] + wrapped + p2p[end_idx + len(handler_end):]

    p2p = replace_once(
        p2p,
        """      persistHistoryEntry(incomingEntry, true)
        .then(saved => {
          const ok = Boolean(saved);
          sendP2PMessage({ type: 'COMPLETE_DATE_ACK', syncId: incomingEntry.syncId, ok });
          if (ok) closeModal();
        })
        .catch(() => sendP2PMessage({ type: 'COMPLETE_DATE_ACK', syncId: incomingEntry.syncId, ok: false }));""",
        """      try {
        const saved = await persistHistoryEntry(incomingEntry, true);
        const ok = Boolean(saved);
        sendP2PMessage({ type: 'COMPLETE_DATE_ACK', syncId: incomingEntry.syncId, ok });
        if (ok) closeModal();
      } catch (_) {
        sendP2PMessage({ type: 'COMPLETE_DATE_ACK', syncId: incomingEntry.syncId, ok: false });
      }""",
        "await host history persistence"
    )
    p2p = replace_once(
        p2p,
        """        persistHistoryEntry(entry, false)
          .then(() => { closeModal(); showToast('Date completion confirmed and saved.'); })
          .catch(() => showToast('Could not save confirmed date locally.'));""",
        """        try {
          await persistHistoryEntry(entry, false);
          closeModal();
          showToast('Date completion confirmed and saved.');
        } catch (_) {
          showToast('Could not save confirmed date locally.');
        }""",
        "await guest history persistence"
    )
    p2p = replace_once(
        p2p,
        "      receiveHistoryEntry(message.entry).catch(err => console.error('Could not receive history entry:', err));",
        "      await receiveHistoryEntry(message.entry).catch(err => console.error('Could not receive history entry:', err));",
        "await received history entry persistence"
    )
    p2p = replace_once(
        p2p,
        "    if (!message || typeof message !== 'object') return;\n\n    if (message.type === 'PING') {",
        "    if (!message || typeof message !== 'object') return;\n\n    if (message.type === 'PEER_SESSION_TERMINATED') { cleanupPeerConnection(); return; }\n    if (message.type === 'PING') {",
        "peer termination message handling"
    )
    # Allow the peer engine to be restarted after a reset was safely aborted.
    p2p = replace_once(p2p, "async function startP2PServer(presetCode = null) {", "async function startP2PServer(presetCode = null) {\n  if (typeof getResetState === 'function' && getResetState()) return;\n  isP2PQuiescing = false;", "host reset-state guard")
    p2p = replace_once(p2p, "async function joinP2PServer(presetCode = null) {", "async function joinP2PServer(presetCode = null) {\n  if (typeof getResetState === 'function' && getResetState()) return;\n  isP2PQuiescing = false;", "join reset-state guard")

    # A reset overlay is not actionable through the regular delegated UI event path.
    ui = replace_once(
        ui,
        "function runDelegatedAction(element, event, kind) {",
        "function runDelegatedAction(element, event, kind) {\n  if (document.documentElement.dataset.resetInProgress === 'true' || document.documentElement.dataset.appInitializing === 'true') return;\n  if (window.DNDStorage && !window.DNDStorage.isCurrentGeneration()) { window.location.reload(); return; }",
        "delegated UI reset guard"
    )

    # Force a fresh fetch of patched files on the next deployment while retaining classic-script semantics.
    index = index.replace('3.4.3-hotfix1', '3.4.3-hotfix1-reset-hardening')
    sw = sw.replace('3.4.3-hotfix1', '3.4.3-hotfix1-reset-hardening')

    # Validate all code before modifying the checkout.
    targets = {
        'db.js': db,
        'app.js': app,
        'p2p.js': p2p,
        'ui.js': ui,
        'index.html': index,
        'service-worker.js': sw,
        'tests/check-local-assets.mjs': asset_test,
        '.github/workflows/source-integrity.yml': workflow,
    }
    node = shutil.which('node')
    if node:
        with tempfile.TemporaryDirectory(prefix='dnd-hardening-check-') as temporary_dir:
            temporary_root = pathlib.Path(temporary_dir)
            for filename, new_content in targets.items():
                if filename.endswith(('.js', '.mjs')):
                    candidate = temporary_root / filename
                    candidate.parent.mkdir(parents=True, exist_ok=True)
                    candidate.write_text(new_content, encoding='utf-8', newline='\n')
            for filename in ('db.js', 'app.js', 'p2p.js', 'ui.js', 'service-worker.js', 'tests/check-local-assets.mjs'):
                result = subprocess.run([node, '--check', str(temporary_root / filename)], capture_output=True, text=True)
                if result.returncode != 0:
                    raise RuntimeError('Node syntax check failed for ' + filename + ':\n' + result.stderr)

    # All markers and syntax checks passed; preserve the originals before writing.
    stamp = _dt.datetime.now().strftime('%Y%m%d-%H%M%S')
    changed = []
    for filename, new_content in targets.items():
        path = repo / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            backup = path.with_name(path.name + '.pre-hardening-' + stamp)
            shutil.copy2(path, backup)
        path.write_text(new_content, encoding='utf-8', newline='\n')
        changed.append(filename)
    return changed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('repo', nargs='?', default='.', help='Path to a checkout of Date-night-Decider-master')
    args = parser.parse_args()
    repo = pathlib.Path(args.repo).resolve()
    package = pathlib.Path(__file__).resolve().parent
    try:
        changed = apply_patch(repo, package)
    except Exception as err:
        print('FAILED:', err, file=sys.stderr)
        return 1
    print('Updated files:', ', '.join(changed))
    print('Backups were created beside each edited file. This applies source changes only; it does not deploy or prove browser-level correctness.')
    print('Note: the asset-integrity workflow may fail until missing vendor, store, adapter, and icon assets are restored or obsolete references are removed.')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
