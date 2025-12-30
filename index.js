// index.js — FlowSense (FASE 1.3 Bloque 1: paywall + plans + daily limits)
// v-2025-12-30-PAYWALL

require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

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
app.use(express.urlencoded({ extended: false }));

const VERSION = "v-2025-12-30-PAYWALL";

// -------------------------
// Config comercial (ajustable)
// -------------------------
const LIMITS = {
  free_daily_actions: 15, // acciones/día en plan free
};

// qué intents “cuentan” como uso
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
  `• Recordatorios ilimitados\n` +
  `• Prioridad inteligente\n` +
  `• Resumen diario\n\n` +
  `Para activar Pro responde: *QUIERO PRO*\n` +
  `o escribe: *PRECIO*`;

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

// FASE 1.3: comandos comerciales (sin pagos todavía)
function localParsePrice(body) {
  const t = normalizeText(body).toLowerCase();
  if (t === "precio" || t === "precios" || t.includes("cuanto cuesta") || t.includes("cuánto cuesta")) {
    return { intent: "pricing" };
  }
  return null;
}
function localParseWantPro(body) {
  const t = normalizeText(body).toLowerCase();
  if (t === "quiero pro" || t === "pro" || t.includes("activar pro") || t.includes("suscrib")) {
    return { intent: "want_pro" };
  }
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
  // solo cuenta si es billable y si NO es pro
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
  return (
    `⚠️ Llegaste al límite gratuito de hoy (${used}/${limit}).\n\n` +
    CTA_TEXT
  );
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
// Core features
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

app.get("/health", (_, res) => res.send(`ok ${VERSION}`));

app.post("/webhook/whatsapp", async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  const from = req.body.From;
  const bodyRaw = req.body.Body || "";
  const body = String(bodyRaw).trim();

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
        `Tip: escribe *PRECIO* cuando quieras activar Pro.`
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

    // -------------------------
    // Local router first, then OpenAI
    // -------------------------
    let parsed = localRouter(body);
    if (parsed) {
      metric("INTENT", { reqId, user_id: user.id, intent: parsed.intent, source: "local_router" });
    } else {
      parsed = await parseMessage(body);
      metric("INTENT", { reqId, user_id: user.id, intent: parsed.intent || "unknown", source: "openai" });
    }

    // -------------------------
    // FASE 1.3: intents comerciales
    // -------------------------
    if (parsed.intent === "pricing") {
      twiml.message(
        `💳 *Planes FlowSense*\n\n` +
        `*Gratis*: hasta ${LIMITS.free_daily_actions} acciones al día.\n` +
        `*Pro*: ilimitado + mejoras.\n\n` +
        `Para activar Pro responde: *QUIERO PRO*`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    if (parsed.intent === "want_pro") {
      // aquí en Bloque 1 NO cobramos aún: solo instrucción.
      twiml.message(
        `Perfecto. Para activar *FlowSense Pro* te voy a enviar el link de pago en el siguiente paso.\n\n` +
        `Por ahora dime:\n` +
        `1) ¿Tu nombre / negocio?\n` +
        `2) ¿Quieres *mensual* o *anual*?\n\n` +
        `Responde: "Mensual" o "Anual".`
      );
      metric("PRO_INTEREST", { reqId, user_id: user.id });
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
    // LISTAR
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
          `\nTip: "Guarda teléfono de ${debt.client_name} +52..." y luego "Manda recordatorio a ${debt.client_name}".`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // PRIORIZAR
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
          `.\n` +
          `\n${CTA_TEXT}`
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
    // REMIND (simple: solo inicia flujo)
    // =========================
    if (parsed.intent === "remind") {
      const clientName = parsed.client_name || null;
      if (!clientName) {
        twiml.message(`¿A quién le mando recordatorio? Ejemplo:\n"Manda recordatorio a Pepe"`);
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

    // fallback
    twiml.message(`Te leo. Prueba:\n• "Pepe me debe 9500 desde agosto"\n• "¿Quién me debe?"\n• "PRECIO"`);
    metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("❌ Webhook error:", err);
    metric("ERROR", { reqId, stage: "webhook_catch", message: err?.message || "unknown" });
    twiml.message("⚠️ Hubo un problema temporal. Intenta de nuevo en un momento.");
    metric("RESPONSE_SENT", { reqId, ms: Date.now() - startedAt });
    return res.type("text/xml").send(twiml.toString());
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000, "—", VERSION);
});
