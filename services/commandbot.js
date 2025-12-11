// services/commandbot.js
import axios from "axios";
import crypto from "crypto";

// URL de ton workflow n8n CommandBot
const COMMANDBOT_API_URL =
  process.env.COMMANDBOT_API_URL ||
  "https://n8n.srv853938.hstgr.cloud/webhook/commandBot";

// ✅ CORRECTION #1: Timeout augmenté à 30 secondes pour OpenAI
const TIMEOUT_MS = Number(process.env.COMMANDBOT_TIMEOUT_MS || 30000); // 30 sec au lieu de 15
const MAX_RETRIES = Number(process.env.COMMANDBOT_RETRIES || 1);

// ✅ CORRECTION #2: Whitelist des actions autorisées (sécurité)
const VALID_ACTION_TYPES = new Set([
  "ADD_TO_CART",
  "REMOVE_FROM_CART",
  "CLEAR_CART",
  "SET_STATE",
  "ASK_INFO",
  "UPDATE_CUSTOMER",
  "CONFIRM_ORDER",
  "SHOW_LAST_ORDER",
  "CANCEL_LAST_ORDER",
  "MODIFY_LAST_ORDER",
]);

// ✅ CORRECTION #3: Champs autorisés pour UPDATE_CUSTOMER (sécurité)
const VALID_CUSTOMER_FIELDS = new Set([
  "name",
  "address",
  "payment_method",
]);

// ================================
// Helpers parsing / normalization
// ================================
function safeString(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return String(v);
  } catch {
    return "";
  }
}

function isPlainObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

/**
 * Essaie de parser une chaîne en JSON.
 * - retourne null si échec
 */
function tryParseJsonString(str) {
  const s = (str || "").trim();
  if (!s) return null;
  if (!(s.startsWith("{") || s.startsWith("["))) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Extrait un JSON contenu dans du texte (ex: "bla bla { ... }").
 * - prend le premier bloc { ... } ou [ ... ]
 */
function extractFirstJsonFromText(text) {
  const s = (text || "").trim();
  if (!s) return null;

  // si déjà JSON pur
  const direct = tryParseJsonString(s);
  if (direct) return direct;

  // cherche un bloc { ... }
  const firstObj = s.indexOf("{");
  const lastObj = s.lastIndexOf("}");
  if (firstObj !== -1 && lastObj !== -1 && lastObj > firstObj) {
    const candidate = s.slice(firstObj, lastObj + 1);
    const parsed = tryParseJsonString(candidate);
    if (parsed) return parsed;
  }

  // cherche un bloc [ ... ]
  const firstArr = s.indexOf("[");
  const lastArr = s.lastIndexOf("]");
  if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) {
    const candidate = s.slice(firstArr, lastArr + 1);
    const parsed = tryParseJsonString(candidate);
    if (parsed) return parsed;
  }

  return null;
}

/**
 * n8n peut renvoyer :
 * - { message, actions }
 * - [{...}] (array)
 * - { data: {...} }
 * - { output: {...} }
 * - string JSON
 * - texte + JSON
 */
function unwrapN8nResponse(raw) {
  if (raw == null) return null;

  // tableau => prendre le 1er élément utile
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    // souvent n8n renvoie [ { json: {...} } ] ou [ {...} ]
    const first = raw[0];
    if (isPlainObject(first) && isPlainObject(first.json)) return first.json;
    return first;
  }

  // objet avec json / data / output
  if (isPlainObject(raw)) {
    if (isPlainObject(raw.json)) return raw.json;
    if (isPlainObject(raw.data)) return raw.data;
    if (isPlainObject(raw.output)) return raw.output;
    return raw;
  }

  // string => essayer JSON
  if (typeof raw === "string") {
    return extractFirstJsonFromText(raw) || { message: raw };
  }

  return { message: safeString(raw) };
}

// ✅ CORRECTION #4: Validation stricte des actions (sécurité)
function validateAction(action, requestId) {
  if (!action || typeof action !== "object") return false;
  
  // Vérifier que le type est dans la whitelist
  if (!VALID_ACTION_TYPES.has(action.type)) {
    console.warn(`[CommandBot] (${requestId}) ⚠️ Action type invalide ignorée: ${action.type}`);
    return false;
  }
  
  // Validation spécifique par type
  switch (action.type) {
    case "ADD_TO_CART":
    case "REMOVE_FROM_CART":
      // product_id doit être un nombre positif
      if (typeof action.product_id !== "number" || action.product_id <= 0 || !Number.isInteger(action.product_id)) {
        console.warn(`[CommandBot] (${requestId}) ⚠️ ${action.type}: product_id invalide (${action.product_id})`);
        return false;
      }
      // quantity (optionnelle) doit être un nombre positif
      if (action.quantity !== undefined) {
        if (typeof action.quantity !== "number" || action.quantity <= 0 || !Number.isInteger(action.quantity)) {
          console.warn(`[CommandBot] (${requestId}) ⚠️ ${action.type}: quantity invalide (${action.quantity})`);
          return false;
        }
      }
      break;

    case "UPDATE_CUSTOMER":
      // field doit être dans la whitelist
      if (!action.field || !VALID_CUSTOMER_FIELDS.has(action.field)) {
        console.warn(`[CommandBot] (${requestId}) ⚠️ UPDATE_CUSTOMER: field invalide ou non autorisé (${action.field})`);
        return false;
      }
      // value doit être une string non vide
      if (typeof action.value !== "string" || action.value.trim().length === 0) {
        console.warn(`[CommandBot] (${requestId}) ⚠️ UPDATE_CUSTOMER: value invalide`);
        return false;
      }
      break;

    case "SET_STATE":
      // state doit être un objet (ou null pour reset)
      if (action.state !== null && !isPlainObject(action.state)) {
        console.warn(`[CommandBot] (${requestId}) ⚠️ SET_STATE: state doit être un objet ou null`);
        return false;
      }
      break;

    case "ASK_INFO":
      // field doit être une string non vide
      if (!action.field || typeof action.field !== "string") {
        console.warn(`[CommandBot] (${requestId}) ⚠️ ASK_INFO: field manquant ou invalide`);
        return false;
      }
      break;

    // Les autres actions (CLEAR_CART, CONFIRM_ORDER, etc.) n'ont pas de paramètres obligatoires
    default:
      break;
  }
  
  return true;
}

// ✅ CORRECTION #5: Sanitizer pour logs (RGPD/sécurité)
function sanitizeForLog(text) {
  if (!text || typeof text !== "string") return text;
  
  let sanitized = text;
  
  // Masquer numéros de téléphone (format 225XXXXXXXXXX ou +225XXXXXXXXXX)
  sanitized = sanitized.replace(/\+?225\d{8,10}/g, "225XXXXXXXX");
  
  // Masquer emails
  sanitized = sanitized.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "***@***.***");
  
  // Masquer adresses IP
  sanitized = sanitized.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "XXX.XXX.XXX.XXX");
  
  // Tronquer si trop long (éviter de logger des messages de 10k caractères)
  if (sanitized.length > 500) {
    sanitized = sanitized.substring(0, 500) + "... [tronqué]";
  }
  
  return sanitized;
}

/**
 * Normalise vers { message: string, actions: [] }
 */
function normalizeBotResult(obj, requestId) {
  const base = unwrapN8nResponse(obj) || {};

  // parfois: { result: { message, actions } }
  const candidate =
    (isPlainObject(base.result) && base.result) ||
    (isPlainObject(base.response) && base.response) ||
    base;

  // parfois message est dans "text"
  const msg =
    typeof candidate.message === "string"
      ? candidate.message
      : typeof candidate.text === "string"
      ? candidate.text
      : "";

  // ✅ Validation stricte des actions
  const rawActions = Array.isArray(candidate.actions) ? candidate.actions : [];
  const validActions = rawActions.filter((a) => validateAction(a, requestId));
  
  // Log si des actions ont été rejetées
  if (rawActions.length > validActions.length) {
    console.warn(
      `[CommandBot] (${requestId}) ⚠️ ${rawActions.length - validActions.length} action(s) rejetée(s) sur ${rawActions.length}`
    );
  }

  return {
    message: msg,
    actions: validActions,
  };
}

/**
 * Petit retry sur erreurs réseau (timeout / 5xx / ECONNRESET)
 */
function shouldRetry(err) {
  const code = err?.code;
  const status = err?.response?.status;
  if (code === "ECONNABORTED" || code === "ECONNRESET" || code === "ETIMEDOUT") return true;
  if (status && status >= 500) return true;
  return false;
}

// ================================
// Main
// ================================
/**
 * Appelle le workflow n8n CommandBot avec l'agentInput
 * et retourne { message, actions } au format attendu par server.js
 *
 * @param {object} agentInput - objet construit dans server.js (message, merchant, customer, cart, products, conversation_state)
 * @returns {Promise<{ message: string, actions: Array }>}
 */
export async function callCommandBot(agentInput) {
  const requestId = crypto.randomBytes(8).toString("hex");

  // Payload attendu par ton webhook n8n
  const payload = {
    request_id: requestId,
    message: agentInput,
  };

  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      attempt++;

      console.log(`[CommandBot] (${requestId}) Appel n8n (attempt ${attempt}/${MAX_RETRIES + 1}) :`, COMMANDBOT_API_URL);

      const response = await axios.post(COMMANDBOT_API_URL, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: TIMEOUT_MS,
        // utile si ton n8n est derrière un proxy:
        validateStatus: (s) => s >= 200 && s < 500,
      });

      // ✅ CORRECTION #6: Messages d'erreur plus détaillés en développement
      if (response.status >= 400) {
        console.error(`[CommandBot] (${requestId}) ❌ n8n error status=${response.status}`, response.data);
        
        // En développement, renvoyer l'erreur détaillée
        if (process.env.NODE_ENV === "development") {
          return {
            message: `⚠️ Erreur technique (${response.status}): ${JSON.stringify(response.data).substring(0, 200)}`,
            actions: [],
          };
        }
        
        return {
          message: "Désolé, je n'ai pas pu traiter votre demande pour le moment.",
          actions: [],
        };
      }

      const raw = response.data;
      // console.log(`[CommandBot] (${requestId}) Réponse brute n8n :`, raw);

      const normalized = normalizeBotResult(raw, requestId);

      // IMPORTANT: si message est null/undefined => message vide
      normalized.message = safeString(normalized.message).trim();

      // ✅ CORRECTION #7: Log sanitizé (RGPD)
      console.log(`[CommandBot] (${requestId}) ✅ Réponse normalisée :`, {
        message: sanitizeForLog(normalized.message),
        actionsCount: normalized.actions.length,
        actionTypes: normalized.actions.map(a => a.type).join(", "),
      });

      return normalized;
    } catch (error) {
      const details = error?.response?.data || error?.message;
      const errorCode = error?.code;
      
      // ✅ CORRECTION #8: Logs d'erreur plus détaillés
      console.error(`[CommandBot] (${requestId}) ❌ Erreur appel n8n (attempt ${attempt}/${MAX_RETRIES + 1}):`, {
        code: errorCode,
        message: error?.message,
        status: error?.response?.status,
        details: typeof details === "string" ? details.substring(0, 200) : details,
      });

      if (attempt <= MAX_RETRIES && shouldRetry(error)) {
        // retry soft immédiat
        console.log(`[CommandBot] (${requestId}) 🔄 Retry automatique...`);
        continue;
      }

      // Message d'erreur adapté selon le type d'erreur
      let userMessage = "Désolé, le service a un souci technique pour le moment. Merci de réessayer plus tard 🙂";
      
      if (errorCode === "ECONNABORTED" || errorCode === "ETIMEDOUT") {
        userMessage = "Le service met trop de temps à répondre. Merci de réessayer dans quelques instants 🙂";
      } else if (error?.response?.status === 503) {
        userMessage = "Le service est temporairement indisponible. Merci de réessayer dans 1-2 minutes 🙂";
      }

      return {
        message: userMessage,
        actions: [],
      };
    }
  }

  // fallback (ne devrait pas arriver)
  console.error(`[CommandBot] (${requestId}) ❌ Tous les retries ont échoué`);
  return { 
    message: "Désolé, erreur inconnue après plusieurs tentatives.", 
    actions: [] 
  };
}

// ✅ BONUS: Fonction utilitaire pour tester la connexion (optionnel)
export async function healthCheckCommandBot() {
  try {
    const testPayload = {
      request_id: "health-check",
      message: {
        message: "ping",
        merchant: { id: 0, name: "health-check" },
        customer: { id: 0, phone: "+0000000000", name: "health-check" },
        cart: { items: [], total: 0 },
        products: [],
        conversation_state: {},
      },
    };

    const response = await axios.post(COMMANDBOT_API_URL, testPayload, {
      headers: { "Content-Type": "application/json" },
      timeout: 5000,
      validateStatus: (s) => s >= 200 && s < 500,
    });

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      latency: response.headers?.['x-response-time'] || 'N/A',
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      code: error.code,
    };
  }
}