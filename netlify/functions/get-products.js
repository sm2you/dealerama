export default async (req, context) => {
  const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
  
  if (!APPS_SCRIPT_URL) {
    return new Response(JSON.stringify({ error: "Missing APPS_SCRIPT_URL environment variable" }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      body: JSON.stringify({ action: 'get' })
    });
    
    const data = await response.json();
    
    // CLEAN THE DATA BEFORE SENDING TO THE WEBSITE
    if (data && data.products) {
      data.products = data.products.map(p => {
        // 1. Fix the ID (remove the apostrophe Google Sheets adds)
        let cleanId = String(p.id).replace(/'/g, '').trim();
        
        // 2. Fix the Images (turn nested arrays into flat text links)
        let cleanImages = [];
        if (p.images) {
           // If it's a string that looks like JSON, parse it
           let parsed = p.images;
           if (typeof p.images === 'string') {
               try { parsed = JSON.parse(p.images); } catch(e) { parsed = []; }
           }
           // Flatten the array completely and remove quotes
           if (Array.isArray(parsed)) {
               cleanImages = parsed.flat(Infinity).map(img => String(img).replace(/[\[\]"]/g, '').trim());
           }
        }

        return { ...p, id: cleanId, images: cleanImages };
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
};
