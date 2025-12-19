import cors from "cors";
import express from "express";
import bodyParser from "body-parser";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import fs from 'fs';

import {
  // WhatsApp / bot core
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
  updateCustomerProfile,
  getLastOrderWithItemsForCustomer,
  cancelLastOrderForCustomer,
  loadLastOrderToCart,

  // Backoffice merchant
  createProductForMerchant,
  updateProductForMerchant,
  deleteProductForMerchant,
  getOrdersForMerchant,
  getOrderWithItems,
  updateOrderStatus,

  // Auth merchant
  findMerchantByEmail,
  createMerchant,

  // Admin
  createMerchantWithWaha,
  updateMerchantWahaConfig,
  adminListMerchants,
  adminSetMerchantSuspended,
  adminGetDashboard,
  adminAddSubscriptionPayment,
  adminListSubscriptionPayments,

  // Subscription gate
  getMerchantAccessFlags,
} from "./services/store.pg.js";

import { callCommandBot } from "./services/commandbot.js";
import { sendWhatsappMessage, sendWhatsappDocument } from "./services/whatsapp.js";
import { PORT } from "./config.js";
import { generateCatalogPDF, cleanupPDF } from './services/catalog-pdf.js';
import { query as db } from "./db.js";

import multer from 'multer';
import path from 'path';

// ================================
// Config
// ================================
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "5mb" }));

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-a-changer";

// Admin credentials (prod conseillé)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL; // ex: admin@dido.com
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH; // bcrypt hash

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

// ✅ NOUVEAU CODE (plus flexible)
function looksLikeAddress(val) {
  if (isAckValue(val)) return false;
  const v = (val || "").toString().trim();
  
  // Une adresse valide doit :
  // - Faire au moins 5 caractères
  // - Contenir au moins 3 lettres
  // - OU contenir des mots-clés d'adresse
  const hasMinLength = v.length >= 5;
  const hasEnoughLetters = lettersCount(v) >= 3;
  
  const addressKeywords = /\b(angré|angre|cocody|yopougon|abobo|adjamé|adjame|plateau|marcory|koumassi|treichville|rue|avenue|av|boulevard|bd|quartier|résidence|residence|villa|immeuble|tranche|cite|cité)\b/i;
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
  
  // Accepter tous ces formats
  return (
    /\b(aujourd'?hui|auj|ce soir|cet? après[ -]?midi|ce matin)\b/.test(t) ||
    /\b(demain|tmrw|2moro)\b/.test(t) ||
    /dans \d+ jours?/.test(t) ||
    /\d{1,2}\s+(janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre|jan|fev|fév|mar|avr|mai|jun|juil|sept|sep|oct|nov|dec|déc)/i.test(t) ||
    /\d{4}-\d{2}-\d{2}/.test(t) ||
    /\d{2}\/\d{2}\/\d{4}/.test(t) ||
    /\d{2}-\d{2}-\d{4}/.test(t) ||
    /\b(\d{1,2}h|\d{1,2}:\d{2})\b/.test(t)
  );
}

// ✅ CORRECTION #2: Ajout validation payment_method
function looksLikePaymentMethod(val) {
  if (isAckValue(val)) return false;
  const t = normText(val);
  return /\b(cash|espece|wave|orange|mtn|moov|mobile money|carte|card)\b/.test(t);
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
      return looksLikePaymentMethod(value); // ✅ NOUVEAU
    case "recipient_mode":
      // traité séparément (1/2/moi/autre)
      return !isAckValue(value) && normText(value).length > 0;
    default:
      // Refuser ACK par défaut
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
  if (s.endsWith("@lid")) return s; // WAHA peut fournir @lid
  if (s.includes("@")) return s;

  const digits = s.replace(/[^\d]/g, "");
  return digits ? `${digits}@c.us` : null;
}

function mapWhatsappPayload(body) {
  // Postman : { from, to, text }
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

/**
 * Parse les dates de livraison dans tous les formats
 * Formats supportés :
 * - "aujourd'hui", "auj", "ce soir"
 * - "demain", "demain matin", "demain soir"
 * - "30 décembre", "30 dec", "le 30/12"
 * - "2025-12-30", "30/12/2025"
 * - "2025-12-30 14:00", "30/12/2025 14h30"
 */
function parseDeliveryRequestedAt(rawText) {
  if (!rawText) return null;
  
  const s = String(rawText).trim().toLowerCase();
  const now = new Date();
  
  // ===== FORMAT 1 : AUJOURD'HUI =====
  if (/\b(aujourd'?hui|auj|ce soir|cet? après[ -]?midi|ce matin)\b/.test(s)) {
    const result = new Date(now);
    
    // Extraire l'heure si présente
    const hourMatch = s.match(/(\d{1,2})[h:](\d{2})?/);
    if (hourMatch) {
      result.setHours(parseInt(hourMatch[1], 10));
      result.setMinutes(hourMatch[2] ? parseInt(hourMatch[2], 10) : 0);
    } else if (s.includes("soir")) {
      result.setHours(19, 0, 0, 0);
    } else if (s.includes("matin")) {
      result.setHours(10, 0, 0, 0);
    } else if (s.includes("après-midi") || s.includes("apres-midi")) {
      result.setHours(14, 0, 0, 0);
    } else {
      result.setHours(14, 0, 0, 0); // Par défaut 14h
    }
    
    result.setSeconds(0, 0);
    return result;
  }
  
  // ===== FORMAT 2 : DEMAIN =====
  if (/\b(demain|tmrw|2moro)\b/.test(s)) {
    const result = new Date(now);
    result.setDate(result.getDate() + 1);
    
    // Extraire l'heure si présente
    const hourMatch = s.match(/(\d{1,2})[h:](\d{2})?/);
    if (hourMatch) {
      result.setHours(parseInt(hourMatch[1], 10));
      result.setMinutes(hourMatch[2] ? parseInt(hourMatch[2], 10) : 0);
    } else if (s.includes("soir")) {
      result.setHours(19, 0, 0, 0);
    } else if (s.includes("matin")) {
      result.setHours(10, 0, 0, 0);
    } else {
      result.setHours(14, 0, 0, 0); // Par défaut 14h
    }
    
    result.setSeconds(0, 0);
    return result;
  }
  
  // ===== FORMAT 3 : DANS X JOURS =====
  const daysMatch = s.match(/dans (\d+) jours?/);
  if (daysMatch) {
    const result = new Date(now);
    result.setDate(result.getDate() + parseInt(daysMatch[1], 10));
    result.setHours(14, 0, 0, 0);
    return result;
  }
  
  // ===== FORMAT 4 : JOUR + MOIS (ex: "30 décembre", "15 janvier") =====
  const monthNames = {
    'janvier': 0, 'jan': 0,
    'février': 1, 'fevrier': 1, 'fev': 1, 'fév': 1,
    'mars': 2, 'mar': 2,
    'avril': 3, 'avr': 3,
    'mai': 4,
    'juin': 5,
    'juillet': 6, 'juil': 6,
    'août': 7, 'aout': 7,
    'septembre': 8, 'sept': 8, 'sep': 8,
    'octobre': 9, 'oct': 9,
    'novembre': 10, 'nov': 10,
    'décembre': 11, 'decembre': 11, 'dec': 11, 'déc': 11
  };
  
  const dayMonthMatch = s.match(/(\d{1,2})\s+(janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre|jan|fev|fév|mar|avr|mai|jun|juil|aout|sept|sep|oct|nov|dec|déc)/i);
  if (dayMonthMatch) {
    const day = parseInt(dayMonthMatch[1], 10);
    const monthName = dayMonthMatch[2].toLowerCase();
    const month = monthNames[monthName];
    
    if (month !== undefined) {
      const year = now.getFullYear();
      const result = new Date(year, month, day);
      
      // Si la date est dans le passé, on prend l'année prochaine
      if (result.getTime() < now.getTime()) {
        result.setFullYear(year + 1);
      }
      
      // Extraire l'heure si présente
      const hourMatch = s.match(/(\d{1,2})[h:](\d{2})?/);
      if (hourMatch) {
        result.setHours(parseInt(hourMatch[1], 10));
        result.setMinutes(hourMatch[2] ? parseInt(hourMatch[2], 10) : 0);
      } else {
        result.setHours(14, 0, 0, 0);
      }
      
      result.setSeconds(0, 0);
      return result;
    }
  }
  
  // ===== FORMAT 5 : YYYY-MM-DD [HH:mm] =====
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2})[h:](\d{2}))?$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    const hh = m[4] != null ? Number(m[4]) : 14;
    const mm = m[5] != null ? Number(m[5]) : 0;
    return new Date(year, month, day, hh, mm, 0, 0);
  }
  
  // ===== FORMAT 6 : DD/MM/YYYY [HH:mm] =====
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2})[h:](\d{2}))?$/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]) - 1;
    const year = Number(m[3]);
    const hh = m[4] != null ? Number(m[4]) : 14;
    const mm = m[5] != null ? Number(m[5]) : 0;
    return new Date(year, month, day, hh, mm, 0, 0);
  }
  
  // ===== FORMAT 7 : DD-MM-YYYY [HH:mm] =====
  m = s.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{1,2})[h:](\d{2}))?$/);
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
// Structured replies (sans IA) - CORRIGÉ + LOOP GUARD
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
  return (
    s === "2" ||
    s.includes("autre") ||
    s.includes("tier") ||
    s.includes("tierce") ||
    s.includes("quelqu") ||
    s.includes("pour lui") ||
    s.includes("pour elle")
  );
}

async function tryHandleStructuredReply({ merchant, customer, text, conversationState }) {
  const waiting = conversationState?.waiting_field;
  if (!waiting) return { handled: false };

  const clean = String(text || "").trim();
  if (!clean) return { handled: true, message: "Je n'ai pas bien reçu. Peux-tu répéter ?" };

  // ✅ CORRECTION #3: LOOP GUARD (limite 3 tentatives)
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
    return {
      handled: true,
      message: "Je n'arrive pas à comprendre cette information. Un conseiller va te recontacter 🙂",
    };
  }

  // Si ACK alors on redemande la vraie valeur (important)
  const fieldsRequiringValue = [
    "name",
    "self_name",
    "recipient_name",
    "recipient_address",
    "recipient_phone",
    "delivery_requested_raw",
    "payment_method", // ✅ AJOUTÉ
  ];

  if (isAckValue(clean) && fieldsRequiringValue.includes(waiting)) {
    // ✅ Incrémenter loop_guard
    await setConversationState(merchant.id, customer.id, {
      ...conversationState,
      loop_guard: { key: currentKey, count },
    });

    const mapMsg = {
      name: "Quel est votre **nom complet** ? (ex : \"KONE Aïcha\")",
      self_name: "Quel est votre **nom complet** ? (ex : \"KONE Aïcha\")",
      recipient_name: "Quel est le **nom complet** du destinataire ? (ex : \"KONE Aïcha\")",
      recipient_phone: "Quel est le **numéro WhatsApp** du destinataire ? (ex : 225XXXXXXXXXX)",
      recipient_address: "Quelle est l'**adresse complète** du destinataire ? (ex : \"Cocody Angré …\")",
      delivery_requested_raw: "Donnez la **date/heure de livraison** (ex : 2025-12-10 14:30).",
      payment_method: "Merci ✅ Quel mode de paiement souhaitez-vous ? (cash, Wave, Orange Money, MTN, carte…)",
    };
    return { handled: true, message: mapMsg[waiting] || "Je vous écoute 🙂 Peux-tu préciser ?" };
  }

  // ✅ NOUVEAU: Gestion payment_method
  if (waiting === "payment_method") {
    if (!validateField("payment_method", clean)) {
      await setConversationState(merchant.id, customer.id, {
        ...conversationState,
        loop_guard: { key: currentKey, count },
      });
      return {
        handled: true,
        message: "Mode de paiement non reconnu. Choisis parmi : *cash*, *Wave*, *Orange Money*, *MTN*, *carte*.",
      };
    }
    await updateCustomerField(merchant.id, customer.id, "payment_method", clean);
    await setConversationState(merchant.id, customer.id, {
      ...conversationState,
      waiting_field: null,
      loop_guard: null, // ✅ Reset après succès
    });
    return {
      handled: true,
      message: "Merci ✅. Maintenant écris *Je confirme* pour valider la commande.",
    };
  }

  // Date/heure de livraison (HARMONISÉE)
  if (waiting === "delivery_requested_raw") {
    if (!validateField("delivery_requested_raw", clean)) {
      await setConversationState(merchant.id, customer.id, {
        ...conversationState,
        loop_guard: { key: currentKey, count },
      });
      return { handled: true, message: "Format non valide. Exemple : *2025-12-10 14:30* ou *10/12/2025 14:30*." };
    }
    await setConversationState(merchant.id, customer.id, {
      ...conversationState,
      delivery_requested_raw: clean,
      waiting_field: null,
      loop_guard: null, // ✅ Reset après succès
    });
    return {
      handled: true,
      message: "Merci ✅. Maintenant écris *Je confirme* pour valider la commande.",
    };
  }

  // Nom (self)
  if (waiting === "name" || waiting === "self_name") {
    if (!validateField("name", clean)) {
      await setConversationState(merchant.id, customer.id, {
        ...conversationState,
        loop_guard: { key: currentKey, count },
      });
      return { handled: true, message: "J'ai besoin de votre **nom complet** (ex : \"KONE Aïcha\")." };
    }
    await updateCustomerField(merchant.id, customer.id, "name", clean);
    await setConversationState(merchant.id, customer.id, {
      ...conversationState,
      waiting_field: null,
      loop_guard: null, // ✅ Reset après succès
    });
    return { handled: true, message: `Merci ${clean} ✅. Écris *Je confirme* pour valider.` };
  }

  // Choix destinataire : 1/2/moi/autre
  if (waiting === "recipient_mode") {
    if (isAckValue(clean)) {
      await setConversationState(merchant.id, customer.id, {
        ...conversationState,
        loop_guard: { key: currentKey, count },
      });
      return { handled: true, message: "Réponds : *1* = pour toi-même, *2* = pour une autre personne." };
    }

    if (looksLikeRecipientSelf(clean)) {
      const nextState = { ...conversationState, recipient_mode: "self", waiting_field: null, step: null, loop_guard: null };
      await setConversationState(merchant.id, customer.id, nextState);

      if (!customer.name) {
        await setConversationState(merchant.id, customer.id, { ...nextState, step: "ASKING_INFO", waiting_field: "name" });
        return { handled: true, message: "D'accord 🙂 Quel est votre nom (et prénom) ?" };
      }

      // ✅ CORRECTION #4: Vérifier payment_method avant delivery
      if (!customer.payment_method) {
        await setConversationState(merchant.id, customer.id, { ...nextState, step: "ASKING_INFO", waiting_field: "payment_method" });
        return { handled: true, message: "Merci ✅ Quel mode de paiement souhaitez-vous ? (cash, Wave, Orange Money, MTN, carte…)" };
      }

      // ensuite livraison
      await setConversationState(merchant.id, customer.id, { ...nextState, step: "ASKING_INFO", waiting_field: "delivery_requested_raw" });
      return { handled: true, message: "Parfait ✅. Donnez-moi la *date/heure de livraison* (ex: 2025-12-10 14:30)." };
    }

    if (looksLikeRecipientThird(clean)) {
      const nextState = { ...conversationState, recipient_mode: "third_party", waiting_field: "recipient_name", step: "ASKING_INFO", loop_guard: null };
      await setConversationState(merchant.id, customer.id, nextState);
      return { handled: true, message: "Très bien. Donne-moi le *nom et prénom* du destinataire." };
    }

    await setConversationState(merchant.id, customer.id, {
      ...conversationState,
      loop_guard: { key: currentKey, count },
    });
    return { handled: true, message: "Réponds : *1* = pour toi-même, *2* = pour une autre personne." };
  }

  // Tiers : nom
  if (waiting === "recipient_name") {
    if (!validateField("recipient_name", clean)) {
      await setConversationState(merchant.id, customer.id, {
        ...conversationState,
        loop_guard: { key: currentKey, count },
      });
      return { handled: true, message: "J'ai besoin du **nom complet** du destinataire (ex : \"KONE Aïcha\")." };
    }
    const nextState = { ...conversationState, recipient_name: clean, waiting_field: "recipient_phone", step: "ASKING_INFO", loop_guard: null };
    await setConversationState(merchant.id, customer.id, nextState);
    return { handled: true, message: "Super. Donne-moi son *numéro WhatsApp* (format 225XXXXXXXXXX)." };
  }

  // Tiers : téléphone
  if (waiting === "recipient_phone") {
    if (!validateField("recipient_phone", clean)) {
      await setConversationState(merchant.id, customer.id, {
        ...conversationState,
        loop_guard: { key: currentKey, count },
      });
      return { handled: true, message: "Numéro invalide. Envoie le numéro au format: *225XXXXXXXXXX*." };
    }
    const phone = normalizePhone(clean);
    if (!phone) {
      await setConversationState(merchant.id, customer.id, {
        ...conversationState,
        loop_guard: { key: currentKey, count },
      });
      return { handled: true, message: "Numéro invalide. Envoie le numéro au format: *225XXXXXXXXXX*." };
    }

    const nextState = { ...conversationState, recipient_phone: phone, waiting_field: "recipient_address", step: "ASKING_INFO", loop_guard: null };
    await setConversationState(merchant.id, customer.id, nextState);
    return { handled: true, message: "Merci. Et l'*adresse de livraison* du destinataire ?" };
  }

  // Tiers : adresse
  if (waiting === "recipient_address") {
    if (!validateField("recipient_address", clean)) {
      await setConversationState(merchant.id, customer.id, {
        ...conversationState,
        loop_guard: { key: currentKey, count },
      });
      return { handled: true, message: "J'ai besoin d'une **adresse complète** (ex : \"Cocody Angré 8e tranche …\")." };
    }
    // ✅ CORRECTION #5: Vérifier payment_method avant de terminer
    const nextState = { ...conversationState, recipient_address: clean, waiting_field: null, loop_guard: null };

    if (!customer.payment_method) {
      await setConversationState(merchant.id, customer.id, { ...nextState, step: "ASKING_INFO", waiting_field: "payment_method" });
      return { handled: true, message: "Merci ✅ Quel mode de paiement souhaitez-vous ? (cash, Wave, Orange Money, MTN, carte…)" };
    }

    // Sinon passer à delivery
    await setConversationState(merchant.id, customer.id, { ...nextState, step: "ASKING_INFO", waiting_field: "delivery_requested_raw" });
    return { handled: true, message: "Parfait ✅. Donnez-moi la *date/heure de livraison* (ex: 2025-12-10 14:30)." };
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
// Actions IA (CORRIGÉ)
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

      // ✅ Ne rien faire si state vide (au lieu de tout reset)
      if (keys.length === 0) {
        return;
      }

      const st = await getConversationState(merchant.id, customer.id);
      await setConversationState(merchant.id, customer.id, { ...(st || {}), ...patch });
      return;
    }

    case "UPDATE_CUSTOMER": {
      const val = (action.value || "").toString().trim();

      // ✅ anti-bug : refuse ACK et valeurs non plausibles
      if (!validateField(action.field, val)) {
        // forcer la question claire
        const st = await getConversationState(merchant.id, customer.id);
        await setConversationState(merchant.id, customer.id, { ...(st || {}), step: "ASKING_INFO", waiting_field: action.field });

        ctx.overrideMessage =
          action.field === "name"
            ? "Parfait 🙂 Quel est votre **nom complet** ? (ex : \"KONE Aïcha\")"
            : action.field === "address"
            ? "D'accord 🙂 Quelle est votre **adresse complète** ? (ex : \"Cocody Angré 8e tranche …\")"
            : action.field === "payment_method"
            ? "Merci ✅ Quel mode de paiement souhaitez-vous ? (cash, Wave, Orange Money, MTN, carte…)"
            : "Je vous écoute 🙂 Pouvez-vous préciser ?";
        return;
      }

      await updateCustomerField(merchant.id, customer.id, action.field, val);
      return;
    }

    case "ASK_INFO": {
      // ✅ merge state (ne pas écraser last_question/pending_add_to_cart)
      const st = await getConversationState(merchant.id, customer.id);
      await setConversationState(merchant.id, customer.id, {
        ...(st || {}),
        step: "ASKING_INFO",
        waiting_field: action.field,
      });
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
      else ctx.overrideMessage = "✅ Ok. J'ai remis votre dernière commande dans le panier. Ajoutez/retirez puis écrivez *Je confirme*.";
      return;
    }

    case "CONFIRM_ORDER": {
      const st = await getConversationState(merchant.id, customer.id);

      if (!st?.recipient_mode) {
        await setConversationState(merchant.id, customer.id, { ...(st || {}), step: "ASKING_INFO", waiting_field: "recipient_mode" });
        ctx.overrideMessage = "Parfait ✅ C'est pour vous-même (1) ou pour une autre personne (2) ?";
        return;
      }

      // ✅ CORRECTION #6: Vérifier payment_method AVANT delivery
      if (!customer.payment_method) {
        await setConversationState(merchant.id, customer.id, {
          ...(st || {}),
          step: "ASKING_INFO",
          waiting_field: "payment_method",
        });
        ctx.overrideMessage = "Merci ✅ Quel mode de paiement souhaitez-vous ? (cash, Wave, Orange Money, MTN, carte…)";
        return;
      }

      const deliveryRaw = st?.delivery_requested_raw;
      if (!deliveryRaw) {
        // ✅ harmonisé
        await setConversationState(merchant.id, customer.id, { ...(st || {}), step: "ASKING_INFO", waiting_field: "delivery_requested_raw" });
        ctx.overrideMessage = "Merci ✅ Il me manque la date et l'heure de livraison. Pour quand souhaitez-vous la livraison ?";
        return;
      }

      const deliveryAt = parseDeliveryRequestedAt(deliveryRaw);
      if (!deliveryAt || isPastDate(deliveryAt)) {
        await setConversationState(merchant.id, customer.id, {
          ...(st || {}),
          step: "ASKING_INFO",
          waiting_field: "delivery_requested_raw",
          delivery_requested_raw: null,
        });
        ctx.overrideMessage = "La date de livraison est invalide ou passée. Donnez une date future (ex: 2025-12-10 14:30).";
        return;
      }

      // self
      if (st.recipient_mode === "self") {
        if (!customer.name) {
          await setConversationState(merchant.id, customer.id, { ...(st || {}), step: "ASKING_INFO", waiting_field: "name", recipient_mode: "self" });
          ctx.overrideMessage = "D'accord 🙂 Quel est votre nom (et prénom) ?";
          return;
        }

        // ✅ CRÉER LA COMMANDE
        await createOrderFromCart(merchant.id, customer.id, {
          recipientCustomerId: customer.id,
          recipientNameSnapshot: customer.name,
          recipientPhoneSnapshot: customer.phone || null,
          recipientAddressSnapshot: customer.address || null,
          deliveryRequestedAt: deliveryAt,
          deliveryRequestedRaw: deliveryRaw,
          status: "NEW",
        });

        // ✅ RESET COMPLET DU STATE
        await setConversationState(merchant.id, customer.id, {
          opted_out: false,
          order_completed: true,
          step: "COMPLETED",
          waiting_field: null,
          loop_guard: null,
          recipient_mode: null, // ⬅️ RESET pour prochaine commande
          delivery_requested_raw: null, // ⬅️ RESET
          pending_add_to_cart: null, // ⬅️ RESET
        });
        
        ctx.overrideMessage = `✅ Commande confirmée. Livraison prévue le ${deliveryAt.toLocaleString("fr-FR")}. Merci et à bientôt !`;
        return;
      }

      // third party
      if (st.recipient_mode === "third_party") {
        if (!st.recipient_name) {
          await setConversationState(merchant.id, customer.id, { ...(st || {}), step: "ASKING_INFO", waiting_field: "recipient_name" });
          ctx.overrideMessage = "Très bien. Donne-moi le *nom et prénom* du destinataire.";
          return;
        }
        if (!st.recipient_phone) {
          await setConversationState(merchant.id, customer.id, { ...(st || {}), step: "ASKING_INFO", waiting_field: "recipient_phone" });
          ctx.overrideMessage = "Super. Donne-moi son *numéro WhatsApp* (format 225XXXXXXXXXX).";
          return;
        }
        if (!st.recipient_address) {
          await setConversationState(merchant.id, customer.id, { ...(st || {}), step: "ASKING_INFO", waiting_field: "recipient_address" });
          ctx.overrideMessage = "Merci. Et l'*adresse de livraison* du destinataire ?";
          return;
        }

        const recipientPhone = normalizeE164(st.recipient_phone);
        const recipient = await findOrCreateCustomer(merchant.id, recipientPhone);

        if (recipient && st.recipient_name) 
          await updateCustomerField(merchant.id, recipient.id, "name", st.recipient_name);
        if (recipient && st.recipient_address) 
          await updateCustomerField(merchant.id, recipient.id, "address", st.recipient_address);

        // ✅ CRÉER LA COMMANDE
        await createOrderFromCart(merchant.id, customer.id, {
          recipientCustomerId: recipient?.id || null,
          recipientNameSnapshot: st.recipient_name,
          recipientPhoneSnapshot: recipientPhone,
          recipientAddressSnapshot: st.recipient_address,
          deliveryRequestedAt: deliveryAt,
          deliveryRequestedRaw: deliveryRaw,
          status: "NEW",
        });

        // ✅ RESET COMPLET DU STATE
        await setConversationState(merchant.id, customer.id, {
          opted_out: false,
          order_completed: true,
          step: "COMPLETED",
          waiting_field: null,
          loop_guard: null,
          recipient_mode: null, // ⬅️ RESET
          recipient_name: null, // ⬅️ RESET
          recipient_phone: null, // ⬅️ RESET
          recipient_address: null, // ⬅️ RESET
          delivery_requested_raw: null, // ⬅️ RESET
          pending_add_to_cart: null, // ⬅️ RESET
        });
        
        ctx.overrideMessage = `✅ Commande confirmée pour ${st.recipient_name}. Livraison le ${deliveryAt.toLocaleString("fr-FR")}. Merci et à bientôt !`;
        return;
      }

      await setConversationState(merchant.id, customer.id, { ...(st || {}), step: "ASKING_INFO", waiting_field: "recipient_mode" });
      ctx.overrideMessage = "Parfait ✅ C'est pour vous-même (1) ou pour une autre personne (2) ?";
      return;
    }

    default:
      console.warn("⚠️ Action inconnue", action);
      return;
  }
}

// ================================
// Moteur commun (utilisé par WAHA + Postman)
// ================================
async function handleIncomingMessage({ from, text, merchant, replyChatId }) {
  const customer = await findOrCreateCustomer(merchant.id, from);
  const conversationState = await getConversationState(merchant.id, customer.id);

  // ✅ silence si opt-out déjà activé (sauf réactivation)
  if (conversationState?.opted_out && !isReactivationMessage(text)) {
    return { message: null, actions: [] };
  }

  // ✅ 1) Réponses structurées (sans IA)
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

  // ===== NOUVEAU : DÉTECTION "AVEC IMAGES" POUR PDF =====
  const normalizedText = text.toLowerCase().trim();
  const isPdfRequest = 
    normalizedText.includes("avec images") ||
    normalizedText.includes("avec photos") ||
    normalizedText.includes("catalogue pdf") ||
    normalizedText === "pdf" ||
    normalizedText === "images";

  if (isPdfRequest) {
    try {
      // Récupérer les produits
      const products = await getProductsForMerchant(merchant.id);
      
      if (products.length === 0) {
        await sendWhatsappMessage({
          merchant,
          chatId: replyChatId,
          to: from,
          text: "Désolé, aucun produit n'est disponible pour le moment.",
        });
        return { message: "Aucun produit disponible", actions: [] };
      }

      // Message de chargement
      await sendWhatsappMessage({
        merchant,
        chatId: replyChatId,
        to: from,
        text: "🔄 Génération du catalogue PDF en cours (quelques secondes)..."
      });

      // Générer le PDF
      console.log(`[Catalog] 📄 Génération PDF pour ${products.length} produits...`);
      const pdfPath = await generateCatalogPDF(merchant, products);

      // Envoyer le PDF via WhatsApp
      await sendWhatsappDocument({
        merchant,
        chatId: replyChatId,
        to: from,
        filePath: pdfPath,
        filename: `Catalogue_${merchant.name.replace(/\s+/g, '_')}.pdf`,
        caption: `📦 Catalogue complet (${products.length} produits)\n\n✅ Pour commander, tapez le nom ou le code du produit`
      });

      // Nettoyer le fichier après envoi (attendre 10 secondes)
      setTimeout(() => cleanupPDF(pdfPath), 10000);

      return { message: "Catalogue PDF envoyé", actions: [] };
      
    } catch (error) {
      console.error('[Catalog] ❌ Erreur génération PDF:', error);
      await sendWhatsappMessage({
        merchant,
        chatId: replyChatId,
        to: from,
        text: "❌ Erreur lors de la génération du catalogue. Veuillez réessayer ou tapez 1 pour voir la liste."
      });
      return { message: "Erreur PDF", actions: [] };
    }
  }

  // ✅ RÉCUPÉRER LE PANIER DE LA DB
  const cart = await getCart(merchant.id, customer.id);

  // ✅ LOG DE DIAGNOSTIC
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🛒 CART DEBUG (from getCart):");
  console.log("  Type:", Array.isArray(cart) ? "Array" : typeof cart);
  console.log("  Length:", Array.isArray(cart) ? cart.length : (cart?.items?.length || "N/A"));
  if (Array.isArray(cart) && cart.length > 0) {
    console.log("  Items:");
    cart.forEach(item => {
      console.log(`    - ${item.name} x${item.quantity} (${item.total || item.price * item.quantity} XOF)`);
    });
  } else if (cart?.items && cart.items.length > 0) {
    console.log("  Items:");
    cart.items.forEach(item => {
      console.log(`    - ${item.name} x${item.quantity} (${item.total_price || item.total || item.price * item.quantity} XOF)`);
    });
  } else {
    console.log("  ⚠️ Panier vide ou format inconnu");
  }
  console.log("  Full content:", JSON.stringify(cart, null, 2));
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

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

  // ✅ si message vide => ne rien envoyer (utile pour STOP)
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
// Route pour upload logo
// ================================

// ===== DOSSIERS UPLOAD =====
const productsUploadDir = '/var/www/uploads/products';
const logosUploadDir = '/var/www/uploads/logos';

if (!fs.existsSync(productsUploadDir)) {
  fs.mkdirSync(productsUploadDir, { recursive: true });
}
if (!fs.existsSync(logosUploadDir)) {
  fs.mkdirSync(logosUploadDir, { recursive: true });
}

// ===== MULTER CONFIG IMAGES PRODUITS =====
const productImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, productsUploadDir),
  filename: (req, file, cb) => {
    const merchantId = req.params.merchantId;
    const ext = path.extname(file.originalname);
    const timestamp = Date.now();
    cb(null, `product_${merchantId}_${timestamp}${ext}`);
  }
});

const uploadProductImage = multer({
  storage: productImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format invalide. PNG, JPG, WEBP uniquement.'));
    }
  }
});

// ===== MULTER CONFIG LOGOS MARCHANDS =====
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, logosUploadDir),
  filename: (req, file, cb) => {
    const merchantId = req.params.merchantId;
    const ext = path.extname(file.originalname);
    const timestamp = Date.now();
    cb(null, `logo_${merchantId}_${timestamp}${ext}`);
  }
});

const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format invalide. PNG, JPG uniquement.'));
    }
  }
});

// ===== ROUTES UPLOAD =====

// Upload image produit
app.post(
  '/api/merchants/:merchantId/upload-product-image',
  authMiddleware,
  requireSameMerchant,
  uploadProductImage.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Aucun fichier uploadé' });
      }

      const imageUrl = `http://92.112.193.171:3002/uploads/products/${req.file.filename}`;
      
      console.log('[UPLOAD] Image produit:', {
        merchant: req.params.merchantId,
        filename: req.file.filename,
        url: imageUrl
      });

      return res.json({ success: true, url: imageUrl, filename: req.file.filename });
    } catch (error) {
      console.error('[UPLOAD] Erreur:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

// Upload logo marchand
app.post(
  '/api/merchants/:merchantId/logo',
  authMiddleware,
  requireSameMerchant,
  uploadLogo.single('logo'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Aucun fichier uploadé' });
      }

      const logoUrl = `http://92.112.193.171:3002/uploads/logos/${req.file.filename}`;
      
      // Mettre à jour en BDD
      const result = await db.query(
        'UPDATE merchants SET logo_url = $1 WHERE id = $2 RETURNING *',
        [logoUrl, req.params.merchantId]
      );

      console.log('[UPLOAD] Logo marchand:', {
        merchant: req.params.merchantId,
        filename: req.file.filename,
        url: logoUrl
      });

      return res.json({ 
        success: true, 
        logo_url: logoUrl,
        merchant: result.rows[0]
      });
    } catch (error) {
      console.error('[UPLOAD] Erreur:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

// ===== SERVIR LES FICHIERS STATIQUES =====
app.use('/uploads', express.static('/var/www/uploads'));

// ================================
// Webhook "test" (Postman)
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

    if (
      (fromChatId && String(fromChatId).includes("status@broadcast")) ||
      (chatId && String(chatId).includes("status@broadcast"))
    ) {
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
// Merchant Auth (login/register)
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
// Merchant API (products/orders) - protégée
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
    if (e.code === "23505") {
      return res.status(400).json({ error: "Collision: email/whatsapp/session déjà utilisé", details: e.detail });
    }
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.put("/api/admin/merchants/:merchantId/waha", adminAuthMiddleware, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const { whatsapp_number, waha_session } = req.body || {};
    if (!whatsapp_number && !waha_session) return res.status(400).json({ error: "Fournis whatsapp_number et/ou waha_session" });

    const updated = await updateMerchantWahaConfig(merchantId, {
      whatsappNumber: whatsapp_number,
      wahaSession: waha_session,
    });

    if (!updated) return res.status(404).json({ error: "Marchand introuvable" });
    return res.json({ merchant: updated });
  } catch (e) {
    console.error("Erreur PUT /api/admin/merchants/:merchantId/waha", e);
    if (e.code === "23505") {
      return res.status(400).json({ error: "whatsapp_number ou waha_session déjà pris", details: e.detail });
    }
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ================================
// Start server
// ================================
const listenPort = Number(process.env.PORT || PORT || 3000);
app.listen(listenPort, "0.0.0.0", () => {
  console.log("✅ Serveur démarré sur le port", listenPort);
});
