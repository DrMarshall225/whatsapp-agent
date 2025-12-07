// services/commandbot.js
import axios from "axios";
import crypto from "crypto";

// URL de ton workflow n8n CommandBot
const COMMANDBOT_API_URL =
  process.env.COMMANDBOT_API_URL ||
  "https://n8n.srv853938.hstgr.cloud/webhook/commandBot";

const TIMEOUT_MS = Number(process.env.COMMANDBOT_TIMEOUT_MS || 15000);
const MAX_RETRIES = Number(process.env.COMMANDBOT_RETRIES || 1);

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

/**
 * Normalise vers { message: string, actions: [] }
 */
function normalizeBotResult(obj) {
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

  const actions = Array.isArray(candidate.actions) ? candidate.actions : [];

  return {
    message: msg,
    actions,
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

      // Si n8n renvoie 4xx => on ne retry pas, on log et on retourne safe
      if (response.status >= 400) {
        console.error(`[CommandBot] (${requestId}) n8n error status=${response.status}`, response.data);
        return {
          message: "Désolé, je n'ai pas pu traiter votre demande pour le moment.",
          actions: [],
        };
      }

      const raw = response.data;
      // console.log(`[CommandBot] (${requestId}) Réponse brute n8n :`, raw);

      const normalized = normalizeBotResult(raw);

      // IMPORTANT: si message est null/undefined => message vide
      normalized.message = safeString(normalized.message).trim();

      // Sécurité: actions doit être array d'objets
      normalized.actions = Array.isArray(normalized.actions) ? normalized.actions.filter((a) => a && typeof a === "object") : [];

      console.log(`[CommandBot] (${requestId}) Réponse normalisée :`, {
        message: normalized.message,
        actionsCount: normalized.actions.length,
      });

      return normalized;
    } catch (error) {
      const details = error?.response?.data || error?.message;
      console.error(`[CommandBot] (${requestId}) Erreur appel n8n :`, details);

      if (attempt <= MAX_RETRIES && shouldRetry(error)) {
        // retry soft immédiat
        continue;
      }

      return {
        message: "Désolé, le service a un souci technique pour le moment. Merci de réessayer plus tard 🙏",
        actions: [],
      };
    }
  }

  // fallback (ne devrait pas arriver)
  return { message: "Désolé, erreur inconnue.", actions: [] };
}
