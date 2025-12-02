export async function sendWhatsappMessage({ merchant, to, text }) {
  const baseUrl = process.env.WAHA_BASE_URL; // http://waha:3000
  const apiKey = process.env.WAHA_API_KEY;   // clé unique WAHA

  const session = merchant?.waha_session || "default"; // fallback
  const digits = String(to || "").replace(/[^\d]/g, "");
  const chatId = `${digits}@c.us`;

  if (!digits) {
    throw new Error("sendWhatsappMessage: numéro 'to' invalide");
  }

  const url = `${baseUrl}/api/sendText`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({ session, chatId, text }),
  });

  const bodyText = await res.text();
  console.log("[WAHA sendText]", { session, status: res.status, body: bodyText });

  if (!res.ok) {
    // Erreur typique: session inexistante / pas démarrée / pas connectée
    throw new Error(`WAHA sendText failed: ${res.status} ${bodyText}`);
  }

  // Optionnel: retourner la réponse JSON si tu veux
  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}
