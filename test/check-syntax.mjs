/**
 * Syntax + wiring checks that need no browser and no child processes.
 *   node test/check-syntax.mjs
 *
 * Parses every classic script (including the inline <script> blocks inside the
 * HTML pages) with node:vm, validates JSON, and verifies a few wiring rules
 * that were broken in v4.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));
const problems = [];
const checked = [];

function parseScript(source, label) {
  try {
    new vm.Script(source, { filename: label });
    checked.push(label);
  } catch (e) {
    problems.push(label + ' — ' + e.message);
  }
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* 1. Classic scripts (ESM files are already parsed by the test import). */
const classic = [
  ...walk(join(root, 'public')).filter((f) => extname(f) === '.js'),
  ...walk(join(root, 'extension')).filter((f) => extname(f) === '.js'),
  join(root, 'apps-script', 'Code.gs')
];
for (const file of classic) {
  parseScript(readFileSync(file, 'utf8'), relative(root, file));
}

/* 2. Inline <script> blocks in every HTML page. */
const htmlFiles = [...walk(join(root, 'public')), ...walk(join(root, 'extension'))].filter(
  (f) => extname(f) === '.html'
);
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  blocks.forEach((m, i) => {
    if (!m[1].trim()) return;
    parseScript(m[1], relative(root, file) + ' inline script #' + (i + 1));
  });
}

/* 3. JSON files. */
for (const f of ['package.json', 'extension/manifest.json', 'apps-script/appsscript.json']) {
  const full = join(root, f);
  if (!existsSync(full)) {
    problems.push(f + ' — missing');
    continue;
  }
  try {
    JSON.parse(readFileSync(full, 'utf8'));
    checked.push(f);
  } catch (e) {
    problems.push(f + ' — ' + e.message);
  }
}

/* 4. Manifest references must exist (a typo here breaks the whole extension). */
const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
const manifestRefs = [manifest.action && manifest.action.default_popup].filter(Boolean);
for (const ref of manifestRefs) {
  if (!existsSync(join(root, 'extension', ref))) problems.push('manifest.json references missing ' + ref);
}

/* 5. admin.html: every $('id') must exist in the markup or be generated at runtime. */
const adminHtml = readFileSync(join(root, 'public', 'admin.html'), 'utf8');
const ids = new Set([...adminHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const generated = new Set([
  'newp', 'imp', 'impu', 'search', 'filters', 'emptyProducts',
  'fp', 'fpa', 'np', 'nn', 'no', 'ns', 'nt',
  'gbtn', 'pgm', 'pgx', 'pgt', 'pgb'
]);
for (const m of adminHtml.matchAll(/\$\('([^']+)'\)/g)) {
  const id = m[1];
  if (!ids.has(id) && !generated.has(id)) {
    problems.push('admin.html uses #' + id + ' but never defines it');
  }
}

/* 5b. Regression: variant rows used data-key, which the Save handler also
 * scanned for private keys, producing "reading 'trim' of undefined". */
if (/data-key/.test(adminHtml)) {
  problems.push('admin.html still uses data-key — variant rows must use data-vkey and secrets data-secret');
}
if (!/data-vkey/.test(adminHtml)) {
  problems.push('admin.html does not render data-vkey on variant rows');
}
if (!/data-secret/.test(adminHtml)) {
  problems.push('admin.html does not render data-secret on private-key inputs');
}

/* 5c. Regression: wireProductCard must receive DOM nodes, not product data.
 * Calling it with D.products threw "card.querySelector is not a function". */
if (/\b(all|D\.products)\.forEach\(\s*wireProductCard\s*\)/.test(adminHtml)) {
  problems.push('admin.html wires product cards from data objects — select [data-pid] elements instead');
}
if (!/#pane-products \[data-pid\]/.test(adminHtml)) {
  problems.push('admin.html does not select rendered product cards before wiring them');
}
if (!/failed to render/.test(adminHtml)) {
  problems.push('admin.html render errors are not separated from auth errors');
}

/* 6. The storefront must go through getData(), never fetch(API) directly. */
for (const f of ['index.html', 'product.html', 'account.html']) {
  const html = readFileSync(join(root, 'public', f), 'utf8');
  if (/fetch\(\s*API\s*\)/.test(html)) {
    problems.push(f + ' still calls fetch(API) directly — use getData()');
  }
  if (!/getData\s*\(/.test(html) && !/api\(\{/.test(html)) {
    problems.push(f + ' does not use the shared API helpers');
  }
}

/* 7. No page may still ship the "Method Not Allowed" 405 handler shape. */
const apiSrc = readFileSync(join(root, 'netlify', 'functions', 'api.js'), 'utf8');
if (/method\s*!==\s*'POST'[\s\S]{0,80}405/.test(apiSrc)) {
  problems.push('api.js still rejects non-POST requests with a plain 405');
}
if (!/Access-Control-Allow-Origin/.test(apiSrc)) {
  problems.push('api.js is missing CORS headers (the extension needs them)');
}
if (/export const config\s*=/.test(apiSrc)) {
  problems.push('api.js declares config.path, which replaces /.netlify/functions/api and breaks /api');
}

/* 9. CSS coverage: the storefront no longer loads Tailwind from a CDN, so every
 * utility class used in the pages or in site.js must exist in styles.css
 * (or be provided by the small styles injected by site.js / product.html). */
const storefrontCss = readFileSync(join(root, 'public', 'styles.css'), 'utf8');
const CUSTOM_CLASSES = new Set([
  'card', 'price', 'pgrid', 'stars', 'badge', 'btn-p',
  'car', 'car-track', 'car-slide', 'car-b', 'car-l', 'car-r', 'car-dots', 'on', 'active',
  'thumb', 'rs', 'lbb', 'lbt', 'lb', 'lbx', 'lbp', 'lbn', 'opt'
]);
const cssSources = [
  join(root, 'public', 'index.html'),
  join(root, 'public', 'product.html'),
  join(root, 'public', 'account.html'),
  join(root, 'public', 'site.js')
];
const usedClasses = new Set();
for (const file of cssSources) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/class="([^"]*)"/g)) {
    const raw = m[1];
    // Static part: drop ${...} expressions, which are not class names.
    for (const token of raw.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      if (!token || /['${}?]/.test(token)) continue;
      usedClasses.add(token);
    }
    // Classes chosen inside a ternary still need a rule: 'a' : 'b c'.
    for (const expr of raw.matchAll(/\$\{([^}]*)\}/g)) {
      for (const literal of expr[1].matchAll(/'([^']*)'/g)) {
        for (const token of literal[1].split(/\s+/)) {
          if (token) usedClasses.add(token);
        }
      }
    }
  }
}
const escapeClass = (token) => '.' + token.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
const missingCss = [...usedClasses].filter((token) => !CUSTOM_CLASSES.has(token) && !storefrontCss.includes(escapeClass(token)));
if (missingCss.length) {
  problems.push('styles.css is missing ' + missingCss.length + ' class(es): ' + missingCss.slice(0, 12).join(', '));
}
if (/cdn\.tailwindcss\.com/.test(readFileSync(join(root, 'public', 'index.html'), 'utf8'))) {
  problems.push('index.html still loads the Tailwind CDN');
}

/* ------------------------------------------------------------------ */
console.log(checked.length + ' script(s)/JSON file(s) parsed');
if (problems.length) {
  console.error('\n' + problems.length + ' problem(s):');
  problems.forEach((p) => console.error('  • ' + p));
  process.exit(1);
}
console.log('All checks passed');
