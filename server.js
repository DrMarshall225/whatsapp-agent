// server.js
import "dotenv/config";
import cors from "cors";
import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

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
  createProductForMerchant,
  updateProductForMerchant,
  deleteProductForMerchant,
  updateCustomerField,
  getOrdersForMerchant,
  getOrderWithItems,
  updateOrderStatus,
  findMerchantByEmail,
  createMerchant,
  createMerchantWithWaha,
  updateMerchantWahaConfig,
  updateCustomerProfile,
  getLastOrderWithItemsForCustomer,
  cancelLastOrderForCustomer,
  loadLastOrderToCart,
  adminListMerchants,
  adminSetMerchantSuspended,
  adminGetDashboard,
  adminAddSubscriptionPayment,
  adminListSubscriptionPayments,
  getMerchantAccessFlags,
} from "./services/store.pg.js";

import { callCommandBot } from "./services/commandbot.js";
import { sendWhatsappMessage } from "./services/whatsapp.js";
import { PORT } from "./config.js";

// ================================
// App config
// ================================
const app = express();

app.use(
  cors({
    origin: true, // OK pour dev / multi-origins
    credentials: true,
  })
);

app.use(express.json({ limit: "5mb" }));

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-a-changer";

// ================================
// Helpers (phone / WAHA)
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
  if (s.endsWith("@lid")) return s; // WAHA peut donner @lid
  if (s.includes("@")) return s;

  const digits = s.replace(/[^\d]/g, "");
  return digits ? `${digits}@c.us` : null;
}

function isStatusBroadcast(id) {
  return (
    !!id &&
    (String(id).includes("status@broadcast") || String(id).includes("false_status@broadcast"))
  );
}

function mapWhatsappPayload(body) {
  // Postman: { from, to, text }
  return {
    from: body?.from,
    to: body?.to,
    text: body?.text,
  };
}

function pickTextFromWaha(root) {
  const p = root?.payload || root;
  return (
    p?.text ||
    p?.body ||
    p?.message?.text ||
    p?.payload?.text ||
    p?.payload?.body ||
    root?.payload?.text ||
    root?.payload?.body ||
    null
  );
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
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Token invalide" });
  }
}

function requireSameMerchant(req, res, next) {
  const merchantId = Number(req.params.merchantId);
  if (Number.isNaN(merchantId)) return res.status(400).json({ error: "merchantId invalide" });
  if (req.merchantId !== merchantId)
    return res.status(403).json({ error: "Accès interdit (mauvais marchand)" });
  return next();
}

function adminAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [type, token] = authHeader.split(" ");
  if (type !== "Bearer" || !token) return res.status(401).json({ error: "Token admin manquant" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== "admin") return res.status(403).json({ error: "Accès refusé" });
    req.admin = payload;
    return next();
  } catch {
    return res.status(401).json({ error: "Token admin invalide" });
  }
}

async function subscriptionGate(req, res, next) {
  const merchantId = Number(req.params.merchantId);
  const m = await getMerchantAccessFlags(merchantId);
  if (!m) return res.status(404).json({ error: "Marchand introuvable" });

  if (m.is_suspended) return res.status(403).json({ error: "Compte suspendu. Contactez l’admin." });

  if (m.subscription_expires_at && new Date(m.subscription_expires_at).getTime() < Date.now()) {
    return res.status(402).json({ error: "Abonnement expiré. Veuillez renouveler (15 000 FCFA / mois)." });
  }
  return next();
}

// ================================
// Mini NLP helpers (pour éviter les boucles)
// ================================
function looksLikeAck(msg) {
  const s = String(msg || "").trim().toLowerCase();
  return ["ok", "okay", "d’accord", "dac", "👍", "👌", "oui"].includes(s);
}
function looksLikeSelf(msg) {
  const s = String(msg || "").trim().toLowerCase();
  return ["1", "moi", "pour moi", "pour moi-même", "pour moi meme", "c'est moi", "meme"].some((k) =>
    s.includes(k)
  );
}
function looksLikeThird(msg) {
  const s = String(msg || "").trim().toLowerCase();
  return ["2", "autre", "tiers", "tierce", "quelqu'un", "quelquun", "pour lui", "pour elle"].some((k) =>
    s.includes(k)
  );
}
function normalizeE164(input) {
  if (!input) return null;
  const digits = String(input).replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

// Convertit "aujourd’hui 16h", "demain 14h", "après demain 15h" => "DD/MM/YYYY HH:mm"
function normalizeRelativeDelivery(text, now = new Date()) {
  if (!text) return null;
  const t = String(text).toLowerCase();

  let addDays = null;
  if (/(apres|après)\s*-?\s*demain/.test(t)) addDays = 2;
  else if (t.includes("aujourd")) addDays = 0;
  else if (t.includes("demain")) addDays = 1;

  const m = t.match(/\b(\d{1,2})(?:\s*[h:]\s*(\d{2}))?\b/);
  if (addDays === null || !m) return null;

  const hh = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  d.setDate(d.getDate() + addDays);

  const dd = String(d.getDate()).padStart(2, "0");
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const HH = String(hh).padStart(2, "0");
  const MIN = String(mm).padStart(2, "0");

  return `${dd}/${MM}/${yyyy} ${HH}:${MIN}`;
}

function parseDeliveryRequestedAt(rawText) {
  if (!rawText) return null;
  const s = String(rawText).trim();

  // YYYY-MM-DD [HH:mm]
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    const hh = m[4] != null ? Number(m[4]) : 10;
    const mm = m[5] != null ? Number(m[5]) : 0;
    return new Date(year, month, day, hh, mm, 0, 0);
  }

  // DD/MM/YYYY [HH:mm]
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]) - 1;
    const year = Number(m[3]);
    const hh = m[4] != null ? Number(m[4]) : 10;
    const mm = m[5] != null ? Number(m[5]) : 0;
    return new Date(year, month, day, hh, mm, 0, 0);
  }

  return null;
}

function isPastDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return true;
  return d.getTime() < Date.now();
}

// ================================
// Healthcheck
// ================================
app.get("/", (req, res) => res.status(200).send("whatsapp-agent OK ✅"));

// ================================
// Core actions from n8n
// ================================
async function applyAction(action, context) {
  const { merchant, customer } = context;

  switch (action.type) {
    case "ADD_TO_CART":
      await addToCart(merchant.id, customer.id, Number(action.product_id), action.quantity || 1);
      break;

    case "REMOVE_FROM_CART":
      await removeFromCart(merchant.id, customer.id, Number(action.product_id));
      break;

    case "CLEAR_CART":
      await clearCart(merchant.id, customer.id);
      break;

    case "SET_STATE": {
      const current = (await getConversationState(merchant.id, customer.id)) || {};
      const merged = { ...current, ...(action.state || {}) };
      await setConversationState(merchant.id, customer.id, merged);
      break;
    }

    case "ASK_INFO": {
      const current = (await getConversationState(merchant.id, customer.id)) || {};
      const merged = { ...current, step: "ASKING_INFO", waiting_field: action.field };
      await setConversationState(merchant.id, customer.id, merged);
      break;
    }

    case "UPDATE_CUSTOMER":
      await updateCustomerField(merchant.id, customer.id, action.field, action.value);
      break;

    case "SHOW_LAST_ORDER": {
      const last = await getLastOrderWithItemsForCustomer(merchant.id, customer.id);
      context.overrideMessage = last
        ? `Votre dernière commande (#${last.order.id}) est ${last.order.status}. Total: ${last.order.total_amount} ${last.order.currency}.`
        : "Vous n’avez pas encore de commande.";
      break;
    }

    case "CANCEL_LAST_ORDER": {
      const result = await cancelLastOrderForCustomer(merchant.id, customer.id);
      if (!result) context.overrideMessage = "Vous n’avez pas encore de commande à annuler.";
      else if (result.blocked) context.overrideMessage = `Impossible d’annuler : ${result.reason}`;
      else context.overrideMessage = `✅ D’accord. J’ai annulé votre commande (#${result.order.id}).`;
      break;
    }

    case "MODIFY_LAST_ORDER": {
      const result = await loadLastOrderToCart(merchant.id, customer.id);
      if (!result) context.overrideMessage = "Vous n’avez pas encore de commande à modifier.";
      else if (result.blocked) context.overrideMessage = `Impossible de modifier : ${result.reason}`;
      else
        context.overrideMessage =
          "✅ Ok. J’ai remis votre dernière commande dans le panier. Ajoutez/retirez des articles puis écrivez *Je confirme*.";
      break;
    }

    case "CONFIRM_ORDER": {
      // Safety gate (ne valide pas si infos manquantes)
      const st = (await getConversationState(merchant.id, customer.id)) || {};
      const cart = await getCart(merchant.id, customer.id);

      const hasItems =
        (Array.isArray(cart?.items) && cart.items.length > 0) ||
        (typeof cart?.total_items === "number" && cart.total_items > 0);

      if (!hasItems) {
        context.overrideMessage = "Votre panier est vide. Dites-moi le produit et la quantité 🙂";
        break;
      }

      if (!st.recipient_mode) {
        await setConversationState(merchant.id, customer.id, {
          ...st,
          step: "ASKING_INFO",
          waiting_field: "recipient_mode",
          last_question: "RECIPIENT_CHOICE",
        });
        context.overrideMessage = "C’est pour vous-même (1) ou pour une autre personne (2) ?";
        break;
      }

      // payment + delivery requis pour confirmer (selon ton workflow)
      if (!customer.payment_method) {
        await setConversationState(merchant.id, customer.id, {
          ...st,
          step: "ASKING_INFO",
          waiting_field: "payment_method",
          last_question: "ASK_PAYMENT",
        });
        context.overrideMessage =
          "Quel mode de paiement souhaitez-vous ? (cash, Wave, Orange Money, MTN, carte…)";
        break;
      }

      if (!st.delivery_requested_raw) {
        await setConversationState(merchant.id, customer.id, {
          ...st,
          step: "ASKING_INFO",
          waiting_field: "delivery_requested_raw",
          last_question: "ASK_DELIVERY_DATETIME",
        });
        context.overrideMessage =
          "Il me manque la date et l’heure de livraison. Pour quand souhaitez-vous la livraison ? (ex : demain 14h)";
        break;
      }

      const deliveryAt = parseDeliveryRequestedAt(st.delivery_requested_raw);
      if (!deliveryAt || isPastDate(deliveryAt)) {
        await setConversationState(merchant.id, customer.id, {
          ...st,
          step: "ASKING_INFO",
          waiting_field: "delivery_requested_raw",
          last_question: "ASK_DELIVERY_DATETIME",
          delivery_requested_raw: null,
        });
        context.overrideMessage =
          "Date/heure invalide. Envoyez par ex : 10/12/2025 16:00 (ou demain 14h).";
        break;
      }

      if (st.recipient_mode === "self") {
        if (!customer.name) {
          await setConversationState(merchant.id, customer.id, {
            ...st,
            step: "ASKING_INFO",
            waiting_field: "name",
            last_question: "ASK_NAME",
          });
          context.overrideMessage = "Quel est votre nom et prénom ?";
          break;
        }
        if (!customer.address) {
          await setConversationState(merchant.id, customer.id, {
            ...st,
            step: "ASKING_INFO",
            waiting_field: "address",
            last_question: "ASK_ADDRESS",
          });
          context.overrideMessage =
            "Quelle est votre adresse de livraison ? (ex : Cocody Angré 10e tranche, Abidjan)";
          break;
        }

        await createOrderFromCart(merchant.id, customer.id, {
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          address: customer.address,
          payment_method: customer.payment_method,
          delivery_requested_raw: st.delivery_requested_raw,
        });

        break;
      }

      if (st.recipient_mode === "third_party") {
        if (!st.recipient_name) {
          await setConversationState(merchant.id, customer.id, {
            ...st,
            step: "ASKING_INFO",
            waiting_field: "recipient_name",
            last_question: "ASK_RECIPIENT_NAME",
          });
          context.overrideMessage = "Donne-moi le nom et prénom du destinataire.";
          break;
        }
        if (!st.recipient_phone) {
          await setConversationState(merchant.id, customer.id, {
            ...st,
            step: "ASKING_INFO",
            waiting_field: "recipient_phone",
            last_question: "ASK_RECIPIENT_PHONE",
          });
          context.overrideMessage = "Donne-moi son numéro WhatsApp (format 225XXXXXXXXXX).";
          break;
        }
        if (!st.recipient_address) {
          await setConversationState(merchant.id, customer.id, {
            ...st,
            step: "ASKING_INFO",
            waiting_field: "recipient_address",
            last_question: "ASK_RECIPIENT_ADDRESS",
          });
          context.overrideMessage =
            "Quelle est l’adresse de livraison du destinataire ? (ex : Angré 8e tranche, Abidjan)";
          break;
        }

        const recipientPhone = normalizeE164(st.recipient_phone);
        const recipient = await findOrCreateCustomer(merchant.id, recipientPhone);

        await updateCustomerProfile(merchant.id, recipient.id, {
          name: st.recipient_name,
          address: st.recipient_address,
        });

        await createOrderFromCart(merchant.id, customer.id, {
          id: recipient.id,
          name: st.recipient_name,
          phone: recipientPhone,
          address: st.recipient_address,
          payment_method: customer.payment_method,
          delivery_requested_raw: st.delivery_requested_raw,
        });

        break;
      }

      break;
    }

    default:
      console.warn("⚠️ Action inconnue", action);
  }
}

// ================================
// Structured reply handler (anti-boucle)
// ================================
async function tryHandleStructuredReply({ merchant, customer, text, conversationState }) {
  const waiting = conversationState?.waiting_field;
  if (!waiting) return { handled: false };

  const clean = String(text || "").trim();
  if (!clean) return { handled: true, message: "Je n’ai pas bien reçu. Peux-tu répéter ?" };

  // recipient_mode
  if (waiting === "recipient_mode") {
    if (!looksLikeSelf(clean) && !looksLikeThird(clean)) {
      return { handled: true, message: "Réponds : 1 = pour toi-même, 2 = pour une autre personne." };
    }

    const next = { ...conversationState, recipient_mode: looksLikeSelf(clean) ? "self" : "third_party" };

    if (next.recipient_mode === "self") {
      if (!customer.name) {
        await setConversationState(merchant.id, customer.id, {
          ...next,
          step: "ASKING_INFO",
          waiting_field: "name",
          last_question: "ASK_NAME",
        });
        return { handled: true, message: "Merci 🙂 Quel est votre nom et prénom ?" };
      }
      if (!customer.address) {
        await setConversationState(merchant.id, customer.id, {
          ...next,
          step: "ASKING_INFO",
          waiting_field: "address",
          last_question: "ASK_ADDRESS",
        });
        return { handled: true, message: "Quelle est votre adresse de livraison ? (ex : Angré 10e tranche, Abidjan)" };
      }
      if (!customer.payment_method) {
        await setConversationState(merchant.id, customer.id, {
          ...next,
          step: "ASKING_INFO",
          waiting_field: "payment_method",
          last_question: "ASK_PAYMENT",
        });
        return { handled: true, message: "Quel mode de paiement souhaitez-vous ? (cash, Wave, Orange Money, MTN, carte…)" };
      }
      await setConversationState(merchant.id, customer.id, {
        ...next,
        step: "ASKING_INFO",
        waiting_field: "delivery_requested_raw",
        last_question: "ASK_DELIVERY_DATETIME",
      });
      return { handled: true, message: "Pour quand souhaitez-vous la livraison ? (ex : demain 14h, 10/12/2025 16:00)" };
    }

    // third_party flow
    await setConversationState(merchant.id, customer.id, {
      ...next,
      step: "ASKING_INFO",
      waiting_field: "recipient_name",
      last_question: "ASK_RECIPIENT_NAME",
    });
    return { handled: true, message: "Très bien. Donne-moi le nom et prénom du destinataire." };
  }

  // name
  if (waiting === "name") {
    if (looksLikeAck(clean)) {
      return { handled: true, message: "Quel est votre nom et prénom ? (ex : Diabaté Falikou)" };
    }
    await updateCustomerField(merchant.id, customer.id, "name", clean);

    const st = { ...(conversationState || {}) };
    if (!customer.address) {
      await setConversationState(merchant.id, customer.id, {
        ...st,
        step: "ASKING_INFO",
        waiting_field: "address",
        last_question: "ASK_ADDRESS",
      });
      return { handled: true, message: "Merci 🙂 Quelle est votre adresse de livraison ? (ex : Angré 10e tranche, Abidjan)" };
    }
    if (!customer.payment_method) {
      await setConversationState(merchant.id, customer.id, {
        ...st,
        step: "ASKING_INFO",
        waiting_field: "payment_method",
        last_question: "ASK_PAYMENT",
      });
      return { handled: true, message: "Quel mode de paiement souhaitez-vous ? (cash, Wave, Orange Money, MTN, carte…)" };
    }
    await setConversationState(merchant.id, customer.id, {
      ...st,
      step: "ASKING_INFO",
      waiting_field: "delivery_requested_raw",
      last_question: "ASK_DELIVERY_DATETIME",
    });
    return { handled: true, message: "Pour quand souhaitez-vous la livraison ? (ex : demain 14h, 10/12/2025 16:00)" };
  }

  // address
  if (waiting === "address") {
    if (looksLikeAck(clean) || clean.length < 6) {
      return { handled: true, message: "Adresse trop courte. Exemple : Cocody Angré 10e tranche, Abidjan." };
    }
    await updateCustomerField(merchant.id, customer.id, "address", clean);

    const st = { ...(conversationState || {}) };
    if (!customer.payment_method) {
      await setConversationState(merchant.id, customer.id, {
        ...st,
        step: "ASKING_INFO",
        waiting_field: "payment_method",
        last_question: "ASK_PAYMENT",
      });
      return { handled: true, message: "Quel mode de paiement souhaitez-vous ? (cash, Wave, Orange Money, MTN, carte…)" };
    }

    await setConversationState(merchant.id, customer.id, {
      ...st,
      step: "ASKING_INFO",
      waiting_field: "delivery_requested_raw",
      last_question: "ASK_DELIVERY_DATETIME",
    });
    return { handled: true, message: "Pour quand souhaitez-vous la livraison ? (ex : demain 14h, 10/12/2025 16:00)" };
  }

  // payment_method
  if (waiting === "payment_method") {
    if (looksLikeAck(clean)) {
      return { handled: true, message: "Quel mode de paiement ? (cash, wave, orange, mtn, carte…)" };
    }
    await updateCustomerField(merchant.id, customer.id, "payment_method", clean);

    const st = { ...(conversationState || {}) };
    await setConversationState(merchant.id, customer.id, {
      ...st,
      step: "ASKING_INFO",
      waiting_field: "delivery_requested_raw",
      last_question: "ASK_DELIVERY_DATETIME",
    });
    return { handled: true, message: "Pour quand souhaitez-vous la livraison ? (ex : demain 14h, 10/12/2025 16:00)" };
  }

  // recipient_name
  if (waiting === "recipient_name") {
    if (looksLikeAck(clean) || clean.length < 2) {
      return { handled: true, message: "Donne-moi le nom et prénom du destinataire (ex : Diaby Aminata)." };
    }
    const next = { ...conversationState, recipient_name: clean };
    await setConversationState(merchant.id, customer.id, {
      ...next,
      step: "ASKING_INFO",
      waiting_field: "recipient_phone",
      last_question: "ASK_RECIPIENT_PHONE",
    });
    return { handled: true, message: "Super. Donne-moi son numéro WhatsApp (format 225XXXXXXXXXX)." };
  }

  // recipient_phone
  if (waiting === "recipient_phone") {
    const phone = normalizeE164(clean);
    if (!phone || phone.replace(/[^\d]/g, "").length < 8) {
      return { handled: true, message: "Numéro invalide. Exemple : 2250700000000" };
    }
    const next = { ...conversationState, recipient_phone: phone };
    await setConversationState(merchant.id, customer.id, {
      ...next,
      step: "ASKING_INFO",
      waiting_field: "recipient_address",
      last_question: "ASK_RECIPIENT_ADDRESS",
    });
    return { handled: true, message: "Merci. Et l’adresse de livraison du destinataire ? (ex : Angré 8e tranche, Abidjan)" };
  }

  // recipient_address
  if (waiting === "recipient_address") {
    if (looksLikeAck(clean) || clean.length < 6) {
      return { handled: true, message: "Adresse trop courte. Exemple : Angré 8e tranche, Abidjan." };
    }
    const next = { ...conversationState, recipient_address: clean };

    if (!customer.payment_method) {
      await setConversationState(merchant.id, customer.id, {
        ...next,
        step: "ASKING_INFO",
        waiting_field: "payment_method",
        last_question: "ASK_PAYMENT",
      });
      return { handled: true, message: "Quel mode de paiement souhaitez-vous ? (cash, Wave, Orange Money, MTN, carte…)" };
    }

    await setConversationState(merchant.id, customer.id, {
      ...next,
      step: "ASKING_INFO",
      waiting_field: "delivery_requested_raw",
      last_question: "ASK_DELIVERY_DATETIME",
    });
    return { handled: true, message: "Pour quand souhaitez-vous la livraison ? (ex : demain 14h, 10/12/2025 16:00)" };
  }

  // delivery_requested_raw
  if (waiting === "delivery_requested_raw") {
    if (looksLikeAck(clean)) {
      return { handled: true, message: "Donnez la date/heure. Exemple : 10/12/2025 16:00 (ou demain 14h)." };
    }

    // On accepte relatif et on normalise si possible
    const normalized = normalizeRelativeDelivery(clean) || clean;
    const next = { ...conversationState, delivery_requested_raw: normalized };

    await setConversationState(merchant.id, customer.id, {
      ...next,
      step: "ASKING_INFO",
      waiting_field: "",
      last_question: "WAITING_FINAL_CONFIRM",
    });

    return { handled: true, message: "Parfait ✅ Pour valider la commande, écrivez : Je confirme." };
  }

  return { handled: false };
}

// ================================
// Incoming message (WAHA + Postman)
// ================================
async function handleIncomingMessage({ from, text, merchant, replyChatId }) {
  const customer = await findOrCreateCustomer(merchant.id, from);
  const cart = await getCart(merchant.id, customer.id);
  const products = await getProductsForMerchant(merchant.id);
  const conversationState = (await getConversationState(merchant.id, customer.id)) || {};

  // ✅ Anti-boucle : si on attend un champ précis, on le gère ici
  const structured = await tryHandleStructuredReply({
    merchant,
    customer,
    text,
    conversationState,
  });

  if (structured.handled) {
    const msg = String(structured.message || "").trim();
    if (msg) {
      await sendWhatsappMessage({
        merchant,
        chatId: replyChatId,
        to: from,
        text: msg,
      });
    }
    return { message: msg, actions: [] };
  }

  // ✅ Payload EXACT attendu par ton workflow n8n :
  const agentInput = {
    message: String(text || ""),
    merchant: { id: merchant.id, name: merchant.name },
    customer: {
      id: customer.id,
      phone: customer.phone,
      name: customer.name,
      address: customer.address,
      payment_method: customer.payment_method,
    },
    cart,
    products,
    conversation_state: conversationState,
  };

  let agentOutput;
  try {
    agentOutput = await callCommandBot(agentInput); // ⚠️ IMPORTANT : pas de re-wrapper ici
  } catch (e) {
    console.error("❌ callCommandBot error:", e);
    agentOutput = { message: "Désolé, souci technique. Réessayez svp 🙏", actions: [] };
  }

  const actions = Array.isArray(agentOutput?.actions) ? agentOutput.actions : [];
  const ctx = { merchant, customer, overrideMessage: null };

  for (const action of actions) {
    await applyAction(action, ctx);
  }

  const outgoingMsg =
    (ctx.overrideMessage && String(ctx.overrideMessage).trim()) ||
    (agentOutput?.message ? String(agentOutput.message).trim() : "");

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
// Webhook test Postman
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
// Webhook WAHA
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

    const text = String(pickTextFromWaha(eventWrap) || "").trim();
    if (!text) return res.sendStatus(200);

    const rawFrom = p?.from || p?.sender?.id || p?.author || p?.participant;
    const rawChatId = p?.chatId || p?.id?.remote || p?.conversation || p?.to;

    const fromChatId = normalizeWahaChatId(rawFrom);
    const chatId = normalizeWahaChatId(rawChatId);

    if (isStatusBroadcast(fromChatId) || isStatusBroadcast(chatId)) return res.sendStatus(200);

    const replyChatId = chatId && chatId.endsWith("@g.us") ? chatId : fromChatId;
    if (!replyChatId) return res.sendStatus(200);

    let fromPhone = chatIdToPhone(fromChatId) || normalizePhone(rawFrom) || String(fromChatId || replyChatId);

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
// Admin Auth
// ================================
app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });

    const adminEmail = process.env.ADMIN_EMAIL || "admin@local";
    const adminHash = process.env.ADMIN_PASSWORD_HASH || null;
    const adminPlain = process.env.ADMIN_PASSWORD || null;

    if (String(email).toLowerCase() !== String(adminEmail).toLowerCase()) {
      return res.status(401).json({ error: "Identifiants invalides" });
    }

    let ok = false;
    if (adminHash) ok = await bcrypt.compare(password, adminHash);
    else if (adminPlain) ok = password === adminPlain;

    if (!ok) return res.status(401).json({ error: "Identifiants invalides" });

    const token = jwt.sign({ role: "admin", email: adminEmail }, JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, admin: { email: adminEmail } });
  } catch (e) {
    console.error("Erreur /api/admin/login", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ================================
// Admin Dashboard + Merchants
// ================================
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

app.put("/api/admin/merchants/:id/suspend", adminAuthMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { is_suspended } = req.body || {};
    const updated = await adminSetMerchantSuspended(id, !!is_suspended);
    if (!updated) return res.status(404).json({ error: "Marchand introuvable" });
    return res.json(updated);
  } catch (e) {
    console.error("Erreur PUT /api/admin/merchants/:id/suspend", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post("/api/admin/merchants/:id/payments", adminAuthMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { amount = 15000, months = 1, method = null, reference = null, note = null } = req.body || {};

    const result = await adminAddSubscriptionPayment(id, { amount, months, method, reference, note });
    if (!result) return res.status(404).json({ error: "Marchand introuvable" });

    return res.json({ payment: result.payment, merchant: result.merchant });
  } catch (e) {
    console.error("Erreur POST /api/admin/merchants/:id/payments", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/admin/merchants/:id/payments", adminAuthMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = await adminListSubscriptionPayments(id);
    return res.json(data);
  } catch (e) {
    console.error("Erreur GET /api/admin/merchants/:id/payments", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// créer merchant (admin)
app.post("/api/admin/merchants", adminAuthMiddleware, async (req, res) => {
  try {
    const { name, email, password, whatsapp_number, waha_session } = req.body || {};
    if (!name || !email || !password || !whatsapp_number || !waha_session) {
      return res.status(400).json({
        error: "Champs requis: name, email, password, whatsapp_number, waha_session",
      });
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
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// lier merchant à WAHA
app.put("/api/admin/merchants/:merchantId/waha", adminAuthMiddleware, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    if (Number.isNaN(merchantId)) return res.status(400).json({ error: "merchantId invalide" });

    const { whatsapp_number, waha_session } = req.body || {};
    if (!whatsapp_number && !waha_session) {
      return res.status(400).json({ error: "Fournis whatsapp_number et/ou waha_session" });
    }

    const updated = await updateMerchantWahaConfig(merchantId, {
      whatsappNumber: whatsapp_number,
      wahaSession: waha_session,
    });

    if (!updated) return res.status(404).json({ error: "Marchand introuvable" });
    return res.json({ merchant: updated });
  } catch (e) {
    console.error("Erreur PUT /api/admin/merchants/:id/waha", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ================================
// Auth merchants (login/register)
// ================================
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email et mot de passe obligatoires." });

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
      return res.status(400).json({ error: "name, email, password, whatsapp_number obligatoires." });
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
// Products
// ================================
app.get(
  "/api/merchants/:merchantId/products",
  authMiddleware,
  requireSameMerchant,
  subscriptionGate,
  async (req, res) => {
    try {
      const merchantId = Number(req.params.merchantId);
      const products = await getProductsForMerchant(merchantId);
      return res.json(products);
    } catch (e) {
      console.error("Erreur GET products", e);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

app.post(
  "/api/merchants/:merchantId/products",
  authMiddleware,
  requireSameMerchant,
  subscriptionGate,
  async (req, res) => {
    try {
      const merchantId = Number(req.params.merchantId);
      const { name, price, description, currency, code, category, image_url } = req.body || {};

      if (!name || price == null) return res.status(400).json({ error: "name et price obligatoires." });

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
  }
);

app.put(
  "/api/merchants/:merchantId/products/:productId",
  authMiddleware,
  requireSameMerchant,
  subscriptionGate,
  async (req, res) => {
    try {
      const merchantId = Number(req.params.merchantId);
      const productId = Number(req.params.productId);

      const { name, price, description, currency, code, category, image_url, is_active } = req.body || {};
      if (!name || price == null) return res.status(400).json({ error: "name et price obligatoires." });

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

      if (!updated) return res.status(404).json({ error: "Produit non trouvé" });
      return res.json(updated);
    } catch (e) {
      console.error("Erreur PUT products", e);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

app.delete(
  "/api/merchants/:merchantId/products/:productId",
  authMiddleware,
  requireSameMerchant,
  subscriptionGate,
  async (req, res) => {
    try {
      const merchantId = Number(req.params.merchantId);
      const productId = Number(req.params.productId);

      await deleteProductForMerchant(merchantId, productId);
      return res.status(204).send();
    } catch (e) {
      console.error("Erreur DELETE products", e);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// ================================
// Orders
// ================================
app.get(
  "/api/merchants/:merchantId/orders",
  authMiddleware,
  requireSameMerchant,
  subscriptionGate,
  async (req, res) => {
    try {
      const merchantId = Number(req.params.merchantId);
      const orders = await getOrdersForMerchant(merchantId);
      return res.json(orders);
    } catch (e) {
      console.error("Erreur GET orders", e);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

app.get(
  "/api/merchants/:merchantId/orders/:orderId",
  authMiddleware,
  requireSameMerchant,
  subscriptionGate,
  async (req, res) => {
    try {
      const merchantId = Number(req.params.merchantId);
      const orderId = Number(req.params.orderId);

      const data = await getOrderWithItems(merchantId, orderId);
      if (!data) return res.status(404).json({ error: "Commande introuvable" });

      return res.json(data);
    } catch (e) {
      console.error("Erreur GET order details", e);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

app.put(
  "/api/merchants/:merchantId/orders/:orderId/status",
  authMiddleware,
  requireSameMerchant,
  subscriptionGate,
  async (req, res) => {
    try {
      const merchantId = Number(req.params.merchantId);
      const orderId = Number(req.params.orderId);
      const { status } = req.body || {};
      if (!status) return res.status(400).json({ error: "status obligatoire" });

      const updated = await updateOrderStatus(merchantId, orderId, status);
      if (!updated) return res.status(404).json({ error: "Commande introuvable" });

      return res.json(updated);
    } catch (e) {
      console.error("Erreur PUT order status", e);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// ================================
// Start
// ================================
const listenPort = Number(process.env.PORT || PORT || 3000);
app.listen(listenPort, "0.0.0.0", () => {
  console.log("✅ Serveur démarré sur le port", listenPort);
  console.log("✅ ADMIN_EMAIL =", process.env.ADMIN_EMAIL || "(non défini)");
  console.log("✅ ADMIN_PASSWORD_HASH =", process.env.ADMIN_PASSWORD_HASH ? "(OK)" : "(non défini)");
});
