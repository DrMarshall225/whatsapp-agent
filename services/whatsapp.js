// services/whatsapp.js

// Version simple : en dev on LOG juste le message.
// Tu peux ensuite décommenter la partie "appel API" plus bas pour l’intégrer à WAHA ou autre.

export async function sendWhatsappMessage({ to, from, text }) {
  console.log("✅ [sendWhatsappMessage] Message à envoyer :", { to, from, text });

  // 👉 Ici, en DEV, on ne fait rien d'autre.
  // Si tu veux vraiment appeler ton gateway WhatsApp (WAHA, Cloud API, etc.),
  // adapte l’exemple ci-dessous :

  /*
  const WAHA_API_URL = process.env.WAHA_API_URL || "http://localhost:3000/api/sendMessage";
  const WAHA_API_TOKEN = process.env.WAHA_API_TOKEN || "TON_TOKEN";

  const response = await fetch(WAHA_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${WAHA_API_TOKEN}`,
    },
    body: JSON.stringify({
      to,
      from,
      text,
      // adapte selon le format attendu par ton provider
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error("❌ Erreur en envoyant le message WhatsApp :", body);
    throw new Error("Erreur d'envoi WhatsApp");
  }
  */

  return true;
}
