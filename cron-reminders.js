// cron-reminders.js
// Cron robusto para Render + Supabase pooler (Transaction 6543)
// - Reintentos ante timeouts
// - No truena el cron por fallas temporales
// - Cierra pool siempre

require("dotenv").config();

const twilio = require("twilio");
const { Pool } = require("pg");

// =========================
// ENV
// =========================
const {
  DATABASE_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM, // ej: "whatsapp:+14155238886"
} = process.env;

if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");
if (!TWILIO_ACCOUNT_SID) throw new Error("TWILIO_ACCOUNT_SID is not set");
if (!TWILIO_AUTH_TOKEN) throw new Error("TWILIO_AUTH_TOKEN is not set");
if (!TWILIO_WHATSAPP_FROM) throw new Error("TWILIO_WHATSAPP_FROM is not set");

// Asegura sslmode=require
const connectionString = DATABASE_URL.includes("sslmode=")
  ? DATABASE_URL
  : DATABASE_URL + (DATABASE_URL.includes("?") ? "&" : "?") + "sslmode=require";

// =========================
// PG Pool (más tolerante a latencia)
// =========================
const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  },

  // Cron: pocas conexiones
  max: 2,

  // ⬆️ subimos tolerancia de conexión (clave)
  connectionTimeoutMillis: 60000, // 60s
  idleTimeoutMillis: 30000,
  keepAlive: true,
  family: 4,
});

pool.on("error", (err) => console.error("PG pool error:", err?.message || err));

const tw = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// =========================
// Helpers
// =========================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);
      console.error(`Retry ${i}/${tries} failed:`, msg);
      // backoff: 1s, 2s, 4s
      await sleep(1000 * Math.pow(2, i - 1));
    }
  }
  throw lastErr;
}

function fmtMoneyMXN(n) {
  const val = Number(n || 0);
  return val.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

function asWhatsApp(toPhone) {
  const s = String(toPhone || "").trim();
  if (!s) return null;
  if (s.startsWith("whatsapp:")) return s;
  if (s.startsWith("+")) return `whatsapp:${s}`;
  return `whatsapp:${s}`;
}

async function sendWhatsApp(toPhone, body) {
  const to = asWhatsApp(toPhone);
  if (!to) throw new Error("toPhone is empty");
  await tw.messages.create({ from: TWILIO_WHATSAPP_FROM, to, body });
}

// =========================
// 1) Recordatorios vencidos
// =========================
async function sendDueReminders(limit = 50) {
  const { rows } = await withRetry(
    () =>
      pool.query(
        `
        select id, user_id, to_phone, message
        from public.reminders
        where status = 'pending'
          and remind_at <= now()
        order by remind_at asc
        limit $1
        `,
        [limit]
      ),
    3
  );

  if (!rows.length) {
    console.log("No due reminders.");
    return 0;
  }

  let sent = 0;

  for (const r of rows) {
    try {
      await sendWhatsApp(r.to_phone, r.message || "👋 Recordatorio.");
      await withRetry(
        () =>
          pool.query(
            `update public.reminders
             set status = 'sent', sent_at = now()
             where id = $1`,
            [r.id]
          ),
        2
      );
      sent += 1;
    } catch (err) {
      console.error("Failed reminder id:", r.id, err?.message || err);
      try {
        await pool.query(
          `update public.reminders
           set status = 'failed'
           where id = $1`,
          [r.id]
        );
      } catch (_) {}
    }
  }

  console.log(`Sent due reminders: ${sent}/${rows.length}`);
  return sent;
}

// =========================
// 2) Resumen diario (dueños)
// =========================
async function sendDailyOwnerSummaries() {
  const { rows: users } = await withRetry(
    () =>
      pool.query(
        `select id, phone
         from public.users
         where phone is not null and phone <> ''
         order by id asc`
      ),
    3
  );

  if (!users.length) {
    console.log("No users with phone.");
    return 0;
  }

  let sent = 0;

  for (const u of users) {
    try {
      const { rows: debts } = await withRetry(
        () =>
          pool.query(
            `
            select client_name, amount_due, due_text
            from public.debts
            where user_id = $1 and status = 'pending'
            order by created_at desc
            limit 10
            `,
            [u.id]
          ),
        2
      );

      if (!debts.length) continue;

      const top = debts.slice(0, 5);
      const extra = Math.max(0, debts.length - top.length);

      const lines = top.map((d) => {
        const name = d.client_name || "Cliente";
        const amt = fmtMoneyMXN(d.amount_due);
        const since = d.due_text ? ` (desde: ${d.due_text})` : "";
        return `• *${name}*: ${amt}${since}`;
      });

      const msg =
        `📌 *Recordatorio de cobranza (hoy)*\n\n` +
        `Tengo estas deudas pendientes que conviene revisar:\n` +
        `${lines.join("\n")}\n\n` +
        (extra ? `(+${extra} más pendientes)\n\n` : "") +
        `Responde aquí con uno de estos:\n` +
        `• "¿A quién cobro primero?"\n` +
        `• "Manda recordatorio a {Nombre}"\n` +
        `• "¿Quién me debe?"`;

      await sendWhatsApp(u.phone, msg);
      sent += 1;
    } catch (err) {
      console.error("Failed daily summary for user:", u.id, err?.message || err);
      // NO tronamos todo el cron por un usuario
    }
  }

  console.log(`Daily summaries sent: ${sent}/${users.length}`);
  return sent;
}

// =========================
// MAIN (NO truena por fallas temporales)
// =========================
async function main() {
  console.log("Cron start:", new Date().toISOString());

  let r1 = 0,
    r2 = 0;

  try {
    r1 = await sendDueReminders(80);
  } catch (e) {
    console.error("sendDueReminders failed:", e?.message || e);
  }

  try {
    r2 = await sendDailyOwnerSummaries();
  } catch (e) {
    console.error("sendDailyOwnerSummaries failed:", e?.message || e);
  }

  console.log("Cron done.", { dueRemindersSent: r1, dailySummariesSent: r2 });
}

main()
  .catch((err) => {
    console.error("Cron fatal error:", err?.message || err);
    // 👇 no hacemos exit(1); dejamos que termine “verde” si es posible
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch (_) {}
  });
