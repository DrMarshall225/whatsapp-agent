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
function adminMiddleware(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!process.env.ADMIN_KEY) {
    return res.status(500).json({ error: "ADMIN_KEY non configuré côté serveur" });
  }
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Admin key invalide" });
  }
  next();
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
    next();
  } catch (e) {
    console.error("Erreur JWT", e);
    return res.status(401).json({ error: "Token invalide" });
  }
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
  console.log("📩 Message reçu", { from, merchantId: merchant?.id, text, replyChatId });

  const customer = await findOrCreateCustomer(merchant.id, from);
  const cart = await getCart(merchant.id, customer.id);
  const products = await getProductsForMerchant(merchant.id);
  const conversationState = await getConversationState(merchant.id, customer.id);

  const agentOutput = await callCommandBot({
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

  if (Array.isArray(agentOutput?.actions)) {
    for (const action of agentOutput.actions) {
      await applyAction(action, { merchant, customer });
    }
  }

  if (agentOutput?.message) {
    await sendWhatsappMessage({
      merchant,
      chatId: replyChatId, // ✅ répond au chat exact
      to: from, // fallback
      text: agentOutput.message,
    });
  }

  return agentOutput || { message: null, actions: [] };
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

    case "CONFIRM_ORDER":
      await createOrderFromCart(merchant.id, customer.id);
      break;

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
  // IMPORTANT: répondre vite à WAHA
  res.sendStatus(200);

  try {
    const root = req.body || {};
    const p = root.payload || root;

    const session = root.session || p.session || null;

    // Certaines versions ont fromMe (message sortant) -> on ignore
    if (p?.fromMe === true || p?.key?.fromMe === true) return;

    const rawChatId = p?.chatId || p?.id?.remote || p?.to || null;
    const rawFrom = p?.from || p?.sender || p?.id?.participant || null;

    const chatId = normalizeWahaChatId(rawChatId || rawFrom);
    if (!chatId) return;

    // Ignore status/broadcast
    if (isStatusBroadcast(chatId) || isStatusBroadcast(rawFrom)) return;

    // Ignorer certains messages système
    const type = p?.type || root?.type;
    if (type === "protocolMessage") return;

    const text = String(pickTextFromWaha(root) || "").trim();
    if (!text) return;

    // téléphone client
    const customerPhone = normalizePhone(chatIdToPhone(rawFrom || chatId));
    if (!customerPhone) return;

    // 1) merchant par session (meilleur)
    let merchant = null;
    if (session) merchant = await findMerchantByWahaSession(session);

    // 2) fallback: merchant par numéro business si possible
    if (!merchant) {
      const businessNum = normalizePhone(pickBusinessNumberFromPayload(root));
      if (businessNum) merchant = await findMerchantByWhatsappNumber(businessNum);
    }

    if (!merchant) {
      console.warn("❗ Merchant introuvable (session/num business)", { session });
      return;
    }

    await handleIncomingMessage({
      from: customerPhone,
      text,
      merchant,
      replyChatId: chatId,
    });
  } catch (e) {
    console.error("Erreur webhook /webhook/waha", e);
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
app.get("/api/merchants/:merchantId/products", authMiddleware, async (req, res) => {
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

app.post("/api/merchants/:merchantId/products", authMiddleware, async (req, res) => {
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

app.get("/api/merchants/:merchantId/orders", authMiddleware, async (req, res) => {
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

app.get("/api/merchants/:merchantId/orders/:orderId", authMiddleware, async (req, res) => {
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

app.put("/api/merchants/:merchantId/orders/:orderId/status", authMiddleware, async (req, res) => {
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
