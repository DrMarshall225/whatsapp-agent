// services/whatsapp.js

function normalizeChatId(input) {
  if (!input) return null;

  const s = String(input).trim();

  // Déjà un chatId WA
  if (s.includes("@")) {
    if (s.endsWith("@s.whatsapp.net")) return s.replace("@s.whatsapp.net", "@c.us");
    // @lid -> on garde tel quel
    return s;
  }

  // Sinon, on transforme un numéro en chatId
  const digits = s.replace(/[^\d]/g, "");
  return digits ? `${digits}@c.us` : null;
}

function withNoTrailingSlash(url) {
  if (!url) return url;
  return String(url).replace(/\/+$/, "");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/**
 * Envoi message via WAHA
 * @param {Object} params
 * @param {Object} params.merchant - doit contenir merchant.waha_session
 * @param {string} [params.chatId]  - id du chat (ex: 22507...@c.us / @g.us / @lid)
 * @param {string} [params.to]      - fallback numéro (ex: +22507...)
 * @param {string} params.text      - message à envoyer
 */
export async function sendWhatsappMessage({ merchant, chatId, to, text }) {
  const baseUrl = withNoTrailingSlash(process.env.WAHA_BASE_URL || "");
  const apiKey = process.env.WAHA_API_KEY || "";
  const session = merchant?.waha_session;

  if (!baseUrl) throw new Error("WAHA_BASE_URL manquant");
  if (!apiKey) throw new Error("WAHA_API_KEY manquant");
  if (!session) throw new Error("merchant.waha_session manquant (merchant non lié à WAHA)");
  if (!text || !String(text).trim()) throw new Error("text vide");

  const finalChatId = normalizeChatId(chatId) || normalizeChatId(to);
  if (!finalChatId) throw new Error("Missing chatId/to (impossible de construire le chatId)");

  const url = `${baseUrl}/api/sendText`;

  const payload = { session, chatId: finalChatId, text: String(text) };

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify(payload),
    },
    15000
  );

  const body = await res.text();
  console.log("[WAHA sendText]", {
    session,
    chatId: finalChatId,
    status: res.status,
    ok: res.ok,
    body: body?.slice(0, 500),
  });

  if (!res.ok) {
    throw new Error(`WAHA sendText failed: ${res.status} ${body}`);
  }

  // WAHA peut renvoyer du JSON ou du texte
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
