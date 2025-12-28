// db.js
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false, // 👈 CLAVE para Supabase + Render
  },
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 8000,
});

// Debug mínimo (puedes borrar luego)
pool.on("connect", () => {
  console.log("✅ DB connected");
});

async function getOrCreateUser(phone) {
  const { rows } = await pool.query(
    `
    insert into public.users (phone)
    values ($1)
    on conflict (phone)
    do update set updated_at = now()
    returning *
    `,
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
    `
    update public.users
    set ${sets.join(", ")}, updated_at = now()
    where phone = $1
    returning *
    `,
    values
  );

  return rows[0];
}

async function addDebt(userId, clientName, amountDue, dueText) {
  const { rows } = await pool.query(
    `
    insert into public.debts (user_id, client_name, amount_due, due_text, status)
    values ($1, $2, $3, $4, 'pending')
    returning *
    `,
    [userId, clientName, amountDue, dueText || null]
  );
  return rows[0];
}

async function listPendingDebts(userId) {
  const { rows } = await pool.query(
    `
    select *
    from public.debts
    where user_id = $1 and status = 'pending'
    order by created_at desc
    limit 50
    `,
    [userId]
  );
  return rows;
}

module.exports = {
  pool,
  getOrCreateUser,
  updateUser,
  addDebt,
  listPendingDebts,
};
