export async function sendWhatsappMessage({ to, text }) {
  const baseUrl = process.env.WAHA_BASE_URL;      // ex: http://waha:3000
  const apiKey = process.env.WAHA_API_KEY;
  const session = process.env.WAHA_SESSION || "default";

  const chatId = String(to).replace(/[^\d]/g, "") + "@c.us"; // "+22507..." => "22507...@c.us"

  const url = `${baseUrl}/api/sendText`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({ session, chatId, text }),
  });

  const body = await res.text();
  console.log("[WAHA sendText] status=", res.status, "body=", body);

  if (!res.ok) {
    throw new Error(`WAHA sendText failed: ${res.status} ${body}`);
  }
}
