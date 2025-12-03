export async function sendWhatsappMessage({ merchant, chatId, to, text }) {
  const baseUrl = process.env.WAHA_BASE_URL; // http://waha:3000
  const apiKey  = process.env.WAHA_API_KEY;
  const session = merchant.waha_session;

  let finalChatId = chatId;

  if (!finalChatId) {
    // fallback: reconstruire depuis "to"
    const digits = String(to || "").replace(/[^\d]/g, "");
    finalChatId = digits ? `${digits}@c.us` : null;
  }

  if (!finalChatId) throw new Error("Missing chatId/to for WAHA sendText");

  // Normalisation
  if (finalChatId.endsWith("@s.whatsapp.net")) {
    finalChatId = finalChatId.replace("@s.whatsapp.net", "@c.us");
  }
  // ⚠️ si @lid -> on garde tel quel

  const url = `${baseUrl}/api/sendText`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({ session, chatId: finalChatId, text }),
  });

  const body = await res.text();
  console.log("[WAHA sendText]", { session, chatId: finalChatId, status: res.status, body });

  if (!res.ok) throw new Error(`WAHA sendText failed: ${res.status} ${body}`);
}
