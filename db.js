// db.js
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

// Pool estable para Render + Supabase pooler
const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  },

  // estabilidad
  max: 5,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000,
  keepAlive: true,

  // ✅ fuerza IPv4 (clave en Render cuando hay timeouts raros)
  family: 4,
});

pool.on("error", (err) => {
  console.error("PG pool error:", err);
});



// Logs útiles si se cae el pool
pool.on("error", (err) => {
  console.error("PG pool error:", err);
});

// Timeout de queries (opcional)
pool.on("connect", (client) => {
  client.query("SET statement_timeout = 15000").catch(() => {});
});

// =========================
// USERS
// =========================
async function getOrCreateUser(phone) {
  const { rows } = await pool.query(
    `insert into public.users (phone)
     values ($1)
     on conflict (phone) do update set updated_at = now()
     returning *`,
    [phone]
  );
  return rows[0];
}

async function updateUser(phone, patch) {
  const keys = Object.keys(patch || {});
  if (!keys.length) return getOrCreateUser(phone);

  const sets = [];
  const values = [phone];
  let i = 2;

  for (const k of keys) {
    sets.push(`${k} = $${i++}`);
    values.push(patch[k]);
  }

  const { rows } = await pool.query(
    `update public.users
     set ${sets.join(", ")}, updated_at = now()
     where phone = $1
     returning *`,
    values
  );

  if (rows.length) return rows[0];

  // Si por alguna razón no existe, lo crea y vuelve a intentar
  await getOrCreateUser(phone);
  const { rows: rows2 } = await pool.query(
    `update public.users
     set ${sets.join(", ")}, updated_at = now()
     where phone = $1
     returning *`,
    values
  );
  return rows2[0];
}

// =========================
// CLIENTS
// =========================
async function getOrCreateClient(userId, name) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error("client name is required");

  const { rows } = await pool.query(
    `
    insert into public.clients (user_id, name)
    values ($1, $2)
    on conflict (user_id, lower(name))
    do update set name = excluded.name
    returning *;
    `,
    [userId, clean]
  );

  return rows[0];
}

async function findClientByName(userId, name) {
  const clean = String(name || "").trim();
  if (!clean) return null;

  const { rows } = await pool.query(
    `select *
     from public.clients
     where user_id = $1 and lower(name) = lower($2)
     limit 1`,
    [userId, clean]
  );
  return rows[0] || null;
}

async function setClientPhone(userId, name, phone) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error("client name is required");

  const { rows } = await pool.query(
    `update public.clients
     set phone = $3
     where user_id = $1 and lower(name) = lower($2)
     returning *`,
    [userId, clean, phone]
  );
  return rows[0] || null;
}

// =========================
// DEBTS
// =========================
async function addDebt(userId, clientName, amountDue, dueText) {
  // 1) asegura cliente
  const client = await getOrCreateClient(userId, clientName);

  // 2) crea deuda ligada al cliente
  const { rows } = await pool.query(
    `insert into public.debts (user_id, client_id, client_name, amount_due, due_text, status)
     values ($1, $2, $3, $4, $5, 'pending')
     returning *`,
    [userId, client.id, client.name, amountDue, dueText || null]
  );

  return rows[0];
}

async function listPendingDebts(userId) {
  const { rows } = await pool.query(
    `select *
     from public.debts
     where user_id = $1 and status = 'pending'
     order by created_at desc
     limit 50`,
    [userId]
  );
  return rows;
}

// =========================
// REMINDERS
// =========================
async function createReminder({
  userId,
  toPhone,
  clientName,
  amountDue,
  remindAt,
  message,
}) {
  const { rows } = await pool.query(
    `insert into public.reminders (user_id, to_phone, client_name, amount_due, remind_at, message)
     values ($1, $2, $3, $4, $5, $6)
     returning *`,
    [userId, toPhone, clientName || null, amountDue || null, remindAt, message]
  );
  return rows[0];
}

async function listDueReminders(limit = 50) {
  const { rows } = await pool.query(
    `select *
     from public.reminders
     where status = 'pending'
       and remind_at <= now()
     order by remind_at asc
     limit $1`,
    [limit]
  );
  return rows;
}

async function markReminderSent(id) {
  await pool.query(
    `update public.reminders
     set status = 'sent', sent_at = now()
     where id = $1`,
    [id]
  );
}

async function markReminderFailed(id) {
  await pool.query(
    `update public.reminders
     set status = 'failed'
     where id = $1`,
    [id]
  );
}

module.exports = {
  pool,

  // users
  getOrCreateUser,
  updateUser,

  // clients
  getOrCreateClient,
  findClientByName,
  setClientPhone,

  // debts
  addDebt,
  listPendingDebts,

  // reminders
  createReminder,
  listDueReminders,
  markReminderSent,
  markReminderFailed,
};
