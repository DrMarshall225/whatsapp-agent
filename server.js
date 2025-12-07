import cors from "cors";
import express from "express";
import bodyParser from "body-parser";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

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
import { sendWhatsappMessage } from "./services/whatsapp.js";
import { PORT } from "./config.js";

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
// Helpers
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

// Parse très simple:
// - "YYYY-MM-DD" ou "YYYY-MM-DD HH:mm"
// - "DD/MM/YYYY" ou "DD/MM/YYYY HH:mm"
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

    if (m.is_suspended) return res.status(403).json({ error: "Compte suspendu. Contactez l’admin." });

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
function looksLikeYes(msg) {
  const s = String(msg || "").trim().toLowerCase();
  return ["1", "oui", "ouais", "y", "yes", "moi", "pour moi", "c'est moi", "meme"].some((k) => s.includes(k));
}
function looksLikeNo(msg) {
  const s = String(msg || "").trim().toLowerCase();
  return ["2", "non", "autre", "tiers", "tierce", "quelqu'un", "quelquun", "pour lui", "pour elle"].some((k) => s.includes(k));
}

async function tryHandleStructuredReply({ merchant, customer, text, conversationState }) {
  const waiting = conversationState?.waiting_field;
  if (!waiting) return { handled: false };

  const clean = String(text || "").trim();
  if (!clean) return { handled: true, message: "Je n’ai pas bien reçu. Peux-tu répéter ?" };

  // Date de livraison
  if (waiting === "delivery_datetime") {
    await setConversationState(merchant.id, customer.id, {
      ...conversationState,
      delivery_requested_raw: clean,
      waiting_field: null,
    });
    return {
      handled: true,
      message: "Merci ✅. Maintenant écris *Je confirme* pour valider la commande.",
    };
  }

  // Nom (si demandé)
  if (waiting === "name" || waiting === "self_name") {
    await updateCustomerField(merchant.id, customer.id, "name", clean);
    await setConversationState(merchant.id, customer.id, { ...conversationState, waiting_field: null });
    return { handled: true, message: `Merci ${clean} ✅. Écris *Je confirme* pour valider.` };
  }

  // Choix : pour moi / pour quelqu'un d'autre
  if (waiting === "recipient_mode") {
    if (looksLikeYes(clean)) {
      const nextState = { ...conversationState, recipient_mode: "self", waiting_field: null, step: null };
      await setConversationState(merchant.id, customer.id, nextState);

      if (!customer.name) {
        await setConversationState(merchant.id, customer.id, { ...nextState, step: "ASKING_INFO", waiting_field: "name" });
        return { handled: true, message: "D’accord 😊. Quel est ton nom (et prénom) ?" };
      }
      return { handled: true, message: "Parfait ✅. Donne-moi la *date/heure de livraison* (ex: 2025-12-10 14:30)." };
    }

    if (looksLikeNo(clean)) {
      const nextState = { ...conversationState, recipient_mode: "third_party", waiting_field: "recipient_name", step: "ASKING_INFO" };
      await setConversationState(merchant.id, customer.id, nextState);
      return { handled: true, message: "Très bien. Donne-moi le *nom et prénom* du destinataire." };
    }

    return { handled: true, message: "Réponds : *1* = pour toi-même, *2* = pour une autre personne." };
  }

  // Tiers : nom
  if (waiting === "recipient_name") {
    const nextState = { ...conversationState, recipient_name: clean, waiting_field: "recipient_phone", step: "ASKING_INFO" };
    await setConversationState(merchant.id, customer.id, nextState);
    return { handled: true, message: "Super. Donne-moi son *numéro WhatsApp* (format 225XXXXXXXXXX)." };
  }

  // Tiers : téléphone
  if (waiting === "recipient_phone") {
    const phone = normalizePhone(clean);
    if (!phone) return { handled: true, message: "Numéro invalide. Envoie le numéro au format: 225XXXXXXXXXX" };

    const nextState = { ...conversationState, recipient_phone: phone, waiting_field: "recipient_address", step: "ASKING_INFO" };
    await setConversationState(merchant.id, customer.id, nextState);
    return { handled: true, message: "Merci. Et l’*adresse de livraison* du destinataire ?" };
  }

  // Tiers : adresse
  if (waiting === "recipient_address") {
    const nextState = { ...conversationState, recipient_address: clean, waiting_field: null };
    await setConversationState(merchant.id, customer.id, nextState);
    return { handled: true, message: "Merci ✅. Maintenant écris *Je confirme* pour valider la commande." };
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

    case "SET_STATE":
      await setConversationState(merchant.id, customer.id, action.state || {});
      return;

    case "UPDATE_CUSTOMER":
      await updateCustomerField(merchant.id, customer.id, action.field, action.value);
      return;

    case "ASK_INFO":
      await setConversationState(merchant.id, customer.id, { step: "ASKING_INFO", waiting_field: action.field });
      return;

    case "SHOW_LAST_ORDER": {
      const last = await getLastOrderWithItemsForCustomer(merchant.id, customer.id);
      ctx.overrideMessage = last
        ? `Votre dernière commande (#${last.order.id}) est **${last.order.status}**. Total: ${last.order.total_amount} ${last.order.currency}.`
        : "Vous n’avez pas encore de commande.";
      return;
    }

    case "CANCEL_LAST_ORDER": {
      const result = await cancelLastOrderForCustomer(merchant.id, customer.id);
      if (!result) ctx.overrideMessage = "Vous n’avez pas encore de commande à annuler.";
      else if (result.blocked) ctx.overrideMessage = `Impossible d’annuler : ${result.reason}`;
      else ctx.overrideMessage = `✅ D’accord. J’ai annulé votre commande (#${result.order.id}).`;
      return;
    }

    case "MODIFY_LAST_ORDER": {
      const result = await loadLastOrderToCart(merchant.id, customer.id);
      if (!result) ctx.overrideMessage = "Vous n’avez pas encore de commande à modifier.";
      else if (result.blocked) ctx.overrideMessage = `Impossible de modifier : ${result.reason}`;
      else ctx.overrideMessage = "✅ Ok. J’ai remis votre dernière commande dans le panier. Ajoutez/retirez puis écrivez *Je confirme*.";
      return;
    }

    case "CONFIRM_ORDER": {
      const st = await getConversationState(merchant.id, customer.id);

      if (!st?.recipient_mode) {
        await setConversationState(merchant.id, customer.id, { step: "ASKING_INFO", waiting_field: "recipient_mode" });
        return;
      }

      const deliveryRaw = st?.delivery_requested_raw;
      if (!deliveryRaw) {
        await setConversationState(merchant.id, customer.id, { ...st, step: "ASKING_INFO", waiting_field: "delivery_datetime" });
        return;
      }

      const deliveryAt = parseDeliveryRequestedAt(deliveryRaw);
      if (!deliveryAt || isPastDate(deliveryAt)) {
        await setConversationState(merchant.id, customer.id, {
          ...st,
          step: "ASKING_INFO",
          waiting_field: "delivery_datetime",
          delivery_requested_raw: null,
        });
        return;
      }

      // self
      if (st.recipient_mode === "self") {
        if (!customer.name) {
          await setConversationState(merchant.id, customer.id, { ...st, step: "ASKING_INFO", waiting_field: "name", recipient_mode: "self" });
          return;
        }

        await createOrderFromCart(merchant.id, customer.id, {
          recipientCustomerId: customer.id,
          recipientNameSnapshot: customer.name,
          recipientPhoneSnapshot: customer.phone || null,
          recipientAddressSnapshot: customer.address || null,
          deliveryRequestedAt: deliveryAt,
          deliveryRequestedRaw: deliveryRaw,
          status: "NEW",
        });

        await setConversationState(merchant.id, customer.id, {});
        ctx.overrideMessage = `✅ Commande confirmée. Livraison prévue le ${deliveryAt.toLocaleString("fr-FR")}.`;
        return;
      }

      // third party
      if (st.recipient_mode === "third_party") {
        if (!st.recipient_name) {
          await setConversationState(merchant.id, customer.id, { ...st, step: "ASKING_INFO", waiting_field: "recipient_name" });
          return;
        }
        if (!st.recipient_phone) {
          await setConversationState(merchant.id, customer.id, { ...st, step: "ASKING_INFO", waiting_field: "recipient_phone" });
          return;
        }
        if (!st.recipient_address) {
          await setConversationState(merchant.id, customer.id, { ...st, step: "ASKING_INFO", waiting_field: "recipient_address" });
          return;
        }

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
          deliveryRequestedRaw: deliveryRaw,
          status: "NEW",
        });

        await setConversationState(merchant.id, customer.id, {});
        ctx.overrideMessage = `✅ Commande confirmée pour ${st.recipient_name}. Livraison le ${deliveryAt.toLocaleString("fr-FR")}.`;
        return;
      }

      await setConversationState(merchant.id, customer.id, { step: "ASKING_INFO", waiting_field: "recipient_mode" });
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
    agentOutput = { message: "Désolé, j’ai eu un souci technique. Réessaie dans un instant.", actions: [] };
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
      console.error("Erreur GET order detail", e);
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
      if (!status) return res.status(400).json({ error: "Le champ 'status' est obligatoire." });

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

// ⚠️ Correspond à AdminApp.jsx: PUT /api/admin/merchants/${merchantId}/suspend
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

// Paiement + prolongation
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

// Admin: créer merchant avec waha_session
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

// Admin: lier merchant à WAHA (optionnel)
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
