// services/commandbot.js - VERSION AVEC LOGS DE DEBUG
import axios from "axios";
import crypto from "crypto";

// URL de ton workflow n8n CommandBot
const COMMANDBOT_API_URL =
  process.env.COMMANDBOT_API_URL ||
  "https://n8n.srv853938.hstgr.cloud/webhook/commandBot";

const TIMEOUT_MS = Number(process.env.COMMANDBOT_TIMEOUT_MS || 30000);
const MAX_RETRIES = Number(process.env.COMMANDBOT_RETRIES || 1);

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

const VALID_CUSTOMER_FIELDS = new Set([
  "name",
  "address",
  "payment_method",
]);

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

function extractFirstJsonFromText(text) {
  const s = (text || "").trim();
  if (!s) return null;

  const direct = tryParseJsonString(s);
  if (direct) return direct;

  const firstObj = s.indexOf("{");
  const lastObj = s.lastIndexOf("}");
  if (firstObj !== -1 && lastObj !== -1 && lastObj > firstObj) {
    const candidate = s.slice(firstObj, lastObj + 1);
    const parsed = tryParseJsonString(candidate);
    if (parsed) return parsed;
  }

  const firstArr = s.indexOf("[");
  const lastArr = s.lastIndexOf("]");
  if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) {
    const candidate = s.slice(firstArr, lastArr + 1);
    const parsed = tryParseJsonString(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function unwrapN8nResponse(raw) {
  if (raw == null) return null;

  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    const first = raw[0];
    if (isPlainObject(first) && isPlainObject(first.json)) return first.json;
    return first;
  }

  if (isPlainObject(raw)) {
    if (isPlainObject(raw.json)) return raw.json;
    if (isPlainObject(raw.data)) return raw.data;
    if (isPlainObject(raw.output)) return raw.output;
    return raw;
  }

  if (typeof raw === "string") {
    return extractFirstJsonFromText(raw) || { message: raw };
  }

  return { message: safeString(raw) };
}

function validateAction(action, requestId) {
  if (!action || typeof action !== "object") return false;
  
  if (!VALID_ACTION_TYPES.has(action.type)) {
    console.warn(`[CommandBot] (${requestId}) ⚠️ Action type invalide ignorée: ${action.type}`);
    return false;
  }
  
  switch (action.type) {
    case "ADD_TO_CART":
    case "REMOVE_FROM_CART":
      if (typeof action.product_id !== "number" || action.product_id <= 0 || !Number.isInteger(action.product_id)) {
        console.warn(`[CommandBot] (${requestId}) ⚠️ ${action.type}: product_id invalide (${action.product_id})`);
        return false;
      }
      if (action.quantity !== undefined) {
        if (typeof action.quantity !== "number" || action.quantity <= 0 || !Number.isInteger(action.quantity)) {
          console.warn(`[CommandBot] (${requestId}) ⚠️ ${action.type}: quantity invalide (${action.quantity})`);
          return false;
        }
      }
      break;

    case "UPDATE_CUSTOMER":
      if (!action.field || !VALID_CUSTOMER_FIELDS.has(action.field)) {
        console.warn(`[CommandBot] (${requestId}) ⚠️ UPDATE_CUSTOMER: field invalide ou non autorisé (${action.field})`);
        return false;
      }
      if (typeof action.value !== "string" || action.value.trim().length === 0) {
        console.warn(`[CommandBot] (${requestId}) ⚠️ UPDATE_CUSTOMER: value invalide`);
        return false;
      }
      break;

    case "SET_STATE":
      if (action.state !== null && !isPlainObject(action.state)) {
        console.warn(`[CommandBot] (${requestId}) ⚠️ SET_STATE: state doit être un objet ou null`);
        return false;
      }
      break;

    case "ASK_INFO":
      if (!action.field || typeof action.field !== "string") {
        console.warn(`[CommandBot] (${requestId}) ⚠️ ASK_INFO: field manquant ou invalide`);
        return false;
      }
      break;

    default:
      break;
  }
  
  return true;
}

function sanitizeForLog(text) {
  if (!text || typeof text !== "string") return text;
  
  let sanitized = text;
  sanitized = sanitized.replace(/\+?225\d{8,10}/g, "225XXXXXXXX");
  sanitized = sanitized.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "***@***.***");
  sanitized = sanitized.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "XXX.XXX.XXX.XXX");
  
  if (sanitized.length > 500) {
    sanitized = sanitized.substring(0, 500) + "... [tronqué]";
  }
  
  return sanitized;
}

function normalizeBotResult(obj, requestId) {
  const base = unwrapN8nResponse(obj) || {};

  const candidate =
    (isPlainObject(base.result) && base.result) ||
    (isPlainObject(base.response) && base.response) ||
    base;

  const msg =
    typeof candidate.message === "string"
      ? candidate.message
      : typeof candidate.text === "string"
      ? candidate.text
      : "";

  const rawActions = Array.isArray(candidate.actions) ? candidate.actions : [];
  const validActions = rawActions.filter((a) => validateAction(a, requestId));
  
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

function shouldRetry(err) {
  const code = err?.code;
  const status = err?.response?.status;
  if (code === "ECONNABORTED" || code === "ECONNRESET" || code === "ETIMEDOUT") return true;
  if (status && status >= 500) return true;
  return false;
}

// ================================
// Main - AVEC LOGS DE DEBUG
// ================================
export async function callCommandBot(agentInput) {
  const requestId = crypto.randomBytes(8).toString("hex");

  // ✅ LOGS DE DEBUG AJOUTÉS ICI
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[CommandBot] (${requestId}) 🔍 DEBUG INPUT`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📥 Message:", sanitizeForLog(agentInput.message));
  console.log("🏪 Merchant:", agentInput.merchant?.name, "(ID:", agentInput.merchant?.id, ")");
  console.log("👤 Customer:", agentInput.customer?.phone, "(ID:", agentInput.customer?.id, ")");
  console.log("📦 Produits:", agentInput.products?.length || 0, "produits");
  
  if (agentInput.products && agentInput.products.length > 0) {
    console.log("   Exemples:");
    agentInput.products.slice(0, 3).forEach(p => {
      console.log(`   - ${p.name} (${p.price} ${p.currency}) - Code: ${p.code || 'N/A'}`);
    });
  } else {
    console.log("   ⚠️ ATTENTION : Aucun produit envoyé à l'IA !");
  }
  
  console.log("🛒 Panier:", agentInput.cart?.length || 0, "articles");
  console.log("📊 État:", JSON.stringify(agentInput.conversation_state || {}, null, 2));
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

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
        validateStatus: (s) => s >= 200 && s < 500,
      });

      if (response.status >= 400) {
        console.error(`[CommandBot] (${requestId}) ❌ n8n error status=${response.status}`, response.data);
        
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
      const normalized = normalizeBotResult(raw, requestId);
      normalized.message = safeString(normalized.message).trim();

      console.log(`[CommandBot] (${requestId}) ✅ Réponse normalisée :`, {
        message: sanitizeForLog(normalized.message),
        actionsCount: normalized.actions.length,
        actionTypes: normalized.actions.map(a => a.type).join(", "),
      });

      return normalized;
    } catch (error) {
      const details = error?.response?.data || error?.message;
      const errorCode = error?.code;
      
      console.error(`[CommandBot] (${requestId}) ❌ Erreur appel n8n (attempt ${attempt}/${MAX_RETRIES + 1}):`, {
        code: errorCode,
        message: error?.message,
        status: error?.response?.status,
        details: typeof details === "string" ? details.substring(0, 200) : details,
      });

      if (attempt <= MAX_RETRIES && shouldRetry(error)) {
        console.log(`[CommandBot] (${requestId}) 🔄 Retry automatique...`);
        continue;
      }

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

  console.error(`[CommandBot] (${requestId}) ❌ Tous les retries ont échoué`);
  return { 
    message: "Désolé, erreur inconnue après plusieurs tentatives.", 
    actions: [] 
  };
}

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