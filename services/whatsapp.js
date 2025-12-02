export async function sendWhatsappMessage({ merchant, to, text }) {
  const baseUrl = process.env.WAHA_BASE_URL;     // http://waha:3000
  const apiKey  = process.env.WAHA_API_KEY;      // clé unique WAHA
  const session = merchant.waha_session;         // <<< clé du routing

  const chatId = String(to).replace(/[^\d]/g, "") + "@c.us";
  const url = `${baseUrl}/api/sendText`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({ session, chatId, text }),
  });

  const body = await res.text();
  console.log("[WAHA sendText]", { session, status: res.status, body });

  if (!res.ok) throw new Error(`WAHA sendText failed: ${res.status} ${body}`);
}
