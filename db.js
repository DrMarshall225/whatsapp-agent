// db.js
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  host: "65.109.27.58",
  port: 55432,
  user: "postgres",
  password: "ayYtneAT6CuKks",
  database: "whatsapp_agent"
});

export async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}
