// services/whatsapp.js

// ✅ CORRECTION #1: Import fetch pour compatibilité Node < 18
// Décommenter si Node.js < 18
// import fetch from 'node-fetch';

// ✅ CORRECTION #2: Configuration centralisée
const WAHA_CONFIG = {
  baseUrl: process.env.WAHA_BASE_URL || "",
  apiKey: process.env.WAHA_API_KEY || "",
  timeout: {
    text: Number(process.env.WAHA_TIMEOUT_TEXT) || 15000,      // 15s pour texte
    media: Number(process.env.WAHA_TIMEOUT_MEDIA) || 45000,    // 45s pour images/vidéos
  },
  retries: Number(process.env.WAHA_RETRIES) || 2,              // 2 retries par défaut
};


// Validation au démarrage
if (WAHA_CONFIG.baseUrl && !WAHA_CONFIG.apiKey) {
  console.warn("[WAHA] ⚠️ WAHA_BASE_URL configuré mais WAHA_API_KEY manquant");
}

import fs from 'fs';
/**
 * ✅ CORRECTION #3: Normalisation chatId avec validation
 */
function normalizeChatId(input) {
  if (!input) return null;

  const s = String(input).trim();

  // Déjà un chatId WA
  if (s.includes("@")) {
    if (s.endsWith("@s.whatsapp.net")) return s.replace("@s.whatsapp.net", "@c.us");
    // @lid -> on garde tel quel
    if (s.endsWith("@lid") || s.endsWith("@c.us") || s.endsWith("@g.us")) {
      return s;
    }
    // Autre format inconnu
    console.warn("[WAHA] ⚠️ Format chatId inconnu:", s);
    return s; // On laisse passer, WAHA décidera
  }

  // Sinon, on transforme un numéro en chatId
  const digits = s.replace(/[^\d]/g, "");
  
  // ✅ Validation: au moins 8 chiffres
  if (!digits || digits.length < 8) {
    console.warn("[WAHA] ⚠️ Numéro trop court pour chatId:", s);
    return null;
  }
  
  return `${digits}@c.us`;
}

/**
 * ✅ CORRECTION #4: Sanitizer pour logs (RGPD)
 */
function sanitizeChatIdForLog(chatId) {
  if (!chatId) return chatId;
  
  // Masquer les 6 derniers chiffres avant @
  // Exemple: 225XXXXXXXXXX@c.us -> 225XXXXX@c.us
  return String(chatId).replace(/(\d{3})\d+(@.+)/, "$1XXXXX$2");
}

function withNoTrailingSlash(url) {
  if (!url) return url;
  return String(url).replace(/\/+$/, "");
}

/**
 * ✅ CORRECTION #5: Fetch avec timeout et retry
 */
async function fetchWithRetry(url, options = {}, timeoutMs = 15000, maxRetries = 2) {
  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      
      try {
        const response = await fetch(url, { 
          ...options, 
          signal: controller.signal 
        });
        
        clearTimeout(timeoutId);
        return response;
        
      } catch (fetchError) {
        clearTimeout(timeoutId);
        throw fetchError;
      }
      
    } catch (error) {
      lastError = error;
      const isTimeout = error.name === 'AbortError';
      const isNetworkError = error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT';
      
      // Retry seulement sur timeout ou erreur réseau
      if ((isTimeout || isNetworkError) && attempt < maxRetries) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt), 5000); // Exponential backoff
        console.warn(`[WAHA] 🔄 Retry ${attempt + 1}/${maxRetries} après ${delayMs}ms`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      
      throw error;
    }
  }
  
  throw lastError;
}

/**
 * ✅ CORRECTION #6: Fonction générique sendMessage
 */
async function sendWahaMessage(endpoint, payload, timeoutMs = WAHA_CONFIG.timeout.text) {
  const baseUrl = withNoTrailingSlash(WAHA_CONFIG.baseUrl);
  const apiKey = WAHA_CONFIG.apiKey;

  if (!baseUrl) {
    throw new Error("WAHA_BASE_URL manquant dans .env");
  }
  if (!apiKey) {
    throw new Error("WAHA_API_KEY manquant dans .env");
  }

  const url = `${baseUrl}${endpoint}`;

  try {
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": apiKey,
        },
        body: JSON.stringify(payload),
      },
      timeoutMs,
      WAHA_CONFIG.retries
    );

    const body = await res.text();
    
    // ✅ Log sanitizé
    console.log("[WAHA]", {
      endpoint,
      session: payload.session,
      chatId: sanitizeChatIdForLog(payload.chatId),
      status: res.status,
      ok: res.ok,
      responsePreview: body?.slice(0, 200),
    });

    if (!res.ok) {
      throw new Error(`WAHA ${endpoint} failed: ${res.status} ${body}`);
    }

    // WAHA peut renvoyer du JSON ou du texte
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
    
  } catch (error) {
    console.error("[WAHA] ❌ Erreur:", {
      endpoint,
      error: error.message,
      code: error.code,
      name: error.name,
    });
    throw error;
  }
}

/**
 * Envoi message texte via WAHA
 * @param {Object} params
 * @param {Object} params.merchant - doit contenir merchant.waha_session
 * @param {string} [params.chatId]  - id du chat (ex: 22507...@c.us / @g.us / @lid)
 * @param {string} [params.to]      - fallback numéro (ex: +22507...)
 * @param {string} params.text      - message à envoyer
 */


export async function sendWhatsappMessage({ merchant, chatId, to, text }) {
  const session = merchant?.waha_session;

  if (!session) {
    throw new Error("merchant.waha_session manquant (merchant non lié à WAHA)");
  }
  
  if (!text || !String(text).trim()) {
    throw new Error("text vide");
  }

  const finalChatId = normalizeChatId(chatId) || normalizeChatId(to);
  
  if (!finalChatId) {
    throw new Error("Missing chatId/to (impossible de construire le chatId)");
  }

  const payload = { 
    session, 
    chatId: finalChatId, 
    text: String(text).trim() 
  };

  return sendWahaMessage("/api/sendText", payload, WAHA_CONFIG.timeout.text);
}

/**
 * ✅ NOUVEAU: Envoi d'image via WAHA
 * @param {Object} params
 * @param {Object} params.merchant
 * @param {string} params.chatId
 * @param {string} params.imageUrl - URL de l'image
 * @param {string} [params.caption] - Légende optionnelle
 */
export async function sendWhatsappImage({ merchant, chatId, to, imageUrl, caption = "" }) {
  const session = merchant?.waha_session;

  if (!session) {
    throw new Error("merchant.waha_session manquant");
  }
  
  if (!imageUrl || !String(imageUrl).trim()) {
    throw new Error("imageUrl vide");
  }

  const finalChatId = normalizeChatId(chatId) || normalizeChatId(to);
  
  if (!finalChatId) {
    throw new Error("Missing chatId/to");
  }

  const payload = {
    session,
    chatId: finalChatId,
    file: {
      url: imageUrl,
      mimetype: "image/jpeg", // Adapter si besoin
    },
    caption: caption || "",
  };

  // ✅ Timeout plus long pour les médias
  return sendWahaMessage("/api/sendImage", payload, WAHA_CONFIG.timeout.media);
}

/**
 * Envoie un document (PDF, image, etc.) via WhatsApp
 */
export async function sendWhatsappDocument({ merchant, chatId, to, filePath, filename, caption = '' }) {
  const wahaUrl = process.env.WAHA_URL || 'http://localhost:3000';
  const sessionName = merchant.waha_session;

  if (!sessionName) {
    console.warn('[WAHA] Pas de waha_session configurée pour ce marchand');
    return null;
  }

  try {
    // ✅ Vérifier que le fichier existe
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Fichier introuvable: ${filePath}`);
    }

    // ✅ Lire le fichier en base64
    const fileBuffer = fs.readFileSync(filePath);
    const fileBase64 = fileBuffer.toString('base64');
    
    // ✅ Essayer plusieurs endpoints possibles
    const endpoints = [
      `/api/${sessionName}/sendFile`,
      `/api/sendFile/${sessionName}`,
      `/api/${sessionName}/sendDocument`,
      `/api/${sessionName}/sendMedia`
    ];

    for (const endpoint of endpoints) {
      const url = `${wahaUrl}${endpoint}`;
      
      console.log(`[WAHA] Tentative envoi document: ${url}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chatId: chatId,
          file: {
            mimetype: 'application/pdf',
            filename: filename,
            data: fileBase64
          },
          caption: caption || ''
        })
      });

      const status = response.status;
      
      if (status !== 404) {
        // Cet endpoint existe !
        const ok = response.ok;
        const data = await response.json().catch(() => ({}));
        
        console.log('[WAHA] Document envoyé:', { 
          endpoint,
          session: sessionName, 
          chatId, 
          filename,
          status, 
          ok,
          response: JSON.stringify(data).substring(0, 200)
        });

        return { ok, status, data };
      }
    }

    throw new Error('Aucun endpoint valide trouvé pour envoyer des fichiers');

  } catch (error) {
    console.error('[WAHA] Erreur envoi document:', error);
    throw error;
  }
}
/**
 * ✅ NOUVEAU: Health check WAHA
 */
export async function wahaHealthCheck() {
  const baseUrl = withNoTrailingSlash(WAHA_CONFIG.baseUrl);
  const apiKey = WAHA_CONFIG.apiKey;

  if (!baseUrl || !apiKey) {
    return {
      ok: false,
      error: "WAHA non configuré (WAHA_BASE_URL ou WAHA_API_KEY manquant)",
    };
  }

  try {
    const res = await fetchWithRetry(
      `${baseUrl}/api/health`,
      {
        method: "GET",
        headers: {
          "X-API-KEY": apiKey,
        },
      },
      5000, // Timeout court pour health check
      1     // 1 seul retry
    );

    const body = await res.text();
    
    return {
      ok: res.ok,
      status: res.status,
      response: body,
    };
    
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      code: error.code,
    };
  }
}

/**
 * ✅ NOUVEAU: Vérifier le statut d'une session
 */
export async function getSessionStatus(sessionName) {
  const baseUrl = withNoTrailingSlash(WAHA_CONFIG.baseUrl);
  const apiKey = WAHA_CONFIG.apiKey;

  if (!baseUrl || !apiKey) {
    throw new Error("WAHA non configuré");
  }

  try {
    const res = await fetchWithRetry(
      `${baseUrl}/api/sessions/${sessionName}`,
      {
        method: "GET",
        headers: {
          "X-API-KEY": apiKey,
        },
      },
      5000,
      1
    );

    const body = await res.text();
    
    if (!res.ok) {
      throw new Error(`Session status failed: ${res.status} ${body}`);
    }

    return JSON.parse(body);
    
  } catch (error) {
    console.error("[WAHA] ❌ getSessionStatus error:", error.message);
    throw error;
  }
}