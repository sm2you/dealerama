#!/usr/bin/env node
/**
 * Dealerama setup verifier + configurator.
 *
 * This automates README step 4 (Settings → site_url, Stripe key, ImgBB key) and
 * verifies steps 1–3, without opening the admin panel.
 *
 *   node scripts/configure.mjs --url <apps-script /exec URL> --secret <admin secret> \
 *     --site-url https://dealerama.netlify.app \
 *     --stripe sk_live_xxx --imgbb abc123 \
 *     --business "Dealerama" --email you@example.com --google-client-id xxx.apps.googleusercontent.com
 *
 * Everything can also come from the environment:
 *   APPS_SCRIPT_URL, ADMIN_SECRET, SITE_URL, STRIPE_SECRET_KEY, IMGBB_API_KEY
 *
 * Nothing is written unless a --site-url/--stripe/--imgbb/... flag is supplied.
 * Secrets are never printed.
 */

import { pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const EXEC_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec\/?$/;
const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//;

const HELP = `
Dealerama configure

  --url <url>              Apps Script Web App /exec URL   (env APPS_SCRIPT_URL)
  --secret <secret>        admin secret printed by setup()  (env ADMIN_SECRET)
  --site-url <url>         public storefront URL            (env SITE_URL)
  --stripe <key>           Stripe secret key (restricted)   (env STRIPE_SECRET_KEY)
  --imgbb <key>            ImgBB API key                    (env IMGBB_API_KEY)
  --business <name>        business_name setting
  --email <email>          contact_email setting
  --google-client-id <id>  google_client_id setting (enables customer login)
  --new-secret <secret>    rotate the admin secret (12+ characters)
  --env-file <path>        read KEY=VALUE from a file (default: .env.local)
  --verify-only            never write anything
  --json                   machine-readable output
  --help
`;

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const raw = a.slice(2);
    const eq = raw.indexOf('=');
    const key = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;

    if (['help', 'json', 'verify-only'].includes(key)) {
      out[key] = true;
      continue;
    }
    if (inline !== undefined) {
      out[key] = inline;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = '';
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
}

export function fromEnv() {
  return {
    url: process.env.APPS_SCRIPT_URL || '',
    secret: process.env.ADMIN_SECRET || '',
    'site-url': process.env.SITE_URL || '',
    stripe: process.env.STRIPE_SECRET_KEY || '',
    imgbb: process.env.IMGBB_API_KEY || ''
  };
}

/** Minimal KEY=VALUE reader (no dependencies, quotes optional). */
export function readEnvFile(path) {
  const out = {};
  if (!path || !existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const eq = text.indexOf('=');
    if (eq < 1) continue;
    const key = text.slice(0, eq).trim();
    let value = text.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const ENV_MAP = {
  APPS_SCRIPT_URL: 'url',
  ADMIN_SECRET: 'secret',
  SITE_URL: 'site-url',
  STRIPE_SECRET_KEY: 'stripe',
  IMGBB_API_KEY: 'imgbb',
  BUSINESS_NAME: 'business-name',
  CONTACT_EMAIL: 'email',
  GOOGLE_CLIENT_ID: 'google-client-id'
};

/** Turn .env.local keys into the same flags the CLI accepts. */
export function mapEnvFile(values) {
  const out = {};
  Object.keys(values || {}).forEach((k) => {
    if (ENV_MAP[k] && values[k]) out[ENV_MAP[k]] = values[k];
  });
  return out;
}

const mask = (v) => (v ? String(v).slice(0, 4) + '…' + String(v).slice(-2) : '');

async function request(fetchImpl, url, init, timeoutMs = 30000) {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      'The endpoint returned ' +
        (response.status ? 'HTTP ' + response.status + ' and ' : '') +
        'a non-JSON page. Redeploy the Apps Script Web App with "Who has access: Anyone" and use the /exec URL.\n' +
        'First 160 chars: ' + text.replace(/\s+/g, ' ').slice(0, 160)
    );
  }
  return { status: response.status, data };
}

/**
 * @returns {Promise<{ok:boolean, checks:object[], warnings:string[]}>}
 */
export async function configure(opts, { fetchImpl = fetch, log = () => {} } = {}) {
  const url = String(opts.url || '').trim().replace(/\/+$/, '');
  const checks = [];
  const warnings = [];

  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
    return ok;
  };

  if (!url) throw new Error('Missing --url (the Apps Script /exec URL).');
  if (!EXEC_RE.test(url) && !LOCAL_RE.test(url)) {
    throw new Error(
      'That does not look like an Apps Script /exec URL.\n' +
        'Expected https://script.google.com/macros/s/…/exec — you gave: ' + url
    );
  }

  /* 1. health ------------------------------------------------------------ */
  log('1. Apps Script deployment');
  const health = await request(fetchImpl, url + '?action=health', { method: 'GET' });
  if (health.data.error) throw new Error('Health check failed: ' + health.data.error);

  check('Web App reachable', true, 'version ' + (health.data.version || 'unknown'));
  check('Sheet tabs present', !Array.isArray(health.data.sheets) || health.data.sheets.every(Boolean));
  const hasSecret = health.data.hasSecret === true;
  check('Admin secret exists', hasSecret, hasSecret ? '' : 'run setup() in Apps Script');

  const before = {
    stripe: health.data.hasStripe === true,
    imgbb: health.data.hasImgbb === true
  };
  log('');
  log('2. Admin access');
  const secret = String(opts.secret || '').trim();
  if (!secret) {
    warnings.push('No --secret supplied, so settings cannot be verified or written.');
    return { ok: checks.every((c) => c.ok), checks, warnings, state: { before } };
  }

  const admin = await request(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'adminGet', secret })
  });
  if (admin.data.error) throw new Error('Admin login failed: ' + admin.data.error);

  check('Admin secret accepted', true);
  const state = admin.data;
  const counts = {
    products: (state.products || []).length,
    live: (state.products || []).filter((p) => p.status === 'live').length,
    reviews: (state.reviews || []).length,
    orders: (state.orders || []).length
  };
  log('     products: ' + counts.products + ' (' + counts.live + ' live), reviews: ' + counts.reviews + ', orders: ' + counts.orders);

  /* 2. optional writes --------------------------------------------------- */
  const settings = {};
  const keys = {};
  const businessName = opts['business-name'] || opts.business;
  if (opts['site-url']) settings.site_url = String(opts['site-url']).replace(/\/+$/, '');
  if (businessName) settings.business_name = String(businessName);
  if (opts.email) settings.contact_email = String(opts.email);
  if (opts['google-client-id']) settings.google_client_id = String(opts['google-client-id']);
  if (opts.stripe) keys.STRIPE_SECRET_KEY = String(opts.stripe);
  if (opts.imgbb) keys.IMGBB_API_KEY = String(opts.imgbb);
  if (opts['new-secret']) keys.SECRET_KEY = String(opts['new-secret']);

  let activeSecret = secret;

  if (!opts['verify-only'] && (Object.keys(settings).length || Object.keys(keys).length)) {
    log('');
    log('3. Writing configuration');
    if (settings.site_url) log('     site_url      = ' + settings.site_url);
    if (settings.business_name) log('     business_name = ' + settings.business_name);
    if (settings.contact_email) log('     contact_email = ' + settings.contact_email);
    if (settings.google_client_id) log('     google_client_id = ' + mask(settings.google_client_id));
    if (keys.STRIPE_SECRET_KEY) log('     Stripe key    = ' + mask(keys.STRIPE_SECRET_KEY));
    if (keys.IMGBB_API_KEY) log('     ImgBB key     = ' + mask(keys.IMGBB_API_KEY));
    if (keys.SECRET_KEY) log('     new admin secret (masked)');

    const saved = await request(fetchImpl, url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'saveAll', secret, settings, keys })
    });
    if (saved.data.error) throw new Error('Save failed: ' + saved.data.error);
    check('Settings saved', true);

    if (keys.SECRET_KEY) {
      activeSecret = keys.SECRET_KEY;
      log('     admin secret rotated — use the new one from now on');
    }
  } else {
    log('');
    log('3. Writing configuration — skipped (nothing to write)');
  }

  /* 3. verify ------------------------------------------------------------ */
  log('');
  log('4. Verification');
  const after = await request(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'adminGet', secret: activeSecret })
  });
  if (after.data.error) throw new Error('Could not re-read settings: ' + after.data.error);
  const finalSettings = after.data.settings || {};
  const finalKeys = after.data.keysSet || {};

  check('Stripe key set', finalKeys.STRIPE_SECRET_KEY === true, finalKeys.STRIPE_SECRET_KEY ? '' : 'checkout will be disabled');
  check('ImgBB key set', finalKeys.IMGBB_API_KEY === true, finalKeys.IMGBB_API_KEY ? '' : 'imports keep source URLs');
  check('site_url set', !!finalSettings.site_url, finalSettings.site_url || 'Stripe redirects need this');
  if (!finalSettings.google_client_id) {
    log('  note google_client_id not set — optional, only "My orders" needs it');
    warnings.push('google_client_id is not set, so customer sign-in / "My orders" stays disabled.');
  }

  /* 4. storefront -------------------------------------------------------- */
  const siteUrl = String(opts['site-url'] || finalSettings.site_url || '')
    .trim()
    .replace(/\/+$/, '');
  if (siteUrl) {
    log('');
    log('5. Storefront (' + siteUrl + ')');
    try {
      const proxy = await request(fetchImpl, siteUrl + '/api?action=health', { method: 'GET' }, 20000);
      check('/api deployed', proxy.data.appsScriptConfigured === true, 'APPS_SCRIPT_URL ' + (proxy.data.appsScriptConfigured ? 'set' : 'MISSING'));

      const catalog = await request(fetchImpl, siteUrl + '/api', { method: 'GET' }, 20000);
      if (catalog.data.error) throw new Error(catalog.data.error);
      const products = catalog.data.products || [];
      check(
        'Storefront catalogue loads',
        true,
        products.length + ' product(s), ' + ((catalog.data.settings || {}).site_name || 'no site name')
      );
      if (!products.length) warnings.push('No public products yet — imported products start as drafts; set one to live in /admin.html.');
    } catch (e) {
      check('/api deployed', false, e.message.split('\n')[0]);
    }
  }

  /* 5. checkout readiness ------------------------------------------------ */
  const live = (after.data.products || []).filter((p) => p.status === 'live');
  const buyable = live.filter((p) => {
    if (p.variants && p.variants.items) return p.variants.items.some((i) => i.qty > 0 && (i.price > 0 || p.basePrice > 0));
    return p.qty > 0 && (p.basePrice > 0 || p.price > 0);
  });

  const ok = checks.every((c) => c.ok);
  log('');
  log('Summary');
  log('  Apps Script : ' + (hasSecret ? 'ready' : 'needs setup()'));
  log('  Stripe key  : ' + (finalKeys.STRIPE_SECRET_KEY ? 'set' : 'missing'));
  log('  ImgBB key   : ' + (finalKeys.IMGBB_API_KEY ? 'set' : 'missing'));
  log('  site_url    : ' + (finalSettings.site_url || 'missing'));
  log('  Buyable now : ' + buyable.length + ' of ' + live.length + ' live product(s)');
  if (!buyable.length) warnings.push('No buyable product yet: at least one live product needs price > 0 and stock > 0 before you can test checkout.');

  return {
    ok,
    checks,
    warnings,
    state: {
      counts,
      settings: {
        site_url: finalSettings.site_url || '',
        site_name: finalSettings.site_name || '',
        business_name: finalSettings.business_name || '',
        google_client_id: !!finalSettings.google_client_id
      },
      keysSet: finalKeys,
      buyable: buyable.length
    }
  };
}

/* ------------------------------------------------------------------ */
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    console.log(HELP);
    process.exit(0);
  }
  const envPath = cli['env-file'] || join(ROOT, '.env.local');
  const fromFile = mapEnvFile(readEnvFile(envPath));
  const args = Object.assign(fromEnv(), fromFile, cli);
  if (!cli.json && Object.keys(fromFile).length) {
    console.log('Loaded configuration from ' + envPath);
  }
  try {
    const result = await configure(args, {
      log: (line) => {
        if (!args.json) console.log(line);
      }
    });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    if (result.warnings.length) {
      console.log('\nNotes');
      result.warnings.forEach((w) => console.log('  • ' + w));
    }
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    console.error('\nERROR: ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
}
