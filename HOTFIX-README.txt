DATE NIGHT DECIDER V3.4.3 — HOTFIX 1

Files in this package are full replacements for the current main-branch source. The original styles.css and manifest.json are included unchanged to preserve styling, layout, and PWA metadata.

Fixes included:
- Initializes the existing swipe gesture listeners.
- Makes invite copy resilient, adds share/manual-copy fallback, and opens Join Room when a ?room= link is opened.
- Hides the no-match draft-turn banner and restores it for real elimination drafts.
- Removes custom cards from the playable deck, Library, and export/import flow; old custom-card records are ignored and cleared during import.
- Updates the application asset version to 3.4.3-hotfix1 across HTML, loader, and service worker.

Install:
1. Extract this ZIP.
2. Upload every included source file to the root of the Date-Night-Decider-V3.4.3 repository, replacing existing files when asked.
3. Wait for GitHub Pages to finish deploying.
4. Test mobile left/right drag, invite link on a second browser, no-match result, a real mutual draft, and the official-pack-only Library.

Backup compatibility: this hotfix retains import support for existing 3.1.2 backups; customDeck content from old backups is deliberately ignored.

Validation: guarded source replacements passed. This is not a live browser/device test; test the published build before release.
