// services/store.pg.js
import { query } from "../db.js";

function normalizeE164(input) {
  if (!input) return null;
  const digits = String(input).replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

function normalizeSession(input) {
  if (!input) return null;
  // ex: "Ferme DEM" -> "ferme_dem"
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\w]/g, "");
}

// ✅ Routing par session WAHA
export async function findMerchantByWahaSession(session) {
  const s = normalizeSession(session);
  if (!s) return null;

  const res = await query(
    `SELECT * FROM merchants WHERE waha_session = $1 LIMIT 1`,
    [s]
  );
  return res.rows[0] || null;
}

// ✅ Routing par numéro WhatsApp (E164)
export async function findMerchantByWhatsappNumberE164(whatsappNumber) {
  const n = normalizeE164(whatsappNumber);
  if (!n) return null;

  const res = await query(
    `SELECT * FROM merchants WHERE whatsapp_number = $1 LIMIT 1`,
    [n]
  );
  return res.rows[0] || null;
}

export async function createMerchantWithWaha({
  name,
  email,
  passwordHash,
  whatsappNumber,
  wahaSession,
}) {
  const n = normalizeE164(whatsappNumber);
  const s = normalizeSession(wahaSession) || "default";

  const res = await query(
    `INSERT INTO merchants (name, email, password_hash, whatsapp_number, waha_session)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, email, whatsapp_number, waha_session`,
    [name, email, passwordHash, n, s]
  );
  return res.rows[0];
}

export async function updateMerchantWahaConfig(merchantId, { whatsappNumber, wahaSession }) {
  const id = Number(merchantId);
  const n = normalizeE164(whatsappNumber);
  const s = normalizeSession(wahaSession);

  const res = await query(
    `UPDATE merchants
     SET whatsapp_number = COALESCE($2, whatsapp_number),
         waha_session    = COALESCE($3, waha_session)
     WHERE id = $1
     RETURNING id, name, email, whatsapp_number, waha_session`,
    [id, n, s]
  );
  return res.rows[0] || null;
}

// ✅ ALIAS pour compatibilité avec ton server.js actuel
export async function findMerchantByWhatsappNumber(whatsappNumber) {
  return findMerchantByWhatsappNumberE164(whatsappNumber);
}

// ✅ ALIAS pour compatibilité avec ton server.js actuel (il attend createMerchant)
export async function createMerchant({ name, email, passwordHash, whatsappNumber, wahaSession = "default" }) {
  return createMerchantWithWaha({ name, email, passwordHash, whatsappNumber, wahaSession });
}

export { normalizeE164, normalizeSession };

/**
 * Trouver ou créer un client pour un marchand donné
 */
export async function findOrCreateCustomer(merchantId, phone) {
  const selectSql = `
    SELECT *
    FROM customers
    WHERE merchant_id = $1 AND phone = $2
    LIMIT 1
  `;
  const existing = await query(selectSql, [merchantId, phone]);

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const insertSql = `
    INSERT INTO customers (merchant_id, phone, name, address, payment_method, created_at)
    VALUES ($1, $2, NULL, NULL, NULL, NOW())
    RETURNING *
  `;
  const inserted = await query(insertSql, [merchantId, phone]);
  return inserted.rows[0];
}

/**
 * Produits d'un marchand
 */
export async function getProductsForMerchant(merchantId) {
  const sql = `
    SELECT *
    FROM products
    WHERE merchant_id = $1
    ORDER BY id
  `;
  const result = await query(sql, [merchantId]);
  return result.rows;
}

/**
 * Récupérer l'état de conversation (JSON) pour ce couple marchand/client
 */
export async function getConversationState(merchantId, customerId) {
  const sql = `
    SELECT state
    FROM conversation_states
    WHERE merchant_id = $1 AND customer_id = $2
    LIMIT 1
  `;
  const result = await query(sql, [merchantId, customerId]);
  return result.rows[0]?.state || {};
}

/**
 * Définir / mettre à jour l'état de conversation
 */
export async function setConversationState(merchantId, customerId, state) {
  const sql = `
    INSERT INTO conversation_states (merchant_id, customer_id, state)
    VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (merchant_id, customer_id)
    DO UPDATE SET state = EXCLUDED.state
    RETURNING state
  `;
  const result = await query(sql, [merchantId, customerId, JSON.stringify(state)]);
  return result.rows[0].state;
}

/**
 * Contenu du panier pour ce marchand + client
 */
export async function getCart(merchantId, customerId) {
  const sql = `
    SELECT ci.product_id,
           ci.quantity,
           p.name,
           p.price
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id
    WHERE ci.merchant_id = $1
      AND ci.customer_id = $2
    ORDER BY ci.id
  `;
  const result = await query(sql, [merchantId, customerId]);
  return result.rows;
}

/**
 * Ajouter au panier / incrémenter la quantité
 */
export async function addToCart(merchantId, customerId, productId, quantity) {
  // 1) Récupérer le prix du produit pour ce marchand
  const productRes = await query(
    `
    SELECT price
    FROM products
    WHERE id = $1 AND merchant_id = $2
    `,
    [productId, merchantId]
  );

  if (productRes.rowCount === 0) {
    throw new Error(`Produit ${productId} introuvable pour le marchand ${merchantId}`);
  }

  // price est stocké en NUMERIC dans Postgres -> on le passe en Number JS
  const unitPrice = Number(productRes.rows[0].price);
  const totalPrice = unitPrice * quantity;

  // 2) Insérer / mettre à jour la ligne du panier avec unit_price + total_price
  const sql = `
    INSERT INTO cart_items (
      merchant_id,
      customer_id,
      product_id,
      quantity,
      unit_price,
      total_price
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (merchant_id, customer_id, product_id)
    DO UPDATE SET
      quantity   = cart_items.quantity + EXCLUDED.quantity,
      unit_price = EXCLUDED.unit_price,
      total_price = (cart_items.quantity + EXCLUDED.quantity) * EXCLUDED.unit_price
    RETURNING *;
  `;

  const params = [
    merchantId,
    customerId,
    productId,
    quantity,
    unitPrice,
    totalPrice,
  ];

  const result = await query(sql, params);
  return result.rows[0];
}


/**
 * Retirer un produit du panier
 */
export async function removeFromCart(merchantId, customerId, productId) {
  const sql = `
    DELETE FROM cart_items
    WHERE merchant_id = $1
      AND customer_id = $2
      AND product_id = $3
  `;
  await query(sql, [merchantId, customerId, productId]);
  return true;
}

/**
 * Vider le panier
 */
export async function clearCart(merchantId, customerId) {
  const sql = `
    DELETE FROM cart_items
    WHERE merchant_id = $1
      AND customer_id = $2
  `;
  await query(sql, [merchantId, customerId]);
  return true;
}

/**
 * Créer une commande à partir du panier
 */
export async function createOrderFromCart(merchantId, customerId) {
  // 1) Récupérer les lignes du panier pour ce client
  const cartRes = await query(
    `
    SELECT
      ci.product_id,
      ci.quantity,
      ci.unit_price,
      ci.total_price,
      p.name
    FROM cart_items ci
    JOIN products p
      ON p.id = ci.product_id
    WHERE ci.merchant_id = $1
      AND ci.customer_id = $2
    `,
    [merchantId, customerId]
  );

  if (cartRes.rowCount === 0) {
    throw new Error(
      `Aucun article dans le panier pour le marchand ${merchantId}, client ${customerId}`
    );
  }

  const items = cartRes.rows;

  // 2) Calculer le total de la commande
  const totalAmount = items.reduce(
    (sum, item) => sum + Number(item.total_price),
    0
  );

  // (on suppose que tous les produits sont en XOF dans ta boutique)
  const currency = "XOF";
// 1bis) Récupérer les infos client
const customerRes = await query(
  `
  SELECT address, payment_method
  FROM customers
  WHERE id = $1 AND merchant_id = $2
  `,
  [customerId, merchantId]
);

const customerRow = customerRes.rows[0] || {};
const deliveryAddress = customerRow.address || null;
const paymentMethodSnapshot = customerRow.payment_method || null;

  // 3) Créer la commande
  const orderRes = await query(
  `
  INSERT INTO orders (
    merchant_id,
    customer_id,
    total_amount,
    currency,
    status,
    delivery_address,
    payment_method_snapshot
  )
  VALUES ($1, $2, $3, $4, 'PENDING', $5, $6)
  RETURNING *;
  `,
  [merchantId, customerId, totalAmount, currency, deliveryAddress, paymentMethodSnapshot]
);

  const order = orderRes.rows[0];

  // 4) Créer les lignes de commande
  const values = [];
  const params = [];

  items.forEach((item, index) => {
    // pour chaque ligne : (order_id, product_id, quantity, unit_price, total_price)
    values.push(
      `($1, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4}, $${
        index * 4 + 5
      })`
    );
    params.push(
      item.product_id,
      item.quantity,
      item.unit_price,
      item.total_price
    );
  });

  // order_id en première position
  params.unshift(order.id);

  const insertItemsSql = `
    INSERT INTO order_items (
      order_id,
      product_id,
      quantity,
      unit_price,
      total_price
    )
    VALUES ${values.join(", ")}
  `;

  await query(insertItemsSql, params);

  // 5) Vider le panier
  await query(
    `
    DELETE FROM cart_items
    WHERE merchant_id = $1
      AND customer_id = $2
    `,
    [merchantId, customerId]
  );

  // 6) Retourner la commande créée + éventuellement les lignes
  return {
    order,
    items,
  };
}

// ...

export async function createProductForMerchant(merchantId, productData) {
  const {
    name,
    description = null,
    price,
    currency = "XOF",
    code = null,
    category = null,
    image_url = null,
  } = productData;

  const sql = `
    INSERT INTO products (
      merchant_id,
      name,
      description,
      price,
      currency,
      code,
      category,
      image_url
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *;
  `;

  const params = [
    merchantId,
    name,
    description,
    price,
    currency,
    code,
    category,
    image_url,
  ];

  const result = await query(sql, params);
  return result.rows[0];
}
export async function updateProductForMerchant(merchantId, productId, productData) {
  const {
    name,
    description = null,
    price,
    currency = "XOF",
    code = null,
    category = null,
    image_url = null,
    is_active = true,
  } = productData;

  const sql = `
    UPDATE products
    SET
      name = $1,
      description = $2,
      price = $3,
      currency = $4,
      code = $5,
      category = $6,
      image_url = $7,
      is_active = $8,
      updated_at = NOW()
    WHERE id = $9 AND merchant_id = $10
    RETURNING *;
  `;

  const params = [
    name,
    description,
    price,
    currency,
    code,
    category,
    image_url,
    is_active,
    productId,
    merchantId,
  ];

  const result = await query(sql, params);
  return result.rows[0] || null;
}

export async function deleteProductForMerchant(merchantId, productId) {
  const sql = `
    DELETE FROM products
    WHERE id = $1 AND merchant_id = $2
  `;
  await query(sql, [productId, merchantId]);
  return true;
}

export async function updateCustomerField(merchantId, customerId, field, value) {
  const allowedFields = ["address", "payment_method"];

  if (!allowedFields.includes(field)) {
    throw new Error(`Champ client non autorisé: ${field}`);
  }

  const sql = `
    UPDATE customers
    SET ${field} = $1
    WHERE id = $2
      AND merchant_id = $3
    RETURNING *;
  `;

  const result = await query(sql, [value, customerId, merchantId]);
  return result.rows[0];
}

export async function getOrdersForMerchant(merchantId) {
  const sql = `
    SELECT
      o.id,
      o.merchant_id,
      o.customer_id,
      o.total_amount,
      o.currency,
      o.status,
      o.created_at,
      c.name AS customer_name,
      c.phone AS customer_phone
    FROM orders o
    JOIN customers c
      ON c.id = o.customer_id
    WHERE o.merchant_id = $1
    ORDER BY o.created_at DESC
  `;
  const result = await query(sql, [merchantId]);
  return result.rows;
}

export async function getOrderWithItems(merchantId, orderId) {
  // 1) Récupérer la commande + client
  const orderRes = await query(
    `
   SELECT
  o.*,
  c.name  AS customer_name,
  c.phone AS customer_phone
FROM orders o
JOIN customers c
  ON c.id = o.customer_id
WHERE o.id = $1
  AND o.merchant_id = $2
    `,
    [orderId, merchantId]
  );

  if (orderRes.rowCount === 0) {
    return null;
  }

  const orderRow = orderRes.rows[0];

  // 2) Récupérer les lignes de commande
  const itemsRes = await query(
    `
    SELECT
      oi.id,
      oi.product_id,
      oi.quantity,
      oi.unit_price,
      oi.total_price,
      p.name AS product_name
    FROM order_items oi
    JOIN products p
      ON p.id = oi.product_id
    WHERE oi.order_id = $1
    ORDER BY oi.id ASC
    `,
    [orderId]
  );

  return {
    order: {
    id: orderRow.id,
    merchant_id: orderRow.merchant_id,
    customer_id: orderRow.customer_id,
    total_amount: orderRow.total_amount,
    currency: orderRow.currency,
    status: orderRow.status,
    created_at: orderRow.created_at,
    delivery_address: orderRow.delivery_address,
    payment_method_snapshot: orderRow.payment_method_snapshot,
  },
  customer: {
    id: orderRow.customer_id,
    name: orderRow.customer_name,
    phone: orderRow.customer_phone,
  },
    items: itemsRes.rows.map((r) => ({
      id: r.id,
      product_id: r.product_id,
      product_name: r.product_name,
      quantity: r.quantity,
      unit_price: r.unit_price,
      total_price: r.total_price,
    })),
  };
}

export async function updateOrderStatus(merchantId, orderId, status) {
  const allowedStatuses = ["PENDING", "CONFIRMED", "DELIVERED", "CANCELED"];

  if (!allowedStatuses.includes(status)) {
    throw new Error(`Statut de commande invalide: ${status}`);
  }

  const sql = `
    UPDATE orders
    SET status = $1
    WHERE id = $2
      AND merchant_id = $3
    RETURNING *;
  `;

  const result = await query(sql, [status, orderId, merchantId]);
  return result.rows[0] || null;
}
export async function findMerchantByEmail(email) {
  const res = await query(
    `
    SELECT id, name, email, password_hash
    FROM merchants
    WHERE email = $1
    `,
    [email]
  );
  return res.rows[0] || null;
}


