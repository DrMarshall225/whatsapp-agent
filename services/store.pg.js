// services/store.pg.js
import { query, withTransaction } from "../db.js";

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

/**
 * ✅ VERSION CORRIGÉE (robuste)
 *
 * Règles :
 * - state = {}  -> reset complet
 * - patch avec { key: null } -> supprime la clé dans jsonb
 * - sinon -> merge jsonb côté SQL (sans race condition)
 */
export async function setConversationState(merchantId, customerId, state) {
  try {
    const input = state && typeof state === "object" ? state : {};

    // ✅ Reset complet si objet vide
    if (Object.keys(input).length === 0) {
      const res = await query(
        `INSERT INTO conversation_states (merchant_id, customer_id, state)
         VALUES ($1, $2, '{}'::jsonb)
         ON CONFLICT (merchant_id, customer_id)
         DO UPDATE SET state='{}'::jsonb, updated_at=now()
         RETURNING state`,
        [merchantId, customerId]
      );
      return res.rows[0]?.state || {};
    }

    // ✅ Construire patch + liste de suppression
    const patch = {};
    const deleteKeys = [];

    for (const [k, v] of Object.entries(input)) {
      if (v === null || v === undefined) deleteKeys.push(k);
      else patch[k] = v;
    }

    const patchJson = JSON.stringify(patch);
    const deleteArr = deleteKeys; // toujours un array (peut être vide)

    const res = await query(
      `INSERT INTO conversation_states (merchant_id, customer_id, state)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (merchant_id, customer_id)
       DO UPDATE SET
         state = ((conversation_states.state || $3::jsonb) - $4::text[]),
         updated_at = now()
       RETURNING state`,
      [merchantId, customerId, patchJson, deleteArr]
    );

    return res.rows[0]?.state || {};
  } catch (error) {
    console.error(`[store.pg] setConversationState error:`, {
      merchantId,
      customerId,
      error: error.message,
    });
    throw error;
  }
}

/* =========================
   Cart
========================= */

/**
 * ✅ getCart retourne un objet structuré
 */
export async function getCart(merchantId, customerId) {
  const res = await query(
    `SELECT ci.product_id, ci.quantity, ci.unit_price, ci.total_price,
            p.name, p.price, p.currency, p.code, p.category
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     WHERE ci.merchant_id=$1 AND ci.customer_id=$2
     ORDER BY ci.id`,
    [merchantId, customerId]
  );

  const items = res.rows;
  const total = items.reduce((sum, item) => sum + Number(item.total_price), 0);
  const currency = items[0]?.currency || "XOF";

  return {
    items,
    total_items: items.length,
    total_amount: total,
    currency,
  };
}

/**
 * ✅ Vérifier que le produit est actif avant ajout au panier
 */
export async function addToCart(merchantId, customerId, productId, quantity) {
  try {
    const productRes = await query(
      `SELECT price, currency, is_active, name FROM products
       WHERE id=$1 AND merchant_id=$2`,
      [productId, merchantId]
    );

    if (productRes.rowCount === 0) {
      throw new Error(`Produit ${productId} introuvable pour marchand ${merchantId}`);
    }

    const product = productRes.rows[0];
    if (!product.is_active) {
      throw new Error(`Produit "${product.name}" (${productId}) n'est plus disponible`);
    }

    const unitPrice = Number(product.price);
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
  } catch (error) {
    console.error(`[store.pg] addToCart error:`, {
      merchantId,
      customerId,
      productId,
      quantity,
      error: error.message,
    });
    throw error;
  }
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
export async function createOrderFromCart(merchantId, customerId, opts = {}) {
  const {
    deliveryRequestedAt = null,
    deliveryRequestedRaw = null,

    recipientCustomerId = null,
    recipientNameSnapshot = null,
    recipientPhoneSnapshot = null,
    recipientAddressSnapshot = null,

    status = "NEW",
  } = opts;

  try {
    const result = await withTransaction(async (client) => {
      const cartRes = await client.query(
        `SELECT ci.product_id, ci.quantity, ci.unit_price, ci.total_price, p.name
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
         WHERE ci.merchant_id=$1 AND ci.customer_id=$2
         FOR UPDATE`,
        [merchantId, customerId]
      );

      if (cartRes.rowCount === 0) {
        throw new Error("Panier vide");
      }

      const items = cartRes.rows;
      const totalAmount = items.reduce((sum, it) => sum + Number(it.total_price), 0);
      const currency = "XOF";

      const customerRes = await client.query(
        `SELECT address, payment_method FROM customers
         WHERE id=$1 AND merchant_id=$2`,
        [customerId, merchantId]
      );

      const customerRow = customerRes.rows[0] || {};
      const deliveryAddress = customerRow.address || null;
      const paymentMethodSnapshot = customerRow.payment_method || null;

      const orderRes = await client.query(
        `INSERT INTO orders (
            merchant_id, customer_id,
            total_amount, currency, status,
            delivery_address, payment_method_snapshot,
            recipient_customer_id,
            recipient_name_snapshot, recipient_phone_snapshot, recipient_address_snapshot,
            delivery_requested_at, delivery_requested_raw
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          merchantId,
          customerId,
          totalAmount,
          currency,
          status,
          deliveryAddress,
          paymentMethodSnapshot,
          recipientCustomerId,
          recipientNameSnapshot,
          recipientPhoneSnapshot,
          recipientAddressSnapshot,
          deliveryRequestedAt,
          deliveryRequestedRaw,
        ]
      );

      const order = orderRes.rows[0];

      const values = [];
      const params = [order.id];

      items.forEach((item, idx) => {
        const base = idx * 4 + 2;
        values.push(`($1, $${base}, $${base + 1}, $${base + 2}, $${base + 3})`);
        params.push(item.product_id, item.quantity, item.unit_price, item.total_price);
      });

      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_price)
         VALUES ${values.join(", ")}`,
        params
      );

      await client.query(
        `DELETE FROM cart_items WHERE merchant_id=$1 AND customer_id=$2`,
        [merchantId, customerId]
      );

      return { order, items };
    });

    console.log(`[store.pg] ✅ Commande créée: order_id=${result.order.id}, merchant=${merchantId}, customer=${customerId}`);
    return result;
  } catch (error) {
    console.error(`[store.pg] ❌ createOrderFromCart error (transaction rolled back):`, {
      merchantId,
      customerId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
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

/**
 * ✅ FIX: autoriser "NEW" (car server.js crée status="NEW")
 */
export async function updateOrderStatus(merchantId, orderId, status) {
  const allowed = ["NEW", "PENDING", "CONFIRMED", "DELIVERED", "CANCELED"];
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
  const allowedFields = {
    name: "name",
    address: "address",
    payment_method: "payment_method",
  };

  const safeField = allowedFields[field];
  if (!safeField) {
    throw new Error(`Champ non autorisé: ${field}`);
  }

  try {
    const res = await query(
      `UPDATE customers SET ${safeField}=$1 WHERE id=$2 AND merchant_id=$3 RETURNING *`,
      [value, customerId, merchantId]
    );
    return res.rows[0];
  } catch (error) {
    console.error(`[store.pg] updateCustomerField error:`, {
      merchantId,
      customerId,
      field,
      error: error.message,
    });
    throw error;
  }
}

export async function updateCustomerProfile(merchantId, customerId, { name, address, payment_method }) {
  const res = await query(
    `UPDATE customers
     SET name = COALESCE($1, name),
         address = COALESCE($2, address),
         payment_method = COALESCE($3, payment_method)
     WHERE id=$4 AND merchant_id=$5
     RETURNING *`,
    [name ?? null, address ?? null, payment_method ?? null, customerId, merchantId]
  );
  return res.rows[0] || null;
}

export async function getLastOrderWithItemsForCustomer(merchantId, customerId) {
  const orderRes = await query(
    `SELECT *
     FROM orders
     WHERE merchant_id=$1 AND customer_id=$2
     ORDER BY created_at DESC
     LIMIT 1`,
    [merchantId, customerId]
  );
  if (orderRes.rowCount === 0) return null;

  const order = orderRes.rows[0];

  const itemsRes = await query(
    `SELECT oi.id, oi.product_id, oi.quantity, oi.unit_price, oi.total_price, p.name AS product_name
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id=$1
     ORDER BY oi.id ASC`,
    [order.id]
  );

  return { order, items: itemsRes.rows };
}

export async function cancelLastOrderForCustomer(merchantId, customerId) {
  const last = await getLastOrderWithItemsForCustomer(merchantId, customerId);
  if (!last) return null;

  const currentStatus = last.order.status;
  if (currentStatus === "DELIVERED" || currentStatus === "CANCELED") {
    return { blocked: true, reason: `Commande non annulable (status=${currentStatus})`, order: last.order };
  }

  const res = await query(
    `UPDATE orders
     SET status='CANCELED'
     WHERE id=$1 AND merchant_id=$2 AND customer_id=$3
     RETURNING *`,
    [last.order.id, merchantId, customerId]
  );

  return { blocked: false, order: res.rows[0] || null };
}

export async function loadLastOrderToCart(merchantId, customerId) {
  const last = await getLastOrderWithItemsForCustomer(merchantId, customerId);
  if (!last) return null;

  const st = last.order.status;
  if (st === "DELIVERED" || st === "CANCELED") {
    return { blocked: true, reason: `Commande non modifiable (status=${st})`, order: last.order };
  }

  await clearCart(merchantId, customerId);

  for (const it of last.items) {
    await query(
      `INSERT INTO cart_items (merchant_id, customer_id, product_id, quantity, unit_price, total_price)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (merchant_id, customer_id, product_id)
       DO UPDATE SET
         quantity = EXCLUDED.quantity,
         unit_price = EXCLUDED.unit_price,
         total_price = EXCLUDED.total_price`,
      [merchantId, customerId, it.product_id, it.quantity, it.unit_price, it.total_price]
    );
  }

  return { blocked: false, order: last.order, items: last.items };
}

// =========================
// Admin - Merchants / Subscriptions
// =========================

export async function adminListMerchants({ q = null, status = null } = {}) {
  const params = [];
  let where = "1=1";

  if (q) {
    params.push(`%${String(q).toLowerCase()}%`);
    where += ` AND (
      LOWER(name) LIKE $${params.length}
      OR LOWER(email) LIKE $${params.length}
      OR LOWER(COALESCE(whatsapp_number,'')) LIKE $${params.length}
      OR LOWER(COALESCE(waha_session,'')) LIKE $${params.length}
    )`;
  }

  if (status && status !== "ALL") {
    params.push(status);
    where += ` AND (
      CASE
        WHEN is_suspended = true THEN 'SUSPENDED'
        WHEN subscription_expires_at IS NOT NULL AND subscription_expires_at < NOW() THEN 'EXPIRED'
        WHEN subscription_status = 'ACTIVE' AND (subscription_expires_at IS NULL OR subscription_expires_at >= NOW()) THEN 'ACTIVE'
        ELSE 'TRIAL'
      END
    ) = $${params.length}`;
  }

  const sql = `
    SELECT
      id, name, email, whatsapp_number, waha_session,
      subscription_status, subscription_expires_at, is_suspended,
      CASE
        WHEN is_suspended = true THEN 'SUSPENDED'
        WHEN subscription_expires_at IS NOT NULL AND subscription_expires_at < NOW() THEN 'EXPIRED'
        WHEN subscription_status = 'ACTIVE' AND (subscription_expires_at IS NULL OR subscription_expires_at >= NOW()) THEN 'ACTIVE'
        ELSE 'TRIAL'
      END AS computed_status
    FROM merchants
    WHERE ${where}
    ORDER BY id DESC
  `;
  const res = await query(sql, params);
  return res.rows;
}

export async function adminSetMerchantSuspended(merchantId, isSuspended) {
  const res = await query(
    `UPDATE merchants
     SET is_suspended = $2
     WHERE id = $1
     RETURNING id, name, email, whatsapp_number, waha_session,
               subscription_status, subscription_expires_at, is_suspended`,
    [Number(merchantId), !!isSuspended]
  );
  return res.rows[0] || null;
}

export async function adminGetDashboard() {
  const counts = await query(`
    SELECT
      COUNT(*)::int AS total_merchants,
      SUM(CASE WHEN is_suspended = true THEN 1 ELSE 0 END)::int AS suspended_merchants,
      SUM(CASE WHEN subscription_expires_at IS NOT NULL AND subscription_expires_at < NOW() THEN 1 ELSE 0 END)::int AS expired_merchants,
      SUM(CASE WHEN is_suspended = false AND subscription_status='ACTIVE' AND (subscription_expires_at IS NULL OR subscription_expires_at >= NOW()) THEN 1 ELSE 0 END)::int AS active_merchants
    FROM merchants
  `);

  const revenue = await query(`
    SELECT COALESCE(SUM(amount),0)::int AS revenue_month
    FROM subscription_payments
    WHERE date_trunc('month', paid_at) = date_trunc('month', now())
  `);

  return {
    ...counts.rows[0],
    revenue_month: revenue.rows[0]?.revenue_month || 0,
  };
}

export async function adminAddSubscriptionPayment(
  merchantId,
  { amount = 15000, months = 1, method = null, reference = null, note = null } = {}
) {
  const id = Number(merchantId);
  const m = Math.max(1, Number(months || 1));
  const amt = Number(amount || 15000);

  const merchRes = await query(
    `SELECT subscription_expires_at FROM merchants WHERE id=$1`,
    [id]
  );
  if (merchRes.rowCount === 0) return null;

  const expiresAt = merchRes.rows[0].subscription_expires_at;
  const isStillValid = expiresAt && new Date(expiresAt).getTime() > Date.now();

  const startDateSql = isStillValid
    ? "DATE($1::timestamptz) + INTERVAL '1 day'"
    : "CURRENT_DATE";

  const periodRes = await query(
    `SELECT
      (${startDateSql})::date AS period_start,
      ((${startDateSql}) + ($2 || ' month')::interval - INTERVAL '1 day')::date AS period_end`,
    isStillValid ? [expiresAt, String(m)] : [null, String(m)]
  );

  const period_start = periodRes.rows[0].period_start;
  const period_end = periodRes.rows[0].period_end;

  const payRes = await query(
    `INSERT INTO subscription_payments(merchant_id, amount, currency, period_start, period_end, method, reference, note)
     VALUES($1,$2,'XOF',$3,$4,$5,$6,$7)
     RETURNING *`,
    [id, amt, period_start, period_end, method, reference, note]
  );

  const updated = await query(
    `UPDATE merchants
     SET subscription_status='ACTIVE',
         subscription_expires_at = ($2::date + time '23:59:59')::timestamptz,
         is_suspended = false
     WHERE id=$1
     RETURNING id, name, email, whatsapp_number, waha_session,
               subscription_status, subscription_expires_at, is_suspended`,
    [id, period_end]
  );

  return { payment: payRes.rows[0], merchant: updated.rows[0] };
}

export async function adminListSubscriptionPayments(merchantId) {
  const res = await query(
    `SELECT *
     FROM subscription_payments
     WHERE merchant_id=$1
     ORDER BY paid_at DESC`,
    [Number(merchantId)]
  );
  return res.rows;
}

export async function getMerchantAccessFlags(merchantId) {
  const res = await query(
    `SELECT id, is_suspended, subscription_expires_at, subscription_status
     FROM merchants WHERE id=$1`,
    [Number(merchantId)]
  );
  return res.rows[0] || null;
}
