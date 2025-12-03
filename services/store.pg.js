// services/store.pg.js
import { query } from "../db.js";

/* =========================
   Normalisers
========================= */
export function normalizeE164(input) {
  if (!input) return null;
  const digits = String(input).replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

export function normalizeSession(input) {
  if (!input) return null;
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\w]/g, "");
}

/* =========================
   Merchants (routing)
========================= */
export async function findMerchantByWahaSession(session) {
  const s = normalizeSession(session);
  if (!s) return null;

  const res = await query(
    `SELECT * FROM merchants WHERE waha_session = $1 LIMIT 1`,
    [s]
  );
  return res.rows[0] || null;
}

export async function findMerchantByWhatsappNumber(whatsappNumber) {
  const n = normalizeE164(whatsappNumber);
  if (!n) return null;

  const res = await query(
    `SELECT * FROM merchants WHERE whatsapp_number = $1 LIMIT 1`,
    [n]
  );
  return res.rows[0] || null;
}

export async function findMerchantByEmail(email) {
  const res = await query(
    `SELECT id, name, email, password_hash, whatsapp_number, waha_session
     FROM merchants
     WHERE email = $1
     LIMIT 1`,
    [email]
  );
  return res.rows[0] || null;
}

/**
 * createMerchant — compatible "register"
 * ✅ wahaSession devient OPTIONNEL, pour ne pas casser /api/auth/register
 */
export async function createMerchant({ name, email, passwordHash, whatsappNumber, wahaSession = null }) {
  const n = normalizeE164(whatsappNumber);
  const s = wahaSession ? normalizeSession(wahaSession) : null;

  const res = await query(
    `INSERT INTO merchants (name, email, password_hash, whatsapp_number, waha_session)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, email, whatsapp_number, waha_session`,
    [name, email, passwordHash, n, s]
  );
  return res.rows[0];
}

/**
 * ✅ AJOUT: createMerchantWithWaha
 * Ton server.js l'importe, donc on le fournit.
 * Exige wahaSession (logique "admin create merchant")
 */
export async function createMerchantWithWaha({ name, email, passwordHash, whatsappNumber, wahaSession }) {
  const n = normalizeE164(whatsappNumber);
  const s = normalizeSession(wahaSession);

  if (!s) {
    throw new Error("wahaSession est obligatoire pour createMerchantWithWaha()");
  }

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

  // ⚠️ Important: COALESCE($2, whatsapp_number) => si $2 est null, pas de changement
  const n = whatsappNumber !== undefined ? normalizeE164(whatsappNumber) : null;
  const s = wahaSession !== undefined ? normalizeSession(wahaSession) : null;

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

/* =========================
   Customers
========================= */
export async function findOrCreateCustomer(merchantId, phone) {
  const selectSql = `
    SELECT *
    FROM customers
    WHERE merchant_id = $1 AND phone = $2
    LIMIT 1
  `;
  const existing = await query(selectSql, [merchantId, phone]);

  if (existing.rows.length > 0) return existing.rows[0];

  const insertSql = `
    INSERT INTO customers (merchant_id, phone, name, address, payment_method, created_at)
    VALUES ($1, $2, NULL, NULL, NULL, NOW())
    RETURNING *
  `;
  const inserted = await query(insertSql, [merchantId, phone]);
  return inserted.rows[0];
}

/* =========================
   Products
========================= */
export async function getProductsForMerchant(merchantId) {
  const res = await query(
    `SELECT * FROM products WHERE merchant_id = $1 ORDER BY id`,
    [merchantId]
  );
  return res.rows;
}

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

  const res = await query(
    `INSERT INTO products (merchant_id, name, description, price, currency, code, category, image_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [merchantId, name, description, price, currency, code, category, image_url]
  );
  return res.rows[0];
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

  const res = await query(
    `UPDATE products
     SET name=$1, description=$2, price=$3, currency=$4, code=$5, category=$6,
         image_url=$7, is_active=$8, updated_at=NOW()
     WHERE id=$9 AND merchant_id=$10
     RETURNING *`,
    [name, description, price, currency, code, category, image_url, is_active, productId, merchantId]
  );

  return res.rows[0] || null;
}

export async function deleteProductForMerchant(merchantId, productId) {
  await query(`DELETE FROM products WHERE id=$1 AND merchant_id=$2`, [productId, merchantId]);
  return true;
}

/* =========================
   Conversation state
========================= */
export async function getConversationState(merchantId, customerId) {
  const res = await query(
    `SELECT state FROM conversation_states
     WHERE merchant_id=$1 AND customer_id=$2 LIMIT 1`,
    [merchantId, customerId]
  );
  return res.rows[0]?.state || {};
}

export async function setConversationState(merchantId, customerId, state) {
  const res = await query(
    `INSERT INTO conversation_states (merchant_id, customer_id, state)
     VALUES ($1,$2,$3::jsonb)
     ON CONFLICT (merchant_id, customer_id)
     DO UPDATE SET state=EXCLUDED.state
     RETURNING state`,
    [merchantId, customerId, JSON.stringify(state)]
  );
  return res.rows[0].state;
}

/* =========================
   Cart
========================= */
export async function getCart(merchantId, customerId) {
  const res = await query(
    `SELECT ci.product_id, ci.quantity, p.name, p.price
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     WHERE ci.merchant_id=$1 AND ci.customer_id=$2
     ORDER BY ci.id`,
    [merchantId, customerId]
  );
  return res.rows;
}

export async function addToCart(merchantId, customerId, productId, quantity) {
  const productRes = await query(
    `SELECT price FROM products WHERE id=$1 AND merchant_id=$2`,
    [productId, merchantId]
  );
  if (productRes.rowCount === 0) {
    throw new Error(`Produit ${productId} introuvable pour marchand ${merchantId}`);
  }

  const unitPrice = Number(productRes.rows[0].price);
  const totalPrice = unitPrice * quantity;

  const res = await query(
    `INSERT INTO cart_items (merchant_id, customer_id, product_id, quantity, unit_price, total_price)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (merchant_id, customer_id, product_id)
     DO UPDATE SET
       quantity = cart_items.quantity + EXCLUDED.quantity,
       unit_price = EXCLUDED.unit_price,
       total_price = (cart_items.quantity + EXCLUDED.quantity) * EXCLUDED.unit_price
     RETURNING *`,
    [merchantId, customerId, productId, quantity, unitPrice, totalPrice]
  );

  return res.rows[0];
}

export async function removeFromCart(merchantId, customerId, productId) {
  await query(
    `DELETE FROM cart_items WHERE merchant_id=$1 AND customer_id=$2 AND product_id=$3`,
    [merchantId, customerId, productId]
  );
  return true;
}

export async function clearCart(merchantId, customerId) {
  await query(`DELETE FROM cart_items WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);
  return true;
}

/* =========================
   Orders
========================= */
export async function createOrderFromCart(merchantId, customerId) {
  const cartRes = await query(
    `SELECT ci.product_id, ci.quantity, ci.unit_price, ci.total_price, p.name
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     WHERE ci.merchant_id=$1 AND ci.customer_id=$2`,
    [merchantId, customerId]
  );
  if (cartRes.rowCount === 0) throw new Error("Panier vide");

  const items = cartRes.rows;
  const totalAmount = items.reduce((sum, it) => sum + Number(it.total_price), 0);
  const currency = "XOF";

  const customerRes = await query(
    `SELECT address, payment_method FROM customers WHERE id=$1 AND merchant_id=$2`,
    [customerId, merchantId]
  );
  const customerRow = customerRes.rows[0] || {};
  const deliveryAddress = customerRow.address || null;
  const paymentMethodSnapshot = customerRow.payment_method || null;

  const orderRes = await query(
    `INSERT INTO orders (merchant_id, customer_id, total_amount, currency, status, delivery_address, payment_method_snapshot)
     VALUES ($1,$2,$3,$4,'PENDING',$5,$6)
     RETURNING *`,
    [merchantId, customerId, totalAmount, currency, deliveryAddress, paymentMethodSnapshot]
  );

  const order = orderRes.rows[0];

  const values = [];
  const params = [order.id];

  items.forEach((item, idx) => {
    const base = idx * 4 + 2;
    values.push(`($1, $${base}, $${base + 1}, $${base + 2}, $${base + 3})`);
    params.push(item.product_id, item.quantity, item.unit_price, item.total_price);
  });

  await query(
    `INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_price)
     VALUES ${values.join(", ")}`,
    params
  );

  await query(`DELETE FROM cart_items WHERE merchant_id=$1 AND customer_id=$2`, [merchantId, customerId]);

  return { order, items };
}

export async function getOrdersForMerchant(merchantId) {
  const res = await query(
    `SELECT o.id, o.merchant_id, o.customer_id, o.total_amount, o.currency, o.status, o.created_at,
            c.name AS customer_name, c.phone AS customer_phone
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.merchant_id=$1
     ORDER BY o.created_at DESC`,
    [merchantId]
  );
  return res.rows;
}

export async function getOrderWithItems(merchantId, orderId) {
  const orderRes = await query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.id=$1 AND o.merchant_id=$2`,
    [orderId, merchantId]
  );
  if (orderRes.rowCount === 0) return null;

  const orderRow = orderRes.rows[0];

  const itemsRes = await query(
    `SELECT oi.id, oi.product_id, oi.quantity, oi.unit_price, oi.total_price, p.name AS product_name
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id=$1
     ORDER BY oi.id ASC`,
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
  const allowed = ["PENDING", "CONFIRMED", "DELIVERED", "CANCELED"];
  if (!allowed.includes(status)) throw new Error(`Statut invalide: ${status}`);

  const res = await query(
    `UPDATE orders SET status=$1 WHERE id=$2 AND merchant_id=$3 RETURNING *`,
    [status, orderId, merchantId]
  );
  return res.rows[0] || null;
}

/* =========================
   Customer fields
========================= */
export async function updateCustomerField(merchantId, customerId, field, value) {
  const allowedFields = ["address", "payment_method"];
  if (!allowedFields.includes(field)) throw new Error(`Champ non autorisé: ${field}`);

  const res = await query(
    `UPDATE customers SET ${field}=$1 WHERE id=$2 AND merchant_id=$3 RETURNING *`,
    [value, customerId, merchantId]
  );
  return res.rows[0];
}
