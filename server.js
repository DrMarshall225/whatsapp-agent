import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-a-changer";

import cors from "cors";
import express from "express";
import bodyParser from "body-parser";
const app = express();
app.use(cors());          // ← autorise les appels depuis le front
app.use(bodyParser.json());
app.get("/", (req, res) => {
  res.status(200).send("whatsapp-agent OK ✅");
});

import {
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
} from "./services/store.pg.js";

import { callCommandBot } from "./services/commandbot.js";
import { sendWhatsappMessage } from "./services/whatsapp.js";
import { PORT } from "./config.js";

// Webhook WhatsApp

app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const { from, to, text } = mapWhatsappPayload(req.body);

    console.log("Message reçu", { from, to, text });

    const merchant = await findMerchantByWhatsappNumber(to);
    if (!merchant) {
      console.warn("Aucun marchand pour ce numéro", to);
      return res.sendStatus(200);
    }

    const customer = await findOrCreateCustomer(merchant.id, from);
    const cart = await getCart(merchant.id, customer.id);
    const products = await getProductsForMerchant(merchant.id);
    const conversationState = await getConversationState(merchant.id, customer.id);

    const agentInput = {
      message: text,
      merchant: {
        id: merchant.id,
        name: merchant.name
      },
      customer: {
        id: customer.id,
        phone: customer.phone,
        name: customer.name,
        known_fields: {
          address: customer.address,
          payment_method: customer.payment_method
        }
      },
      cart,
      products,
      conversation_state: conversationState
    };

   // console.log("👉 Produits envoyés à CommandBot :", products.length);

    const agentOutput = await callCommandBot(agentInput);

    if (Array.isArray(agentOutput.actions)) {
      for (const action of agentOutput.actions) {
        await applyAction(action, { merchant, customer });
      }
    }

    if (agentOutput.message) {
      await sendWhatsappMessage({
        to: from,
        from: to,
        text: agentOutput.message
      });
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Erreur webhook", e);
    res.sendStatus(200);
  }
});

function mapWhatsappPayload(body) {
  // À adapter selon ton provider
  return {
    from: body.from,
    to: body.to,
    text: body.text
  };
}

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
      await removeFromCart(
        merchant.id,
        customer.id,
        Number(action.product_id)
      );
      break;

    case "CLEAR_CART":
      await clearCart(merchant.id, customer.id);
      break;

    case "SET_STATE":
      await setConversationState(merchant.id, customer.id, action.state || {});
      break;

    case "UPDATE_CUSTOMER":  // ← nouveau
      await updateCustomerField(
        merchant.id,
        customer.id,
        action.field,
        action.value
      );
      break;

    case "CONFIRM_ORDER":
      await createOrderFromCart(merchant.id, customer.id);
      break;

    case "ASK_INFO":
      await setConversationState(merchant.id, customer.id, {
        step: "ASKING_INFO",
        waiting_field: action.field
      });
      break;

    default:
      console.warn("Action inconnue", action);
  }
}

// ================================
// API pour tester le catalogue
// ================================
app.get("/api/merchants/:merchantId/products", authMiddleware, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);

    if (Number.isNaN(merchantId)) {
      return res.status(400).json({ error: "merchantId invalide" });
    }

    const products = await getProductsForMerchant(merchantId);
    return res.json(products);
  } catch (e) {
    console.error("Erreur /api/merchants/:merchantId/products", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// Créer un produit pour un marchand
app.post("/api/merchants/:merchantId/products", authMiddleware, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    if (Number.isNaN(merchantId)) {
      return res.status(400).json({ error: "merchantId invalide" });
    }

    const { name, price, description, currency, code, category, image_url } = req.body;

    if (!name || price == null) {
      return res
        .status(400)
        .json({ error: "Les champs 'name' et 'price' sont obligatoires." });
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


app.listen(PORT, () => {
  console.log("Serveur démarré sur le port", PORT);
});
// Modifier un produit d'un marchand
app.put("/api/merchants/:merchantId/products/:productId", authMiddleware, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const productId = Number(req.params.productId);

    if (Number.isNaN(merchantId) || Number.isNaN(productId)) {
      return res.status(400).json({ error: "merchantId ou productId invalide" });
    }

    const { name, price, description, currency, code, category, image_url, is_active } = req.body;

    if (!name || price == null) {
      return res
        .status(400)
        .json({ error: "Les champs 'name' et 'price' sont obligatoires." });
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

    if (!updated) {
      return res.status(404).json({ error: "Produit non trouvé pour ce marchand" });
    }

    return res.json(updated);
  } catch (e) {
    console.error("Erreur PUT /api/merchants/:merchantId/products/:productId", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});
// Supprimer un produit d'un marchand
app.delete("/api/merchants/:merchantId/products/:productId", authMiddleware, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const productId = Number(req.params.productId);

    if (Number.isNaN(merchantId) || Number.isNaN(productId)) {
      return res.status(400).json({ error: "merchantId ou productId invalide" });
    }

    await deleteProductForMerchant(merchantId, productId);
    return res.status(204).send(); // No Content
  } catch (e) {
    console.error("Erreur DELETE /api/merchants/:merchantId/products/:productId", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// Liste des commandes pour un marchand
app.get("/api/merchants/:merchantId/orders", authMiddleware, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    if (Number.isNaN(merchantId)) {
      return res.status(400).json({ error: "merchantId invalide" });
    }

    const orders = await getOrdersForMerchant(merchantId);
    return res.json(orders);
  } catch (e) {
    console.error("Erreur GET /api/merchants/:merchantId/orders", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});
// Détail d'une commande (avec lignes + client)
app.get("/api/merchants/:merchantId/orders/:orderId", authMiddleware, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const orderId = Number(req.params.orderId);

    if (Number.isNaN(merchantId) || Number.isNaN(orderId)) {
      return res.status(400).json({ error: "merchantId ou orderId invalide" });
    }

    const data = await getOrderWithItems(merchantId, orderId);

    if (!data) {
      return res.status(404).json({ error: "Commande introuvable" });
    }

    return res.json(data);
  } catch (e) {
    console.error("Erreur GET /api/merchants/:merchantId/orders/:orderId", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});
// Mettre à jour le statut d'une commande
app.put("/api/merchants/:merchantId/orders/:orderId/status", authMiddleware, async (req, res) => {
  try {
    const merchantId = Number(req.params.merchantId);
    const orderId = Number(req.params.orderId);
    const { status } = req.body;

    if (Number.isNaN(merchantId) || Number.isNaN(orderId)) {
      return res.status(400).json({ error: "merchantId ou orderId invalide" });
    }
    if (!status) {
      return res.status(400).json({ error: "Le champ 'status' est obligatoire." });
    }

    const updated = await updateOrderStatus(merchantId, orderId, status);
    if (!updated) {
      return res.status(404).json({ error: "Commande introuvable" });
    }

    return res.json(updated);
  } catch (e) {
    console.error(
      "Erreur PUT /api/merchants/:merchantId/orders/:orderId/status",
      e
    );
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

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

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email et mot de passe sont obligatoires." });
    }

    const merchant = await findMerchantByEmail(email);
    if (!merchant || !merchant.password_hash) {
      return res.status(401).json({ error: "Identifiants invalides." });
    }

    const ok = await bcrypt.compare(password, merchant.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Identifiants invalides." });
    }

    const token = jwt.sign(
      { merchantId: merchant.id },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      token,
      merchant: {
        id: merchant.id,
        name: merchant.name,
        email: merchant.email,
      },
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

    // Vérifier si l'email existe déjà
    const existing = await findMerchantByEmail(email);
    if (existing) {
      return res.status(400).json({ error: "Cet email est déjà utilisé." });
    }

    // Hasher le mot de passe
    const passwordHash = await bcrypt.hash(password, 10);

    // Créer le marchand
    let merchant;
    try {
      merchant = await createMerchant({
        name,
        email,
        passwordHash,
        whatsappNumber: whatsapp_number,
      });
    } catch (e) {
      // Gestion des erreurs de contrainte unique (email ou whatsapp_number)
      console.error("Erreur createMerchant", e);
      if (e.code === "23505") {
        return res
          .status(400)
          .json({ error: "Cet email ou ce numéro WhatsApp est déjà utilisé." });
      }
      throw e;
    }

    // Générer un token comme pour le login
    const token = jwt.sign(
      { merchantId: merchant.id },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      token,
      merchant: {
        id: merchant.id,
        name: merchant.name,
        email: merchant.email,
      },
    });
  } catch (e) {
    console.error("Erreur /api/auth/register", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});
