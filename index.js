// index.js — FlowSense (Stripe + WhatsApp confirmation + PAGAR local)
// v-2025-12-30-STRIPE-CONFIRM-FIX

require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const Stripe = require("stripe");

const { parseMessage } = require("./ai");
const {
  pool,
  getOrCreateUser,
  updateUser,
  addDebt,
  listPendingDebts,
  markLatestDebtPaid,
  findClientByName,
  upsertClient,
  setClientPhone,
} = require("./db");

const app = express();
const VERSION = "v-2025-12-30-OBSERVABILITY";

// -------------------------
// Admin controls (observability commands)
// -------------------------
const ADMIN_PHONES_RAW = process.env.ADMIN_PHONES || "";
const ADMIN_PHONES = ADMIN_PHONES_RAW
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAdminPhone(waPhone) {
  if (!ADMIN_PHONES.length) return false;
  return ADMIN_PHONES.includes(String(waPhone || "").trim());
}

// -------------------------
// Stripe init
// -------------------------
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY || "";
const STRIPE_PRICE_ANNUAL = process.env.STRIPE_PRICE_ANNUAL || "";
const STRIPE_SUCCESS_URL =
  process.env.STRIPE_SUCCESS_URL || "https://example.com/success";
const STRIPE_CANCEL_URL =
  process.env.STRIPE_CANCEL_URL || "https://example.com/cancel";

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" })
  : null;

function stripeReady() {
  return Boolean(
    stripe &&
      STRIPE_SECRET_KEY &&
      STRIPE_WEBHOOK_SECRET &&
      STRIPE_PRICE_MONTHLY &&
      STRIPE_PRICE_ANNUAL &&
      STRIPE_SUCCESS_URL &&
      STRIPE_CANCEL_URL
  );
}

function pickPriceId(cycle) {
  const c = String(cycle || "").toLowerCase();
  if (c === "anual") return STRIPE_PRICE_ANNUAL;
  return STRIPE_PRICE_MONTHLY;
}

async function createCheckoutSessionForUser(user, cycle) {
  const price = pickPriceId(cycle);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    success_url: STRIPE_SUCCESS_URL,
    cancel_url: STRIPE_CANCEL_URL,
    client_reference_id: String(user.id),
    metadata: {
      phone: user.phone,
      user_id: String(user.id),
      cycle: String(cycle || "mensual"),
    },
    subscription_data: {
      metadata: {
        phone: user.phone,
        user_id: String(user.id),
        cycle: String(cycle || "mensual"),
      },
    },
    allow_promotion_codes: true,
  });

  return session;
}

// -------------------------
// Middlewares (IMPORTANT order)
// -------------------------
app.use("/webhook/stripe", express.raw({ type: "application/json" }));
app.use(express.urlencoded({ extended: false }));

// -------------------------
// Logging + Metrics
// -------------------------
function isoNow() {
  return new Date().toISOString();
}
function dayKey() {
  return new Date().toISOString().slice(0, 10);
}
function makeReqId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function logEvent(event, data = {}) {
  console.log(`[${event}]`, JSON.stringify({ ts: isoNow(), ...data }));
}
function metric(event, data = {}) {
  console.log(
    `[METRIC:${event}]`,
    JSON.stringify({ ts: isoNow(), ...data })
  );
}

//
// =========================
// Minimal DB observability (daily counters)
// Requires tables: daily_user_metrics, daily_event_counters
// =========================
async function bumpDailyUserMetric(day, userId, phone, field, inc = 1) {
  try {
    await pool.query(
      `
      insert into public.daily_user_metrics (day, user_id, phone, messages, billable, unknown)
      values ($1, $2, $3, 0, 0, 0)
      on conflict (day, user_id) do nothing
      `,
      [day, userId, phone]
    );

    const col =
      field === "messages"
        ? "messages"
        : field === "billable"
        ? "billable"
        : "unknown";

    await pool.query(
      `update public.daily_user_metrics set ${col} = ${col} + $1, phone = $2 where day = $3 and user_id = $4`,
      [inc, phone, day, userId]
    );
  } catch (err) {
    console.log(
      "[METRIC:OBS_DB_FAIL]",
      JSON.stringify({
        ts: isoNow(),
        stage: "bumpDailyUserMetric",
        message: err?.message || "unknown",
      })
    );
  }
}

async function bumpDailyEvent(day, eventName, meta = null, inc = 1) {
  try {
    await pool.query(
      `
      insert into public.daily_event_counters (day, event, count, last_ts, last_meta)
      values ($1, $2, $3, now(), $4)
      on conflict (day, event)
      do update set
        count = public.daily_event_counters.count + $3,
        last_ts = now(),
        last_meta = coalesce($4, public.daily_event_counters.last_meta)
      `,
      [day, eventName, inc, meta]
    );
  } catch (err) {
    console.log(
      "[METRIC:OBS_DB_FAIL]",
      JSON.stringify({
        ts: isoNow(),
        stage: "bumpDailyEvent",
        message: err?.message || "unknown",
      })
    );
  }
}

async function getTodayStats(day) {
  const out = {
    day,
    active_users: 0,
    messages: 0,
    billable: 0,
    unknown: 0,
    unknown_rate: 0,
    debts_created: 0,
    reminders_sent: 0,
    pay_links_created: 0,
    stripe_checkout_completed: 0,
    pro_activated: 0,
    errors: 0,
  };

  try {
    const u = await pool.query(
      `
      select
        count(*)::int as active_users,
        coalesce(sum(messages),0)::int as messages,
        coalesce(sum(billable),0)::int as billable,
        coalesce(sum(unknown),0)::int as unknown
      from public.daily_user_metrics
      where day = $1
      `,
      [day]
    );
    if (u.rows?.[0]) {
      out.active_users = u.rows[0].active_users || 0;
      out.messages = u.rows[0].messages || 0;
      out.billable = u.rows[0].billable || 0;
      out.unknown = u.rows[0].unknown || 0;
    }

    const e = await pool.query(
      `select event, count from public.daily_event_counters where day = $1`,
      [day]
    );
    const map = new Map((e.rows || []).map((r) => [r.event, Number(r.count || 0)]));

    out.debts_created = map.get("DEBT_CREATED") || 0;
    out.reminders_sent = map.get("REMINDER_SENT") || 0;
    out.pay_links_created = map.get("PAY_LINK_CREATED") || 0;
    out.stripe_checkout_completed = map.get("STRIPE_CHECKOUT_COMPLETED") || 0;
    out.pro_activated = map.get("PRO_ACTIVATED_FROM_STRIPE") || 0;
    out.errors = map.get("ERROR") || 0;

    out.unknown_rate = out.messages
      ? Math.round((out.unknown / out.messages) * 1000) / 10
      : 0;
  } catch (err) {
    console.log(
      "[METRIC:OBS_DB_FAIL]",
      JSON.stringify({
        ts: isoNow(),
        stage: "getTodayStats",
        message: err?.message || "unknown",
      })
    );
  }

  return out;
}

async function getTopEvents(day, limit = 5) {
  try {
    const r = await pool.query(
      `
      select event, count, last_ts, last_meta
      from public.daily_event_counters
      where day = $1
      order by count desc
      limit $2
      `,
      [day, limit]
    );
    return r.rows || [];
  } catch (err) {
    console.log(
      "[METRIC:OBS_DB_FAIL]",
      JSON.stringify({
        ts: isoNow(),
        stage: "getTopEvents",
        message: err?.message || "unknown",
      })
    );
    return [];
  }
}

function fmtPct(n) {
  return `${Number(n || 0).toFixed(1)}%`;
}

function normalizeText(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}
function normalizePhoneToWhatsApp(raw) {
  if (!raw) return null;
  let s = String(raw).trim();

  if (s.toLowerCase().startsWith("whatsapp:")) {
    const num = s.slice("whatsapp:".length).trim();
    return "whatsapp:" + normalizePhoneToWhatsApp(num).replace("whatsapp:", "");
  }

  s = s.replace(/[()\s-]/g, "");
  const hasPlus = s.startsWith("+");
  s = s.replace(/[^\d+]/g, "");
  if (!s) return null;

  if (!hasPlus) {
    if (s.startsWith("52")) s = "+" + s;
    else if (s.length === 10) s = "+52" + s;
    else s = "+" + s;
  }

  return `whatsapp:${s}`;
}

function isYes(text) {
  const t = normalizeText(text).toLowerCase();
  return ["si", "sí", "simon", "ok", "dale", "enviar", "manda", "confirmo"].includes(t);
}
function isNo(text) {
  const t = normalizeText(text).toLowerCase();
  return ["no", "cancelar", "cancela", "alto", "detener"].includes(t);
}

function looksLikeNewCommand(text) {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  return (
    t.includes("¿") ||
    t.includes("?") ||
    t.includes("quién") ||
    t.includes("quien") ||
    t.includes("cobro") ||
    t.includes("debe") ||
    t.includes("deuda") ||
    t.includes("pag") ||
    t.includes("guarda") ||
    t.includes("telefono") ||
    t.includes("teléfono") ||
    t.includes("recordatorio") ||
    t.includes("manda") ||
    t.includes("ayuda") ||
    t.includes("precio") ||
    t.includes("pro")
  );
}

// -------------------------
// Comercial / Planes
// -------------------------
const LIMITS = { free_daily_actions: 15 };
const TRIAL_DAYS_DEFAULT = 7;

const BILLABLE_INTENTS = new Set([
  "add_debt",
  "list_debts",
  "prioritize",
  "remind",
  "mark_paid",
  "save_phone",
]);

const CTA_TEXT =
  `🚀 *FlowSense Pro*\n` +
  `• Ilimitado\n` +
  `• Resumen diario\n\n` +
  `Responde: *QUIERO PRO* o escribe: *PRECIO*`;

function planText() {
  return (
    `💳 *Planes FlowSense*\n\n` +
    `*Gratis*: hasta ${LIMITS.free_daily_actions} acciones al día.\n` +
    `*Pro*: ilimitado.\n\n` +
    `Para iniciar prueba: *QUIERO PRO*\n` +
    `Para pagar: *PAGAR*`
  );
}

function addDaysISO(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function isPro(user) {
  if (!user) return false;

  const plan = String(user.plan || "").toLowerCase();

  const proUntilOk = (() => {
    if (!user.pro_until) return false;
    try {
      return new Date(user.pro_until).getTime() > Date.now();
    } catch (_) {
      return false;
    }
  })();

  if (plan !== "pro") return proUntilOk;

  const source = String(user.pro_source || "").toLowerCase();
  if (source === "stripe") {
    const status = String(user.stripe_status || "").toLowerCase();

    if (status === "active" || status === "trialing") return true;

    const periodOk = (() => {
      if (!user.stripe_current_period_end) return false;
      try {
        return new Date(user.stripe_current_period_end).getTime() > Date.now();
      } catch (_) {
        return false;
      }
    })();

    if (status === "past_due" || status === "unpaid") return periodOk || proUntilOk;

    if (status === "canceled" || status === "incomplete_expired") return proUntilOk;

    return periodOk || proUntilOk;
  }

  return true;
}

async function ensureDailyCounter(user) {
  const today = dayKey();
  if (user.daily_count_day !== today) {
    const updated = await updateUser(user.phone, {
      daily_count_day: today,
      daily_count: 0,
    });
    return updated || user;
  }
  return user;
}

async function incrementUsage(user, reqId, intent) {
  if (!BILLABLE_INTENTS.has(intent)) return user;
  if (isPro(user)) return user;

  const next = (user.daily_count || 0) + 1;
  const updated = await updateUser(user.phone, { daily_count: next });
  metric("USAGE_INCREMENT", { reqId, user_id: user.id, intent, daily_count: next });
  return updated || { ...user, daily_count: next };
}

function paywallMessage(user) {
  const used = user.daily_count || 0;
  const limit = LIMITS.free_daily_actions;
  return `⚠️ Llegaste al límite gratuito de hoy (${used}/${limit}).\n\n${CTA_TEXT}`;
}

async function enforcePaywallIfNeeded({ user, reqId, intent, twiml }) {
  if (!BILLABLE_INTENTS.has(intent)) return { blocked: false, user };

  const u = await ensureDailyCounter(user);
  if (isPro(u)) return { blocked: false, user: u };

  const limit = LIMITS.free_daily_actions;
  if ((u.daily_count || 0) >= limit) {
    metric("PAYWALL_HIT", { reqId, user_id: u.id, intent, daily_count: u.daily_count, limit });
    twiml.message(paywallMessage(u));
    return { blocked: true, user: u };
  }

  const u2 = await incrementUsage(u, reqId, intent);
  return { blocked: false, user: u2 };
}

// -------------------------
// Recordatorios helpers
// -------------------------
function buildReminderMessage(tone, clientName, debtLine) {
  const name = clientName || "hola";
  const extra = debtLine ? `\n\n${debtLine}` : "";
  if (tone === "firme")
    return `Hola ${name}.\nTe escribo para solicitar el pago pendiente. ¿Me confirmas hoy tu fecha y hora de pago?${extra}`;
  if (tone === "urgente")
    return `Hola ${name}.\nEste es un recordatorio URGENTE del pago pendiente. Necesito confirmación inmediata de cuándo lo vas a cubrir.${extra}`;
  return `Hola ${name} 👋\nTe escribo para recordarte un pago pendiente. ¿Me confirmas cuándo podrás cubrirlo?${extra}`;
}

async function safeResetPending(phone) {
  try {
    await updateUser(phone, { pending_action: null, pending_payload: null });
  } catch (_) {}
}

// -------------------------
// Router local (incluye PAGAR)
// -------------------------
function localParseSavePhone(body) {
  const t = normalizeText(body);
  const re = /^guarda(?:\s+el)?\s+tel(?:e|é)fono\s+de\s+(.+?)\s+(\+?\d[\d()\s-]{7,}\d)\s*$/i;
  const m = t.match(re);
  if (!m) return null;
  const clientName = normalizeText(m[1]).replace(/[:\-]+$/, "").trim();
  const phone = m[2];
  if (!clientName || !phone) return null;
  return { intent: "save_phone", client_name: clientName, phone };
}

function localParseMarkPaid(body) {
  const t = normalizeText(body).toLowerCase();
  let m = t.match(/^ya\s+pag[oó]\s+(.+)\s*$/i);
  if (m) return { intent: "mark_paid", client_name: normalizeText(m[1]) };
  m = t.match(/^(.+)\s+ya\s+pag[oó]\s*$/i);
  if (m) return { intent: "mark_paid", client_name: normalizeText(m[1]) };
  return null;
}

function localParseListDebts(body) {
  const t = normalizeText(body).toLowerCase();
  if (
    t === "quien me debe" ||
    t === "quién me debe" ||
    t.includes("quien me debe") ||
    t.includes("quién me debe")
  ) {
    return { intent: "list_debts" };
  }
  return null;
}

function localParsePrioritize(body) {
  const t = normalizeText(body).toLowerCase().replace(/[¿?]/g, "");
  if (t.includes("a quien cobro primero") || t.includes("a quién cobro primero"))
    return { intent: "prioritize" };
  return null;
}

function localParseRemind(body) {
  const t = normalizeText(body);
  const re = /^(manda|envia|envía)\s+recordatorio\s+a\s+(.+)\s*$/i;
  const m = t.match(re);
  if (!m) return null;
  const clientName = normalizeText(m[2]);
  if (!clientName) return null;
  return { intent: "remind", client_name: clientName };
}

function localParseHelp(body) {
  const t = normalizeText(body).toLowerCase();
  if (t === "ayuda" || t === "help" || t === "menu" || t === "menú")
    return { intent: "help" };
  return null;
}

function localParsePrice(body) {
  const t = normalizeText(body).toLowerCase();
  if (
    t === "precio" ||
    t === "precios" ||
    t.includes("cuanto cuesta") ||
    t.includes("cuánto cuesta")
  )
    return { intent: "pricing" };
  return null;
}

function localParseWantPro(body) {
  const t = normalizeText(body).toLowerCase();
  if (
    t === "quiero pro" ||
    t === "pro" ||
    t.includes("activar pro") ||
    t.includes("suscrib")
  )
    return { intent: "want_pro" };
  return null;
}

function localParsePay(body) {
  const t = normalizeText(body).toLowerCase();
  if (
    t === "pagar" ||
    t === "pago" ||
    t === "pagar pro" ||
    t.includes("link de pago")
  )
    return { intent: "pay" };
  return null;
}

function localRouter(body) {
  return (
    localParseSavePhone(body) ||
    localParseMarkPaid(body) ||
    localParseListDebts(body) ||
    localParsePrioritize(body) ||
    localParseRemind(body) ||
    localParseHelp(body) ||
    localParsePrice(body) ||
    localParseWantPro(body) ||
    localParsePay(body) ||
    null
  );
}

// -------------------------
// Routes (health + stripe success/cancel)
// -------------------------
app.get("/health", (_, res) => res.send(`ok ${VERSION}`));
app.get("/stripe/success", (_, res) =>
  res.status(200).send("Pago recibido. Ya puedes volver a WhatsApp.")
);
app.get("/stripe/cancel", (_, res) =>
  res.status(200).send("Pago cancelado. Puedes volver a WhatsApp y escribir PAGAR cuando gustes.")
);

// -------------------------
// Stripe Webhook (Idempotencia segura)
// -------------------------
async function acquireStripeEventLock(event) {
  try {
    const r = await pool.query(
      `
      insert into public.stripe_events (event_id, type, meta)
      values ($1, $2, $3)
      on conflict (event_id) do nothing
      returning event_id
      `,
      [
        event.id,
        event.type,
        { created: event.created || null, livemode: event.livemode || null },
      ]
    );
    return (r.rows || []).length > 0;
  } catch (err) {
    console.error("❌ acquireStripeEventLock error:", err?.message);
    return false;
  }
}

async function markStripeEventProcessed(eventId) {
  try {
    await pool.query(
      `update public.stripe_events set processed_at = now() where event_id = $1`,
      [eventId]
    );
  } catch (_) {}
}

async function releaseStripeEventLockIfUnprocessed(eventId) {
  try {
    await pool.query(
      `delete from public.stripe_events where event_id = $1 and processed_at is null`,
      [eventId]
    );
  } catch (_) {}
}

app.post("/webhook/stripe", async (req, res) => {
  if (!stripeReady()) return res.status(500).send("Stripe not configured");

  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Stripe webhook signature failed:", err?.message);
    return res.status(400).send(`Webhook Error: ${err?.message}`);
  }

  const isNewEvent = await acquireStripeEventLock(event);
  if (!isNewEvent) {
    console.log("⚠️ Stripe duplicate event ignored:", event.id, event.type);
    return res.json({ received: true, deduped: true });
  }

  const phoneFromSubscription = (sub) => {
    const p = sub?.metadata?.phone || sub?.metadata?.whatsapp || null;
    return p ? String(p) : null;
  };

  const isoFromUnix = (unix) => {
    if (!unix) return null;
    try {
      return new Date(Number(unix) * 1000).toISOString();
    } catch (_) {
      return null;
    }
  };

  const sendWhatsApp = async (to, text) => {
    if (!to || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return false;
    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const fromWa = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";
    await twilioClient.messages.create({ from: fromWa, to, body: text });
    return true;
  };

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const phone = session?.metadata?.phone;
      const userId = session?.metadata?.user_id || null;
      const cycle = session?.metadata?.cycle || "mensual";
      const customerId = session.customer || null;
      const subscriptionId = session.subscription || null;

      metric("STRIPE_CHECKOUT_COMPLETED", {
        user_id: userId,
        phone,
        cycle,
        customerId,
        subscriptionId,
      });
      await bumpDailyEvent(dayKey(), "STRIPE_CHECKOUT_COMPLETED", { event_id: event.id }, 1);

      let sub = null;
      if (subscriptionId) {
        try {
          await stripe.subscriptions.update(subscriptionId, {
            metadata: {
              phone: String(phone || ""),
              user_id: String(userId || ""),
              cycle: String(cycle || "mensual"),
            },
          });
          sub = await stripe.subscriptions.retrieve(subscriptionId);
        } catch (err) {
          console.error("❌ Stripe subscription metadata/update error:", err?.message || err);
          metric("ERROR", { stage: "stripe_sub_update", message: err?.message || "unknown", subscriptionId });
        }
      }

      const stripeStatus = sub?.status || "active";
      const periodEnd = isoFromUnix(sub?.current_period_end) || null;

      if (phone) {
        const current = await getOrCreateUser(phone);
        const alreadyPaid =
          String(current?.pro_lead_status || "").toLowerCase() === "paid" &&
          String(current?.pro_source || "").toLowerCase() === "stripe" &&
          String(current?.stripe_subscription_id || "") === String(subscriptionId || "");

        if (!alreadyPaid) {
          await updateUser(phone, {
            plan: "pro",
            pro_source: "stripe",
            pro_until: null,
            pro_started_at: isoNow(),
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            stripe_status: stripeStatus,
            stripe_current_period_end: periodEnd,
            pro_lead_status: "paid",
          });

          metric("PRO_ACTIVATED_FROM_STRIPE", { phone, user_id: userId, cycle, stripe_status: stripeStatus });
          await bumpDailyEvent(dayKey(), "PRO_ACTIVATED_FROM_STRIPE", { event_id: event.id }, 1);

          try {
            const msg =
              `✅ *Pago confirmado*\n\n` +
              `Tu suscripción *FlowSense Pro* ya está activa.\n` +
              `Plan: *${cycle}*\n\n` +
              `Ya puedes usar FlowSense sin límites.`;
            await sendWhatsApp(phone, msg);
            metric("WHATSAPP_PURCHASE_CONFIRM_SENT", { phone, user_id: userId, cycle });
          } catch (err) {
            console.error("❌ Twilio confirm send error:", err);
            metric("ERROR", { stage: "twilio_purchase_confirm", message: err?.message || "unknown", phone });
          }
        } else {
          metric("STRIPE_EVENT_SKIPPED_ALREADY_PAID", { phone, user_id: userId, cycle, event_id: event.id });
        }
      } else {
        metric("STRIPE_CHECKOUT_NO_PHONE", { user_id: userId, subscriptionId, event_id: event.id });
      }
    }

    await markStripeEventProcessed(event.id);
    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Stripe webhook handler error:", err);
    metric("ERROR", { stage: "stripe_webhook", message: err?.message || "unknown" });
    await bumpDailyEvent(dayKey(), "ERROR", { event_id: event.id, stage: "stripe_webhook" }, 1);

    await releaseStripeEventLockIfUnprocessed(event.id);
    return res.status(500).send("Webhook handler failed");
  }
});

// -------------------------
// WhatsApp Webhook
// -------------------------
app.post("/webhook/whatsapp", async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twimlResp = new MessagingResponse();

  const from = req.body.From;
  const body = String(req.body.Body || "").trim();

  const reqId = makeReqId();
  const startedAt = Date.now();

  logEvent("INCOMING", { reqId, from, body });

  try {
    const phone = from;
    let user = await getOrCreateUser(phone);

    // DB observability: count every incoming message
    await bumpDailyUserMetric(dayKey(), user.id, phone, "messages", 1);
    await bumpDailyEvent(dayKey(), "INCOMING", { reqId }, 1);

    metric("USER_ACTIVE", { reqId, day: dayKey(), user_id: user.id, phone });

    // =========================
    // ADMIN commands (STATS / LOGS HOY)
    // =========================
    const adminBody = normalizeText(body).toUpperCase();
    if (isAdminPhone(phone) && (adminBody === "STATS" || adminBody === "LOGS HOY")) {
      const day = dayKey();
      await bumpDailyEvent(day, "ADMIN_CMD", { cmd: adminBody }, 1);

      if (adminBody === "STATS") {
        const s = await getTodayStats(day);
        twimlResp.message(
          `📊 *FlowSense — STATS (${s.day})*\n\n` +
            `Usuarios activos: *${s.active_users}*\n` +
            `Mensajes: *${s.messages}*\n` +
            `Acciones billables: *${s.billable}*\n` +
            `Unknown intents: *${s.unknown}* (${fmtPct(s.unknown_rate)})\n\n` +
            `Deudas creadas: *${s.debts_created}*\n` +
            `Recordatorios enviados: *${s.reminders_sent}*\n\n` +
            `Links de pago: *${s.pay_links_created}*\n` +
            `Stripe checkout: *${s.stripe_checkout_completed}*\n` +
            `Pro activado: *${s.pro_activated}*\n\n` +
            `Errores: *${s.errors}*`
        );
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }

      const top = await getTopEvents(day, 5);
      if (!top.length) {
        twimlResp.message(`📋 *LOGS HOY (${day})*\n\nNo hay eventos registrados aún.`);
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }

      const lines = top.map((x, i) => `${i + 1}) ${x.event}: ${x.count}`).join("\n");
      const lastErr = top.find((x) => x.event === "ERROR");
      const extra = lastErr?.last_meta
        ? `\n\nÚltimo ERROR: ${JSON.stringify(lastErr.last_meta).slice(0, 500)}`
        : "";
      twimlResp.message(`📋 *LOGS HOY (${day})*\n\n${lines}${extra}`);
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    if (!user.seen_onboarding) {
      await updateUser(phone, { seen_onboarding: true });
      twimlResp.message(
        `👋 Soy FlowSense.\n\n` +
          `Prueba:\n` +
          `• "Pepe me debe 9500 desde agosto"\n` +
          `• "¿Quién me debe?"\n` +
          `• "¿A quién cobro primero?"\n` +
          `• "Guarda teléfono de Pepe +52..."\n` +
          `• "Manda recordatorio a Pepe"\n\n` +
          `Tip: escribe *PRECIO*, *QUIERO PRO* o *PAGAR*.`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    if (isNo(body)) {
      await safeResetPending(phone);
      twimlResp.message("Cancelado ✅");
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // Intent parse (hard-guard PAGAR -> local -> OpenAI)
    let parsed = null;
    if (normalizeText(body).toLowerCase() === "pagar") {
      parsed = { intent: "pay" };
      metric("INTENT", { reqId, user_id: user.id, intent: "pay", source: "hard_guard" });
    } else {
      parsed = localRouter(body);
      if (parsed) metric("INTENT", { reqId, user_id: user.id, intent: parsed.intent, source: "local_router" });
      else {
        parsed = await parseMessage(body);
        metric("INTENT", { reqId, user_id: user.id, intent: parsed.intent || "unknown", source: "openai" });
      }
    }

    // DB observability: billable / unknown counters
    const _intent = parsed.intent || "unknown";
    if (_intent === "unknown") {
      await bumpDailyUserMetric(dayKey(), user.id, phone, "unknown", 1);
      await bumpDailyEvent(dayKey(), "INTENT_UNKNOWN", { reqId, body }, 1);
    }
    if (BILLABLE_INTENTS.has(_intent)) {
      await bumpDailyUserMetric(dayKey(), user.id, phone, "billable", 1);
    }
    await bumpDailyEvent(dayKey(), `INTENT_${String(_intent).toUpperCase()}`, { reqId }, 1);

    // Pricing / Want Pro / Pay
    if (parsed.intent === "pricing") {
      twimlResp.message(planText());
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    if (parsed.intent === "want_pro") {
      await updateUser(phone, { pending_action: "pro_ask_name", pending_payload: { started_at: isoNow() } });
      metric("PRO_INTEREST", { reqId, user_id: user.id });

      twimlResp.message(
        `Perfecto. Para activar tu prueba *Pro* (${TRIAL_DAYS_DEFAULT} días), dime:\n\n` +
          `¿Cómo te llamas o cómo se llama tu negocio?\n` +
          `(Ej: "Tienda Pepe")`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    if (parsed.intent === "pay") {
      if (!stripeReady()) {
        metric("PAY_NOT_CONFIGURED", { reqId, user_id: user.id });
        twimlResp.message(
          "⚠️ Pagos no configurados todavía. Revisa variables STRIPE_* en Render (Web Service)."
        );
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }

      const cycle = user.pro_lead_cycle || "mensual";
      const session = await createCheckoutSessionForUser(user, cycle);

      await updateUser(phone, { pro_lead_status: "payment_link_sent" });
      metric("PAY_LINK_CREATED", { reqId, user_id: user.id, cycle });
      await bumpDailyEvent(dayKey(), "PAY_LINK_CREATED", { reqId, user_id: user.id }, 1);

      twimlResp.message(
        `💳 Listo. Aquí está tu link de pago (*${cycle}*):\n\n` +
          `${session.url}\n\n` +
          `Cuando se complete, yo te activo Pro automáticamente ✅`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // Paywall for billable intents
    const gate = await enforcePaywallIfNeeded({ user, reqId, intent: parsed.intent, twiml: twimlResp });
    user = gate.user;
    if (gate.blocked) {
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // SAVE PHONE
    if (parsed.intent === "save_phone") {
      const clientName = parsed.client_name;
      const normalized = normalizePhoneToWhatsApp(parsed.phone);

      if (!clientName || !normalized) {
        twimlResp.message(`Ejemplo:\n"Guarda teléfono de Pepe +5218331112222"`);
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }

      await upsertClient(user.id, clientName);
      await setClientPhone(user.id, clientName, normalized);

      metric("PHONE_SAVED", { reqId, user_id: user.id, client: clientName });
      twimlResp.message(
        `✅ Guardado.\n• Cliente: ${clientName}\n• Tel: ${normalized.replace("whatsapp:", "")}`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // LIST DEBTS
    if (parsed.intent === "list_debts") {
      const debts = await listPendingDebts(user.id);
      metric("DEBTS_LISTED", { reqId, user_id: user.id, count: debts.length });

      if (!debts.length) {
        twimlResp.message("✅ No tienes deudas registradas por cobrar.");
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }

      const lines = debts.map((d, i) => {
        const amt = Number(d.amount_due || 0).toLocaleString("es-MX", {
          style: "currency",
          currency: "MXN",
        });
        const since = d.due_text ? ` (desde ${d.due_text})` : "";
        return `${i + 1}) ${d.client_name}: ${amt}${since}`;
      });

      twimlResp.message("📌 Te deben:\n" + lines.join("\n"));
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // ADD DEBT
    if (parsed.intent === "add_debt") {
      const clientName = parsed.client_name || "Cliente";
      const amount = parsed.amount_due;

      if (!amount) {
        twimlResp.message(
          `No pude identificar el monto. Ejemplo: "Pepe me debe 9500 desde agosto"`
        );
        metric("DEBT_AMOUNT_MISSING", { reqId, user_id: user.id, client: clientName });
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }

      const since = parsed.since_text || null;
      await upsertClient(user.id, clientName);
      const debt = await addDebt(user.id, clientName, amount, since);

      metric("DEBT_CREATED", { reqId, user_id: user.id, client: clientName, amount_due: Number(amount) });
      await bumpDailyEvent(dayKey(), "DEBT_CREATED", { reqId, user_id: user.id }, 1);

      const amt = Number(debt.amount_due).toLocaleString("es-MX", {
        style: "currency",
        currency: "MXN",
      });
      twimlResp.message(
        `Registrado ✅\n• Cliente: ${debt.client_name}\n• Monto: ${amt}\n` +
          (debt.due_text ? `• Desde: ${debt.due_text}\n` : "") +
          `\n${CTA_TEXT}`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // HELP
    if (parsed.intent === "help") {
      twimlResp.message(
        `Así te ayudo:\n` +
          `• "Pepe me debe 9500 desde agosto"\n` +
          `• "¿Quién me debe?"\n` +
          `• "¿A quién cobro primero?"\n` +
          `• "Guarda teléfono de Pepe +52..."\n` +
          `• "Manda recordatorio a Pepe"\n` +
          `• "PRECIO" / "QUIERO PRO"\n` +
          `• "PAGAR"`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // fallback
    twimlResp.message(
      `Te leo. Prueba:\n• "Pepe me debe 9500 desde agosto"\n• "¿Quién me debe?"\n• "PRECIO" / "PAGAR"`
    );
    metric("FALLBACK_DEFAULT", { reqId, user_id: user.id });
    metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
    return res.type("text/xml").send(twimlResp.toString());
  } catch (err) {
    console.error("❌ Webhook error:", err);
    metric("ERROR", { stage: "webhook_catch", message: err?.message || "unknown" });
    await bumpDailyEvent(dayKey(), "ERROR", { reqId, stage: "webhook_catch" }, 1);
    twimlResp.message("⚠️ Hubo un problema temporal. Intenta de nuevo en un momento.");
    metric("RESPONSE_SENT", { ms: Date.now() - startedAt });
    return res.type("text/xml").send(twimlResp.toString());
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000, "—", VERSION);
});
