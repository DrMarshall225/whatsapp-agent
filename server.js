// server.js (COMPLET - CORRIGÉ ✅)
// Version: 2025-12-30
// Corrections: PDF timeout, gestion erreur robuste, logs détaillés

import cors from "cors";
import express from "express";
import bodyParser from "body-parser";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import multer from "multer";
import path from "path";
import fs from "fs";

import {
  findMerchantByWahaSession,
  findMerchantByWhatsappNumber,
  findOrCreateCustomer,
  getCart,
  getProductsForMerchant,
  getConversationState,
  setConversationState,
  addToCart,
  removeFromCart,
  clearCart,
  createOrderFromCart,
  updateCustomerField,
  getLastOrderWithItemsForCustomer,
  cancelLastOrderForCustomer,
  loadLastOrderToCart,
  createProductForMerchant,
  updateProductForMerchant,
  deleteProductForMerchant,
  getOrdersForMerchant,
  getOrderWithItems,
  updateOrderStatus,
  findMerchantByEmail,
  createMerchant,
  createMerchantWithWaha,
  updateMerchantWahaConfig,
  adminListMerchants,
  adminSetMerchantSuspended,
  adminGetDashboard,
  adminAddSubscriptionPayment,
  adminListSubscriptionPayments,
  getMerchantAccessFlags,
} from "./services/store.pg.js";

import { callCommandBot } from "./services/commandbot.js";
import { sendWhatsappMessage, sendWhatsappDocument } from "./services/whatsapp.js";
import { PORT } from "./config.js";
import { generateCatalogPDF, cleanupPDF } from "./services/catalog-pdf.js";
import { query } from "./db.js";

// ================================
// Config
// ================================
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "5mb" }));

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-a-changer";

// Admin credentials
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

// Cache PDF (optionnel)
const pdfCache = new Map(); // merchantId -> { path, timestamp }

// ================================
// Helpers (Validation & Anti-ACK)
// ================================
const ACK_WORDS = new Set([
  "ok",
  "okay",
  "oui",
  "yes",
  "y",
  "d'accord",
  "daccord",
  "dac",
  "ça marche",
  "ca marche",
  "c'est bon",
  "cest bon",
  "vas-y",
  "vas y",
  "go",
  "bien",
  "👍",
  "👌",
]);

function normText(s) {
  return (s || "").toString().trim().toLowerCase();
}

function isAckValue(val) {
  const t = normText(val);
  if (!t) return true;
  return ACK_WORDS.has(t);
}

function lettersCount(str) {
  return ((str || "").match(/[A-Za-zÀ-ÿ]/g) || []).length;
}

function looksLikeName(val) {
  if (isAckValue(val)) return false;
  const v = (val || "").toString().trim();
  return v.length >= 2 && lettersCount(v) >= 2;
}

function looksLikeAddress(val) {
  if (isAckValue(val)) return false;
  const v = (val || "").toString().trim();

  const hasMinLength = v.length >= 5;
  const hasEnoughLetters = lettersCount(v) >= 3;

  const addressKeywords =
    /\b(angré|angre|cocody|yopougon|abobo|adjamé|adjame|plateau|marcory|koumassi|treichville|rue|avenue|av|boulevard|bd|quartier|résidence|residence|villa|immeuble|tranche|cite|cité)\b/i;
  const hasKeyword = addressKeywords.test(v);

  return hasMinLength && (hasEnoughLetters || hasKeyword);
}

function looksLikePhone(val) {
  if (isAckValue(val)) return false;
  const digits = (val || "").toString().replace(/\D/g, "");
  return digits.length >= 8;
}

function looksLikeDelivery(val) {
  if (isAckValue(val)) return false;
  const t = normText(val);

  return (
    /\b(aujourd'?hui|auj|ce soir|cet? après[ -]?midi|ce matin)\b/.test(t) ||
    /\b(demain|tmrw|2moro)\b/.test(t) ||
    /dans \d+ jours?/.test(t) ||
    /\d{1,2}\s+(janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre|jan|fev|fév|mar|avr|mai|jun|juil|sept|sep|oct|nov|dec|déc)/i.test(
      t
    ) ||
    /\d{4}-\d{2}-\d{2}/.test(t) ||
    /\d{2}\/\d{2}\/\d{4}/.test(t) ||
    /\d{2}-\d{2}-\d{4}/.test(t) ||
    /\b(\d{1,2}h|\d{1,2}:\d{2})\b/.test(t)
  );
}

function looksLikePaymentMethod(val) {
  if (isAckValue(val)) return false;
  const t = normText(val);
  return /\b(cash|espece|espèce|wave|orange|mtn|moov|mobile money|carte|card)\b/.test(t);
}

function validateField(field, value) {
  switch (field) {
    case "name":
    case "self_name":
    case "recipient_name":
      return looksLikeName(value);
    case "address":
    case "recipient_address":
      return looksLikeAddress(value);
    case "phone":
    case "recipient_phone":
      return looksLikePhone(value);
    case "delivery_requested_raw":
      return looksLikeDelivery(value);
    case "payment_method":
      return looksLikePaymentMethod(value);
    case "recipient_mode":
      return !isAckValue(value) && normText(value).length > 0;
    default:
      return !isAckValue(value);
  }
}

// ================================
// Helpers (Phones / WAHA)
// ================================
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

function chatIdToPhone(chatId) {
  if (!chatId) return null;
  const digits = String(chatId).split("@")[0].replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

function phoneToChatId(phone) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  return digits ? `${digits}@c.us` : null;
}

function normalizeWahaChatId(raw) {
  if (!raw) return null;
  const s = String(raw);

  if (s.endsWith("@s.whatsapp.net")) return s.replace("@s.whatsapp.net", "@c.us");
  if (s.endsWith("@lid")) return s;
  if (s.includes("@")) return s;

  const digits = s.replace(/[^\d]/g, "");
  return digits ? `${digits}@c.us` : null;
}

function mapWhatsappPayload(body) {
  return {
    from: body?.from,
    to: body?.to,
    text: body?.text,
  };
}

function normalizeE164(input) {
  if (!input) return null;
  const digits = String(input).replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

// ================================
// Confirmation UX
// ================================
const CONFIRM_WORDS = [
  "confirmer",
  "je confirme",
  "confirm",
  "valider",
  "je valide",
  "ok je confirme",
  "ok je valide",
  "oui je confirme",
  "oui je valide",
  "daccord je confirme",
  "d'accord je confirme",
];

const CANCEL_WORDS = ["annule", "annuler", "cancel", "stop commande", "annule commande"];

function isConfirmIntent(text) {
  const t = normText(text);
  if (!t) return false;
  return CONFIRM_WORDS.some((w) => t === w || t.includes(w));
}

function isCancelIntent(text) {
  const t = normText(text);
  if (!t) return false;
  return CANCEL_WORDS.some((w) => t === w || t.includes(w));
}

function questionFor(field) {
  const q = {
    recipient_mode: "Pour finaliser : c'est pour vous-même (1) ou pour une autre personne (2) ?",
    name: "Quel est votre *nom complet* ? (ex : KONE Aïcha)",
    recipient_name: "Donne-moi le *nom complet* du destinataire. (ex : KONE Aïcha)",
    recipient_phone: "Donne-moi le *numéro WhatsApp* du destinataire. (ex : 225XXXXXXXXXX)",
    recipient_address: "Quelle est l'*adresse complète* du destinataire ? (ex : Cocody Angré 8e tranche…)",
    payment_method: "Quel mode de paiement souhaitez-vous ? (*cash*, *Wave*, *Orange Money*, *MTN*, *carte*)",
    delivery_requested_raw: "Donne la *date/heure de livraison* (ex : 31/12/2025 à 13h ou 2025-12-31 13:00).",
  };
  return q[field] || "Peux-tu préciser ?";
}

function formatCartSummary(cart) {
  const items = Array.isArray(cart) ? cart : cart?.items || [];
  if (!items.length) return "🛒 Panier vide";

  const lines = items.slice(0, 8).map((it) => {
    const qty = it.quantity ?? it.qty ?? 1;
    const name = it.name || it.title || `Produit ${it.product_id || it.id}`;
    const price = it.total_price ?? it.total ?? (it.price ? it.price * qty : null);
    return price != null ? `• ${name} x${qty} — ${price} FCFA` : `• ${name} x${qty}`;
  });

  return ["🧾 Récap commande :", ...lines].join("\n");
}

// ================================
// Parse date livraison
// ================================
function parseDeliveryRequestedAt(rawText) {
  if (!rawText) return null;

  const s = String(rawText).trim().toLowerCase();
  const now = new Date();

  // Aujourd'hui
  if (/\b(aujourd'?hui|auj|ce soir|cet? après[ -]?midi|ce matin)\b/.test(s)) {
    const result = new Date(now);

    const hourMatch = s.match(/(\d{1,2})\s*(?:h|:)\s*(\d{2})?/);
    if (hourMatch) {
      result.setHours(parseInt(hourMatch[1], 10));
      result.setMinutes(hourMatch[2] ? parseInt(hourMatch[2], 10) : 0);
    } else if (s.includes("soir")) result.setHours(19, 0, 0, 0);
    else if (s.includes("matin")) result.setHours(10, 0, 0, 0);
    else if (s.includes("après-midi") || s.includes("apres-midi")) result.setHours(14, 0, 0, 0);
    else result.setHours(14, 0, 0, 0);

    result.setSeconds(0, 0);
    return result;
  }

  // Demain
  if (/\b(demain|tmrw|2moro)\b/.test(s)) {
    const result = new Date(now);
    result.setDate(result.getDate() + 1);

    const hourMatch = s.match(/(\d{1,2})\s*(?:h|:)\s*(\d{2})?/);
    if (hourMatch) {
      result.setHours(parseInt(hourMatch[1], 10));
      result.setMinutes(hourMatch[2] ? parseInt(hourMatch[2], 10) : 0);
    } else if (s.includes("soir")) result.setHours(19, 0, 0, 0);
    else if (s.includes("matin")) result.setHours(10, 0, 0, 0);
    else result.setHours(14, 0, 0, 0);

    result.setSeconds(0, 0);
    return result;
  }

  // Dans X jours
  const daysMatch = s.match(/dans\s+(\d+)\s+jours?/);
  if (daysMatch) {
    const result = new Date(now);
    result.setDate(result.getDate() + parseInt(daysMatch[1], 10));
    result.setHours(14, 0, 0, 0);
    return result;
  }

  // Jour + mois
  const monthNames = {
    janvier: 0, jan: 0,
    "février": 1, fevrier: 1, fev: 1, "fév": 1,
    mars: 2, mar: 2,
    avril: 3, avr: 3,
    mai: 4,
    juin: 5,
    juillet: 6, juil: 6,
    août: 7, aout: 7,
    septembre: 8, sept: 8, sep: 8,
    octobre: 9, oct: 9,
    novembre: 10, nov: 10,
    décembre: 11, decembre: 11, dec: 11, "déc": 11,
  };

  const dayMonthMatch = s.match(
    /(\d{1,2})\s+(janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre|jan|fev|fév|mar|avr|mai|jun|juil|sept|sep|oct|nov|dec|déc)/i
  );
  if (dayMonthMatch) {
    const day = parseInt(dayMonthMatch[1], 10);
    const monthName = dayMonthMatch[2].toLowerCase();
    const month = monthNames[monthName];

    if (month !== undefined) {
      const year = now.getFullYear();
      const result = new Date(year, month, day);

      if (result.getTime() < now.getTime()) result.setFullYear(year + 1);

      const hourMatch = s.match(/(\d{1,2})\s*(?:h|:)\s*(\d{2})?/);
      if (hourMatch) {
        result.setHours(parseInt(hourMatch[1], 10));
        result.setMinutes(hourMatch[2] ? parseInt(hourMatch[2], 10) : 0);
      } else result.setHours(14, 0, 0, 0);

      result.setSeconds(0, 0);
      return result;
    }
  }

  // YYYY-MM-DD [HH[:mm] | HHh[mm]]
  let m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:\s*(?:à|a)?\s*(\d{1,2})\s*(?:h|:)?\s*(\d{2})?)?$/
  );
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    const hh = m[4] != null ? Number(m[4]) : 14;
    const mm = m[5] != null ? Number(m[5]) : 0;
    return new Date(year, month, day, hh, mm, 0, 0);
  }

  // DD/MM/YYYY [à HH[:mm] | HHh[mm]]
  m = s.match(
    /^(\d{2})\/(\d{2})\/(\d{4})(?:\s*(?:à|a)?\s*(\d{1,2})\s*(?:h|:)?\s*(\d{2})?)?$/
  );
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]) - 1;
    const year = Number(m[3]);
    const hh = m[4] != null ? Number(m[4]) : 14;
    const mm = m[5] != null ? Number(m[5]) : 0;
    return new Date(year, month, day, hh, mm, 0, 0);
  }

  // DD-MM-YYYY [à HH[:mm] | HHh[mm]]
  m = s.match(
    /^(\d{2})-(\d{2})-(\d{4})(?:\s*(?:à|a)?\s*(\d{1,2})\s*(?:h|:)?\s*(\d{2})?)?$/
  );
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]) - 1;
    const year = Number(m[3]);
    const hh = m[4] != null ? Number(m[4]) : 14;
    const mm = m[5] != null ? Number(m[5]) : 0;
    return new Date(year, month, day, hh, mm, 0, 0);
  }

  return null;
}

function isPastDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return true;
  return d.getTime() < Date.now();
}

function isReactivationMessage(text) {
  const t = normText(text);
  return ["start", "reprends", "recommence", "continue"].some((k) => t === k || t.includes(k));
}

async function buildFinalConfirmationMessage(merchant, customer, st) {
  const cart = await getCart(merchant.id, customer.id);

  let deliveryAt = null;
  if (st?.delivery_requested_at) deliveryAt = new Date(st.delivery_requested_at);
  if (!deliveryAt || Number.isNaN(deliveryAt.getTime())) {
    deliveryAt = parseDeliveryRequestedAt(st?.delivery_requested_raw);
  }

  const who =
    st?.recipient_mode === "third_party"
      ? `${st?.recipient_name || "Destinataire"} ${st?.recipient_phone ? `(${st.recipient_phone})` : ""}`
      : customer?.name || "Client";

  const deliveryStr =
    deliveryAt && !Number.isNaN(deliveryAt.getTime()) ? deliveryAt.toLocaleString("fr-FR") : st?.delivery_requested_raw || "—";

  return [
    formatCartSummary(cart),
    "",
    `👤 Destinataire : ${who}`,
    `💳 Paiement : ${customer?.payment_method || "—"}`,
    `📅 Livraison : ${deliveryStr}`,
    "",
    "✅ Si tout est bon, réponds : *CONFIRMER*",
  ].join("\n");
}

function computeNextMissingField(customer, st) {
  if (!st?.recipient_mode) return "recipient_mode";

  if (st.recipient_mode === "self") {
    if (!customer?.name) return "name";
  } else if (st.recipient_mode === "third_party") {
    if (!st?.recipient_name) return "recipient_name";
    if (!st?.recipient_phone) return "recipient_phone";
    if (!st?.recipient_address) return "recipient_address";
  }

  if (!customer?.payment_method) return "payment_method";

  if (!st?.delivery_requested_raw && !st?.delivery_requested_at) return "delivery_requested_raw";

  return null;
}

async function askNextOrConfirm(merchant, customer, st) {
  const next = computeNextMissingField(customer, st);

  if (next) {
    await setConversationState(merchant.id, customer.id, {
      ...(st || {}),
      step: "ASKING_INFO",
      waiting_field: next,
      awaiting_confirmation: false,
      loop_guard: null,
    });
    return questionFor(next);
  }

  await setConversationState(merchant.id, customer.id, {
    ...(st || {}),
    step: "AWAITING_CONFIRMATION",
    waiting_field: null,
    awaiting_confirmation: true,
    loop_guard: null,
  });

  return await buildFinalConfirmationMessage(merchant, customer, st);
}

// ================================
// Middlewares
// ================================
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [type, token] = authHeader.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ error: "Token manquant ou invalide" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.merchantId = payload.merchantId;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Token invalide" });
  }
}

function requireSameMerchant(req, res, next) {
  const merchantId = Number(req.params.merchantId);
  if (Number.isNaN(merchantId)) return res.status(400).json({ error: "merchantId invalide" });
  if (req.merchantId !== merchantId) return res.status(403).json({ error: "Accès interdit (mauvais marchand)" });
  next();
}

async function subscriptionGate(req, res, next) {
  try {
    const merchantId = Number(req.params.merchantId);
    if (Number.isNaN(merchantId)) return res.status(400).json({ error: "merchantId invalide" });

    const m = await getMerchantAccessFlags(merchantId);
    if (!m) return res.status(404).json({ error: "Marchand introuvable" });

    if (m.is_suspended) return res.status(403).json({ error: "Compte suspendu. Contactez l'admin." });

    if (m.subscription_expires_at && new Date(m.subscription_expires_at).getTime() < Date.now()) {
      return res.status(402).json({ error: "Abonnement expiré. Veuillez renouveler (15 000 FCFA / mois)." });
    }

    req.merchantAccess = m;
    next();
  } catch (e) {
    console.error("subscriptionGate error", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

function adminAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [type, token] = authHeader.split(" ");
  if (type !== "Bearer" || !token) return res.status(401).json({ error: "Token admin manquant" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== "admin") return res.status(403).json({ error: "Accès refusé" });
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Token admin invalide" });
  }
}

// ================================
// Structured replies (sans IA)
// ================================
function looksLikeRecipientSelf(msg) {
  const s = normText(msg);
  return (
    s === "1" ||
    s.includes("moi") ||
    s.includes("pour moi") ||
    s.includes("c'est pour moi") ||
    s.includes("cest pour moi") ||
    s.includes("moi-même") ||
    s.includes("moi meme")
  );
}

function looksLikeRecipientThird(msg) {
  const s = normText(msg);
  return s === "2" || s.includes("autre") || s.includes("tier") || s.includes("tierce") || s.includes("quelqu");
}

async function tryHandleStructuredReply({ merchant, customer, text, conversationState }) {
  const waiting = conversationState?.waiting_field;
  const clean = String(text || "").trim();
  if (!waiting) return { handled: false };

  if (!clean) return { handled: true, message: "Je n'ai pas bien reçu. Peux-tu répéter ?" };

  // Loop guard
  const loopGuard = conversationState?.loop_guard || {};
  const currentKey = `${waiting}_question`;
  const count = (loopGuard.key === currentKey ? loopGuard.count : 0) + 1;

  if (count > 3) {
    await setConversationState(merchant.id, customer.id, {
      ...conversationState,
      step: "NEEDS_HUMAN",
      waiting_field: null,
      loop_guard: null,
    });
    return { handled: true, message: "Je n'arrive pas à comprendre cette information. Un conseiller va te recontacter 🙂" };
  }

  const fieldsRequiringValue = ["name", "recipient_name", "recipient_address", "recipient_phone", "delivery_requested_raw", "payment_method"];

  if (isAckValue(clean) && fieldsRequiringValue.includes(waiting)) {
    await setConversationState(merchant.id, customer.id, {
      ...conversationState,
      loop_guard: { key: currentKey, count },
    });
    return { handled: true, message: questionFor(waiting) };
  }

  // recipient_mode
  if (waiting === "recipient_mode") {
    if (isAckValue(clean)) {
      await setConversationState(merchant.id, customer.id, { ...conversationState, loop_guard: { key: currentKey, count } });
      return { handled: true, message: "Réponds : *1* = pour toi-même, *2* = pour une autre personne." };
    }

    const st0 = await getConversationState(merchant.id, customer.id);
    let st = { ...(st0 || {}), loop_guard: null };

    if (looksLikeRecipientSelf(clean)) {
      st.recipient_mode = "self";
      st.recipient_name = null;
      st.recipient_phone = null;
      st.recipient_address = null;
    } else if (looksLikeRecipientThird(clean)) {
      st.recipient_mode = "third_party";
    } else {
      await setConversationState(merchant.id, customer.id, { ...conversationState, loop_guard: { key: currentKey, count } });
      return { handled: true, message: "Réponds : *1* = pour toi-même, *2* = pour une autre personne." };
    }

    await setConversationState(merchant.id, customer.id, st);
    const msg = await askNextOrConfirm(merchant, customer, st);
    return { handled: true, message: msg };
  }

  // name
  if (waiting === "name" || waiting === "self_name") {
    if (!validateField("name", clean)) {
      await setConversationState(merchant.id, customer.id, { ...conversationState, loop_guard: { key: currentKey, count } });
      return { handled: true, message: "J'ai besoin de votre *nom complet* (ex : KONE Aïcha)." };
    }

    await updateCustomerField(merchant.id, customer.id, "name", clean);
    const st = await getConversationState(merchant.id, customer.id);
    const updatedCustomer = { ...customer, name: clean };

    const msg = await askNextOrConfirm(merchant, updatedCustomer, st);
    return { handled: true, message: msg };
  }

  // payment_method
  if (waiting === "payment_method") {
    if (!validateField("payment_method", clean)) {
      await setConversationState(merchant.id, customer.id, { ...conversationState, loop_guard: { key: currentKey, count } });
      return { handled: true, message: "Mode de paiement non reconnu. Choisis : *cash*, *Wave*, *Orange Money*, *MTN*, *carte*." };
    }

    await updateCustomerField(merchant.id, customer.id, "payment_method", clean);
    const st = await getConversationState(merchant.id, customer.id);
    const updatedCustomer = { ...customer, payment_method: clean };

    const msg = await askNextOrConfirm(merchant, updatedCustomer, st);
    return { handled: true, message: msg };
  }

  // delivery_requested_raw
  if (waiting === "delivery_requested_raw") {
    const deliveryAt = parseDeliveryRequestedAt(clean);
    if (!validateField("delivery_requested_raw", clean) || !deliveryAt || isPastDate(deliveryAt)) {
      await setConversationState(merchant.id, customer.id, { ...conversationState, loop_guard: { key: currentKey, count } });
      return { handled: true, message: "Date invalide. Ex : *31/12/2025 à 13h* ou *2025-12-31 13:00*." };
    }

    const st0 = await getConversationState(merchant.id, customer.id);
    const st = {
      ...(st0 || {}),
      delivery_requested_raw: clean,
      delivery_requested_at: deliveryAt.toISOString(),
      loop_guard: null,
      waiting_field: null,
    };

    await setConversationState(merchant.id, customer.id, st);
    const msg = await askNextOrConfirm(merchant, customer, st);
    return { handled: true, message: msg };
  }

  // third party fields
  if (waiting === "recipient_name") {
    if (!validateField("recipient_name", clean)) {
      await setConversationState(merchant.id, customer.id, { ...conversationState, loop_guard: { key: currentKey, count } });
      return { handled: true, message: "J'ai besoin du *nom complet* du destinataire (ex : KONE Aïcha)." };
    }
    const st0 = await getConversationState(merchant.id, customer.id);
    const st = { ...(st0 || {}), recipient_name: clean, loop_guard: null };
    await setConversationState(merchant.id, customer.id, st);
    const msg = await askNextOrConfirm(merchant, customer, st);
    return { handled: true, message: msg };
  }

  if (waiting === "recipient_phone") {
    if (!validateField("recipient_phone", clean)) {
      await setConversationState(merchant.id, customer.id, { ...conversationState, loop_guard: { key: currentKey, count } });
      return { handled: true, message: "Numéro invalide. Envoie le numéro au format *225XXXXXXXXXX*." };
    }
    const phone = normalizePhone(clean);
    if (!phone) {
      await setConversationState(merchant.id, customer.id, { ...conversationState, loop_guard: { key: currentKey, count } });
      return { handled: true, message: "Numéro invalide. Envoie le numéro au format *225XXXXXXXXXX*." };
    }
    const st0 = await getConversationState(merchant.id, customer.id);
    const st = { ...(st0 || {}), recipient_phone: phone, loop_guard: null };
    await setConversationState(merchant.id, customer.id, st);
    const msg = await askNextOrConfirm(merchant, customer, st);
    return { handled: true, message: msg };
  }

  if (waiting === "recipient_address") {
    if (!validateField("recipient_address", clean)) {
      await setConversationState(merchant.id, customer.id, { ...conversationState, loop_guard: { key: currentKey, count } });
      return { handled: true, message: "J'ai besoin d'une *adresse complète* (ex : Cocody Angré 8e tranche…)." };
    }
    const st0 = await getConversationState(merchant.id, customer.id);
    const st = { ...(st0 || {}), recipient_address: clean, loop_guard: null };
    await setConversationState(merchant.id, customer.id, st);
    const msg = await askNextOrConfirm(merchant, customer, st);
    return { handled: true, message: msg };
  }

  return { handled: false };
}

// ================================
// Healthcheck
// ================================
app.get("/", (req, res) => {
  res.status(200).send("whatsapp-agent OK ✅");
});

// ================================
// Actions IA
// ================================
async function applyAction(action, ctx) {
  const { merchant, customer } = ctx;

  switch (action.type) {
    case "ADD_TO_CART":
      await addToCart(merchant.id, customer.id, Number(action.product_id), action.quantity || 1);
      return;

    case "REMOVE_FROM_CART":
      await removeFromCart(merchant.id, customer.id, Number(action.product_id));
      return;

    case "CLEAR_CART":
      await clearCart(merchant.id, customer.id);
      return;

    case "SET_STATE": {
      const patch = action.state || {};
      const keys = Object.keys(patch);
      if (keys.length === 0) return;

      const st = await getConversationState(merchant.id, customer.id);
      await setConversationState(merchant.id, customer.id, { ...(st || {}), ...patch });
      return;
    }

    case "UPDATE_CUSTOMER": {
      const val = (action.value || "").toString().trim();

      if (!validateField(action.field, val)) {
        const st = await getConversationState(merchant.id, customer.id);
        await setConversationState(merchant.id, customer.id, { ...(st || {}), step: "ASKING_INFO", waiting_field: action.field });
        ctx.overrideMessage = questionFor(action.field);
        return;
      }

      await updateCustomerField(merchant.id, customer.id, action.field, val);
      return;
    }

    case "ASK_INFO": {
      const st = await getConversationState(merchant.id, customer.id);
      await setConversationState(merchant.id, customer.id, { ...(st || {}), step: "ASKING_INFO", waiting_field: action.field });
      ctx.overrideMessage = questionFor(action.field);
      return;
    }

    case "SHOW_LAST_ORDER": {
      const last = await getLastOrderWithItemsForCustomer(merchant.id, customer.id);
      ctx.overrideMessage = last
        ? `Votre dernière commande (#${last.order.id}) est **${last.order.status}**. Total: ${last.order.total_amount} ${last.order.currency}.`
        : "Vous n'avez pas encore de commande.";
      return;
    }

    case "CANCEL_LAST_ORDER": {
      const result = await cancelLastOrderForCustomer(merchant.id, customer.id);
      if (!result) ctx.overrideMessage = "Vous n'avez pas encore de commande à annuler.";
      else if (result.blocked) ctx.overrideMessage = `Impossible d'annuler : ${result.reason}`;
      else ctx.overrideMessage = `✅ D'accord. J'ai annulé votre commande (#${result.order.id}).`;
      return;
    }

    case "MODIFY_LAST_ORDER": {
      const result = await loadLastOrderToCart(merchant.id, customer.id);
      if (!result) ctx.overrideMessage = "Vous n'avez pas encore de commande à modifier.";
      else if (result.blocked) ctx.overrideMessage = `Impossible de modifier : ${result.reason}`;
      else ctx.overrideMessage = "✅ Ok. J'ai remis votre dernière commande dans le panier. Ajoutez/retirez puis tapez *CONFIRMER* à la fin.";
      return;
    }

    case "CONFIRM_ORDER": {
      const st = await getConversationState(merchant.id, customer.id);

      const nextMissing = computeNextMissingField(customer, st);
      if (nextMissing) {
        await setConversationState(merchant.id, customer.id, {
          ...(st || {}),
          step: "ASKING_INFO",
          waiting_field: nextMissing,
          awaiting_confirmation: false,
        });
        ctx.overrideMessage = questionFor(nextMissing);
        return;
      }

      if (!st?.awaiting_confirmation) {
        await setConversationState(merchant.id, customer.id, {
          ...(st || {}),
          step: "AWAITING_CONFIRMATION",
          waiting_field: null,
          awaiting_confirmation: true,
        });
        ctx.overrideMessage = await buildFinalConfirmationMessage(merchant, customer, st);
        return;
      }

      let deliveryAt = null;
      if (st?.delivery_requested_at) deliveryAt = new Date(st.delivery_requested_at);
      if (!deliveryAt || Number.isNaN(deliveryAt.getTime())) deliveryAt = parseDeliveryRequestedAt(st?.delivery_requested_raw);

      if (!deliveryAt || isPastDate(deliveryAt)) {
        await setConversationState(merchant.id, customer.id, {
          ...(st || {}),
          step: "ASKING_INFO",
          waiting_field: "delivery_requested_raw",
          awaiting_confirmation: false,
          delivery_requested_raw: null,
          delivery_requested_at: null,
        });
        ctx.overrideMessage = questionFor("delivery_requested_raw");
        return;
      }

      if (st.recipient_mode === "self") {
        await createOrderFromCart(merchant.id, customer.id, {
          recipientCustomerId: customer.id,
          recipientNameSnapshot: customer.name,
          recipientPhoneSnapshot: customer.phone || null,
          recipientAddressSnapshot: customer.address || null,
          deliveryRequestedAt: deliveryAt,
          deliveryRequestedRaw: st.delivery_requested_raw || null,
          status: "NEW",
        });

        await setConversationState(merchant.id, customer.id, {
          opted_out: false,
          order_completed: true,
          step: "COMPLETED",
          waiting_field: null,
          loop_guard: null,
          awaiting_confirmation: false,
          recipient_mode: null,
          recipient_name: null,
          recipient_phone: null,
          recipient_address: null,
          delivery_requested_raw: null,
          delivery_requested_at: null,
          pending_add_to_cart: null,
        });

        ctx.overrideMessage = `✅ Commande confirmée. Livraison prévue le ${deliveryAt.toLocaleString("fr-FR")}. Merci et à bientôt !`;
        return;
      }

      if (st.recipient_mode === "third_party") {
        const recipientPhone = normalizeE164(st.recipient_phone);
        const recipient = await findOrCreateCustomer(merchant.id, recipientPhone);

        if (recipient && st.recipient_name) await updateCustomerField(merchant.id, recipient.id, "name", st.recipient_name);
        if (recipient && st.recipient_address) await updateCustomerField(merchant.id, recipient.id, "address", st.recipient_address);

        await createOrderFromCart(merchant.id, customer.id, {
          recipientCustomerId: recipient?.id || null,
          recipientNameSnapshot: st.recipient_name,
          recipientPhoneSnapshot: recipientPhone,
          recipientAddressSnapshot: st.recipient_address,
          deliveryRequestedAt: deliveryAt,
          deliveryRequestedRaw: st.delivery_requested_raw || null,
          status: "NEW",
        });

        await setConversationState(merchant.id, customer.id, {
          opted_out: false,
          order_completed: true,
          step: "COMPLETED",
          waiting_field: null,
          loop_guard: null,
          awaiting_confirmation: false,
          recipient_mode: null,
          recipient_name: null,
          recipient_phone: null,
          recipient_address: null,
          delivery_requested_raw: null,
          delivery_requested_at: null,
          pending_add_to_cart: null,
        });

        ctx.overrideMessage = `✅ Commande confirmée pour ${st.recipient_name}. Livraison le ${deliveryAt.toLocaleString("fr-FR")}. Merci et à bientôt !`;
        return;
      }

      await setConversationState(merchant.id, customer.id, { ...(st || {}), step: "ASKING_INFO", waiting_field: "recipient_mode" });
      ctx.overrideMessage = questionFor("recipient_mode");
      return;
    }

    default:
      console.warn("⚠️ Action inconnue", action);
      return;
  }
}

// ================================
// Moteur commun (WAHA + Postman)
// ================================
async function handleIncomingMessage({ from, text, merchant, replyChatId }) {
  const customer = await findOrCreateCustomer(merchant.id, from);
  const conversationState = await getConversationState(merchant.id, customer.id);

  // Silence si opt-out
  if (conversationState?.opted_out && !isReactivationMessage(text)) {
    return { message: null, actions: [] };
  }

  // Annulation pendant AWAITING_CONFIRMATION
  if (conversationState?.awaiting_confirmation && isCancelIntent(text)) {
    await clearCart(merchant.id, customer.id);
    await setConversationState(merchant.id, customer.id, {
      ...(conversationState || {}),
      awaiting_confirmation: false,
      step: null,
      waiting_field: null,
      delivery_requested_raw: null,
      delivery_requested_at: null,
      recipient_mode: null,
      recipient_name: null,
      recipient_phone: null,
      recipient_address: null,
      pending_add_to_cart: null,
      loop_guard: null,
    });

    const msg = "✅ D'accord, j'ai annulé la validation. Ton panier est vidé. Tape *1* pour revoir les produits.";
    await sendWhatsappMessage({ merchant, chatId: replyChatId, to: from, text: msg });
    return { message: msg, actions: [] };
  }

  // Confirmation pendant AWAITING_CONFIRMATION
  if (conversationState?.awaiting_confirmation && isConfirmIntent(text)) {
    const ctx = { merchant, customer, overrideMessage: null };
    await applyAction({ type: "CONFIRM_ORDER" }, ctx);
    if (ctx.overrideMessage) {
      await sendWhatsappMessage({ merchant, chatId: replyChatId, to: from, text: ctx.overrideMessage });
    }
    return { message: ctx.overrideMessage || null, actions: [{ type: "CONFIRM_ORDER" }] };
  }

  // Réponses structurées
  const structured = await tryHandleStructuredReply({ merchant, customer, text, conversationState });
  if (structured.handled) {
    if (structured.message) {
      await sendWhatsappMessage({
        merchant,
        chatId: replyChatId,
        to: from,
        text: structured.message,
      });
    }
    return { message: structured.message || null, actions: [] };
  }

  // ===== PDF CATALOGUE (CORRIGÉ AVEC TIMEOUT) =====
  const normalizedText = text.toLowerCase().trim();
  const isPdfRequest =
    normalizedText.includes("avec images") ||
    normalizedText.includes("avec photos") ||
    normalizedText.includes("catalogue pdf") ||
    normalizedText === "pdf" ||
    normalizedText === "images";

  if (isPdfRequest) {
    console.log("[Catalog] 📄 Demande PDF détectée pour merchant:", merchant.id);
    
    try {
      const products = await getProductsForMerchant(merchant.id);

      if (products.length === 0) {
        console.log("[Catalog] ⚠️ Aucun produit disponible pour merchant:", merchant.id);
        await sendWhatsappMessage({
          merchant,
          chatId: replyChatId,
          to: from,
          text: "Désolé, aucun produit n'est disponible pour le moment.",
        });
        return { message: "Aucun produit disponible", actions: [] };
      }

      console.log(`[Catalog] 📦 ${products.length} produits trouvés, génération en cours...`);

      // Message initial
      await sendWhatsappMessage({
        merchant,
        chatId: replyChatId,
        to: from,
        text: "🔄 Génération du catalogue PDF en cours (quelques secondes)...",
      });

      // ✅ VÉRIFIER LE CACHE (1 heure)
      const cacheKey = `catalog_${merchant.id}`;
      const cached = pdfCache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < 3600000 && fs.existsSync(cached.path)) {
        console.log("[Catalog] 📦 Utilisation du cache PDF");
        
        try {
          await sendWhatsappDocument({
            merchant,
            chatId: replyChatId,
            to: from,
            filePath: cached.path,
            filename: `Catalogue_${merchant.name.replace(/\s+/g, "_")}.pdf`,
            caption: `📦 Catalogue complet (${products.length} produits)\n\n✅ Pour commander, tapez le nom ou le code du produit`,
          });
          
          console.log("[Catalog] ✅ PDF envoyé depuis le cache");
          return { message: "Catalogue PDF envoyé (cache)", actions: [] };
        } catch (sendError) {
          console.error("[Catalog] ❌ Erreur envoi cache:", sendError);
          // Si l'envoi échoue, on continue avec une nouvelle génération
        }
      }

      // ✅ GÉNÉRATION AVEC TIMEOUT DE 30 SECONDES
      let pdfPath = null;
      
      const pdfPromise = generateCatalogPDF(merchant, products);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout: génération PDF > 30s")), 30000)
      );

      try {
        pdfPath = await Promise.race([pdfPromise, timeoutPromise]);
        console.log("[Catalog] ✅ PDF généré avec succès:", pdfPath);
      } catch (timeoutError) {
        console.error("[Catalog] ⏱️ TIMEOUT génération PDF:", timeoutError.message);
        throw new Error("La génération du PDF a pris trop de temps");
      }

      // ✅ VÉRIFIER QUE LE FICHIER EXISTE
      if (!pdfPath || !fs.existsSync(pdfPath)) {
        console.error("[Catalog] ❌ Fichier PDF introuvable:", pdfPath);
        throw new Error("Le fichier PDF n'a pas été créé");
      }

      const stats = fs.statSync(pdfPath);
      console.log(`[Catalog] 📊 Taille PDF: ${(stats.size / 1024).toFixed(2)} KB`);

      // ✅ VÉRIFIER LA TAILLE (max 10MB pour WhatsApp)
      if (stats.size > 10 * 1024 * 1024) {
        console.error("[Catalog] ❌ PDF trop volumineux:", stats.size);
        
        try {
          fs.unlinkSync(pdfPath);
        } catch (cleanupErr) {
          console.error("[Catalog] ⚠️ Erreur cleanup PDF volumineux:", cleanupErr);
        }
        
        await sendWhatsappMessage({
          merchant,
          chatId: replyChatId,
          to: from,
          text: `❌ Le catalogue est trop volumineux (${products.length} produits).\n\nTapez 1 pour voir la liste texte ou contactez-nous.`,
        });
        return { message: "PDF trop volumineux", actions: [] };
      }

      // ✅ ENVOYER LE PDF AVEC GESTION D'ERREUR
      console.log("[Catalog] 📤 Envoi du PDF via WhatsApp...");
      
      try {
        await sendWhatsappDocument({
          merchant,
          chatId: replyChatId,
          to: from,
          filePath: pdfPath,
          filename: `Catalogue_${merchant.name.replace(/\s+/g, "_")}.pdf`,
          caption: `📦 Catalogue complet (${products.length} produits)\n\n✅ Pour commander, tapez le nom ou le code du produit`,
        });
        
        console.log("[Catalog] ✅ PDF envoyé avec succès");
        
        // ✅ SAUVEGARDER DANS LE CACHE
        pdfCache.set(cacheKey, {
          path: pdfPath,
          timestamp: Date.now(),
        });
        
      } catch (sendError) {
        console.error("[Catalog] ❌ Erreur envoi WhatsApp:", sendError);
        throw new Error("Impossible d'envoyer le PDF via WhatsApp");
      }

      // ✅ CLEANUP SÉCURISÉ AVEC DELAY (seulement si pas en cache)
      if (!cached || cached.path !== pdfPath) {
        setTimeout(() => {
          try {
            if (pdfPath && fs.existsSync(pdfPath)) {
              cleanupPDF(pdfPath);
              console.log("[Catalog] 🗑️ PDF nettoyé:", pdfPath);
            }
          } catch (cleanupErr) {
            console.error("[Catalog] ⚠️ Erreur cleanup (non bloquant):", cleanupErr.message);
          }
        }, 15000);
      }

      return { message: "Catalogue PDF envoyé", actions: [] };
      
    } catch (error) {
      console.error("[Catalog] ❌ ERREUR GÉNÉRALE PDF:", {
        error: error.message,
        stack: error.stack,
        merchant: merchant.id,
        from: from,
      });

      const errorMsg =
        error.message.includes("Timeout") || error.message.includes("trop de temps")
          ? "❌ La génération du catalogue prend trop de temps. Réessayez dans quelques instants ou tapez 1 pour la liste."
          : error.message.includes("trop volumineux")
          ? "❌ Le catalogue est trop volumineux. Tapez 1 pour voir la liste texte."
          : "❌ Erreur lors de la génération du catalogue. Veuillez réessayer ou tapez 1 pour voir la liste.";

      await sendWhatsappMessage({
        merchant,
        chatId: replyChatId,
        to: from,
        text: errorMsg,
      });

      return { message: "Erreur PDF", actions: [] };
    }
  }

  // Récupérer panier + produits
  const cart = await getCart(merchant.id, customer.id);
  const products = await getProductsForMerchant(merchant.id);

  let agentOutput = null;
  try {
    agentOutput = await callCommandBot({
      message: text,
      merchant: { id: merchant.id, name: merchant.name },
      customer: {
        id: customer.id,
        phone: customer.phone,
        name: customer.name,
        known_fields: {
          address: customer.address,
          payment_method: customer.payment_method,
        },
      },
      cart,
      products,
      conversation_state: conversationState,
    });
  } catch (e) {
    console.error("❌ callCommandBot error:", e);
    agentOutput = { message: "Désolé, j'ai eu un souci technique. Réessaie dans un instant.", actions: [] };
  }

  const actions = Array.isArray(agentOutput?.actions) ? agentOutput.actions : [];
  const ctx = { merchant, customer, overrideMessage: null };

  for (const action of actions) {
    await applyAction(action, ctx);
  }

  const outgoingMsg = (ctx.overrideMessage || agentOutput?.message || "").toString().trim();

  if (outgoingMsg) {
    await sendWhatsappMessage({
      merchant,
      chatId: replyChatId,
      to: from,
      text: outgoingMsg,
    });
  }

  return { message: outgoingMsg || null, actions };
}

// ================================
// Configuration Upload
// ================================
const productsUploadDir = "/var/www/uploads/products";
const logosUploadDir = "/var/www/uploads/logos";

if (!fs.existsSync(productsUploadDir)) fs.mkdirSync(productsUploadDir, { recursive: true });
if (!fs.existsSync(logosUploadDir)) fs.mkdirSync(logosUploadDir, { recursive: true });

const productImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, productsUploadDir),
  filename: (req, file, cb) => {
    const merchantId = req.params.merchantId;
    const ext = path.extname(file.originalname);
    const timestamp = Date.now();
    cb(null, `product_${merchantId}_${timestamp}${ext}`);
  },
});

const uploadProductImage = multer({
  storage: productImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Format invalide. PNG, JPG, WEBP uniquement."));
  },
});

const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, logosUploadDir),
  filename: (req, file, cb) => {
    const merchantId = req.params.merchantId;
    const ext = path.extname(file.originalname);
    const timestamp = Date.now();
    cb(null, `logo_${merchantId}_${timestamp}${ext}`);
  },
});

const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/png", "image/jpeg", "image/jpg"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Format invalide. PNG, JPG uniquement."));
  },
});

app.use("/uploads", express.static("/var/www/uploads"));

app.post(
  "/api/merchants/:merchantId/upload-product-image",
  authMiddleware,
  requireSameMerchant,
  uploadProductImage.single("image"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Aucun fichier uploadé" });

      const imageUrl = `http://92.112.193.171:3002/uploads/products/${req.file.filename}`;

      console.log("[UPLOAD] Image produit:", {
        merchant: req.params.merchantId,
        filename: req.file.filename,
        url: imageUrl,
      });

      return res.json({ success: true, url: imageUrl, filename: req.file.filename });
    } catch (error) {
      console.error("[UPLOAD] Erreur:", error);
      return res.status(500).json({ error: error.message });
    }
  }
);

app.post("/api/merchants/:merchantId/logo", authMiddleware, requireSameMerchant, uploadLogo.single("logo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Aucun fichier uploadé" });

    const logoUrl = `http://92.112.193.171:3002/uploads/logos/${req.file.filename}`;

    const result = await query("UPDATE merchants SET logo_url = $1 WHERE id = $2 RETURNING *", [logoUrl, req.params.merchantId]);

    console.log("[UPLOAD] Logo marchand:", {
      merchant: req.params.merchantId,
      filename: req.file.filename,
      url: logoUrl,
    });

    return res.json({
      success: true,
      logo_url: logoUrl,
      merchant: result.rows[0],
    });
  } catch (error) {
    console.error("[UPLOAD] Erreur:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ================================
// Webhook test (Postman)
// ================================
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const { from, to, text } = mapWhatsappPayload(req.body);

    const customerPhone = normalizePhone(from);
    const businessPhone = normalizePhone(to);
    const cleanText = String(text || "").trim();

    if (!customerPhone || !businessPhone || !cleanText) return res.sendStatus(200);

    const merchant = await findMerchantByWhatsappNumber(businessPhone);
    if (!merchant) return res.sendStatus(200);

    await handleIncomingMessage({
      from: customerPhone,
      text: cleanText,
      merchant,
      replyChatId: phoneToChatId(customerPhone),
    });

    return res.sendStatus(200);
  } catch (e) {
    console.error("Erreur webhook /webhook/whatsapp", e);
    return res.sendStatus(200);
  }
});

// ================================
// Webhook WAHA (production)
// ================================
app.post("/webhook/waha", async (req, res) => {
  try {
    const eventWrap = req.body;
    const p = eventWrap?.payload || eventWrap;

    const eventName = eventWrap?.event || p?.event;
    if (eventName && eventName !== "message") return res.sendStatus(200);

    const sessionName = eventWrap?.session || p?.session;
    if (!sessionName) return res.sendStatus(200);

    const merchant = await findMerchantByWahaSession(sessionName);
    if (!merchant) return res.sendStatus(200);

    const text = (p?.body ?? p?.text ?? p?.message?.text ?? p?.message ?? "").toString().trim();
    if (!text) return res.sendStatus(200);

    const rawFrom = p?.from || p?.sender?.id || p?.author || p?.participant;
    const rawChatId = p?.chatId || p?.id?.remote || p?.conversation || p?.to;

    const fromChatId = normalizeWahaChatId(rawFrom);
    const chatId = normalizeWahaChatId(rawChatId);

    if ((fromChatId && String(fromChatId).includes("status@broadcast")) || (chatId && String(chatId).includes("status@broadcast"))) {
      return res.sendStatus(200);
    }

    const replyChatId = chatId && chatId.endsWith("@g.us") ? chatId : fromChatId;
    if (!replyChatId) return res.sendStatus(200);

    let fromPhone = chatIdToPhone(fromChatId);
    if (!fromPhone) fromPhone = normalizePhone(rawFrom);
    if (!fromPhone) fromPhone = String(fromChatId || replyChatId);

    await handleIncomingMessage({
      from: fromPhone,
      text,
      merchant,
      replyChatId,
    });

    return res.sendStatus(200);
  } catch (e) {
    console.error("Erreur /webhook/waha", e);
    return res.sendStatus(200);
  }
});

// ================================
// Merchant Auth
// ================================
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email et mot de passe sont obligatoires." });

    const merchant = await findMerchantByEmail(email);
    if (!merchant || !merchant.password_hash) return res.status(401).json({ error: "Identifiants invalides." });

    const ok = await bcrypt.compare(password, merchant.password_hash);
    if (!ok) return res.status(401).json({ error: "Identifiants invalides." });

    const token = jwt.sign({ merchantId: merchant.id }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({ token, merchant: { id: merchant.id, name: merchant.name, email: merchant.email } });
  } catch (e) {
    console.error("Erreur /api/auth/login", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, whatsapp_number } = req.body || {};
    if (!name || !email || !password || !whatsapp_number) {
      return res.status(400).json({ error: "Champs requis: name, email, password, whatsapp_number" });
    }

    const existing = await findMerchantByEmail(email);
    if (existing) return res.status(400).json({ error: "Cet email est déjà utilisé." });

    const passwordHash = await bcrypt.hash(password, 10);

    const merchant = await createMerchant({
      name,
      email,
      passwordHash,
      whatsappNumber: whatsapp_number,
    });

    const token = jwt.sign({ merchantId: merchant.id }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({ token, merchant: { id: merchant.id, name: merchant.name, email: merchant.email } });
  } catch (e) {
    console.error("Erreur /api/auth/register", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ================================
// Merchant API (products/orders)
// ================================
app.get("/api/merchants/:merchantId/products", authMiddleware, requireSameMerchant, subscriptionGate, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const products = await getProductsForMerchant(merchantId);
    return res.json(products);
  } catch (e) {
    console.error("Erreur GET products", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post("/api/merchants/:merchantId/products", authMiddleware, requireSameMerchant, subscriptionGate, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const { name, price, description, currency, code, category, image_url } = req.body || {};

    if (!name || price == null) return res.status(400).json({ error: "Les champs 'name' et 'price' sont obligatoires." });

    const product = await createProductForMerchant(merchantId, {
      name,
      price,
      description,
      currency,
      code,
      category,
      image_url,
    });

    return res.status(201).json(product);
  } catch (e) {
    console.error("Erreur POST products", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.put("/api/merchants/:merchantId/products/:productId", authMiddleware, requireSameMerchant, subscriptionGate, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const productId = Number(req.params.productId);

    const { name, price, description, currency, code, category, image_url, is_active } = req.body || {};
    if (!name || price == null) return res.status(400).json({ error: "Les champs 'name' et 'price' sont obligatoires." });

    const updated = await updateProductForMerchant(merchantId, productId, {
      name,
      description,
      price,
      currency,
      code,
      category,
      image_url,
      is_active,
    });

    if (!updated) return res.status(404).json({ error: "Produit non trouvé pour ce marchand" });
    return res.json(updated);
  } catch (e) {
    console.error("Erreur PUT products", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.delete("/api/merchants/:merchantId/products/:productId", authMiddleware, requireSameMerchant, subscriptionGate, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const productId = Number(req.params.productId);

    await deleteProductForMerchant(merchantId, productId);
    return res.status(204).send();
  } catch (e) {
    console.error("Erreur DELETE products", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/merchants/:merchantId/orders", authMiddleware, requireSameMerchant, subscriptionGate, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const orders = await getOrdersForMerchant(merchantId);
    return res.json(orders);
  } catch (e) {
    console.error("Erreur GET orders", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/merchants/:merchantId/orders/:orderId", authMiddleware, requireSameMerchant, subscriptionGate, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const orderId = Number(req.params.orderId);

    const data = await getOrderWithItems(merchantId, orderId);
    if (!data) return res.status(404).json({ error: "Commande introuvable" });

    return res.json(data);
  } catch (e) {
    console.error("Erreur GET order detail", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.put("/api/merchants/:merchantId/orders/:orderId/status", authMiddleware, requireSameMerchant, subscriptionGate, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const orderId = Number(req.params.orderId);
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: "Le champ 'status' est obligatoire." });

    const updated = await updateOrderStatus(merchantId, orderId, status);
    if (!updated) return res.status(404).json({ error: "Commande introuvable" });

    return res.json(updated);
  } catch (e) {
    console.error("Erreur PUT order status", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ================================
// Admin Auth + Admin API
// ================================
app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });

    if (!ADMIN_EMAIL || !ADMIN_PASSWORD_HASH) {
      return res.status(500).json({ error: "ADMIN_EMAIL / ADMIN_PASSWORD_HASH non configurés" });
    }

    if (String(email).toLowerCase() !== String(ADMIN_EMAIL).toLowerCase()) {
      return res.status(401).json({ error: "Identifiants invalides" });
    }

    const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!ok) return res.status(401).json({ error: "Identifiants invalides" });

    const token = jwt.sign({ role: "admin", email: ADMIN_EMAIL }, JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, admin: { email: ADMIN_EMAIL } });
  } catch (e) {
    console.error("Erreur /api/admin/login", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/admin/dashboard", adminAuthMiddleware, async (req, res) => {
  try {
    const data = await adminGetDashboard();
    return res.json(data);
  } catch (e) {
    console.error("Erreur GET /api/admin/dashboard", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/admin/merchants", adminAuthMiddleware, async (req, res) => {
  try {
    const { q = null, status = null } = req.query || {};
    const data = await adminListMerchants({ q, status });
    return res.json(data);
  } catch (e) {
    console.error("Erreur GET /api/admin/merchants", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.put("/api/admin/merchants/:merchantId/suspend", adminAuthMiddleware, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const { is_suspended } = req.body || {};

    const updated = await adminSetMerchantSuspended(merchantId, !!is_suspended);
    if (!updated) return res.status(404).json({ error: "Marchand introuvable" });

    return res.json(updated);
  } catch (e) {
    console.error("Erreur PUT /api/admin/merchants/:merchantId/suspend", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post("/api/admin/merchants/:merchantId/payments", adminAuthMiddleware, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const { amount = 15000, months = 1, method = null, reference = null, note = null } = req.body || {};

    const result = await adminAddSubscriptionPayment(merchantId, { amount, months, method, reference, note });
    if (!result) return res.status(404).json({ error: "Marchand introuvable" });

    return res.json({ payment: result.payment, merchant: result.merchant });
  } catch (e) {
    console.error("Erreur POST /api/admin/merchants/:merchantId/payments", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/admin/merchants/:merchantId/payments", adminAuthMiddleware, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const data = await adminListSubscriptionPayments(merchantId);
    return res.json(data);
  } catch (e) {
    console.error("Erreur GET /api/admin/merchants/:merchantId/payments", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post("/api/admin/merchants", adminAuthMiddleware, async (req, res) => {
  try {
    const { name, email, password, whatsapp_number, waha_session } = req.body || {};

    if (!name || !email || !password || !whatsapp_number || !waha_session) {
      return res.status(400).json({ error: "Champs requis: name, email, password, whatsapp_number, waha_session" });
    }

    const existing = await findMerchantByEmail(email);
    if (existing) return res.status(400).json({ error: "Cet email est déjà utilisé." });

    const passwordHash = await bcrypt.hash(password, 10);

    const merchant = await createMerchantWithWaha({
      name,
      email,
      passwordHash,
      whatsappNumber: whatsapp_number,
      wahaSession: waha_session,
    });

    return res.status(201).json({ merchant });
  } catch (e) {
    console.error("Erreur POST /api/admin/merchants", e);
    if (e.code === "23505") return res.status(400).json({ error: "Collision: email/whatsapp/session déjà utilisé", details: e.detail });
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.put("/api/admin/merchants/:merchantId/waha", adminAuthMiddleware, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const { whatsapp_number, waha_session } = req.body || {};
    if (!whatsapp_number && !waha_session) return res.status(400).json({ error: "Fournis whatsapp_number et/ou waha_session" });

    const updated = await updateMerchantWahaConfig(merchantId, { whatsappNumber: whatsapp_number, wahaSession: waha_session });

    if (!updated) return res.status(404).json({ error: "Marchand introuvable" });
    return res.json({ merchant: updated });
  } catch (e) {
    console.error("Erreur PUT /api/admin/merchants/:merchantId/waha", e);
    if (e.code === "23505") return res.status(400).json({ error: "whatsapp_number ou waha_session déjà pris", details: e.detail });
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ================================
// Monitoring endpoint (optionnel)
// ================================
app.get("/api/admin/pdf-stats", adminAuthMiddleware, async (req, res) => {
  try {
    const stats = {
      cache_size: pdfCache.size,
      cached_merchants: Array.from(pdfCache.keys()),
      cache_details: Array.from(pdfCache.entries()).map(([merchantId, data]) => ({
        merchant_id: merchantId,
        cached_at: new Date(data.timestamp).toISOString(),
        age_minutes: Math.floor((Date.now() - data.timestamp) / 60000),
        file_exists: fs.existsSync(data.path),
      })),
    };
    
    return res.json(stats);
  } catch (e) {
    return res.status(500).json({ error: "Erreur stats" });
  }
});

// ================================
// Start server
// ================================
const listenPort = Number(process.env.PORT || PORT || 3000);
app.listen(listenPort, "0.0.0.0", () => {
  console.log("✅ Serveur démarré sur le port", listenPort);
  console.log("📄 Génération PDF avec cache activé (1h)");
  console.log("⏱️ Timeout PDF: 30 secondes");
});
