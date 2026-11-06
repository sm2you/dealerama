const API = '/.netlify/functions/api';
const PLACEHOLDER = 'https://placehold.co/600x600?text=No+Image';
const FONTS = ['system-ui', 'Inter', 'Poppins', 'Montserrat', 'Roboto', 'Open Sans', 'Lato', 'Nunito', 'Raleway', 'Oswald', 'Playfair Display', 'Lora', 'Merriweather'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toFixed(2);
const on = (v) => String(v).toLowerCase() === 'true';
let TOKEN = localStorage.getItem('gt') || '';

async function api(body) {
  const r = await fetch(API, { method: 'POST', body: JSON.stringify({ token: TOKEN, ...body }) });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

// ---- stars, stock bar, sanitizer ----
const stars = (r) => `<span class="stars" style="--r:${Number(r) || 0}"></span>`;
function stockBar(p, S) {
  const total = p.qty + p.sold; if (!total) return '';
  const pct = Math.round(p.sold / total * 100), low = p.qty > 0 && p.qty <= Number(S.stock_low_at || 5);
  return `<div class="mt-3"><div class="flex justify-between text-xs font-semibold mb-1"><span>${p.sold} sold</span><span style="${low ? 'color:#dc2626' : ''}">${p.qty > 0 ? 'Only ' + p.qty + ' left' : 'Sold out'}</span></div>
  <div class="h-2.5 rounded-full bg-gray-200 overflow-hidden"><div class="h-full rounded-full" style="width:${pct}%;background:${low ? '#dc2626' : S.stock_bar_color}"></div></div></div>`;
}
function sanitize(html) {
  const ok = new Set(['P', 'BR', 'UL', 'OL', 'LI', 'B', 'STRONG', 'I', 'EM']);
  const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
  const walk = (n) => [...n.childNodes].forEach(c => {
    if (c.nodeType !== 1) return;
    if (!ok.has(c.tagName)) { if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].includes(c.tagName)) { c.remove(); return; } walk(c); c.replaceWith(...c.childNodes); }
    else { [...c.attributes].forEach(a => c.removeAttribute(a.name)); walk(c); }
  });
  walk(doc.body.firstChild); return doc.body.firstChild.innerHTML;
}

// ---- swipe carousel (all slides are the same square size) ----
function carousel(imgs, href) {
  const list = imgs.length ? imgs : [PLACEHOLDER];
  const slide = (u) => { const im = `<img src="${esc(u)}" referrerpolicy="no-referrer" loading="lazy" draggable="false" onerror="this.onerror=null;this.src='${PLACEHOLDER}'">`; return href ? `<a class="car-slide" href="${href}">${im}</a>` : `<div class="car-slide">${im}</div>`; };
  return `<div class="car"><div class="car-track">${list.map(slide).join('')}</div>` + (list.length > 1 ? `<button class="car-b car-l" type="button" aria-label="Previous">‹</button><button class="car-b car-r" type="button" aria-label="Next">›</button><div class="car-dots">${list.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : '') + `</div>`;
}
function initCarousels(root = document, onIndex) {
  root.querySelectorAll('.car:not([data-i])').forEach(c => {
    c.dataset.i = 1;
    const t = c.querySelector('.car-track'), dots = [...c.querySelectorAll('.car-dots i')];
    const go = (d) => t.scrollBy({ left: d * t.clientWidth, behavior: 'smooth' });
    t.addEventListener('scroll', () => { const i = Math.round(t.scrollLeft / t.clientWidth); dots.forEach((x, k) => x.classList.toggle('on', k === i)); if (onIndex) onIndex(i); }, { passive: true });
    c.querySelector('.car-l')?.addEventListener('click', (e) => { e.preventDefault(); go(-1); });
    c.querySelector('.car-r')?.addEventListener('click', (e) => { e.preventDefault(); go(1); });
  });
}

// ---- theme, fonts, banner, footer ----
function applyTheme(s) {
  const fams = [...new Set([s.font_body, s.font_heading])].filter(f => f && f !== 'system-ui');
  if (fams.length) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?' + fams.map(f => 'family=' + encodeURIComponent(f).replace(/%20/g, '+') + ':wght@400;700').join('&') + '&display=swap'; document.head.appendChild(l); }
  const fam = (f) => `'${f}',system-ui,sans-serif`;
  const css = document.createElement('style');
  css.textContent = `:root{--p:${s.primary_color};--a:${s.accent_color}}
  html{font-size:${16 * (Number(s.font_scale) || 1)}px}
  body{background:#f9f9f9;font-family:${fam(s.font_body)}}
  h1,h2,h3,h4,.hd{font-family:${fam(s.font_heading)}!important;font-weight:${s.heading_weight}!important;font-style:${s.heading_style}!important;text-transform:${s.heading_transform}!important}
  .btn-p{background:var(--p);color:#fff}.btn-p:hover{opacity:.85}.btn-p:disabled{background:#9ca3af;cursor:not-allowed}
  .stars{display:inline-block;font-size:1.05em;letter-spacing:2px;background:linear-gradient(90deg,#f59e0b calc(var(--r)/5*100%),#d1d5db 0);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .stars::before{content:'★★★★★'}
  .badge{position:absolute;top:12px;left:12px;padding:4px 12px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase;background:var(--a);color:#fff;z-index:10}
  .card{transition:transform .2s}.card:hover{transform:translateY(-4px);box-shadow:0 10px 20px rgba(0,0,0,.06)}
  .car{position:relative}.car-track{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch}.car-track::-webkit-scrollbar{display:none}
  .car-slide{flex:0 0 100%;scroll-snap-align:center;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;background:#fff;padding:12px;box-sizing:border-box;cursor:pointer}
  .car-slide img{width:100%;height:100%;object-fit:contain;user-select:none}
  .car-b{position:absolute;top:50%;transform:translateY(-50%);width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.9);box-shadow:0 1px 4px rgba(0,0,0,.3);font-size:22px;line-height:1;opacity:0;transition:.2s;z-index:5}
  .car:hover .car-b{opacity:1}.car-l{left:8px}.car-r{right:8px}
  .car-dots{position:absolute;bottom:8px;left:0;right:0;display:flex;justify-content:center;gap:5px;pointer-events:none}.car-dots i{width:7px;height:7px;border-radius:50%;background:#cbd5e1}.car-dots i.on{background:var(--p)}`;
  document.head.appendChild(css);
  const brand = document.getElementById('brand');
  if (brand) brand.innerHTML = s.logo_url ? `<img src="${esc(s.logo_url)}" alt="${esc(s.site_name)}" style="height:2.5rem" referrerpolicy="no-referrer">` : esc(s.site_name);
  const b = document.getElementById('banner');
  if (b && on(s.banner_on) && s.banner_text) { b.textContent = s.banner_text; b.style.background = s.banner_color; b.style.display = 'block'; }
  if (on(s.footer_on)) {
    const f = document.createElement('footer');
    f.className = 'bg-white border-t mt-16 py-8 px-6 text-sm text-gray-500';
    f.innerHTML = `<div class="max-w-6xl mx-auto flex flex-wrap gap-x-6 gap-y-2 justify-between"><span>© ${new Date().getFullYear()} ${esc(s.business_name)}</span><span class="flex flex-wrap gap-x-5 gap-y-1">${['privacy:Privacy Policy', 'terms:Terms & Conditions', 'shipping:Shipping', 'returns:Returns & Refunds', 'contact:Contact'].map(x => { const [k, l] = x.split(':'); return `<a class="hover:text-black" href="legal.html?p=${k}">${l}</a>`; }).join('')}</span></div>`;
    document.body.appendChild(f);
  }
}

// ---- customer login (Google Sign-In: one tap, no passwords) ----
const jwt = (t) => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return null; } };
const authUser = () => { const p = jwt(TOKEN); return p && p.exp * 1000 > Date.now() ? p : null; };
function initAuth(S, onChange) {
  const box = document.getElementById('auth'); if (!box || !S.google_client_id) return;
  const draw = () => {
    const u = authUser();
    if (u) { box.innerHTML = `<a href="account.html" class="text-sm font-bold">${esc(u.given_name || u.email)} · My orders</a> <button id="so" class="text-xs text-gray-500 ml-2">Sign out</button>`;
      document.getElementById('so').onclick = () => { localStorage.removeItem('gt'); TOKEN = ''; draw(); onChange && onChange(); }; }
    else { box.innerHTML = '<div id="gbtn"></div>'; if (window.google && google.accounts) google.accounts.id.renderButton(document.getElementById('gbtn'), { theme: 'outline', size: 'medium' }); }
  };
  const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = () => { google.accounts.id.initialize({ client_id: S.google_client_id, callback: (r) => { TOKEN = r.credential; localStorage.setItem('gt', TOKEN); draw(); onChange && onChange(); } }); draw(); if (!authUser()) google.accounts.id.prompt(); };
  document.head.appendChild(s); draw();
}
