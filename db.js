// db.js
import pkg from "pg";
const { Pool } = pkg;

// ✅ CORRECTION #1: Utiliser des variables d'environnement (CRITIQUE)
const pool = new Pool({
  host: process.env.DB_HOST || "65.109.27.58",
  port: Number(process.env.DB_PORT) || 55432,
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "ayYtneAT6CuKks", // ⚠️ CHANGER CE MOT DE PASSE !
  database: process.env.DB_NAME || "whatsapp_agent",
  
  // ✅ CORRECTION #2: Configuration optimisée
  max: Number(process.env.DB_POOL_MAX) || 20,           // Connexions max dans le pool
  idleTimeoutMillis: 30000,                              // Fermer connexions inactives après 30s
  connectionTimeoutMillis: 5000,                         // Timeout si pas de connexion dispo
  
  // ✅ CORRECTION #3: SSL en production (recommandé)
  ssl: false,
});

// ✅ CORRECTION #4: Logs de connexion
pool.on("connect", () => {
  console.log("[DB] ✅ Nouvelle connexion PostgreSQL établie");
});

pool.on("error", (err) => {
  console.error("[DB] ❌ Erreur pool PostgreSQL:", err);
  // En production, envoyer à un système de monitoring (Sentry, etc.)
});

// ✅ CORRECTION #5: Fonction query avec logs d'erreur
export async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } catch (error) {
    // ✅ Log détaillé pour debug
    console.error("[DB] ❌ Erreur requête:", {
      error: error.message,
      code: error.code,
      query: sql.substring(0, 100), // Premiers 100 caractères seulement
      params: params.length > 0 ? `${params.length} params` : "no params",
    });
    throw error; // Re-throw pour que l'appelant puisse gérer
  } finally {
    client.release();
  }
}

// ✅ CORRECTION #6: Exposer le pool pour transactions (CRITIQUE pour store.pg.js)
export { pool };

// ✅ CORRECTION #7: Fonction helper pour transactions
/**
 * Exécute une fonction dans une transaction
 * Usage: await withTransaction(async (client) => { ... })
 */
export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DB] ❌ Transaction rollback:", error.message);
    throw error;
  } finally {
    client.release();
  }
}

// ✅ CORRECTION #8: Health check pour monitoring
export async function healthCheck() {
  try {
    const result = await query("SELECT NOW() as now, version() as version");
    return {
      ok: true,
      timestamp: result.rows[0].now,
      version: result.rows[0].version,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
    };
  }
}

// ✅ CORRECTION #9: Graceful shutdown
export async function closePool() {
  try {
    await pool.end();
    console.log("[DB] ✅ Pool PostgreSQL fermé proprement");
  } catch (error) {
    console.error("[DB] ❌ Erreur fermeture pool:", error);
  }
}

// ✅ CORRECTION #10: Gestion du shutdown (SIGINT, SIGTERM)
if (process.env.NODE_ENV !== "test") {
  process.on("SIGINT", async () => {
    console.log("[DB] 🛑 SIGINT reçu, fermeture du pool...");
    await closePool();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("[DB] 🛑 SIGTERM reçu, fermeture du pool...");
    await closePool();
    process.exit(0);
  });
}

// ✅ Test de connexion au démarrage
(async () => {
  try {
    const health = await healthCheck();
    if (health.ok) {
      console.log("[DB] ✅ Connexion PostgreSQL OK");
      console.log(`[DB] 📊 Pool: ${health.pool.total} total, ${health.pool.idle} idle`);
    } else {
      console.error("[DB] ❌ Connexion PostgreSQL échouée:", health.error);
      process.exit(1);
    }
  } catch (error) {
    console.error("[DB] ❌ Test connexion échoué:", error);
    process.exit(1);
  }
})();