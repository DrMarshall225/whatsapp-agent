// services/commandbot.js
import axios from "axios";

// URL de ton workflow n8n CommandBot
const COMMANDBOT_API_URL =
  process.env.COMMANDBOT_API_URL ||
  "https://n8n.srv853938.hstgr.cloud/webhook/commandBot";

/**
 * Appelle le workflow n8n CommandBot avec l'agentInput
 * et retourne { message, actions } au format attendu par server.js
 *
 * @param {object} agentInput - objet construit dans server.js (message, merchant, customer, cart, products, conversation_state)
 * @returns {Promise<{ message: string, actions: Array }>}
 */
export async function callCommandBot(agentInput) {
  try {
    // Ce payload doit correspondre à ce que ton node Webhook n8n attend
    const payload = {
      message: agentInput,
    };

    console.log("[CommandBot] Appel n8n :", COMMANDBOT_API_URL);
    // Appel HTTP vers n8n
    const response = await axios.post(COMMANDBOT_API_URL, payload, {
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 15000, // 15s par sécurité
    });

    const data = response.data || {};
    console.log("[CommandBot] Réponse brute n8n :", data);

    // Normalisation de la réponse
    const result = {
      message:
        typeof data.message === "string"
          ? data.message
          : "Désolé, je n'ai pas pu traiter votre demande pour le moment.",
      actions: Array.isArray(data.actions) ? data.actions : [],
    };

    console.log("[CommandBot] Réponse normalisée :", result);
    return result;
  } catch (error) {
    console.error(
      "[CommandBot] Erreur appel n8n :",
      error.response?.data || error.message
    );

    // On renvoie une réponse safe pour ne pas casser le webhook WhatsApp
    return {
      message:
        "Désolé, le robot a un problème technique pour le moment. Merci de réessayer plus tard 🙏",
      actions: [],
    };
  }
}
