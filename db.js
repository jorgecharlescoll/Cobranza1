// db.js
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 8000,
});

// Log claro al conectar
pool.on("connect", () => {
  console.log("✅ DB connected");
});

// Reintento simple y seguro
async function safeQuery(fn, retries = 2) {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    console.warn("⚠️ DB retry due to error:", err.code || err.message);
    await new Promise((r) => setTimeout(r, 500));
    return safeQuery(fn, retries - 1);
  }
}

async function getOrCreateUser(phone) {
  return safeQuery(async () => {
    const { rows } = await pool.query(
      `
      INSERT INTO users (phone)
      VALUES ($1)
      ON CONFLICT (phone)
      DO UPDATE SET updated_at = NOW()
      RETURNING *
      `,
      [phone]
    );
    return rows[0];
  });
}

async function updateUser(phone, patch) {
  const keys = Object.keys(patch || {});
  if (!keys.length) return getOrCreateUser(phone);

  return safeQuery(async () => {
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const values = [phone, ...keys.map((k) => patch[k])];

    const { rows } = await pool.query(
      `
      UPDATE users
      SET ${sets}, updated_at = NOW()
      WHERE phone = $1
      RETURNING *
      `,
      values
    );

    return rows[0];
  });
}

async function addDebt(userId, clientName, amountDue, dueText) {
  return safeQuery(async () => {
    const { rows } = await pool.query(
      `
      INSERT INTO debts (user_id, client_name, amount_due, due_text, status)
      VALUES ($1, $2, $3, $4, 'pending')
      RETURNING *
      `,
      [userId, clientName, amountDue, dueText]
    );
    return rows[0];
  });
}

async function listPendingDebts(userId) {
  return safeQuery(async () => {
    const { rows } = await pool.query(
      `
      SELECT *
      FROM debts
      WHERE user_id = $1 AND status = 'pending'
      ORDER BY created_at DESC
      `,
      [userId]
    );
    return rows;
  });
}

module.exports = {
  pool,
  getOrCreateUser,
  updateUser,
  addDebt,
  listPendingDebts,
};
