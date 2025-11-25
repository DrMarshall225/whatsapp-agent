// test-db.js
import { query } from "./db.js";

try {
  const result = await query("SELECT * FROM test");
  console.log(result.rows);
} catch (err) {
  console.error("Erreur lors de la requête :", err.message);
} finally {
  // pour être sûr que le processus se termine
  process.exit(0);
}
