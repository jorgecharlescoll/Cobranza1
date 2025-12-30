// db.js — FlowSense
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

// -------------------------
// USERS
// -------------------------
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

// -------------------------
// CLIENTS
// -------------------------
async function findClientByName(userId, name) {
  if (!userId || !name) return null;
  return safeQuery(async () => {
    const { rows } = await pool.query(
      `
      SELECT *
      FROM clients
      WHERE user_id = $1 AND LOWER(name) = LOWER($2)
      LIMIT 1
      `,
      [userId, name]
    );
    return rows[0] || null;
  });
}

async function upsertClient(userId, name) {
  if (!userId || !name) return null;

  return safeQuery(async () => {
    // 1) intenta encontrar
    const existing = await findClientByName(userId, name);
    if (existing) return existing;

    // 2) inserta si no existe (sin depender de constraints)
    const { rows } = await pool.query(
      `
      INSERT INTO clients (user_id, name)
      VALUES ($1, $2)
      RETURNING *
      `,
      [userId, name]
    );
    return rows[0] || null;
  });
}

async function setClientPhone(userId, name, phone) {
  if (!userId || !name || !phone) return null;

  return safeQuery(async () => {
    // asegura cliente
    const client = await upsertClient(userId, name);
    if (!client) return null;

    const { rows } = await pool.query(
      `
      UPDATE clients
      SET phone = $1, updated_at = NOW()
      WHERE user_id = $2 AND LOWER(name) = LOWER($3)
      RETURNING *
      `,
      [phone, userId, name]
    );

    return rows[0] || null;
  });
}

// alias por compatibilidad con versiones previas
async function saveClientPhone(userId, name, phone) {
  return setClientPhone(userId, name, phone);
}

// -------------------------
// DEBTS
// -------------------------
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

async function listDebtsByClient(userId, clientName) {
  if (!userId || !clientName) return [];
  return safeQuery(async () => {
    const { rows } = await pool.query(
      `
      SELECT *
      FROM debts
      WHERE user_id = $1
        AND LOWER(client_name) = LOWER($2)
        AND status = 'pending'
      ORDER BY created_at DESC
      `,
      [userId, clientName]
    );
    return rows;
  });
}

async function markLatestDebtPaid(userId, clientName) {
  if (!userId || !clientName) return null;

  return safeQuery(async () => {
    const { rows } = await pool.query(
      `
      WITH latest AS (
        SELECT id
        FROM debts
        WHERE user_id = $1
          AND LOWER(client_name) = LOWER($2)
          AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1
      )
      UPDATE debts
      SET status = 'paid', updated_at = NOW()
      WHERE id IN (SELECT id FROM latest)
      RETURNING *
      `,
      [userId, clientName]
    );

    return rows[0] || null;
  });
}

module.exports = {
  pool,

  // users
  getOrCreateUser,
  updateUser,

  // clients
  findClientByName,
  upsertClient,
  setClientPhone,
  saveClientPhone,

  // debts
  addDebt,
  listPendingDebts,
  listDebtsByClient,
  markLatestDebtPaid,
};
