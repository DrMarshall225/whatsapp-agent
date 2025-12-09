// server.js
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
  // payload Postman : { from, to, text }
  return {
    from: body?.from,
    to: body?.to,
    text: body?.text,
  };
}

// YYYY-MM-DD [HH:mm]  /  DD/MM/YYYY [HH:mm]
function parseDeliveryRequestedAt(rawText) {
  if (!rawText) return null;
  const s = String(rawText).trim();

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    const hh = m[4] != null ? Number(m[4]) : 10;
    const mm = m[5] != null ? Number(m[5]) : 0;
    return new Date(year, month, day, hh, mm, 0, 0);
  }

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
    console.error("Erreur JWT", e);
    return res.status(401).json({ error: "Token invalide" });
  }
}

function requireSameMerchant(req, res, next) {
  const merchantId = Number(req.params.merchantId);
  if (Number.isNaN(merchantId)) return res.status(400).json({ error: "merchantId invalide" });
  if (req.merchantId !== merchantId) return res.status(403).json({ error: "Accès interdit (mauvais marchand)" });
  next();
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
// Actions IA (alignées workflow n8n)
// ================================
async function applyAction(action, context) {
  const { merchant, customer } = context;

  switch (action.type) {
    case "ADD_TO_CART":
      await addToCart(
        merchant.id,
        customer.id,
        Number(action.product_id),
        Number(action.quantity || 1)
      );
      break;

    case "REMOVE_FROM_CART":
      await removeFromCart(merchant.id, customer.id, Number(action.product_id));
      break;

    case "CLEAR_CART":
      await clearCart(merchant.id, customer.id);
      break;

    case "SET_STATE": {
      const current = (await getConversationState(merchant.id, customer.id)) || {};
      const patch = action.state && typeof action.state === "object" ? action.state : {};
      // merge (important car n8n envoie souvent des updates partiels)
      const merged = { ...current, ...patch };
      await setConversationState(merchant.id, customer.id, merged);
      break;
    }

    case "ASK_INFO":
      await setConversationState(merchant.id, customer.id, {
        ...(await getConversationState(merchant.id, customer.id)),
        step: "ASKING_INFO",
        waiting_field: action.field,
      });
      break;

    case "UPDATE_CUSTOMER": {
      const field = String(action.field || "");
      if (!["name", "address", "payment_method"].includes(field)) break;
      await updateCustomerField(merchant.id, customer.id, field, action.value);
      break;
    }

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
      else context.overrideMessage =
        "✅ Ok. J’ai remis votre dernière commande dans le panier. Vous pouvez ajouter/retirer des articles puis écrire *Je confirme*.";
      break;
    }

    case "CONFIRM_ORDER": {
      // ✅ Le workflow n8n garantit normalement que tout est complet,
      // mais on re-valide côté serveur pour éviter les commandes incohérentes.
      const st = (await getConversationState(merchant.id, customer.id)) || {};
      const cart = await getCart(merchant.id, customer.id);

      const itemsCount = Array.isArray(cart?.items) ? cart.items.length : (cart?.total_items || 0);
      if (!itemsCount) break;

      const recipientMode = st.recipient_mode;
      if (!recipientMode) break;

      const deliveryRaw = st.delivery_requested_raw;
      const deliveryAt = parseDeliveryRequestedAt(deliveryRaw);
      if (!deliveryRaw || !deliveryAt || isPastDate(deliveryAt)) break;

      // paiement (on le stocke sur le customer)
      if (!customer.payment_method) break;

      if (recipientMode === "self") {
        if (!customer.name || !customer.address) break;

        await createOrderFromCart(merchant.id, customer.id, {
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          address: customer.address,
          payment_method: customer.payment_method,
          delivery_requested_raw: deliveryRaw,
          delivery_requested_at: deliveryAt.toISOString(),
          recipient_mode: "self",
        });
      } else if (recipientMode === "third_party") {
        if (!st.recipient_name || !st.recipient_phone || !st.recipient_address) break;

        const phone = normalizePhone(st.recipient_phone) || st.recipient_phone;
        const recipient = await findOrCreateCustomer(merchant.id, phone);

        await updateCustomerProfile(merchant.id, recipient.id, {
          name: st.recipient_name,
          address: st.recipient_address,
        });

        await createOrderFromCart(merchant.id, customer.id, {
          id: recipient.id,
          name: st.recipient_name,
          phone,
          address: st.recipient_address,
          payment_method: customer.payment_method,
          delivery_requested_raw: deliveryRaw,
          delivery_requested_at: deliveryAt.toISOString(),
          recipient_mode: "third_party",
        });
      } else {
        break;
      }

      // Optionnel: on verrouille l'état localement (n8n le fait aussi)
      await setConversationState(merchant.id, customer.id, {
        ...st,
        order_completed: true,
        step: "COMPLETED",
        waiting_field: "",
        last_question: "",
        pending_add_to_cart: null,
        pending_delivery_raw: null,
      });

      break;
    }

    default:
      console.warn("⚠️ Action inconnue", action);
  }
}

// ================================
// Moteur commun (utilisé par WAHA + Postman)
// ================================
async function handleIncomingMessage({ from, text, merchant, replyChatId }) {
  console.log("📩 Message reçu", { from, merchantId: merchant?.id, text, replyChatId });

  const customer = await findOrCreateCustomer(merchant.id, from);
  const cart = await getCart(merchant.id, customer.id);
  const products = await getProductsForMerchant(merchant.id);
  const conversationState = await getConversationState(merchant.id, customer.id);

  // ✅ SYMBIOSE AVEC TON WORKFLOW N8N:
  // n8n lit userText via $json.message.message
  const agentInput = {
    message: String(text || "").trim(),
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
    conversation_state: conversationState || {},
  };

  let agentOutput;
  try {
    agentOutput = await callCommandBot(agentInput); // ✅ ne pas wrapper ici
  } catch (e) {
    console.error("❌ callCommandBot error:", e);
    agentOutput = { message: "Désolé, petit souci technique. Réessayez svp 🙏", actions: [] };
  }

  const actions = Array.isArray(agentOutput?.actions) ? agentOutput.actions : [];
  const ctx = { merchant, customer, overrideMessage: null };

  for (const action of actions) {
    try {
      await applyAction(action, ctx);
    } catch (e) {
      console.error("❌ applyAction error:", action, e);
    }
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
    const wrap = req.body;
    const p = wrap?.payload || wrap;

    const eventName = wrap?.event || p?.event;
    if (eventName && eventName !== "message") return res.sendStatus(200);

    const sessionName = wrap?.session || p?.session;
    if (!sessionName) return res.sendStatus(200);

    const merchant = await findMerchantByWahaSession(sessionName);
    if (!merchant) return res.sendStatus(200);

    const text = String(p?.body ?? p?.text ?? p?.message?.text ?? p?.message ?? "").trim();
    if (!text) return res.sendStatus(200);

    const rawFrom = p?.from || p?.sender?.id || p?.author || p?.participant;
    const rawChatId = p?.chatId || p?.id?.remote || p?.conversation || p?.to;

    const fromChatId = normalizeWahaChatId(rawFrom);
    const chatId = normalizeWahaChatId(rawChatId);

    if (isStatusBroadcast(fromChatId) || isStatusBroadcast(chatId)) return res.sendStatus(200);

    const replyChatId = (chatId && chatId.endsWith("@g.us")) ? chatId : fromChatId;
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
// Auth Merchants (login/register)
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
    if (e.code === "23505") return res.status(400).json({ error: "Email ou WhatsApp déjà utilisé." });
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ================================
// Admin Auth (JWT) - compatible HASH ou PASSWORD
// ================================
app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });

    const adminEmail = process.env.ADMIN_EMAIL || "admin@local";

    // Mode A: hash
    const adminHash = process.env.ADMIN_PASSWORD_HASH;
    if (adminHash) {
      if (String(email).toLowerCase() !== String(adminEmail).toLowerCase()) {
        return res.status(401).json({ error: "Identifiants invalides" });
      }
      const ok = await bcrypt.compare(password, adminHash);
      if (!ok) return res.status(401).json({ error: "Identifiants invalides" });

      const token = jwt.sign({ role: "admin", email: adminEmail }, JWT_SECRET, { expiresIn: "7d" });
      return res.json({ token, admin: { email: adminEmail } });
    }

    // Mode B: password simple (dev/prod simple)
    const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
    if (String(email).toLowerCase() !== String(adminEmail).toLowerCase() || password !== adminPassword) {
      return res.status(401).json({ error: "Identifiants admin invalides" });
    }

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
// Admin Merchants + Payments + WAHA
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
    console.error("Erreur PUT /api/admin/merchants/:merchantId/waha", e);
    if (e.code === "23505") {
      return res.status(400).json({ error: "whatsapp_number ou waha_session déjà pris", details: e.detail });
    }
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
      return res.status(400).json({ error: "Collision: email/whatsapp/waha_session déjà utilisé.", details: e.detail });
    }
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ================================
// API Marchand: Catalogue + Commandes
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
      console.error("Erreur GET /api/merchants/:merchantId/products", e);
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

      if (!name || price == null) return res.status(400).json({ error: "Champs requis: name, price" });

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
      if (Number.isNaN(merchantId) || Number.isNaN(productId)) {
        return res.status(400).json({ error: "merchantId ou productId invalide" });
      }

      const { name, price, description, currency, code, category, image_url, is_active } = req.body || {};
      if (!name || price == null) return res.status(400).json({ error: "Champs requis: name, price" });

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
      console.error("Erreur PUT /api/merchants/:merchantId/products/:productId", e);
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
      console.error("Erreur GET /api/merchants/:merchantId/orders", e);
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
      console.error("Erreur GET /api/merchants/:merchantId/orders/:orderId", e);
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
      console.error("Erreur PUT /api/merchants/:merchantId/orders/:orderId/status", e);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

// ================================
// Start server
// ================================
const listenPort = Number(process.env.PORT || PORT || 3000);
app.listen(listenPort, "0.0.0.0", () => {
  console.log("✅ Serveur démarré sur le port", listenPort);
});
