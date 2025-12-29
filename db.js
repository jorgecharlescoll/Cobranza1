// db.js
const { Pool } = require("pg");

// 1) Lee DATABASE_URL
const raw = process.env.DATABASE_URL;
if (!raw) throw new Error("DATABASE_URL is not set");

// 2) Fuerza sslmode=require en el string (por si en Render se te olvida)
const connectionString = raw.includes("sslmode=")
  ? raw
  : raw + (raw.includes("?") ? "&" : "?") + "sslmode=require";

// 3) Pool estable para Render + Supabase pooler
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // evita SELF_SIGNED_CERT_IN_CHAIN
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
  keepAlive: true,
  family: 4,
});

pool.on("error", (err) => {
  console.error("PG pool error:", err);
});

pool.on("connect", (client) => {
  client.query("SET statement_timeout = 15000").catch(() => {});
  client.query("SET idle_in_transaction_session_timeout = 15000").catch(() => {});
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
// DEBTS
// =========================
async function addDebt(userId, clientName, amountDue, dueText) {
  const { rows } = await pool.query(
    `insert into public.debts (user_id, client_name, amount_due, due_text, status)
     values ($1, $2, $3, $4, 'pending')
     returning *`,
    [userId, clientName, amountDue, dueText || null]
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
async function createReminder({ userId, toPhone, clientName, amountDue, remindAt, message }) {
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

// =========================
// CLIENTS (teléfonos)
// =========================
async function findClientByName(userId, name) {
  const clean = (name || "").trim();
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
  const clean = (name || "").trim();
  const { rows } = await pool.query(
    `update public.clients
     set phone = $3
     where user_id = $1 and lower(name) = lower($2)
     returning *`,
    [userId, clean, phone]
  );
  return rows[0] || null;
}

module.exports = {
  pool,
  getOrCreateUser,
  updateUser,
  addDebt,
  listPendingDebts,
  createReminder,
  listDueReminders,
  markReminderSent,
  markReminderFailed,
  findClientByName,
  setClientPhone,
};
