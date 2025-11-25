import { query } from "./db.js";

const merchantId = 1;

const sql = "SELECT * FROM products WHERE merchant_id = $1 ORDER BY id";

const run = async () => {
  try {
    const result = await query(sql, [merchantId]);
    console.log("Produits du marchand", merchantId, ":", result.rows);
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
};

run();