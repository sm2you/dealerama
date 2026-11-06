const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  const url = process.env.APPS_SCRIPT_URL;
  if (!url) return j({ error: 'Missing APPS_SCRIPT_URL environment variable' }, 500);
  try {
    const body = req.method === 'POST' ? await req.text() : JSON.stringify({ action: 'get' });
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, redirect: 'follow' });
    const t = await r.text();
    try { JSON.parse(t); } catch (e) { return j({ error: 'Apps Script did not return JSON (check deployment access = Anyone)', preview: t.slice(0, 200) }, 502); }
    return new Response(t, { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) { return j({ error: e.message }, 500); }
};
