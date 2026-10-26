import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const missing = new Set();
const checked = new Set();

function checkLocalReference(raw, source) {
  if (typeof raw !== 'string' || !raw.trim()) return;
  const value = raw.trim();
  if (/^(?:https?:|data:|mailto:|tel:|javascript:|#)/i.test(value)) return;
  const withoutQuery = value.split(/[?#]/, 1)[0];
  if (!withoutQuery) return;
  const relative = withoutQuery.replace(/^\.\//, '');
  const target = path.resolve(root, relative || '.');
  const key = relative + ' <- ' + source;
  if (checked.has(key)) return;
  checked.add(key);
  if (!fs.existsSync(target)) missing.add(key);
}

const indexPath = path.join(root, 'index.html');
const index = fs.readFileSync(indexPath, 'utf8');
for (const match of index.matchAll(/<(?:script|link|img|source)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
  checkLocalReference(match[1], 'index.html');
}
for (const match of index.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) {
  const href = match[1];
  if (href.startsWith('./') || href.endsWith('.html')) checkLocalReference(href, 'index.html link');
}

const manifestPath = path.join(root, 'manifest.json');
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const icon of manifest.icons || []) checkLocalReference(icon.src, 'manifest.json');
  if (manifest.start_url) checkLocalReference(manifest.start_url, 'manifest.json');
}

const swPath = path.join(root, 'service-worker.js');
if (fs.existsSync(swPath)) {
  const sw = fs.readFileSync(swPath, 'utf8');
  const assetsBlock = sw.match(/const\s+CORE_ASSETS\s*=\s*\[([\s\S]*?)\];/);
  if (assetsBlock) {
    for (const match of assetsBlock[1].matchAll(/["'](\.\/[^"']+)["']/g)) {
      checkLocalReference(match[1], 'service-worker.js CORE_ASSETS');
    }
  }
}

if (missing.size) {
  console.error('Missing local assets referenced by the application:');
  for (const item of [...missing].sort()) console.error(' - ' + item);
  console.error('\nRestore the missing assets or remove/update obsolete references before release.');
  process.exitCode = 1;
} else {
  console.log('All checked local asset references resolve.');
}
