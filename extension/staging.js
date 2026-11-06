/**
 * Dealerama staging tab — review, edit, publish.
 *
 * Bug fixes vs v4:
 *  - the publish endpoint is configurable and persisted (was the literal
 *    string 'PASTE_YOUR_GOOGLE_SCRIPT_URL_HERE');
 *  - the "Variants found" box is actually rendered (it was always "none");
 *  - images that load smaller than 500px are flagged and deselected, as the
 *    copy always promised;
 *  - non-JSON (HTML) responses from Apps Script are reported clearly instead
 *    of throwing "Unexpected token '<'";
 *  - failures are re-enable-able and image upload failures are listed.
 */

const $ = (id) => document.getElementById(id);

let draft = null;
let selected = new Set();
const imgInfo = new Map();

async function init() {
  const store = await chrome.storage.local.get(['draftProduct', 'adminSecret', 'publishUrl']);
  draft = store.draftProduct || null;

  if (store.adminSecret) $('secret').value = store.adminSecret;
  if (store.publishUrl) $('endpoint').value = store.publishUrl;

  if (!draft) {
    $('status').textContent = 'No scraped product found. Run the extension on a product page first.';
    $('status').className = 'err';
    $('publishBtn').disabled = true;
    return;
  }

  $('title').value = draft.title || '';
  $('price').value = draft.price != null ? draft.price : '';
  $('description').value = draft.description || '';
  $('sourceLine').innerHTML =
    'Scraped from <b>' + escapeHtml(draft.host || 'this page') + '</b>' +
    (draft.store ? ' · ' + escapeHtml(draft.store) : '') +
    (draft.scrapedAt ? ' · ' + new Date(draft.scrapedAt).toLocaleString() : '');

  renderVariants(draft.variants);
  renderImages(draft.images || []);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ *
 * Variants
 * ------------------------------------------------------------------ */
function renderVariants(v) {
  const box = $('variants');
  const toggle = $('useVariants');

  if (!v || !v.items || !v.items.length) {
    box.innerHTML = '<div class="none">None found.</div><div class="hint">Add options manually in Admin → Products → Variants (one line per option, e.g. <code>Color: Red, Blue</code>).</div>';
    toggle.checked = false;
    toggle.disabled = true;
    return;
  }

  toggle.disabled = false;
  toggle.checked = true;

  const options = v.options || [];
  const chips = (values) => {
    const list = values.map((x) => `<span class="chip">${escapeHtml(x)}</span>`);
    const shown = list.slice(0, 12).join('');
    return shown + (list.length > 12 ? `<span class="hint">+${list.length - 12} more</span>` : '');
  };
  const opts = options
    .map((o) => `<div class="opt"><b>${escapeHtml(o.name)}</b> ${chips((o.values || []).map(String))}</div>`)
    .join('');

  // Sanity check: option values should be short words, not sentences or SKUs.
  const suspicious = options.some((o) => (o.values || []).some((x) => String(x).length > 40))
    || v.items.some((it) => String(it.key).length > 60);

  const preview = v.items.slice(0, 8).map((it) => {
    const key = String(it.key).replace(/\|/g, ' / ');
    const price = it.price != null && it.price !== '' ? '$' + Number(it.price).toFixed(2) : 'base';
    return `<tr><td title="${escapeHtml(key)}">${escapeHtml(key.length > 46 ? key.slice(0, 46) + '…' : key)}</td><td>${price}</td><td>${it.qty}</td></tr>`;
  }).join('');

  box.innerHTML =
    opts +
    `<div class="opt" style="margin-top:8px"><b>${v.items.length}</b> combinations <span class="src">${escapeHtml(v.source || 'auto')}</span></div>` +
    (suspicious
      ? '<div class="warnline">Some option values are very long (whole titles or SKUs). Rescrape the page, or fix the options in Admin → Products before publishing.</div>'
      : '') +
    `<table id="variantTable"><tr><th>Combination</th><th>Price</th><th>Stock</th></tr>${preview}</table>` +
    (v.items.length > 8 ? `<div class="hint">Showing 8 of ${v.items.length}. All of them can be edited in Admin → Products → Variants.</div>` : '');
}

/* ------------------------------------------------------------------ *
 * Images
 * ------------------------------------------------------------------ */
function renderImages(urls) {
  const grid = $('imageGrid');
  grid.innerHTML = '';
  selected.clear();
  imgInfo.clear();

  if (!urls.length) {
    grid.innerHTML = '<p class="hint">No images were found on this page. You can add photos from your device in Admin → Products.</p>';
    return;
  }

  urls.forEach((url) => {
    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';
    wrap.title = url;

    const img = document.createElement('img');
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';

    const dim = document.createElement('span');
    dim.className = 'dim';
    dim.textContent = '…';

    // Optimistically select; the load handler deselects low-resolution images.
    selected.add(url);
    wrap.classList.add('selected');

    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      imgInfo.set(url, { w: w, h: h });
      dim.textContent = w + '×' + h;
      if (w && w < 500) {
        dim.classList.add('low');
        dim.textContent = w + '×' + h + ' · low-res';
        wrap.classList.remove('selected');
        selected.delete(url);
      }
    };

    img.onerror = () => {
      dim.textContent = 'blocked';
      dim.classList.add('low');
      wrap.classList.remove('selected');
      selected.delete(url);
    };

    wrap.onclick = () => {
      if (selected.has(url)) {
        selected.delete(url);
        wrap.classList.remove('selected');
      } else {
        selected.add(url);
        wrap.classList.add('selected');
      }
      updatePublishLabel();
    };

    wrap.appendChild(img);
    wrap.appendChild(dim);
    grid.appendChild(wrap);
    img.src = url;
  });

  updatePublishLabel();
}

function updatePublishLabel() {
  const btn = $('publishBtn');
  if (btn.disabled && btn.dataset.busy === '1') return;
  btn.textContent = 'Publish to store (as draft) · ' + selected.size + ' image' + (selected.size === 1 ? '' : 's');
}

/* ------------------------------------------------------------------ *
 * Endpoint helper
 * ------------------------------------------------------------------ */
function endpointUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function healthUrl(base) {
  const u = new URL(base);
  u.searchParams.set('action', 'health');
  return u.toString();
}

function friendlyNetworkError(e, base) {
  const msg = String((e && e.message) || e);
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return (
      'Could not reach ' + base + '.\n' +
      '• Check the Web App is deployed (Deploy → Manage deployments) with "Who has access: Anyone".\n' +
      '• Use the /exec URL, not the /edit URL.\n' +
      '• Reload the extension after changing manifest.json.'
    );
  }
  return msg;
}

/* ------------------------------------------------------------------ *
 * Test connection
 * ------------------------------------------------------------------ */
$('testBtn').onclick = async () => {
  const base = endpointUrl($('endpoint').value);
  const btn = $('testBtn');
  if (!base) { $('status').textContent = 'Paste your publish endpoint first.'; $('status').className = 'err'; return; }
  btn.disabled = true;
  $('status').className = '';
  $('status').textContent = 'Testing…';
  try {
    const r = await fetch(healthUrl(base), { method: 'GET', cache: 'no-store' });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch (e) {
      throw new Error('The endpoint replied with something that is not JSON (HTTP ' + r.status + '). Make sure it is the /exec Web App URL and access is "Anyone".');
    }
    if (data.error) throw new Error(data.error);
    const missing = [];
    if (data.hasSecret === false) missing.push('admin secret (run setup())');
    if (data.hasStripe === false) missing.push('Stripe key');
    if (data.hasImgbb === false) missing.push('ImgBB key');
    $('status').className = missing.length ? 'warn' : 'ok';
    $('status').textContent =
      'Connected to backend v' + (data.version || '?') +
      (missing.length ? '\nStill missing: ' + missing.join(', ') : '\nAll keys configured.');
  } catch (e) {
    $('status').className = 'err';
    $('status').textContent = friendlyNetworkError(e, base);
  }
  btn.disabled = false;
};

/* ------------------------------------------------------------------ *
 * Publish
 * ------------------------------------------------------------------ */
$('publishBtn').onclick = async () => {
  const btn = $('publishBtn');
  const status = $('status');
  const base = endpointUrl($('endpoint').value);
  const secret = $('secret').value.trim();
  const title = $('title').value.trim();
  const price = Number($('price').value);

  status.className = '';
  status.textContent = '';

  if (!base) { status.className = 'err'; status.textContent = 'Paste your publish endpoint (the Apps Script /exec URL).'; return; }
  if (!secret) { status.className = 'err'; status.textContent = 'Enter your admin secret first.'; return; }
  if (!title) { status.className = 'err'; status.textContent = 'A title is required.'; return; }
  if (!(price > 0)) { status.className = 'err'; status.textContent = 'Enter a price greater than 0.'; return; }
  if (!selected.size) { status.className = 'err'; status.textContent = 'Select at least one image.'; return; }

  await chrome.storage.local.set({ adminSecret: secret, publishUrl: base });

  const useVariants = $('useVariants').checked && draft.variants && draft.variants.items && draft.variants.items.length;

  const payload = {
    action: 'addProductAuto',
    secret: secret,
    product: {
      title: title,
      price: price,
      description: $('description').value,
      images: Array.from(selected),
      dealType: 'daily',
      stripeLink: $('stripeLink').value.trim(),
      variants: useVariants ? draft.variants : null
    }
  };

  btn.disabled = true;
  btn.dataset.busy = '1';
  btn.textContent = 'Uploading… (10-40s)';
  status.className = '';
  status.textContent = 'Sending ' + selected.size + ' image(s) to ImgBB via Apps Script…';

  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    });

    const text = await res.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch (e) {
      throw new Error(
        'The backend returned ' + (res.status ? 'HTTP ' + res.status + ' and ' : '') +
        'an HTML/non-JSON page.\nRedeploy the Web App (Execute as: Me, Who has access: Anyone) and use the /exec URL.'
      );
    }

    if (result.error) throw new Error(result.error);

    const uploaded = (result.images || []).length;
    const failed = result.failed || [];
    const variantCount = Number(result.variants) || 0;

    if (!uploaded) {
      btn.textContent = 'Retry publish';
      status.className = 'err';
      status.textContent = 'Saved, but 0 images were stored. Check IMGBB_API_KEY in Admin → Settings.';
      btn.disabled = false;
      btn.dataset.busy = '0';
      return;
    }

    const lines = [];
    lines.push('Published as ' + (result.status || 'draft') + '.');
    lines.push(uploaded + ' image(s) stored.');
    if (variantCount) lines.push(variantCount + ' variants imported.');
    if (failed.length) lines.push(failed.length + ' image(s) used the original URL (ImgBB refused them):\n' + failed.slice(0, 3).map((f) => '· ' + String(f.reason || '').slice(0, 80)).join('\n'));

    status.className = 'ok';
    status.textContent = lines.join('\n');
    btn.textContent = 'Published — you can close this tab';
    await chrome.storage.local.remove('draftProduct');
  } catch (e) {
    status.className = 'err';
    status.textContent = friendlyNetworkError(e, base);
    btn.disabled = false;
    btn.dataset.busy = '0';
    updatePublishLabel();
  }
};

init();
