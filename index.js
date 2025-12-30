// index.js — FlowSense (clean production MVP + metrics logs + hotfix save_phone)
// v-2025-12-30-HOTFIX-SAVEPHONE

require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const { parseMessage } = require("./ai");

const {
  getOrCreateUser,
  updateUser,
  addDebt,
  listPendingDebts,
  listDebtsByClient,
  markLatestDebtPaid,
  findClientByName,
  upsertClient,
  setClientPhone,
} = require("./db");

const app = express();
app.use(express.urlencoded({ extended: false }));

const VERSION = "v-2025-12-30-HOTFIX-SAVEPHONE";

// -------------------------
// Logging + Metrics (logs only)
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

function normalizeText(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ");
}

function isYes(text) {
  const t = normalizeText(text).toLowerCase();
  return ["si", "sí", "simon", "ok", "dale", "enviar", "manda", "confirmo"].includes(t);
}

function isNo(text) {
  const t = normalizeText(text).toLowerCase();
  return ["no", "cancelar", "cancela", "alto", "detener"].includes(t);
}

// Heurística: si estás en flujo de recordatorio pero escribes otra "orden"
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
    t.includes("manda")
  );
}

// ✅ NUEVO: Parser local para "Guarda teléfono de X +52..."
function localParseSavePhone(body) {
  const t = normalizeText(body);

  // Acepta: telefono / teléfono, guarda / guardame / guarda el
  // Ejemplos:
  // "Guarda teléfono de Pepe +52833..."
  // "Guarda el telefono de Pepe 833..."
  // "Guarda telefono de Pepe: +52..."
  const re = /^guarda(?:\s+el)?\s+tel(?:e|é)fono\s+de\s+(.+?)\s+(\+?\d[\d()\s-]{7,}\d)\s*$/i;
  const m = t.match(re);
  if (!m) return null;

  const clientName = normalizeText(m[1]).replace(/[:\-]+$/, "").trim();
  const phone = m[2];

  if (!clientName || !phone) return null;

  return {
    intent: "save_phone",
    client_name: clientName,
    phone,
  };
}

// Very simple estimator from Spanish "desde ..."
function estimateDays(dueText) {
  if (!dueText) return 0;
  const t = dueText.toLowerCase();

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

function buildReminderMessage(tone, clientName, debtLine) {
  const name = clientName || "hola";
  const extra = debtLine ? `\n\n${debtLine}` : "";

  if (tone === "firme") {
    return (
      `Hola ${name}.\n` +
      `Te escribo para solicitar el pago pendiente. ¿Me confirmas hoy tu fecha y hora de pago?` +
      extra
    );
  }
  if (tone === "urgente") {
    return (
      `Hola ${name}.\n` +
      `Este es un recordatorio URGENTE del pago pendiente. Necesito confirmación inmediata de cuándo lo vas a cubrir.` +
      extra
    );
  }
  return (
    `Hola ${name} 👋\n` +
    `Te escribo para recordarte un pago pendiente. ¿Me confirmas cuándo podrás cubrirlo?` +
    extra
  );
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
    const user = await getOrCreateUser(phone);

    metric("USER_ACTIVE", { reqId, day: dayKey(), user_id: user.id, phone });

    if (!user.seen_onboarding) {
      await updateUser(phone, { seen_onboarding: true });
      metric("ONBOARDING_SHOWN", { reqId, user_id: user.id });

      twiml.message(
        `👋 Soy FlowSense.\n\n` +
          `Prueba:\n` +
          `• "Juan me debe 8500 desde el 3 de mayo"\n` +
          `• "¿Quién me debe?"\n` +
          `• "¿A quién cobro primero?"\n` +
          `• "Guarda teléfono de Juan +521833..."\n` +
          `• "Manda recordatorio a Juan"\n`
      );

      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // Cancelar
    if (isNo(body)) {
      await safeResetPending(phone);
      metric("CANCELLED", { reqId, user_id: user.id, pending_action: user.pending_action || null });
      twiml.message("Cancelado ✅");
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // -------------------------
    // Pending actions (state machine)
    // Escape hatch: si parece otra orden, resetea y sigue normal
    // -------------------------
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
          `📨 Este será el mensaje (${tone}):\n\n` +
            `${msg}\n\n` +
            (toPhone
              ? `¿Lo envío a ${toPhone}? Responde "sí" o "no".`
              : `No tengo el teléfono del cliente. ¿Quieres guardarlo primero?`)
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
            `No tengo el teléfono guardado.\n\n` +
              `Copia y pega este mensaje al cliente:\n\n${msg}\n\n` +
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

    // -------------------------
    // ✅ Router local antes de OpenAI
    // -------------------------
    let parsed = localParseSavePhone(body);

    if (parsed) {
      metric("INTENT", { reqId, user_id: user.id, intent: "save_phone", source: "local_regex" });
    } else {
      parsed = await parseMessage(body);
      metric("INTENT", { reqId, user_id: user.id, intent: parsed.intent || "unknown", source: "openai" });
    }

    // =========================
    // SAVE PHONE
    // =========================
    if (parsed.intent === "save_phone") {
      const clientName = parsed.client_name;

      if (!clientName) {
        twiml.message(`Dime el nombre y el teléfono. Ejemplo:\n"Guarda teléfono de Juan +5218331112222"`);
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twiml.toString());
      }

      let normalized = parsed.phone ? normalizePhoneToWhatsApp(parsed.phone) : null;
      if (!normalized) {
        const m = body.match(/(\+?\d[\d()\s-]{7,}\d)/);
        if (m) normalized = normalizePhoneToWhatsApp(m[1]);
      }

      if (!normalized) {
        twiml.message(`No pude leer el teléfono. Ejemplo:\n"Guarda teléfono de ${clientName} +5218331112222"`);
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
    // AGREGAR DEUDA
    // =========================
    if (parsed.intent === "add_debt") {
      const clientName = parsed.client_name || "Cliente";
      let amount = parsed.amount_due;

      if (!amount) {
        const m = body.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(k|mil)\b/);
        if (m) {
          const n = Number(m[1].replace(",", "."));
          if (Number.isFinite(n)) amount = Math.round(n * 1000);
        }
      } else {
        const hasK = /\b(k|mil)\b/i.test(body);
        if (hasK && amount < 1000) amount = Math.round(amount * 1000);
      }

      if (/\b(k|mil)\b/i.test(body) && amount && amount < 1000) {
        twiml.message(`¿Te refieres a $${amount} o $${amount * 1000}? Responde "${amount}" o "${amount}k".`);
        metric("DEBT_AMOUNT_AMBIGUOUS", { reqId, user_id: user.id, client: clientName, amount_guess: amount });
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twiml.toString());
      }

      if (!amount) {
        twiml.message(
          `No pude identificar el monto. Ejemplos:\n` +
            `• "Juan me debe 8500 desde el 3 de mayo"\n` +
            `• "me deben 2k"\n` +
            `• "Pedro quedó a deber 300"`
        );
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
        `Registrado ✅\n` +
          `• Cliente: ${debt.client_name}\n` +
          `• Monto: ${amt}\n` +
          (debt.due_text ? `• Desde: ${debt.due_text}\n\n` : `\n`) +
          `¿Quieres agregar otro o preguntar "¿Quién me debe?"`
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
        `📌 *Recomendación de cobranza*\n\n` +
          `Cobra primero a *${top.client_name}* por *${amt}*` +
          (top.due_text ? ` (desde ${top.due_text})` : "") +
          `.\n` +
          (top.days ? `Prioridad por atraso estimado: ~${top.days} días.` : "")
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // MARCAR PAGADO
    // =========================
    if (parsed.intent === "mark_paid") {
      const clientName = parsed.client_name;
      if (!clientName) {
        twiml.message(`¿De quién? Ejemplo: "Ya pagó Juan"`);
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
    // RECORDATORIO
    // =========================
    if (parsed.intent === "remind") {
      const clientName = parsed.client_name || null;
      const amount = parsed.amount_due || null;

      if (!clientName) {
        twiml.message(`¿A quién le mando recordatorio? Ejemplo:\n"Manda recordatorio a Juan"`);
        metric("REMINDER_MISSING_CLIENT", { reqId, user_id: user.id });
        metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
        return res.type("text/xml").send(twiml.toString());
      }

      let toPhone = null;
      const client = await findClientByName(user.id, clientName);
      if (client?.phone) toPhone = client.phone;

      await updateUser(phone, {
        pending_action: "remind_choose_tone",
        pending_payload: { clientName, amount, toPhone },
      });

      metric("REMINDER_FLOW_STARTED", { reqId, user_id: user.id, client: clientName, has_client_phone: Boolean(toPhone) });

      twiml.message(
        `¿Qué tono quieres para el recordatorio a *${clientName}*?\n` +
          `• amable\n• firme\n• urgente\n\n` +
          `(O escribe "cancelar")`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // HELP
    // =========================
    if (parsed.intent === "help") {
      metric("HELP_USED", { reqId, user_id: user.id });
      twiml.message(
        `Así te ayudo:\n` +
          `1) "Juan me debe 8500 desde el 3 de mayo"\n` +
          `2) "¿Quién me debe?"\n` +
          `3) "¿A quién cobro primero?"\n` +
          `4) "Guarda teléfono de Juan +521833..."\n` +
          `5) "Manda recordatorio a Juan"\n\n` +
          `También entiendo: "me deben 2k".`
      );
      metric("RESPONSE_SENT", { reqId, user_id: user.id, ms: Date.now() - startedAt });
      return res.type("text/xml").send(twiml.toString());
    }

    // DEFAULT
    metric("FALLBACK_DEFAULT", { reqId, user_id: user.id });
    twiml.message(
      `Te leo. Para avanzar rápido, prueba uno de estos:\n` +
        `• "Juan me debe 8500 desde el 3 de mayo"\n` +
        `• "¿Quién me debe?"\n` +
        `• "¿A quién cobro primero?"\n` +
        `• "Guarda teléfono de Juan +5218..."\n` +
        `• "Manda recordatorio a Juan"\n` +
        `• "ayuda"`
    );

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
