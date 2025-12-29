// db.js
const { Pool } = require("pg");

// 1) DATABASE_URL obligatorio
const raw = process.env.DATABASE_URL;
if (!raw) throw new Error("DATABASE_URL is not set");

// 2) Asegura sslmode=require en el string (por si se te olvida en Render)
const connectionString = raw.includes("sslmode=")
  ? raw
  : raw + (raw.includes("?") ? "&" : "?") + "sslmode=require";

// 3) Pool estable para Render + Supabase pooler
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
  keepAlive: true,
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
// CLIENTS (para teléfonos)
// =========================
async function findClientByName(userId, name) {
  const nm = (name || "").trim();
  if (!nm) return null;

  const { rows } = await pool.query(
    `select *
     from public.clients
     where user_id = $1 and lower(name) = lower($2)
     limit 1`,
    [userId, nm]
  );
  return rows[0] || null;
}

// “Upsert” por lógica (sin UNIQUE fancy)
async function upsertClient(userId, name, phone = null) {
  const nm = (name || "").trim();
  if (!nm) return null;

  const existing = await findClientByName(userId, nm);
  if (existing) {
    if (phone && phone !== existing.phone) {
      const { rows } = await pool.query(
        `update public.clients
         set phone = $3, updated_at = now()
         where user_id = $1 and lower(name) = lower($2)
         returning *`,
        [userId, nm, phone]
      );
      return rows[0] || existing;
    }
    return existing;
  }

  const { rows } = await pool.query(
    `insert into public.clients (user_id, name, phone)
     values ($1, $2, $3)
     returning *`,
    [userId, nm, phone || null]
  );
  return rows[0];
}

// Guardar teléfono: si no existe, crea el cliente; si existe, actualiza
async function setClientPhone(userId, name, phone) {
  return upsertClient(userId, name, phone);
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

async function markLatestDebtPaid(userId, clientName) {
  // Marca como pagada la deuda pendiente más reciente de ese cliente
  const { rows } = await pool.query(
    `
    update public.debts
    set status = 'paid'
    where id = (
      select id
      from public.debts
      where user_id = $1
        and status = 'pending'
        and lower(client_name) = lower($2)
      order by created_at desc
      limit 1
    )
    returning *
    `,
    [userId, clientName]
  );

  return rows[0] || null;
}


module.exports = {
  pool,
  getOrCreateUser,
  updateUser,
  addDebt,
  listPendingDebts,

  // clients
  findClientByName,
  upsertClient,
  setClientPhone,

  // reminders
  createReminder,
  listDueReminders,
  markReminderSent,
  markReminderFailed,
  markLatestDebtPaid,

};
