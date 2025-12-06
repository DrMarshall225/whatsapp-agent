import cors from "cors";
import express from "express";
import bodyParser from "body-parser";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

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
// Config
// ================================
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "5mb" }));

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-a-changer";

// ================================
// Helpers
// ================================
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

function chatIdToPhone(chatId) {
  // ex: "2250700000000@c.us" -> "+2250700000000"
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
  if (s.endsWith("@lid")) return s; // garder @lid si WAHA fournit ça
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
  // Ton payload test Postman : { from, to, text }
  return {
    from: body?.from,
    to: body?.to,
    text: body?.text,
  };
}

/**
 * WAHA payload varie selon versions.
 * On essaie plusieurs champs possibles pour récupérer le texte.
 */
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

/**
 * WAHA payload varie : on essaie de trouver le numéro "business" (le destinataire)
 * pour fallback si on ne trouve pas le merchant via session.
 */
function pickBusinessNumberFromPayload(root) {
  const p = root?.payload || root;
  return (
    chatIdToPhone(p?.to) ||
    chatIdToPhone(p?.recipient) ||
    chatIdToPhone(p?.chatId) ||
    chatIdToPhone(p?.id?.remote) ||
    null
  );
}

// ================================
// Middlewares
// ================================
function adminAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [type, token] = authHeader.split(" ");
  if (type !== "Bearer" || !token) return res.status(401).json({ error: "Token admin manquant" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload?.role !== "admin") return res.status(403).json({ error: "Accès admin refusé" });
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Token admin invalide" });
  }
}


function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [type, token] = authHeader.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ error: "Token manquant ou invalide" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.merchantId = payload.merchantId;
    function requireSameMerchant(req, res, next) {
  const merchantId = Number(req.params.merchantId);
  if (Number.isNaN(merchantId)) return res.status(400).json({ error: "merchantId invalide" });
  if (req.merchantId !== merchantId) return res.status(403).json({ error: "Accès interdit (mauvais marchand)" });
  next();
}

    next();
  } catch (e) {
    console.error("Erreur JWT", e);
    return res.status(401).json({ error: "Token invalide" });
  }
}


function looksLikeYes(msg) {
  const s = String(msg || "").trim().toLowerCase();
  return ["1", "oui", "ouais", "y", "yes", "moi", "pour moi", "c'est moi", "meme"].some(k => s.includes(k));
}
function looksLikeNo(msg) {
  const s = String(msg || "").trim().toLowerCase();
  return ["2", "non", "autre", "tiers", "tierce", "quelqu'un", "quelquun", "pour lui", "pour elle"].some(k => s.includes(k));
}

/**
 * Si le client est en train de répondre à une question structurée (nom, choix 1/2, tel destinataire...)
 * on traite ici SANS appeler l'IA.
 */
async function tryHandleStructuredReply({ merchant, customer, text, conversationState }) {
  const waiting = conversationState?.waiting_field;
  if (!waiting) return { handled: false };

  const clean = String(text || "").trim();
  if (!clean) return { handled: true, message: "Je n’ai pas bien reçu. Peux-tu répéter ?" };

  // 1) Choix : pour moi / pour quelqu'un d'autre
  if (waiting === "recipient_mode") {
    if (looksLikeYes(clean)) {
      // self
      const nextState = { ...conversationState, recipient_mode: "self", waiting_field: null, step: null };
      await setConversationState(merchant.id, customer.id, nextState);

      if (!customer.name) {
        await setConversationState(merchant.id, customer.id, { ...nextState, step: "ASKING_INFO", waiting_field: "self_name" });
        return { handled: true, message: "D’accord 😊. Quel est ton nom (et prénom) ?" };
      }

      // nom déjà connu => on confirme tout de suite
      const { order } = await createOrderFromCart(merchant.id, customer.id, {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        address: customer.address || null,
      });
      await setConversationState(merchant.id, customer.id, {}); // reset
      return { handled: true, message: `Merci ${customer.name} ✅. Ta commande #${order.id} est confirmée.` };
    }

    if (looksLikeNo(clean)) {
      const nextState = { ...conversationState, recipient_mode: "third_party", waiting_field: "recipient_name", step: "ASKING_INFO" };
      await setConversationState(merchant.id, customer.id, nextState);
      return { handled: true, message: "Très bien. Donne-moi le *nom et prénom* de la personne qui recevra la commande." };
    }

    return { handled: true, message: "Réponds : *1* = pour toi-même, *2* = pour une autre personne." };
  }

  // 2) Nom du client (self)
  if (waiting === "self_name") {
    await updateCustomerField(merchant.id, customer.id, "name", clean);
    await setConversationState(merchant.id, customer.id, {}); // reset

    const { order } = await createOrderFromCart(merchant.id, customer.id, {
      id: customer.id,
      name: clean,
      phone: customer.phone,
      address: customer.address || null,
    });

    return { handled: true, message: `Merci ${clean} ✅. Ta commande #${order.id} est confirmée.` };
  }

  // 3) Tiers : nom
  if (waiting === "recipient_name") {
    const nextState = { ...conversationState, recipient_name: clean, waiting_field: "recipient_phone", step: "ASKING_INFO" };
    await setConversationState(merchant.id, customer.id, nextState);
    return { handled: true, message: "Super. Donne-moi maintenant son *numéro WhatsApp* (format 225XXXXXXXXXX)." };
  }

  // 4) Tiers : téléphone (obligatoire pour créer un customer propre)
  if (waiting === "recipient_phone") {
    const phone = normalizePhone(clean); // tu as déjà normalizePhone dans server.js
    if (!phone) return { handled: true, message: "Numéro invalide. Envoie le numéro au format: 225XXXXXXXXXX" };

    const nextState = { ...conversationState, recipient_phone: phone, waiting_field: "recipient_address", step: "ASKING_INFO" };
    await setConversationState(merchant.id, customer.id, nextState);
    return { handled: true, message: "Merci. Et l’*adresse de livraison* du destinataire ?" };
  }

  // 5) Tiers : adresse puis confirmation
  if (waiting === "recipient_address") {
    const st = { ...conversationState, recipient_address: clean };
    // créer/charger le destinataire
    const recipient = await findOrCreateCustomer(merchant.id, st.recipient_phone);

    await updateCustomerProfile(merchant.id, recipient.id, {
      name: st.recipient_name || null,
      address: st.recipient_address || null,
    });

    const { order } = await createOrderFromCart(merchant.id, customer.id, {
      id: recipient.id,
      name: st.recipient_name || recipient.name || null,
      phone: st.recipient_phone,
      address: st.recipient_address,
    });

    await setConversationState(merchant.id, customer.id, {}); // reset

    const who = st.recipient_name ? `pour ${st.recipient_name}` : "pour le destinataire";
    return { handled: true, message: `Parfait ✅. Commande #${order.id} confirmée ${who}.` };
  }

  return { handled: false };
}

async function subscriptionGate(req, res, next) {
  const merchantId = Number(req.params.merchantId);
  const m = await getMerchantAccessFlags(merchantId);
  if (!m) return res.status(404).json({ error: "Marchand introuvable" });

  if (m.is_suspended) return res.status(403).json({ error: "Compte suspendu. Contactez l’admin." });

  if (m.subscription_expires_at && new Date(m.subscription_expires_at).getTime() < Date.now()) {
    return res.status(402).json({ error: "Abonnement expiré. Veuillez renouveler (15 000 FCFA / mois)." });
  }
  next();
}


// ================================
// Healthcheck
// ================================
app.get("/", (req, res) => {
  res.status(200).send("whatsapp-agent OK ✅");
});

// ================================
// Moteur commun (utilisé par WAHA + Postman)
// ================================
async function handleIncomingMessage({ from, text, merchant, replyChatId }) {
  console.log("📩 Message reçu", {
    from,
    merchantId: merchant?.id,
    text,
    replyChatId,
  });

  const customer = await findOrCreateCustomer(merchant.id, from);
  const cart = await getCart(merchant.id, customer.id);
  const products = await getProductsForMerchant(merchant.id);
  const conversationState = await getConversationState(merchant.id, customer.id);

  // ✅ IMPORTANT: déclarer AVANT toute utilisation
  let agentOutput = null;

  try {
    agentOutput = await callCommandBot({
      message: text, // ou "userText" selon ton n8n, mais garde ce qui marche déjà chez toi
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
    agentOutput = {
      message:
        "Désolé, j’ai eu un souci technique. Pouvez-vous réessayer dans un instant ?",
      actions: [],
    };
  }

  const actions = Array.isArray(agentOutput?.actions) ? agentOutput.actions : [];

  for (const action of actions) {
    await applyAction(action, { merchant, customer });
  }

  const outgoingMsg = agentOutput?.message ? String(agentOutput.message).trim() : "";

  if (outgoingMsg) {
    await sendWhatsappMessage({
      merchant,
      chatId: replyChatId, // ✅ répondre au chat reçu (client ou groupe)
      to: from,            // fallback
      text: outgoingMsg,
    });
  }

  return { message: outgoingMsg || null, actions };
}


function normalizeE164(input) {
  if (!input) return null;
  const digits = String(input).replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

// Parse très simple:
// - "YYYY-MM-DD" ou "YYYY-MM-DD HH:mm"
// - "DD/MM/YYYY" ou "DD/MM/YYYY HH:mm"
// Sinon => null (tu redemandes une date au client)
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
  const now = new Date();
  return d.getTime() < now.getTime();
}

// ================================
// Actions IA
// ================================
async function applyAction(action, context) {
  const { merchant, customer } = context;

  switch (action.type) {
    case "ADD_TO_CART":
      await addToCart(
        merchant.id,
        customer.id,
        Number(action.product_id),
        action.quantity || 1
      );
      break;

    case "REMOVE_FROM_CART":
      await removeFromCart(merchant.id, customer.id, Number(action.product_id));
      break;

    case "CLEAR_CART":
      await clearCart(merchant.id, customer.id);
      break;

    case "SET_STATE":
      await setConversationState(merchant.id, customer.id, action.state || {});
      break;

    case "UPDATE_CUSTOMER":
      await updateCustomerField(merchant.id, customer.id, action.field, action.value);
      break;

  case "CONFIRM_ORDER": {
  const st = await getConversationState(merchant.id, customer.id);

  // 1) On doit savoir si c'est pour lui ou un tiers
  if (!st?.recipient_mode) {
    await setConversationState(merchant.id, customer.id, {
      step: "ASKING_INFO",
      waiting_field: "recipient_mode",
    });
    break; // stop, on ne crée pas la commande
  }

  // 2) Date/heure de livraison obligatoire (dans tous les cas)
  // On la stocke dans st.delivery_requested_raw (texte) puis on parse au moment de créer la commande
  const deliveryRaw = st?.delivery_requested_raw;
  if (!deliveryRaw) {
    await setConversationState(merchant.id, customer.id, {
      ...st,
      step: "ASKING_INFO",
      waiting_field: "delivery_datetime",
    });
    break;
  }

  const deliveryAt = parseDeliveryRequestedAt(deliveryRaw);
  if (!deliveryAt || isPastDate(deliveryAt)) {
    // date invalide ou passée => on redemande
    await setConversationState(merchant.id, customer.id, {
      ...st,
      step: "ASKING_INFO",
      waiting_field: "delivery_datetime",
      delivery_requested_raw: null,
    });
    break;
  }

  // 3) Cas: commande pour lui-même
  if (st.recipient_mode === "self") {
    // Si son nom n'est pas renseigné => demander puis enregistrer via UPDATE_CUSTOMER (n8n) ou via ton handler de saisie
    if (!customer.name) {
      await setConversationState(merchant.id, customer.id, {
        ...st,
        step: "ASKING_INFO",
        waiting_field: "name",
        recipient_mode: "self",
      });
      break;
    }

    // Créer commande (destinataire = lui-même)
    await createOrderFromCart(merchant.id, customer.id, {
      recipientCustomerId: customer.id,
      recipientNameSnapshot: customer.name,
      recipientPhoneSnapshot: customer.phone || customer.phone_number || null,
      recipientAddressSnapshot: customer.address || null,
      deliveryRequestedAt: deliveryAt,
      deliveryRequestedRaw: deliveryRaw,
      status: "NEW",
    });

    await setConversationState(merchant.id, customer.id, {});
    break;
  }

  // 4) Cas: commande pour une tierce personne
  if (st.recipient_mode === "third_party") {
    if (!st.recipient_name) {
      await setConversationState(merchant.id, customer.id, { ...st, step: "ASKING_INFO", waiting_field: "recipient_name" });
      break;
    }
    if (!st.recipient_phone) {
      await setConversationState(merchant.id, customer.id, { ...st, step: "ASKING_INFO", waiting_field: "recipient_phone" });
      break;
    }
    if (!st.recipient_address) {
      await setConversationState(merchant.id, customer.id, { ...st, step: "ASKING_INFO", waiting_field: "recipient_address" });
      break;
    }

    // Créer/chercher le "customer destinataire" en base (nouveau customer si absent)
    const recipientPhone = normalizeE164(st.recipient_phone);
    const recipient = await findOrCreateCustomer(merchant.id, recipientPhone);

    // Optionnel: enrichir le destinataire en base
    if (recipient && (!recipient.name || recipient.name !== st.recipient_name)) {
      await updateCustomerField(merchant.id, recipient.id, "name", st.recipient_name);
    }
    if (recipient && st.recipient_address) {
      await updateCustomerField(merchant.id, recipient.id, "address", st.recipient_address);
    }

    // Créer commande (payer = customer.id, destinataire = recipient.id)
    await createOrderFromCart(merchant.id, customer.id, {
      recipientCustomerId: recipient?.id || null,
      recipientNameSnapshot: st.recipient_name,
      recipientPhoneSnapshot: recipientPhone,
      recipientAddressSnapshot: st.recipient_address,
      deliveryRequestedAt: deliveryAt,
      deliveryRequestedRaw: deliveryRaw,
      status: "NEW",
    });

    await setConversationState(merchant.id, customer.id, {});
    break;
  }

  // fallback si valeur inconnue
  await setConversationState(merchant.id, customer.id, { step: "ASKING_INFO", waiting_field: "recipient_mode" });
  break;
}

case "SHOW_LAST_ORDER": {
  const last = await getLastOrderWithItemsForCustomer(merchant.id, customer.id);
  context.overrideMessage = last
    ? `Votre dernière commande (#${last.order.id}) est **${last.order.status}**. Total: ${last.order.total_amount} ${last.order.currency}.`
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
  else context.overrideMessage = "✅ Ok. J’ai remis votre dernière commande dans le panier. Vous pouvez ajouter/retirer des articles puis écrire *Je confirme*.";
  break;
}

    case "ASK_INFO":
      await setConversationState(merchant.id, customer.id, {
        step: "ASKING_INFO",
        waiting_field: action.field,
      });
      break;

    default:
      console.warn("⚠️ Action inconnue", action);
  }
}

// ================================
// Webhook "test" (Postman)
// Body: { from:"+225...", to:"+225...", text:"..." }
// ================================
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const { from, to, text } = mapWhatsappPayload(req.body);

    const customerPhone = normalizePhone(from);
    const businessPhone = normalizePhone(to);
    const cleanText = String(text || "").trim();

    if (!customerPhone || !businessPhone || !cleanText) return res.sendStatus(200);

    const merchant = await findMerchantByWhatsappNumber(businessPhone);
    if (!merchant) {
      console.warn("❗ Aucun merchant pour ce numéro business:", businessPhone);
      return res.sendStatus(200);
    }

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
// WAHA envoie souvent: { event, session, payload: {...} }
// ================================
app.post("/webhook/waha", async (req, res) => {
  try {
    const eventWrap = req.body;              // { event, session, payload }
    const p = eventWrap?.payload || eventWrap;

    // (optionnel) debug 1 fois pour voir la structure exacte
    // console.log("WAHA RAW:", JSON.stringify(eventWrap, null, 2));

    // 0) On ignore les events non-message si tu veux
    const eventName = eventWrap?.event || p?.event;
    if (eventName && eventName !== "message") return res.sendStatus(200);

    // 1) Récupérer session WAHA (pour trouver le marchand)
    const sessionName = eventWrap?.session || p?.session;
    if (!sessionName) return res.sendStatus(200);

    const merchant = await findMerchantByWahaSession(sessionName);
    if (!merchant) {
      console.warn("WAHA: merchant introuvable pour session =", sessionName);
      return res.sendStatus(200);
    }

    // 2) Récupérer le texte du message (selon versions WAHA)
    const text =
      (p?.body ?? p?.text ?? p?.message?.text ?? p?.message ?? "").toString().trim();

    if (!text) return res.sendStatus(200);

    // 3) Récupérer le "from" (chatId du CLIENT) et le chatId (conversation)
    // WAHA met souvent:
    // - p.from  = l’expéditeur (client) -> C'EST LUI QU'ON DOIT REPONDRE en 1-1
    // - p.chatId = le chat courant (peut être groupe, ou parfois le business selon l’event)
    // - p.author / p.participant = expéditeur dans les groupes
    const rawFrom = p?.from || p?.sender?.id || p?.author || p?.participant;
    const rawChatId = p?.chatId || p?.id?.remote || p?.conversation || p?.to;

    const fromChatId = normalizeWahaChatId(rawFrom);
    const chatId = normalizeWahaChatId(rawChatId);

    // 4) Ignore Status/Broadcast (non répondable)
    if (
      (fromChatId && (fromChatId.includes("status@broadcast") || fromChatId.includes("false_status@broadcast"))) ||
      (chatId && (chatId.includes("status@broadcast") || chatId.includes("false_status@broadcast")))
    ) {
      return res.sendStatus(200);
    }

    // 5) Déterminer à qui répondre :
    // - si groupe => répondre au chatId du groupe (@g.us)
    // - sinon => répondre au fromChatId du client (@c.us ou @lid)
    const replyChatId = (chatId && chatId.endsWith("@g.us")) ? chatId : fromChatId;

    if (!replyChatId) {
      console.warn("WAHA: impossible de déterminer replyChatId", { rawFrom, rawChatId });
      return res.sendStatus(200);
    }

    // 6) Déterminer le numéro du client pour ta DB (E164)
    // - si @c.us => on peut récupérer le numéro
    // - si @lid => ce n'est pas un numéro => on “fallback” sur rawFrom si c’était déjà un +225...
    let fromPhone = chatIdToPhone(fromChatId);
    if (!fromPhone) {
      // fallback si WAHA t’envoie déjà un E164 dans rawFrom (rare)
      fromPhone = normalizePhone(rawFrom);
    }
    if (!fromPhone) {
      // dernier fallback: on utilise replyChatId comme identifiant (sinon ton système casse)
      // tu peux aussi décider de return 200 ici si tu refuses les @lid
      fromPhone = String(fromChatId || replyChatId);
    }

    // 7) Traitement commun
    await handleIncomingMessage({
      from: fromPhone,
      text,
      merchant,
      replyChatId, // ✅ on répond au client (ou groupe)
    });

    return res.sendStatus(200);
  } catch (e) {
    console.error("Erreur /webhook/waha", e);
    return res.sendStatus(200);
  }
});


// ================================
// Admin: lier merchant à WAHA
// PUT /api/admin/merchants/:merchantId/waha
// Body: { whatsapp_number, waha_session }
// Header: x-admin-key: ...
// ================================
app.put("/api/admin/merchants/:merchantId/waha", adminMiddleware, async (req, res) => {
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
    if (e.code === "23505") {
      return res
        .status(400)
        .json({ error: "whatsapp_number ou waha_session déjà pris", details: e.detail });
    }
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ================================
// API Catalogue + Commandes
// ================================
app.get("/api/merchants/:merchantId/products", authMiddleware,  requireSameMerchant, subscriptionGate, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    if (Number.isNaN(merchantId)) return res.status(400).json({ error: "merchantId invalide" });

    const products = await getProductsForMerchant(merchantId);
    return res.json(products);
  } catch (e) {
    console.error("Erreur GET /api/merchants/:merchantId/products", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post("/api/merchants/:merchantId/products", authMiddleware, requireSameMerchant, subscriptionGate,  async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    if (Number.isNaN(merchantId)) return res.status(400).json({ error: "merchantId invalide" });

    const { name, price, description, currency, code, category, image_url } = req.body;

    if (!name || price == null) {
      return res.status(400).json({ error: "Les champs 'name' et 'price' sont obligatoires." });
    }

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
    console.error("Erreur POST /api/merchants/:merchantId/products", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.put("/api/merchants/:merchantId/products/:productId", authMiddleware, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const productId = Number(req.params.productId);

    if (Number.isNaN(merchantId) || Number.isNaN(productId)) {
      return res.status(400).json({ error: "merchantId ou productId invalide" });
    }

    const { name, price, description, currency, code, category, image_url, is_active } = req.body;

    if (!name || price == null) {
      return res.status(400).json({ error: "Les champs 'name' et 'price' sont obligatoires." });
    }

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
    console.error("Erreur PUT /api/merchants/:merchantId/products/:productId", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.delete(
  "/api/merchants/:merchantId/products/:productId",
  authMiddleware,
  async (req, res) => {
    try {
      const merchantId = Number(req.params.merchantId);
      const productId = Number(req.params.productId);

      if (Number.isNaN(merchantId) || Number.isNaN(productId)) {
        return res.status(400).json({ error: "merchantId ou productId invalide" });
      }

      await deleteProductForMerchant(merchantId, productId);
      return res.status(204).send();
    } catch (e) {
      console.error("Erreur DELETE /api/merchants/:merchantId/products/:productId", e);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

app.get("/api/merchants/:merchantId/orders", authMiddleware,  requireSameMerchant, subscriptionGate, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    if (Number.isNaN(merchantId)) return res.status(400).json({ error: "merchantId invalide" });

    const orders = await getOrdersForMerchant(merchantId);
    return res.json(orders);
  } catch (e) {
    console.error("Erreur GET /api/merchants/:merchantId/orders", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/merchants/:merchantId/orders/:orderId", authMiddleware, requireSameMerchant, subscriptionGate,  async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const orderId = Number(req.params.orderId);

    if (Number.isNaN(merchantId) || Number.isNaN(orderId)) {
      return res.status(400).json({ error: "merchantId ou orderId invalide" });
    }

    const data = await getOrderWithItems(merchantId, orderId);
    if (!data) return res.status(404).json({ error: "Commande introuvable" });

    return res.json(data);
  } catch (e) {
    console.error("Erreur GET /api/merchants/:merchantId/orders/:orderId", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.put("/api/merchants/:merchantId/orders/:orderId/status", authMiddleware, requireSameMerchant, subscriptionGate,  async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const orderId = Number(req.params.orderId);
    const { status } = req.body;

    if (Number.isNaN(merchantId) || Number.isNaN(orderId)) {
      return res.status(400).json({ error: "merchantId ou orderId invalide" });
    }
    if (!status) return res.status(400).json({ error: "Le champ 'status' est obligatoire." });

    const updated = await updateOrderStatus(merchantId, orderId, status);
    if (!updated) return res.status(404).json({ error: "Commande introuvable" });

    return res.json(updated);
  } catch (e) {
    console.error("Erreur PUT /api/merchants/:merchantId/orders/:orderId/status", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});




// ================================
// Admin Auth (JWT)
// ================================
app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });

    const adminEmail = process.env.ADMIN_EMAIL;
    const adminHash = process.env.ADMIN_PASSWORD_HASH;

    if (!adminEmail || !adminHash) return res.status(500).json({ error: "ADMIN_EMAIL / ADMIN_PASSWORD_HASH non configurés" });
    if (String(email).toLowerCase() !== String(adminEmail).toLowerCase()) return res.status(401).json({ error: "Identifiants invalides" });

    const ok = await bcrypt.compare(password, adminHash);
    if (!ok) return res.status(401).json({ error: "Identifiants invalides" });

    const token = jwt.sign({ role: "admin", email: adminEmail }, JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, admin: { email: adminEmail } });
  } catch (e) {
    console.error("Erreur /api/admin/login", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ================================
// Admin Dashboard
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

// ================================
// Admin Merchants
// ================================
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

// paiement + prolongation
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


// ================================
// Auth (login/register)
// ================================
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email et mot de passe sont obligatoires." });
    }

    const merchant = await findMerchantByEmail(email);
    if (!merchant || !merchant.password_hash) {
      return res.status(401).json({ error: "Identifiants invalides." });
    }

    const ok = await bcrypt.compare(password, merchant.password_hash);
    if (!ok) return res.status(401).json({ error: "Identifiants invalides." });

    const token = jwt.sign({ merchantId: merchant.id }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({
      token,
      merchant: { id: merchant.id, name: merchant.name, email: merchant.email },
    });
  } catch (e) {
    console.error("Erreur /api/auth/login", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, whatsapp_number } = req.body || {};
    if (!name || !email || !password || !whatsapp_number) {
      return res.status(400).json({
        error: "Les champs name, email, password et whatsapp_number sont obligatoires.",
      });
    }

    const existing = await findMerchantByEmail(email);
    if (existing) return res.status(400).json({ error: "Cet email est déjà utilisé." });

    const passwordHash = await bcrypt.hash(password, 10);

    let merchant;
    try {
      merchant = await createMerchant({
        name,
        email,
        passwordHash,
        whatsappNumber: whatsapp_number,
      });
    } catch (e) {
      console.error("Erreur createMerchant", e);
      if (e.code === "23505") {
        return res.status(400).json({ error: "Cet email ou ce numéro WhatsApp est déjà utilisé." });
      }
      throw e;
    }

    const token = jwt.sign({ merchantId: merchant.id }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({
      token,
      merchant: { id: merchant.id, name: merchant.name, email: merchant.email },
    });
  } catch (e) {
    console.error("Erreur /api/auth/register", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ================================
// Admin: créer merchant avec waha_session
// ================================
app.post("/api/admin/merchants", adminMiddleware, async (req, res) => {
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

    let merchant;
    try {
      merchant = await createMerchantWithWaha({
        name,
        email,
        passwordHash,
        whatsappNumber: whatsapp_number,
        wahaSession: waha_session,
      });
    } catch (e) {
      if (e.code === "23505") {
        return res.status(400).json({
          error: "Collision: email ou whatsapp_number ou waha_session déjà utilisé.",
          details: e.detail,
        });
      }
      throw e;
    }

    return res.status(201).json({ merchant });
  } catch (e) {
    console.error("Erreur POST /api/admin/merchants", e);
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
