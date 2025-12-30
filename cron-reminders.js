// cron-reminders.js
// Cron robusto + métricas por logs (FlowSense)
// v-2025-12-29-CRON-METRICS

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
  TWILIO_WHATSAPP_FROM,
} = process.env;

if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");
if (!TWILIO_ACCOUNT_SID) throw new Error("TWILIO_ACCOUNT_SID is not set");
if (!TWILIO_AUTH_TOKEN) throw new Error("TWILIO_AUTH_TOKEN is not set");
if (!TWILIO_WHATSAPP_FROM) throw new Error("TWILIO_WHATSAPP_FROM is not set");

// =========================
// Helpers: logs + metrics
// =========================
function isoNow() {
  return new Date().toISOString();
}
function dayKey() {
  return new Date().toISOString().slice(0, 10);
}
function log(event, data = {}) {
  console.log(`[${event}]`, JSON.stringify({ ts: isoNow(), ...data }));
}
function metric(event, data = {}) {
  console.log(`[METRIC:${event}]`, JSON.stringify({ ts: isoNow(), ...data }));
}

// =========================
// DB Pool
// =========================
const connectionString = DATABASE_URL.includes("sslmode=")
  ? DATABASE_URL
  : DATABASE_URL + (DATABASE_URL.includes("?") ? "&" : "?") + "sslmode=require";

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  },
  max: 2,
  connectionTimeoutMillis: 60000,
  idleTimeoutMillis: 30000,
  keepAlive: true,
  family: 4,
});

pool.on("error", (err) =>
  log("PG_POOL_ERROR", { message: err?.message || String(err) })
);

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
      log("RETRY_FAIL", { attempt: i, message: e?.message || String(e) });
      await sleep(1000 * Math.pow(2, i - 1));
    }
  }
  throw lastErr;
}

function fmtMoneyMXN(n) {
  return Number(n || 0).toLocaleString("es-MX", {
    style: "currency",
    currency: "MXN",
  });
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
  metric("CRON_DUE_REMINDERS_START", { limit });

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

  metric("CRON_DUE_REMINDERS_FOUND", { count: rows.length });

  if (!rows.length) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const r of rows) {
    try {
      await sendWhatsApp(r.to_phone, r.message || "👋 Recordatorio.");
      await withRetry(
        () =>
          pool.query(
            `
            update public.reminders
            set status = 'sent', sent_at = now()
            where id = $1
            `,
            [r.id]
          ),
        2
      );

      sent += 1;
      metric("CRON_REMINDER_SENT", { reminder_id: r.id, user_id: r.user_id });
    } catch (err) {
      failed += 1;
      log("CRON_REMINDER_FAILED", {
        reminder_id: r.id,
        message: err?.message || String(err),
      });

      try {
        await pool.query(
          `
          update public.reminders
          set status = 'failed'
          where id = $1
          `,
          [r.id]
        );
      } catch (_) {}
    }
  }

  metric("CRON_DUE_REMINDERS_DONE", { sent, failed });
  return { sent, failed };
}

// =========================
// 2) Resumen diario (dueños)
// =========================
async function sendDailyOwnerSummaries() {
  metric("CRON_DAILY_SUMMARY_START", {});

  const { rows: users } = await withRetry(
    () =>
      pool.query(
        `
        select id, phone
        from public.users
        where phone is not null and phone <> ''
        order by id asc
        `
      ),
    3
  );

  metric("CRON_USERS_ELIGIBLE", { count: users.length });

  let sent = 0;
  let skipped = 0;

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

      if (!debts.length) {
        skipped += 1;
        metric("CRON_DAILY_SUMMARY_SKIPPED", { user_id: u.id });
        continue;
      }

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
        `Tengo estas deudas pendientes:\n` +
        `${lines.join("\n")}\n\n` +
        (extra ? `(+${extra} más pendientes)\n\n` : "") +
        `Responde aquí con:\n` +
        `• "¿A quién cobro primero?"\n` +
        `• "Manda recordatorio a {Nombre}"\n` +
        `• "¿Quién me debe?"`;

      await sendWhatsApp(u.phone, msg);
      sent += 1;

      metric("CRON_DAILY_SUMMARY_SENT", {
        user_id: u.id,
        debt_count: debts.length,
      });
    } catch (err) {
      log("CRON_DAILY_SUMMARY_FAILED", {
        user_id: u.id,
        message: err?.message || String(err),
      });
    }
  }

  metric("CRON_DAILY_SUMMARY_DONE", { sent, skipped });
  return { sent, skipped };
}

// =========================
// MAIN
// =========================
async function main() {
  const startedAt = Date.now();
  metric("CRON_RUN_START", { day: dayKey() });

  let r1 = { sent: 0, failed: 0 };
  let r2 = { sent: 0, skipped: 0 };

  try {
    r1 = await sendDueReminders(80);
  } catch (e) {
    log("CRON_DUE_REMINDERS_FATAL", { message: e?.message || String(e) });
  }

  try {
    r2 = await sendDailyOwnerSummaries();
  } catch (e) {
    log("CRON_DAILY_SUMMARY_FATAL", { message: e?.message || String(e) });
  }

  metric("CRON_RUN_DONE", {
    ms: Date.now() - startedAt,
    due_sent: r1.sent,
    due_failed: r1.failed,
    summary_sent: r2.sent,
    summary_skipped: r2.skipped,
  });
}

main()
  .catch((err) => {
    log("CRON_FATAL", { message: err?.message || String(err) });
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch (_) {}
  });
