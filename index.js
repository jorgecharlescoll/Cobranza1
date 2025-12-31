// index.js — FlowSense (WhatsApp-first cobranza) + Stripe + Paywall + Observability + Support Tickets
// v-2025-12-30-COPYS-UX-SUPPORT

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
const VERSION = "v-2025-12-30-COPYS-UX-SUPPORT";

// -------------------------
// Admin controls
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
  console.log(`[METRIC:${event}]`, JSON.stringify({ ts: isoNow(), ...data }));
}

// -------------------------
// Copy blocks (UX commercial)
// -------------------------
const COPY = {
  onboarding:
    `👋 Hola, soy *FlowSense*.\n\n` +
    `Te ayudo a cobrar mejor por WhatsApp:\n` +
    `• Registrar deudas\n` +
    `• Saber quién te debe\n` +
    `• Priorizar a quién cobrar\n` +
    `• Enviar recordatorios\n\n` +
    `Prueba escribiendo:\n` +
    `• "Pepe me debe 9500 desde agosto"\n` +
    `• "¿Quién me debe?"\n` +
    `• "¿A quién cobro primero?"\n` +
    `• "Guarda teléfono de Pepe +52..."\n` +
    `• "Manda recordatorio a Pepe"\n\n` +
    `Comandos útiles:\n` +
    `• AYUDA\n` +
    `• PRECIO\n` +
    `• PAGAR\n` +
    `• REPORTAR`,

  help:
    `🤖 *Así puedo ayudarte:*\n\n` +
    `Cobranza:\n` +
    `• "Pepe me debe 9500 desde agosto"\n` +
    `• "¿Quién me debe?"\n` +
    `• "¿A quién cobro primero?"\n` +
    `• "Manda recordatorio a Pepe"\n` +
    `• "Guarda teléfono de Pepe +52..."\n\n` +
    `Planes:\n` +
    `• PRECIO → ver planes\n` +
    `• QUIERO PRO → prueba gratis\n` +
    `• PAGAR → activar Pro\n\n` +
    `Soporte:\n` +
    `• REPORTAR → enviar un problema\n\n` +
    `Escribe tal cual, yo me encargo del resto 😉`,

  pricing:
    `💳 *Planes FlowSense*\n\n` +
    `🆓 *Gratis*\n` +
    `• Hasta 15 acciones al día\n` +
    `• Ideal para uso ocasional\n\n` +
    `🚀 *Pro*\n` +
    `• Acciones ilimitadas\n` +
    `• Resumen diario automático\n` +
    `• Ideal si cobras todos los días\n\n` +
    `👉 Escribe *QUIERO PRO* para probar gratis\n` +
    `👉 Escribe *PAGAR* para activar Pro`,

  wantProAskName:
    `🚀 ¡Excelente decisión!\n\n` +
    `Te activaré *FlowSense Pro* con una prueba gratis.\n` +
    `Antes dime:\n\n` +
    `👉 ¿Cómo te llamas o cómo se llama tu negocio?\n` +
    `(Ejemplo: "Tienda Pepe")`,

  proTrialActivated: (days, proUntilISO) =>
    `✅ *FlowSense Pro activado*\n\n` +
    `Tienes acceso completo durante tu prueba:\n` +
    `• Acciones ilimitadas\n` +
    `• Recordatorios sin límite\n` +
    `• Resumen diario\n\n` +
    `Tu prueba vence: ${String(proUntilISO || "").slice(0, 10)}\n\n` +
    `Cuando quieras continuar:\n👉 Escribe *PAGAR*`,

  lowActionsWarning:
    `ℹ️ Aviso rápido\n\n` +
    `Te quedan *3 acciones gratis* hoy.\n` +
    `Si usas FlowSense a diario, Pro te evita límites.\n\n` +
    `👉 Escribe *PRECIO* o *QUIERO PRO*`,

  paywallHit:
    `⚠️ Límite alcanzado por hoy\n\n` +
    `Usaste tus acciones gratis.\n` +
    `Con *FlowSense Pro* puedes seguir sin límites.\n\n` +
    `👉 Escribe *PAGAR* para activar Pro\n` +
    `👉 O *PRECIO* para ver planes`,

  payLink: (link) =>
    `💳 *Activar FlowSense Pro*\n\n` +
    `Aquí tienes tu link de pago seguro:\n👇\n` +
    `${link}\n\n` +
    `En cuanto se confirme el pago, yo te activo Pro automáticamente ✅`,

  payConfirmed:
    `✅ *Pago confirmado*\n\n` +
    `Tu suscripción *FlowSense Pro* ya está activa.\n` +
    `Ahora puedes usar FlowSense sin límites.\n\n` +
    `¡Gracias por confiar! 🚀`,

  payFailed:
    `⚠️ Pago no realizado\n\n` +
    `No se pudo procesar tu pago.\n` +
    `Para evitar interrupciones en Pro, actualiza tu método de pago.\n\n` +
    `👉 Escribe *PAGAR* para intentarlo de nuevo`,

  proEnded:
    `ℹ️ Tu suscripción Pro terminó\n\n` +
    `Ahora sigues usando *FlowSense Gratis* con límite diario.\n` +
    `Cuando quieras volver a Pro:\n\n` +
    `👉 Escribe *PAGAR*`,

  supportAsk:
    `🛠️ *Soporte FlowSense*\n\n` +
    `Cuéntame qué pasó (en una sola frase si puedes).\n` +
    `Ejemplo: "No detecta 'Guarda teléfono'"\n\n` +
    `Escribe tu reporte ahora, o "cancelar".`,

  supportThanks:
    `✅ Gracias. Ya registré tu reporte.\n` +
    `Lo revisaré y te aviso aquí mismo. 🙌`,
};

// -------------------------
// Minimal DB observability (optional tables)
// -------------------------
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
      field === "messages" ? "messages" : field === "billable" ? "billable" : "unknown";

    await pool.query(
      `update public.daily_user_metrics set ${col} = ${col} + $1, phone = $2 where day = $3 and user_id = $4`,
      [inc, phone, day, userId]
    );
  } catch (err) {
    metric("OBS_DB_FAIL", { stage: "bumpDailyUserMetric", message: err?.message || "unknown" });
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
    metric("OBS_DB_FAIL", { stage: "bumpDailyEvent", message: err?.message || "unknown" });
  }
}

// -------------------------
// Support tickets
// -------------------------
async function createSupportTicket({ userId, phone, message, lastIntent }) {
  await pool.query(
    `
    insert into public.support_tickets (user_id, phone, message, last_intent, status)
    values ($1, $2, $3, $4, 'open')
    `,
    [userId, phone, message, lastIntent || null]
  );
}

async function getTicketsToday(limit = 10) {
  const today = dayKey();
  const r = await pool.query(
    `
    select id, created_at, phone, message, status
    from public.support_tickets
    where created_at::date = $1::date
    order by created_at desc
    limit $2
    `,
    [today, limit]
  );
  return r.rows || [];
}

async function getTicketsOpen(limit = 10) {
  const r = await pool.query(
    `
    select id, created_at, phone, message, status
    from public.support_tickets
    where status = 'open'
    order by created_at desc
    limit $1
    `,
    [limit]
  );
  return r.rows || [];
}

// -------------------------
// Utils
// -------------------------
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
  return ["si", "sí", "simon", "ok", "dale", "enviar", "manda", "confirmo", "confirmar"].includes(t);
}
function isNo(text) {
  const t = normalizeText(text).toLowerCase();
  return ["no", "cancelar", "cancela", "alto", "detener"].includes(t);
}

function looksLikeNewCommand(text) {
  const t = normalizeText(text).toLowerCase();
  if (t.length < 2) return false;
  if (t === "ayuda" || t === "help") return true;
  if (t === "precio" || t === "precios") return true;
  if (t === "pagar" || t === "pago") return true;
  if (t === "reportar" || t.startsWith("reportar ")) return true;
  if (t.includes("me debe") || t.includes("me deben") || t.includes("quedó a deber")) return true;
  if (t.includes("quien me debe") || t.includes("quién me debe")) return true;
  if (t.includes("a quien cobro primero") || t.includes("a quién cobro primero")) return true;
  if (t.includes("manda recordatorio") || t.includes("envia recordatorio") || t.includes("envía recordatorio")) return true;
  if (t.includes("guarda teléfono") || t.includes("guarda telefono")) return true;
  if (t.includes("ya pagó") || t.includes("ya pago")) return true;
  return false;
}

function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}

// Simple estimator for prioritize
function estimateDays(dueText) {
  if (!dueText) return 0;
  const t = String(dueText).toLowerCase();
  if (t.includes("hoy")) return 0;
  if (t.includes("ayer")) return 1;
  if (t.includes("semana")) {
    const m = t.match(/(\d+)\s*seman/);
    return m ? Number(m[1]) * 7 : 7;
  }
  if (t.includes("mes")) {
    const m = t.match(/(\d+)\s*mes/);
    return m ? Number(m[1]) * 30 : 30;
  }
  if (t.includes("año") || t.includes("ano")) {
    const m = t.match(/(\d+)\s*a[nñ]o/);
    return m ? Number(m[1]) * 365 : 365;
  }
  const months = [
    ["enero", 30 * 11],
    ["febrero", 30 * 10],
    ["marzo", 30 * 9],
    ["abril", 30 * 8],
    ["mayo", 30 * 7],
    ["junio", 30 * 6],
    ["julio", 30 * 5],
    ["agosto", 30 * 4],
    ["septiembre", 30 * 3],
    ["setiembre", 30 * 3],
    ["octubre", 30 * 2],
    ["noviembre", 30 * 1],
    ["diciembre", 30 * 0],
  ];
  for (const [name, days] of months) {
    if (t.includes(name)) return days || 15;
  }
  if (t.match(/\d{1,2}\s*de\s*[a-záéíóú]+/i)) return 60;
  return 30;
}

// Reminder copy (kept)
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
// Paywall + Pro logic
// -------------------------
const LIMITS = { free_daily_actions: 15 };
const TRIAL_DAYS_DEFAULT = Number(process.env.TRIAL_DAYS || 7);

const BILLABLE_INTENTS = new Set([
  "add_debt",
  "save_phone",
  "prioritize",
  "remind",
  "mark_paid",
]);

function isPro(user) {
  const plan = String(user.plan || "").toLowerCase();
  const proUntilOk = user.pro_until ? new Date(user.pro_until).getTime() > Date.now() : false;

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

async function enforcePaywallIfNeeded({ user, reqId, intent, twiml }) {
  if (!BILLABLE_INTENTS.has(intent)) return { blocked: false, user, lowActionsWarning: false };

  const u = await ensureDailyCounter(user);
  if (isPro(u)) return { blocked: false, user: u, lowActionsWarning: false };

  const limit = LIMITS.free_daily_actions;
  if ((u.daily_count || 0) >= limit) {
    metric("PAYWALL_HIT", { reqId, user_id: u.id, intent, daily_count: u.daily_count, limit });
    twiml.message(COPY.paywallHit);
    return { blocked: true, user: u, lowActionsWarning: false };
  }

  const u2 = await incrementUsage(u, reqId, intent);
  const remaining = limit - (u2.daily_count || 0);
  const lowActionsWarning = remaining === 3;

  return { blocked: false, user: u2, lowActionsWarning };
}

function respond(twiml, text, { appendLowActions } = {}) {
  if (appendLowActions) return twiml.message(`${text}\n\n${COPY.lowActionsWarning}`);
  return twiml.message(text);
}

// -------------------------
// Local router (hard commands + regex)
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
  if (t.includes("quien me debe") || t.includes("quién me debe")) {
    return { intent: "list_debts" };
  }
  return null;
}

function localParsePrioritize(body) {
  const t = normalizeText(body).toLowerCase().replace(/[¿?]/g, "");
  if (t.includes("a quien cobro primero") || t.includes("a quién cobro primero")) return { intent: "prioritize" };
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
  if (t === "ayuda" || t === "help" || t === "menu" || t === "menú") return { intent: "help" };
  return null;
}

function localParsePrice(body) {
  const t = normalizeText(body).toLowerCase();
  if (t === "precio" || t === "precios" || t.includes("cuanto cuesta") || t.includes("cuánto cuesta")) return { intent: "pricing" };
  return null;
}

function localParseWantPro(body) {
  const t = normalizeText(body).toLowerCase();
  if (t === "quiero pro" || t === "pro" || t.includes("activar pro") || t.includes("suscrib")) return { intent: "want_pro" };
  return null;
}

function localParsePay(body) {
  const t = normalizeText(body).toLowerCase();
  if (t === "pagar" || t === "pago" || t.includes("link de pago")) return { intent: "pay" };
  return null;
}

function localParseReport(body) {
  const t = normalizeText(body).toLowerCase();
  if (t === "reportar" || t === "reporte" || t === "soporte") return { intent: "support_start" };
  if (t.startsWith("reportar ")) return { intent: "support_inline", message: normalizeText(body).slice(8).trim() };
  return null;
}

function localParseAdminTickets(body) {
  const t = normalizeText(body).toLowerCase();
  if (t === "tickets hoy") return { intent: "admin_tickets_today" };
  if (t === "tickets abiertos") return { intent: "admin_tickets_open" };
  return null;
}

function localRouter(body) {
  return (
    localParseAdminTickets(body) ||
    localParseReport(body) ||
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
app.get("/stripe/success", (_, res) => res.status(200).send("Pago recibido. Ya puedes volver a WhatsApp."));
app.get("/stripe/cancel", (_, res) => res.status(200).send("Pago cancelado. Puedes volver a WhatsApp y escribir PAGAR cuando gustes."));

// -------------------------
// Stripe Webhook (idempotente)
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
        {
          created: event.created || null,
          livemode: event.livemode || null,
        },
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
    await pool.query(`update public.stripe_events set processed_at = now() where event_id = $1`, [eventId]);
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

      metric("STRIPE_CHECKOUT_COMPLETED", { user_id: userId, phone, cycle, customerId, subscriptionId });

      let sub = null;
      if (subscriptionId) {
        try {
          await stripe.subscriptions.update(subscriptionId, {
            metadata: { phone: String(phone || ""), user_id: String(userId || ""), cycle: String(cycle || "mensual") },
          });
          sub = await stripe.subscriptions.retrieve(subscriptionId);
        } catch (e) {
          console.error("Stripe sub update/retrieve failed:", e?.message);
        }
      }

      const stripeStatus = String(sub?.status || "active");
      const periodEndISO = isoFromUnix(sub?.current_period_end) || null;

      if (phone) {
        await updateUser(phone, {
          plan: "pro",
          pro_source: "stripe",
          pro_until: null,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          stripe_status: stripeStatus,
          stripe_current_period_end: periodEndISO,
        });

        metric("PRO_ACTIVATED_FROM_STRIPE", { phone, user_id: userId, cycle });
        await sendWhatsApp(phone, COPY.payConfirmed);
      }

      await markStripeEventProcessed(event.id);
      return res.json({ received: true });
    }

    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      const subscriptionId = invoice.subscription || null;

      let sub = null;
      if (subscriptionId) {
        try {
          sub = await stripe.subscriptions.retrieve(subscriptionId);
        } catch (e) {
          console.error("invoice.paid: retrieve sub failed:", e?.message);
        }
      }

      const phone = phoneFromSubscription(sub);
      const stripeStatus = String(sub?.status || "active");
      const periodEndISO = isoFromUnix(sub?.current_period_end) || null;

      if (phone) {
        await updateUser(phone, {
          plan: "pro",
          pro_source: "stripe",
          stripe_subscription_id: subscriptionId,
          stripe_status: stripeStatus,
          stripe_current_period_end: periodEndISO,
        });
        metric("STRIPE_INVOICE_PAID", { phone, subscriptionId });
      }

      await markStripeEventProcessed(event.id);
      return res.json({ received: true });
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const subscriptionId = invoice.subscription || null;

      let sub = null;
      if (subscriptionId) {
        try {
          sub = await stripe.subscriptions.retrieve(subscriptionId);
        } catch (e) {
          console.error("invoice.payment_failed: retrieve sub failed:", e?.message);
        }
      }

      const phone = phoneFromSubscription(sub);
      if (phone) {
        metric("STRIPE_PAYMENT_FAILED", { phone, subscriptionId });
        await sendWhatsApp(phone, COPY.payFailed);
      }

      await markStripeEventProcessed(event.id);
      return res.json({ received: true });
    }

    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const phone = phoneFromSubscription(sub);
      const subscriptionId = sub?.id || null;

      const stripeStatus = String(sub?.status || "");
      const periodEndISO = isoFromUnix(sub?.current_period_end) || null;

      if (phone) {
        await updateUser(phone, {
          stripe_subscription_id: subscriptionId,
          stripe_status: stripeStatus,
          stripe_current_period_end: periodEndISO,
          plan: ["active", "trialing", "past_due", "unpaid"].includes(String(stripeStatus).toLowerCase()) ? "pro" : "free",
          pro_source: "stripe",
        });

        metric("STRIPE_SUB_UPDATED", { phone, subscriptionId, stripe_status: stripeStatus });
      }

      await markStripeEventProcessed(event.id);
      return res.json({ received: true });
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const phone = phoneFromSubscription(sub);
      const subscriptionId = sub?.id || null;

      if (phone) {
        await updateUser(phone, {
          plan: "free",
          pro_source: null,
          pro_until: null,
          stripe_status: "canceled",
          stripe_subscription_id: subscriptionId,
          stripe_current_period_end: null,
        });

        metric("STRIPE_SUB_DELETED", { phone, subscriptionId });
        await sendWhatsApp(phone, COPY.proEnded);
      }

      await markStripeEventProcessed(event.id);
      return res.json({ received: true });
    }

    await markStripeEventProcessed(event.id);
    return res.json({ received: true, ignored: true });
  } catch (err) {
    console.error("❌ Stripe webhook handler error:", err);
    metric("ERROR", { stage: "stripe_webhook", message: err?.message || "unknown" });
    return res.status(500).send("Stripe webhook error");
  }
});

// -------------------------
// WhatsApp webhook
// -------------------------
app.post("/webhook/whatsapp", async (req, res) => {
  const startedAt = Date.now();
  const reqId = makeReqId();

  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twimlResp = new MessagingResponse();

  const from = req.body.From;
  const bodyRaw = req.body.Body || "";
  const body = String(bodyRaw).trim();

  logEvent("INCOMING", { ts: isoNow(), reqId, from, body });

  try {
    const phone = from;
    const admin = isAdminPhone(phone);

    let user = await getOrCreateUser(phone);

    metric("USER_ACTIVE", { reqId, day: dayKey(), user_id: user.id, phone });
    bumpDailyUserMetric(dayKey(), user.id, phone, "messages", 1).catch(() => {});

    // Onboarding
    if (!user.seen_onboarding) {
      await updateUser(phone, { seen_onboarding: true });
      respond(twimlResp, COPY.onboarding);
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // Cancel in any state
    if (isNo(body)) {
      await safeResetPending(phone);
      respond(twimlResp, "Cancelado ✅");
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // Pending: support collect
    if (user.pending_action === "support_collect") {
      const msg = normalizeText(body);
      if (!msg) {
        respond(twimlResp, COPY.supportAsk);
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }

      const payload = user.pending_payload || {};
      const lastIntent = payload.last_intent || null;

      await createSupportTicket({ userId: user.id, phone: user.phone, message: msg.slice(0, 1200), lastIntent });
      metric("SUPPORT_TICKET_CREATED", { reqId, user_id: user.id });

      await safeResetPending(phone);
      respond(twimlResp, COPY.supportThanks);
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // -------------------------
    // Intent parse: hard-guard PAGAR -> local -> OpenAI
    // -------------------------
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

    // Admin commands
    if (parsed.intent === "admin_tickets_today") {
      if (!admin) {
        respond(twimlResp, "No autorizado.");
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }
      const rows = await getTicketsToday(10);
      if (!rows.length) {
        respond(twimlResp, "✅ No hay tickets hoy.");
      } else {
        const lines = rows.map((t) => {
          const hhmm = new Date(t.created_at).toISOString().slice(11, 16);
          return `#${t.id} ${hhmm} ${t.phone}\n${String(t.message).slice(0, 120)}`;
        });
        respond(twimlResp, `🛠️ Tickets HOY (${rows.length}):\n\n` + lines.join("\n\n"));
      }
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    if (parsed.intent === "admin_tickets_open") {
      if (!admin) {
        respond(twimlResp, "No autorizado.");
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }
      const rows = await getTicketsOpen(10);
      if (!rows.length) {
        respond(twimlResp, "✅ No hay tickets abiertos.");
      } else {
        const lines = rows.map((t) => {
          const d = new Date(t.created_at).toISOString().slice(0, 10);
          return `#${t.id} ${d} ${t.phone}\n${String(t.message).slice(0, 120)}`;
        });
        respond(twimlResp, `🛠️ Tickets ABIERTOS (${rows.length}):\n\n` + lines.join("\n\n"));
      }
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // Support start
    if (parsed.intent === "support_start") {
      await updateUser(phone, {
        pending_action: "support_collect",
        pending_payload: { last_intent: user.last_intent || null },
      });
      metric("SUPPORT_FLOW_STARTED", { reqId, user_id: user.id });
      respond(twimlResp, COPY.supportAsk);
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // Support inline: "REPORTAR algo..."
    if (parsed.intent === "support_inline") {
      const msg = normalizeText(parsed.message || "");
      if (!msg) {
        await updateUser(phone, { pending_action: "support_collect", pending_payload: { last_intent: user.last_intent || null } });
        respond(twimlResp, COPY.supportAsk);
      } else {
        await createSupportTicket({ userId: user.id, phone: user.phone, message: msg.slice(0, 1200), lastIntent: user.last_intent || null });
        metric("SUPPORT_TICKET_CREATED", { reqId, user_id: user.id, inline: true });
        respond(twimlResp, COPY.supportThanks);
      }
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // Quick commands
    if (parsed.intent === "pricing") {
      respond(twimlResp, COPY.pricing);
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    if (parsed.intent === "want_pro") {
      await updateUser(phone, { pending_action: "pro_ask_name", pending_payload: { started_at: isoNow() } });
      metric("PRO_INTEREST", { reqId, user_id: user.id });

      respond(twimlResp, COPY.wantProAskName);
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    if (parsed.intent === "pay") {
      if (!stripeReady()) {
        metric("PAY_NOT_CONFIGURED", { reqId, user_id: user.id });
        respond(twimlResp, "⚠️ Pagos no configurados todavía. Revisa variables STRIPE_* en Render (Web Service).");
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }

      const cycle = user.pro_lead_cycle || "mensual";
      const session = await createCheckoutSessionForUser(user, cycle);

      await updateUser(phone, { pro_lead_status: "payment_link_sent" });
      metric("PAY_LINK_CREATED", { reqId, user_id: user.id, cycle });

      respond(twimlResp, COPY.payLink(session.url));
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // Paywall for billable intents
    const gate = await enforcePaywallIfNeeded({ user, reqId, intent: parsed.intent, twiml: twimlResp });
    user = gate.user;
    const appendLowActions = Boolean(gate.lowActionsWarning);

    if (gate.blocked) {
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // SAVE PHONE
    if (parsed.intent === "save_phone") {
      const clientName = parsed.client_name;
      const normalized = normalizePhoneToWhatsApp(parsed.phone);

      if (!clientName || !normalized) {
        respond(twimlResp, `Ejemplo:\n"Guarda teléfono de Pepe +5218331112222"`);
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }

      await upsertClient(user.id, clientName);
      await setClientPhone(user.id, clientName, normalized);

      metric("PHONE_SAVED", { reqId, user_id: user.id, client: clientName });
      respond(
        twimlResp,
        `✅ Guardado.\n• Cliente: ${clientName}\n• Tel: ${normalized.replace("whatsapp:", "")}`,
        { appendLowActions }
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // LIST DEBTS
    if (parsed.intent === "list_debts") {
      const debts = await listPendingDebts(user.id);
      metric("DEBTS_LISTED", { reqId, user_id: user.id, count: debts.length });

      if (!debts.length) {
        respond(twimlResp, "✅ No tienes deudas registradas por cobrar.");
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }

      const lines = debts.map((d, i) => {
        const amt = Number(d.amount_due || 0).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
        const since = d.due_text ? ` (desde ${d.due_text})` : "";
        return `${i + 1}) ${d.client_name}: ${amt}${since}`;
      });

      respond(twimlResp, "📌 Te deben:\n" + lines.join("\n"));
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // ADD DEBT
    if (parsed.intent === "add_debt") {
      const clientName = parsed.client_name || "Cliente";
      const amount = parsed.amount_due;

      if (!amount) {
        respond(twimlResp, `No pude identificar el monto. Ejemplo: "Pepe me debe 9500 desde agosto"`);
        metric("DEBT_AMOUNT_MISSING", { reqId, user_id: user.id, client: clientName });
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }

      const since = parsed.since_text || null;
      await upsertClient(user.id, clientName);
      const debt = await addDebt(user.id, clientName, amount, since);

      metric("DEBT_CREATED", { reqId, user_id: user.id, client: clientName, amount_due: Number(amount) });

      const amt = Number(debt.amount_due).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
      respond(
        twimlResp,
        `Registrado ✅\n• Cliente: ${debt.client_name}\n• Monto: ${amt}\n` +
          (debt.due_text ? `• Desde: ${debt.due_text}\n` : "") +
          `\n¿Quieres agregar otro o preguntar "¿Quién me debe?"`,
        { appendLowActions }
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // PRIORITIZE
    if (parsed.intent === "prioritize") {
      const debts = await listPendingDebts(user.id);
      metric("PRIORITIZE_USED", { reqId, user_id: user.id, pending_count: debts.length });

      if (!debts.length) {
        respond(twimlResp, "✅ No tienes deudas registradas por cobrar.");
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }

      const ranked = debts
        .map((d) => {
          const days = estimateDays(d.due_text);
          const score = Number(d.amount_due || 0) + days * 10;
          return { ...d, score, days };
        })
        .sort((a, b) => b.score - a.score);

      const top = ranked[0];
      const amt = Number(top.amount_due || 0).toLocaleString("es-MX", { style: "currency", currency: "MXN" });

      respond(
        twimlResp,
        `📌 *Recomendación de cobranza*\n\n` +
          `Cobra primero a *${top.client_name}* por *${amt}*` +
          (top.due_text ? ` (desde ${top.due_text})` : "") +
          `.\n` +
          (top.days ? `Prioridad por atraso estimado: ~${top.days} días.` : ""),
        { appendLowActions }
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // MARK PAID
    if (parsed.intent === "mark_paid") {
      const clientName = parsed.client_name;
      if (!clientName) {
        respond(twimlResp, `¿De quién? Ejemplo: "Ya pagó Pepe"`);
        metric("PAID_MISSING_CLIENT", { reqId, user_id: user.id });
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }

      const r = await markLatestDebtPaid(user.id, clientName);
      if (!r) {
        metric("DEBT_PAID_NOT_FOUND", { reqId, user_id: user.id, client: clientName });
        respond(twimlResp, `No encontré deudas pendientes de *${clientName}*.`);
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }

      metric("DEBT_MARKED_PAID", { reqId, user_id: user.id, client: clientName });
      respond(twimlResp, `✅ Marcado como pagado: *${clientName}*`, { appendLowActions });
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // REMIND (start flow)
    if (parsed.intent === "remind") {
      const clientName = parsed.client_name || null;
      if (!clientName) {
        respond(twimlResp, `¿A quién le mando recordatorio? Ejemplo: "Manda recordatorio a Pepe"`);
        metric("REMINDER_MISSING_CLIENT", { reqId, user_id: user.id });
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twimlResp.toString());
      }

      let toPhone = null;
      const client = await findClientByName(user.id, clientName);
      if (client?.phone) toPhone = client.phone;

      await updateUser(phone, {
        pending_action: "remind_choose_tone",
        pending_payload: { clientName, amount: null, toPhone },
      });

      metric("REMINDER_FLOW_STARTED", { reqId, user_id: user.id, client: clientName, has_client_phone: Boolean(toPhone) });

      respond(
        twimlResp,
        `¿Qué tono quieres para el recordatorio a *${clientName}*?\n• amable\n• firme\n• urgente\n\n(O escribe "cancelar")`,
        { appendLowActions }
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // HELP
    if (parsed.intent === "help") {
      respond(twimlResp, COPY.help);
      metric("HELP_USED", { reqId, user_id: user.id });
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twimlResp.toString());
    }

    // fallback
    metric("FALLBACK_DEFAULT", { reqId, user_id: user.id });
    respond(
      twimlResp,
      `Te leo. Prueba:\n` +
        `• "Pepe me debe 9500 desde agosto"\n` +
        `• "¿Quién me debe?"\n` +
        `• "¿A quién cobro primero?"\n` +
        `• "Guarda teléfono de Pepe +52..."\n` +
        `• "Manda recordatorio a Pepe"\n` +
        `• AYUDA\n` +
        `• PRECIO\n` +
        `• PAGAR\n` +
        `• REPORTAR`
    );
    metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
    return res.type("text/xml").send(twimlResp.toString());
  } catch (err) {
    console.error("❌ Webhook error:", err);
    metric("ERROR", { reqId, stage: "webhook_catch", message: err?.message || "unknown" });
    twimlResp.message("⚠️ Hubo un problema temporal. Intenta de nuevo en un momento.");
    metric("RESPONSE_SENT", { reqId, ms: Date.now() - startedAt });
    return res.type("text/xml").send(twimlResp.toString());
  }
});

// -------------------------
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000, "—", VERSION);
});
