// index.js — FlowSense (FASE 1.3 Bloque 3 FIX: PAGAR local + Stripe + recordatorios + trial)
// v-2025-12-30-STRIPE-FIX-PAGAR

require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const Stripe = require("stripe");

const { parseMessage } = require("./ai");

const {
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

// IMPORTANT: Stripe webhook needs RAW body on its endpoint
app.use("/webhook/stripe", express.raw({ type: "application/json" }));

// WhatsApp webhook uses urlencoded (Twilio)
app.use(express.urlencoded({ extended: false }));

const VERSION = "v-2025-12-30-STRIPE-FIX-PAGAR";

// -------------------------
// Stripe init
// -------------------------
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY || "";
const STRIPE_PRICE_ANNUAL = process.env.STRIPE_PRICE_ANNUAL || "";
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL || "https://example.com/success";
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL || "https://example.com/cancel";

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" }) : null;

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
    allow_promotion_codes: true,
  });

  return session;
}

// -------------------------
// Comercial
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
  `• Mejor seguimiento\n` +
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

// -------------------------
// Admin phones
// -------------------------
function parseAdminPhones() {
  const raw = process.env.ADMIN_PHONES || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
const ADMIN_PHONES = parseAdminPhones();
function isAdminPhone(from) {
  return ADMIN_PHONES.includes(from);
}

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
// Router local (crítico)
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
  if (t === "quien me debe" || t === "quién me debe" || t.includes("quien me debe") || t.includes("quién me debe")) {
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

// ✅ FIX: PAGAR debe ser local (sin OpenAI)
function localParsePay(body) {
  const t = normalizeText(body).toLowerCase();
  if (t === "pagar") return { intent: "pay" };
  // tolerante a variantes comunes
  if (t === "pago" || t === "pagar pro" || t.includes("link de pago")) return { intent: "pay" };
  return null;
}

// Admin: "ACTIVAR PRO 7"
function localParseAdminActivatePro(body) {
  const t = normalizeText(body).toLowerCase();
  const m = t.match(/^activar\s+pro\s+(\d{1,3})\s*$/i);
  if (!m) return null;
  const days = Number(m[1]);
  if (!Number.isFinite(days) || days <= 0 || days > 365) return null;
  return { intent: "admin_activate_pro", days };
}

function localRouter(body, from) {
  if (isAdminPhone(from)) {
    const adminCmd = localParseAdminActivatePro(body);
    if (adminCmd) return adminCmd;
  }

  return (
    localParseSavePhone(body) ||
    localParseMarkPaid(body) ||
    localParseListDebts(body) ||
    localParsePrioritize(body) ||
    localParseRemind(body) ||
    localParseHelp(body) ||
    localParsePrice(body) ||
    localParseWantPro(body) ||
    localParsePay(body) || // ✅ FIX
    null
  );
}

// -------------------------
// Paywall helpers
// -------------------------
function isPro(user) {
  if (!user) return false;
  if (String(user.plan || "").toLowerCase() === "pro") return true;
  if (user.pro_until) {
    try {
      return new Date(user.pro_until).getTime() > Date.now();
    } catch (_) {}
  }
  return false;
}

function addDaysISO(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
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
// Helpers negocio
// -------------------------
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
  return 30;
}

function buildReminderMessage(tone, clientName, debtLine) {
  const name = clientName || "hola";
  const extra = debtLine ? `\n\n${debtLine}` : "";
  if (tone === "firme") return `Hola ${name}.\nTe escribo para solicitar el pago pendiente. ¿Me confirmas hoy tu fecha y hora de pago?${extra}`;
  if (tone === "urgente") return `Hola ${name}.\nEste es un recordatorio URGENTE del pago pendiente. Necesito confirmación inmediata de cuándo lo vas a cubrir.${extra}`;
  return `Hola ${name} 👋\nTe escribo para recordarte un pago pendiente. ¿Me confirmas cuándo podrás cubrirlo?${extra}`;
}

async function safeResetPending(phone) {
  try {
    await updateUser(phone, { pending_action: null, pending_payload: null });
  } catch (_) {}
}

// -------------------------
// Routes (health + stripe success/cancel)
// -------------------------
app.get("/health", (_, res) => res.send(`ok ${VERSION}`));

app.get("/stripe/success", (_, res) => res.status(200).send("Pago recibido. Ya puedes volver a WhatsApp."));
app.get("/stripe/cancel", (_, res) => res.status(200).send("Pago cancelado. Puedes volver a WhatsApp y escribir PAGAR cuando gustes."));

// -------------------------
// Stripe Webhook (activación Pro automática)
// -------------------------
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

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const phone = session?.metadata?.phone;
      const userId = session?.metadata?.user_id;
      const cycle = session?.metadata?.cycle || "mensual";
      const customerId = session.customer || null;
      const subscriptionId = session.subscription || null;

      metric("STRIPE_CHECKOUT_COMPLETED", { user_id: userId || null, phone: phone || null, cycle, customerId, subscriptionId });

      if (phone) {
        await updateUser(phone, {
          plan: "pro",
          pro_until: null,
          pro_source: "stripe",
          pro_started_at: isoNow(),
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          pro_lead_status: "paid",
        });
        metric("PRO_ACTIVATED_FROM_STRIPE", { phone, user_id: userId || null, cycle });
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Stripe webhook handler error:", err);
    metric("ERROR", { stage: "stripe_webhook", message: err?.message || "unknown" });
    return res.status(500).send("Webhook handler failed");
  }
});

// -------------------------
// WhatsApp Webhook
// -------------------------
app.post("/webhook/whatsapp", async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  const from = req.body.From;
  const body = String(req.body.Body || "").trim();

  const reqId = makeReqId();
  const startedAt = Date.now();

  logEvent("INCOMING", { reqId, from, body });

  try {
    const phone = from;
    let user = await getOrCreateUser(phone);

    metric("USER_ACTIVE", { reqId, day: dayKey(), user_id: user.id, phone });

    // onboarding
    if (!user.seen_onboarding) {
      await updateUser(phone, { seen_onboarding: true });
      twiml.message(
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
      return res.type("text/xml").send(twiml.toString());
    }

    // cancelar
    if (isNo(body)) {
      await safeResetPending(phone);
      twiml.message("Cancelado ✅");
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // ---------------------------------------------------
    // Pending actions (recordatorios + flujo Pro)
    // ---------------------------------------------------
    if (user.pending_action === "remind_choose_tone") {
      const t = normalizeText(body).toLowerCase();
      if (looksLikeNewCommand(body) && !t.includes("amable") && !t.includes("firme") && !t.includes("urgente")) {
        await safeResetPending(phone);
        metric("PENDING_ABORTED_BY_NEW_COMMAND", { reqId, user_id: user.id, from_state: "remind_choose_tone" });
      } else {
        let tone = null;
        if (t.includes("amable")) tone = "amable";
        else if (t.includes("firme")) tone = "firme";
        else if (t.includes("urgente")) tone = "urgente";

        if (!tone) {
          metric("REMINDER_TONE_INVALID", { reqId, user_id: user.id, input: body });
          twiml.message(`Responde con uno:\n• amable\n• firme\n• urgente\n\n(O escribe "cancelar")`);
          metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
          return res.type("text/xml").send(twiml.toString());
        }

        const payload = user.pending_payload || {};
        const clientName = payload.clientName || null;
        const toPhone = payload.toPhone || null;
        const amount = payload.amount || null;

        const debtLine = amount
          ? `Monto: ${Number(amount).toLocaleString("es-MX", { style: "currency", currency: "MXN" })}`
          : "";
        const msg = buildReminderMessage(tone, clientName || "hola", debtLine);

        await updateUser(phone, {
          pending_action: "remind_confirm_send",
          pending_payload: { ...payload, tone, msg },
        });

        metric("REMINDER_PREVIEW", { reqId, user_id: user.id, tone, has_client_phone: Boolean(toPhone) });

        twiml.message(
          `📨 Este será el mensaje (${tone}):\n\n${msg}\n\n` +
            (toPhone ? `¿Lo envío a ${toPhone}? Responde "sí" o "no".` : `No tengo el teléfono del cliente. ¿Quieres guardarlo primero?`)
        );
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twiml.toString());
      }
    }

    if (user.pending_action === "remind_confirm_send") {
      if (!isYes(body) && !isNo(body) && looksLikeNewCommand(body)) {
        await safeResetPending(phone);
        metric("PENDING_ABORTED_BY_NEW_COMMAND", { reqId, user_id: user.id, from_state: "remind_confirm_send" });
      } else {
        const payload = user.pending_payload || {};
        const clientName = payload.clientName || "cliente";
        const toPhone = payload.toPhone || null;
        const msg = payload.msg || null;
        const tone = payload.tone || null;

        if (!isYes(body)) {
          await safeResetPending(phone);
          metric("REMINDER_CANCELLED_AT_CONFIRM", { reqId, user_id: user.id, client: clientName });
          twiml.message("Ok, no se envió ✅");
          metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
          return res.type("text/xml").send(twiml.toString());
        }

        if (!toPhone) {
          await safeResetPending(phone);
          metric("REMINDER_COPYPASTE_SHOWN", { reqId, user_id: user.id, client: clientName, tone });
          twiml.message(
            `No tengo el teléfono guardado.\n\nCopia y pega este mensaje al cliente:\n\n${msg}\n\n` +
              `Para guardarlo: "Guarda teléfono de ${clientName} +52..."`
          );
          metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
          return res.type("text/xml").send(twiml.toString());
        }

        try {
          const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await twilioClient.messages.create({
            from: process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886",
            to: toPhone,
            body: msg,
          });
          metric("REMINDER_SENT", { reqId, user_id: user.id, client: clientName, tone, to: toPhone });
        } catch (err) {
          console.error("❌ Twilio send error:", err);
          metric("ERROR", { reqId, user_id: user.id, stage: "twilio_send", message: err?.message || "unknown" });
          await safeResetPending(phone);
          twiml.message("⚠️ No pude enviar el mensaje en este momento. Intenta de nuevo en 1 minuto.");
          metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
          return res.type("text/xml").send(twiml.toString());
        }

        await safeResetPending(phone);
        twiml.message(`✅ Listo. Envié el recordatorio a *${clientName}*.`);
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twiml.toString());
      }
    }

    // ---- Flujo Pro: pedir nombre/negocio
    if (user.pending_action === "pro_ask_name") {
      const name = normalizeText(body);

      await updateUser(phone, {
        pro_lead_name: name.slice(0, 120),
        pro_lead_status: "requested",
        pending_action: "pro_ask_cycle",
        pending_payload: { started_at: isoNow() },
      });

      metric("PRO_LEAD_NAME", { reqId, user_id: user.id });

      twiml.message(
        `Gracias. ¿Qué prefieres?\n` +
          `1) *Mensual*\n` +
          `2) *Anual*\n\n` +
          `Responde: "Mensual" o "Anual".\n` +
          `(Puedes escribir "cancelar")`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // ---- Flujo Pro: elegir ciclo y activar TRIAL
    if (user.pending_action === "pro_ask_cycle") {
      const t = normalizeText(body).toLowerCase();
      let cycle = null;
      if (t.includes("mensual")) cycle = "mensual";
      if (t.includes("anual")) cycle = "anual";

      if (!cycle) {
        twiml.message(`Responde: "Mensual" o "Anual". (o "cancelar")`);
        metric("PRO_LEAD_CYCLE_INVALID", { reqId, user_id: user.id, input: body });
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twiml.toString());
      }

      const proUntil = addDaysISO(TRIAL_DAYS_DEFAULT);

      await updateUser(phone, {
        pro_lead_cycle: cycle,
        pro_lead_status: "trial_started",
        plan: "pro",
        pro_until: proUntil,
        pending_action: null,
        pending_payload: null,
      });

      metric("PRO_TRIAL_STARTED", { reqId, user_id: user.id, days: TRIAL_DAYS_DEFAULT, cycle });

      twiml.message(
        `✅ Activé tu *FlowSense Pro* por *${TRIAL_DAYS_DEFAULT} días* (prueba).\n\n` +
          `Tu prueba vence: ${proUntil.slice(0, 10)}.\n` +
          `Para pagar y dejar Pro activo: escribe *PAGAR*`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // -------------------------
    // Parse intent (local -> OpenAI)
    // -------------------------
    // ✅ Hard-guard extra para PAGAR (por si alguien rompe el router en el futuro)
    if (normalizeText(body).toLowerCase() === "pagar") {
      metric("INTENT", { reqId, user_id: user.id, intent: "pay", source: "hard_guard" });
      // se maneja abajo como intent pay
      var parsed = { intent: "pay" };
    } else {
      var parsed = localRouter(body, from);
      if (parsed) metric("INTENT", { reqId, user_id: user.id, intent: parsed.intent, source: "local_router" });
      else {
        parsed = await parseMessage(body);
        metric("INTENT", { reqId, user_id: user.id, intent: parsed.intent || "unknown", source: "openai" });
      }
    }

    // -------------------------
    // Admin activate Pro
    // -------------------------
    if (parsed.intent === "admin_activate_pro") {
      if (!isAdminPhone(from)) {
        twiml.message("No autorizado.");
        metric("ADMIN_DENIED", { reqId, user_id: user.id });
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twiml.toString());
      }

      const days = parsed.days;
      const proUntil = addDaysISO(days);

      await updateUser(phone, {
        plan: "pro",
        pro_until: proUntil,
        pro_source: "admin",
      });

      metric("ADMIN_PRO_ACTIVATED", { reqId, user_id: user.id, days });

      twiml.message(`✅ Pro activado por ${days} días.\nVence: ${proUntil.slice(0, 10)}`);
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // -------------------------
    // Pricing / Want Pro / Pay
    // -------------------------
    if (parsed.intent === "pricing") {
      twiml.message(planText());
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    if (parsed.intent === "want_pro") {
      await updateUser(phone, { pending_action: "pro_ask_name", pending_payload: { started_at: isoNow() } });
      metric("PRO_INTEREST", { reqId, user_id: user.id });

      twiml.message(
        `Perfecto. Para activar tu prueba *Pro* (${TRIAL_DAYS_DEFAULT} días), dime:\n\n` +
          `¿Cómo te llamas o cómo se llama tu negocio?\n` +
          `(Ej: "Tienda Pepe")`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    if (parsed.intent === "pay") {
      if (!stripeReady()) {
        metric("PAY_NOT_CONFIGURED", { reqId, user_id: user.id });
        twiml.message("⚠️ Pagos no configurados todavía. Revisa variables STRIPE_* en Render (Web Service).");
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twiml.toString());
      }

      const cycle = user.pro_lead_cycle || "mensual";
      const session = await createCheckoutSessionForUser(user, cycle);

      await updateUser(phone, { pro_lead_status: "payment_link_sent" });

      metric("PAY_LINK_CREATED", { reqId, user_id: user.id, cycle });

      twiml.message(
        `💳 Listo. Aquí está tu link de pago (*${cycle}*):\n\n` +
          `${session.url}\n\n` +
          `Cuando se complete, yo te activo Pro automáticamente ✅`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // -------------------------
    // Paywall enforcement (antes de ejecutar intent)
    // -------------------------
    const gate = await enforcePaywallIfNeeded({ user, reqId, intent: parsed.intent, twiml });
    user = gate.user;
    if (gate.blocked) {
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // SAVE PHONE
    // =========================
    if (parsed.intent === "save_phone") {
      const clientName = parsed.client_name;
      const normalized = normalizePhoneToWhatsApp(parsed.phone);

      if (!clientName || !normalized) {
        twiml.message(`Ejemplo:\n"Guarda teléfono de Pepe +5218331112222"`);
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twiml.toString());
      }

      await upsertClient(user.id, clientName);
      await setClientPhone(user.id, clientName, normalized);

      metric("PHONE_SAVED", { reqId, user_id: user.id, client: clientName });
      twiml.message(`✅ Guardado.\n• Cliente: ${clientName}\n• Tel: ${normalized.replace("whatsapp:", "")}`);
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // LIST DEBTS
    // =========================
    if (parsed.intent === "list_debts") {
      const debts = await listPendingDebts(user.id);
      metric("DEBTS_LISTED", { reqId, user_id: user.id, count: debts.length });

      if (!debts.length) {
        twiml.message("✅ No tienes deudas registradas por cobrar.");
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twiml.toString());
      }

      const lines = debts.map((d, i) => {
        const amt = Number(d.amount_due || 0).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
        const since = d.due_text ? ` (desde ${d.due_text})` : "";
        return `${i + 1}) ${d.client_name}: ${amt}${since}`;
      });

      twiml.message("📌 Te deben:\n" + lines.join("\n"));
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // ADD DEBT
    // =========================
    if (parsed.intent === "add_debt") {
      const clientName = parsed.client_name || "Cliente";
      const amount = parsed.amount_due;

      if (!amount) {
        twiml.message(`No pude identificar el monto. Ejemplo: "Pepe me debe 9500 desde agosto"`);
        metric("DEBT_AMOUNT_MISSING", { reqId, user_id: user.id, client: clientName });
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twiml.toString());
      }

      const since = parsed.since_text || null;
      await upsertClient(user.id, clientName);
      const debt = await addDebt(user.id, clientName, amount, since);

      metric("DEBT_CREATED", { reqId, user_id: user.id, client: clientName, amount_due: Number(amount) });

      const amt = Number(debt.amount_due).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
      twiml.message(
        `Registrado ✅\n• Cliente: ${debt.client_name}\n• Monto: ${amt}\n` +
          (debt.due_text ? `• Desde: ${debt.due_text}\n` : "") +
          `\n${CTA_TEXT}`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // PRIORITIZE
    // =========================
    if (parsed.intent === "prioritize") {
      const debts = await listPendingDebts(user.id);
      metric("PRIORITIZE_USED", { reqId, user_id: user.id, pending_count: debts.length });

      if (!debts.length) {
        twiml.message("✅ No tienes deudas registradas por cobrar.");
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twiml.toString());
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

      twiml.message(
        `📌 *Recomendación de cobranza*\n\nCobra primero a *${top.client_name}* por *${amt}*` +
          (top.due_text ? ` (desde ${top.due_text})` : "") +
          `.\n\n${CTA_TEXT}`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // MARK PAID
    // =========================
    if (parsed.intent === "mark_paid") {
      const clientName = parsed.client_name;
      if (!clientName) {
        twiml.message(`¿De quién? Ejemplo: "Ya pagó Pepe"`);
        metric("PAID_MISSING_CLIENT", { reqId, user_id: user.id });
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twiml.toString());
      }

      const r = await markLatestDebtPaid(user.id, clientName);
      if (!r) {
        metric("DEBT_PAID_NOT_FOUND", { reqId, user_id: user.id, client: clientName });
        twiml.message(`No encontré deudas pendientes de *${clientName}*.`);
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twiml.toString());
      }

      metric("DEBT_MARKED_PAID", { reqId, user_id: user.id, client: clientName });
      twiml.message(`✅ Marcado como pagado: *${clientName}*`);
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // REMIND (arranca flujo)
    // =========================
    if (parsed.intent === "remind") {
      const clientName = parsed.client_name || null;
      if (!clientName) {
        twiml.message(`¿A quién le mando recordatorio? Ejemplo: "Manda recordatorio a Pepe"`);
        metric("REMINDER_MISSING_CLIENT", { reqId, user_id: user.id });
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twiml.toString());
      }

      let toPhone = null;
      const client = await findClientByName(user.id, clientName);
      if (client?.phone) toPhone = client.phone;

      await updateUser(phone, {
        pending_action: "remind_choose_tone",
        pending_payload: { clientName, amount: null, toPhone },
      });

      metric("REMINDER_FLOW_STARTED", { reqId, user_id: user.id, client: clientName, has_client_phone: Boolean(toPhone) });

      twiml.message(`¿Qué tono quieres para el recordatorio a *${clientName}*?\n• amable\n• firme\n• urgente\n\n(O escribe "cancelar")`);
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // HELP
    if (parsed.intent === "help") {
      twiml.message(
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
      return res.type("text/xml").send(twiml.toString());
    }

    // fallback
    twiml.message(`Te leo. Prueba:\n• "Pepe me debe 9500 desde agosto"\n• "¿Quién me debe?"\n• "PRECIO" / "PAGAR"`);
    metric("FALLBACK_DEFAULT", { reqId, user_id: user.id });
    metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("❌ Webhook error:", err);
    metric("ERROR", { stage: "webhook_catch", message: err?.message || "unknown" });
    twiml.message("⚠️ Hubo un problema temporal. Intenta de nuevo en un momento.");
    metric("RESPONSE_SENT", { ms: Date.now() - startedAt });
    return res.type("text/xml").send(twiml.toString());
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000, "—", VERSION);
});
