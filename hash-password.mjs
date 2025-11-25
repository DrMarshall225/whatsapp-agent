import bcrypt from "bcrypt";

const password = "motdepasse123"; // choisis un mot de passe
const hash = await bcrypt.hash(password, 10);

console.log("Hash :", hash);
