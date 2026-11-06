export default async (req, context) => {
  const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
  
  if (!APPS_SCRIPT_URL) {
    return new Response(JSON.stringify({ error: "Missing APPS_SCRIPT_URL environment variable in Netlify" }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      body: JSON.stringify({ action: 'get' })
    });
    
    const text = await response.text(); // Get raw text first to see if Google returns an error page
    
    try {
      const data = JSON.parse(text);
      return new Response(JSON.stringify(data), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    } catch (e) {
      // If it fails to parse, Google sent back an HTML error page (like a login screen)
      return new Response(JSON.stringify({ error: "Google returned invalid JSON. Raw response: " + text.substring(0, 100) }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({ error: "Fetch failed: " + error.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
};
