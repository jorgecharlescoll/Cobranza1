// cron-reminders.js
// Render Cron: Resumen diario + Downgrade automático (trial/stripe)
// + Anti-duplicados con tabla notifications (dedupe por user_id + type + dedupe_key)
//
// Requisitos DB:
// - public.notifications con unique(user_id, type, dedupe_key)

require("dotenv").config();

const twilio = require("twilio");
const { Pool } = require("pg");

// =========================
// ENV
// =========================
const DATABASE_URL = process.env.DATABASE_URL;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";

// Si existe, limita el cron solo a estos teléfonos (ideal en test):
// ADMIN_PHONES="whatsapp:+5218332455220,whatsapp:+5218330000000"
const ADMIN_PHONES_RAW = process.env.ADMIN_PHONES || "";
const ADMIN_PHONES = ADMIN_PHONES_RAW
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isoNow() {
  return new Date().toISOString();
}
function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function metric(event, data = {}) {
  console.log(`[METRIC:${event}]`, JSON.stringify({ ts: isoNow(), ...data }));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtMoneyMXN(n) {
  const num = Number(n || 0);
  return num.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

// =========================
// DB Pool (Supabase Transaction Pooler 6543)
// =========================
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(0);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 12_000,
});

// =========================
// DB helpers
// =========================
async function queryWithRetry(text, params = [], tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await pool.query(text, params);
      return r;
    } catch (err) {
      lastErr = err;
      metric("CRON_DB_RETRY", { attempt: i + 1, message: err?.message || "unknown" });
      await sleep(1000 * Math.pow(2, i)); // 1s,2s,4s
    }
  }
  throw lastErr;
}

function buildAdminFilterSql(startIndex = 1) {
  if (!ADMIN_PHONES.length) return { sql: "", params: [], nextIndex: startIndex };
  const placeholders = ADMIN_PHONES.map((_, i) => `$${startIndex + i}`).join(", ");
  return {
    sql: ` AND phone IN (${placeholders}) `,
    params: [...ADMIN_PHONES],
    nextIndex: startIndex + ADMIN_PHONES.length,
  };
}

// =========================
// Notifications (anti-duplicados)
// =========================
async function tryAcquireNotification({ user_id, phone, type, dedupe_key, meta = null }) {
  // Inserta un registro único. Si ya existe: NO envíes.
  // Devuelve true si “ganaste” el lock (se insertó), false si ya existía.
  try {
    const r = await queryWithRetry(
      `
      insert into public.notifications (user_id, phone, type, dedupe_key, meta)
      values ($1, $2, $3, $4, $5)
      on conflict (user_id, type, dedupe_key) do nothing
      returning id
      `,
      [user_id, phone, type, dedupe_key, meta],
      3
    );
    return (r.rows || []).length > 0;
  } catch (err) {
    // Si falla el lock, por seguridad NO mandamos para evitar duplicados
    metric("ERROR", { stage: "notifications_tryAcquire", message: err?.message || "unknown", user_id, type, dedupe_key });
    return false;
  }
}

// =========================
// Twilio
// =========================
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

async function sendWhatsApp(to, body) {
  if (!twilioClient) return false;
  if (!to) return false;
  await twilioClient.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to,
    body,
  });
  return true;
}

// =========================
// 1) Downgrade automático (anti-duplicados)
// =========================
async function downgradeExpiredPro() {
  // A) Trial expirado (plan=pro pero NO stripe, y pro_until ya pasó)
  const af = buildAdminFilterSql(1);
  const qTrial = `
    select id, phone, pro_until
    from users
    where plan = 'pro'
      and (pro_source is null or pro_source <> 'stripe')
      and pro_until is not null
      and pro_until < now()
      ${af.sql}
    limit 200
  `;

  let rTrial = { rows: [] };
  try {
    rTrial = await queryWithRetry(qTrial, af.params, 3);
  } catch (err) {
    metric("ERROR", { stage: "downgrade_trial_select", message: err?.message || "unknown" });
  }

  let trialDowngraded = 0;

  for (const u of rTrial.rows) {
    try {
      // Lock anti-duplicado: un downgrade de trial por día
      const lock = await tryAcquireNotification({
        user_id: u.id,
        phone: u.phone,
        type: "trial_expired_downgrade",
        dedupe_key: dayKey(),
        meta: { pro_until: u.pro_until },
      });

      if (!lock) {
        metric("DEDUP_SKIPPED", { type: "trial_expired_downgrade", user_id: u.id, phone: u.phone });
        continue;
      }

      await queryWithRetry(
        `
        update users
        set plan='free',
            pro_source=null,
            pro_until=null
        where id=$1
        `,
        [u.id],
        3
      );

      trialDowngraded++;
      metric("PRO_DOWNGRADED_TRIAL_EXPIRED", { user_id: u.id, phone: u.phone });

      // Mensaje WhatsApp (best-effort) con su propio dedupe (por día)
      const msgLock = await tryAcquireNotification({
        user_id: u.id,
        phone: u.phone,
        type: "whatsapp_trial_expired",
        dedupe_key: dayKey(),
        meta: null,
      });

      if (msgLock) {
        try {
          await sendWhatsApp(
            u.phone,
            `⏳ Tu prueba de *FlowSense Pro* terminó.\n\n` +
              `Sigues en plan gratis (con límite diario).\n` +
              `Para reactivar Pro: escribe *PAGAR*.`
          );
          metric("WHATSAPP_TRIAL_EXPIRED_SENT", { user_id: u.id, phone: u.phone });
        } catch (err2) {
          metric("ERROR", { stage: "twilio_trial_expired", message: err2?.message || "unknown", user_id: u.id });
        }
      } else {
        metric("DEDUP_SKIPPED", { type: "whatsapp_trial_expired", user_id: u.id, phone: u.phone });
      }
    } catch (err) {
      metric("ERROR", { stage: "downgrade_trial_update", message: err?.message || "unknown", user_id: u.id });
    }
  }

  // B) Stripe no-activo y ya venció periodo/gracia
  const bf = buildAdminFilterSql(1);
  const qStripe = `
    select id, phone, stripe_status, stripe_current_period_end, pro_until
    from users
    where plan='pro'
      and pro_source='stripe'
      and (coalesce(stripe_status,'') not in ('active','trialing'))
      and (pro_until is null or pro_until < now())
      and (stripe_current_period_end is null or stripe_current_period_end < now())
      ${bf.sql}
    limit 200
  `;

  let rStripe = { rows: [] };
  try {
    rStripe = await queryWithRetry(qStripe, bf.params, 3);
  } catch (err) {
    metric("ERROR", { stage: "downgrade_stripe_select", message: err?.message || "unknown" });
  }

  let stripeDowngraded = 0;

  for (const u of rStripe.rows) {
    try {
      // Lock anti-duplicado: un downgrade stripe por día
      const lock = await tryAcquireNotification({
        user_id: u.id,
        phone: u.phone,
        type: "stripe_inactive_downgrade",
        dedupe_key: dayKey(),
        meta: { stripe_status: u.stripe_status, stripe_current_period_end: u.stripe_current_period_end },
      });

      if (!lock) {
        metric("DEDUP_SKIPPED", { type: "stripe_inactive_downgrade", user_id: u.id, phone: u.phone });
        continue;
      }

      await queryWithRetry(
        `
        update users
        set plan='free',
            pro_source=null,
            pro_until=null
        where id=$1
        `,
        [u.id],
        3
      );

      stripeDowngraded++;
      metric("PRO_DOWNGRADED_STRIPE_INACTIVE", {
        user_id: u.id,
        phone: u.phone,
        stripe_status: u.stripe_status || null,
      });

      // Mensaje WhatsApp (best-effort) con dedupe (por día)
      const msgLock = await tryAcquireNotification({
        user_id: u.id,
        phone: u.phone,
        type: "whatsapp_stripe_downgrade",
        dedupe_key: dayKey(),
        meta: null,
      });

      if (msgLock) {
        try {
          await sendWhatsApp(
            u.phone,
            `📌 Tu suscripción *FlowSense Pro* ya no está activa.\n\n` +
              `Te pasé al plan gratis (con límite diario).\n` +
              `Para reactivar Pro: escribe *PAGAR*.`
          );
          metric("WHATSAPP_STRIPE_DOWNGRADE_SENT", { user_id: u.id, phone: u.phone });
        } catch (err2) {
          metric("ERROR", { stage: "twilio_stripe_downgrade", message: err2?.message || "unknown", user_id: u.id });
        }
      } else {
        metric("DEDUP_SKIPPED", { type: "whatsapp_stripe_downgrade", user_id: u.id, phone: u.phone });
      }
    } catch (err) {
      metric("ERROR", { stage: "downgrade_stripe_update", message: err?.message || "unknown", user_id: u.id });
    }
  }

  console.log("Downgrade done.", { trialDowngraded, stripeDowngraded });
  return { trialDowngraded, stripeDowngraded };
}

// =========================
// 2) Resumen diario de deudas (anti-duplicados)
// =========================
async function sendDailySummaries() {
  const f = buildAdminFilterSql(1);

  // Usuarios con onboarding visto
  const qUsers = `
    select id, phone
    from users
    where phone is not null
      and seen_onboarding = true
      ${f.sql}
    limit 500
  `;

  let users = [];
  try {
    const r = await queryWithRetry(qUsers, f.params, 3);
    users = r.rows || [];
  } catch (err) {
    metric("ERROR", { stage: "daily_users_select", message: err?.message || "unknown" });
    return 0;
  }

  let sent = 0;

  for (const u of users) {
    try {
      // Dedupe: 1 resumen diario por usuario por día
      const lock = await tryAcquireNotification({
        user_id: u.id,
        phone: u.phone,
        type: "daily_summary",
        dedupe_key: dayKey(),
        meta: null,
      });

      if (!lock) {
        metric("DEDUP_SKIPPED", { type: "daily_summary", user_id: u.id, phone: u.phone });
        continue;
      }

      // Trae deudas pendientes
      const debtsR = await queryWithRetry(
        `
        select client_name, amount_due, due_text
        from debts
        where user_id = $1
          and status = 'pending'
        order by amount_due desc, created_at desc
        limit 20
        `,
        [u.id],
        2
      );

      const debts = debtsR.rows || [];
      if (!debts.length) {
        // No mandamos nada si no hay deudas; dejamos el lock puesto para no recalcular hoy
        metric("DAILY_SUMMARY_SKIPPED_NO_DEBTS", { user_id: u.id, phone: u.phone });
        continue;
      }

      const top = debts.slice(0, 5);
      const extra = Math.max(0, debts.length - top.length);

      const lines = top.map((d, i) => {
        const name = d.client_name || "Cliente";
        const amt = fmtMoneyMXN(d.amount_due);
        const since = d.due_text ? ` (desde ${d.due_text})` : "";
        return `${i + 1}) ${name}: ${amt}${since}`;
      });

      const msg =
        `📌 *Resumen de cobranza — ${dayKey()}*\n\n` +
        `Pendientes: *${debts.length}*\n\n` +
        lines.join("\n") +
        (extra ? `\n…y ${extra} más.` : "") +
        `\n\nTip: escribe *¿A quién cobro primero?*`;

      await sendWhatsApp(u.phone, msg);
      sent++;
      metric("DAILY_SUMMARY_SENT", { user_id: u.id, phone: u.phone, debt_count: debts.length });

      await sleep(200);
    } catch (err) {
      metric("ERROR", { stage: "daily_send_loop", message: err?.message || "unknown", user_id: u.id });
      continue;
    }
  }

  return sent;
}

// =========================
// MAIN
// =========================
async function main() {
  metric("CRON_START", { admin_only: Boolean(ADMIN_PHONES.length), admin_phones_count: ADMIN_PHONES.length });

  // 1) Downgrade automático
  const d = await downgradeExpiredPro();

  // 2) Resumen diario
  const daily = await sendDailySummaries();

  console.log("Cron done.", { ...d, dailySummariesSent: daily });
}

main()
  .catch((err) => {
    console.error("Cron fatal error:", err?.message || err);
    metric("ERROR", { stage: "cron_fatal", message: err?.message || "unknown" });
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch (_) {}
  });
