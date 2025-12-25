const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase requiere SSL
});

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
  const fields = [];
  const values = [phone];
  let i = 2;

  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = $${i++}`);
    values.push(v);
  }

  const sql = `
    update public.users
    set ${fields.join(", ")}, updated_at = now()
    where phone = $1
    returning *;
  `;

  const { rows } = await pool.query(sql, values);
  return rows[0];
}

async function addDebt(userId, clientName, amountDue, dueText) {
  const { rows } = await pool.query(
    `insert into public.debts (user_id, client_name, amount_due, due_text)
     values ($1, $2, $3, $4)
     returning *`,
    [userId, clientName, amountDue, dueText || null]
  );
  return rows[0];
}

async function listPendingDebts(userId) {
  const { rows } = await pool.query(
    `select * from public.debts
     where user_id = $1 and status = 'pending'
     order by created_at desc
     limit 50`,
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
