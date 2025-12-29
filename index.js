require("dotenv").config();

const express = require("express");
const twilio = require("twilio");

const {
  getOrCreateUser,
  updateUser,
  addDebt,
  listPendingDebts,
  createReminder,
  listDueReminders,
  markReminderSent,
  markReminderFailed,
  findClientByName,
  setClientPhone,
  upsertClient
} = require("./db");


const { parseMessage } = require("./ai");

const app = express();
app.use(express.urlencoded({ extended: false }));

const VERSION = "v-2025-12-27-FINAL";

app.get("/health", (_, res) => res.send(`ok ${VERSION}`));

function nextWeekdayDate(targetDow, hour = 10) {
  const now = new Date();
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  const current = d.getDay(); // 0=dom,1=lun,...6=sab
  let add = (targetDow - current + 7) % 7;
  if (add === 0 && d <= now) add = 7;
  d.setDate(d.getDate() + add);
  return d;
}

function parseWhen(text, defaultHour = 10) {
  const t = (text || "").toLowerCase();
  const now = new Date();
  const base = new Date(now);

  if (t.includes("mañana")) {
    base.setDate(base.getDate() + 1);
    base.setHours(defaultHour, 0, 0, 0);
    return base;
  }

  if (t.includes("hoy")) {
    base.setHours(defaultHour, 0, 0, 0);
    if (base <= now) base.setHours(now.getHours() + 1, 0, 0, 0);
    return base;
  }

  const m = t.match(/en\s+(\d+)\s+d[ií]as?/);
  if (m) {
    const n = parseInt(m[1], 10);
    base.setDate(base.getDate() + (Number.isFinite(n) ? n : 1));
    base.setHours(defaultHour, 0, 0, 0);
    return base;
  }

  if (t.includes("lunes")) return nextWeekdayDate(1, defaultHour);
  if (t.includes("martes")) return nextWeekdayDate(2, defaultHour);
  if (t.includes("miércoles") || t.includes("miercoles"))
    return nextWeekdayDate(3, defaultHour);
  if (t.includes("jueves")) return nextWeekdayDate(4, defaultHour);
  if (t.includes("viernes")) return nextWeekdayDate(5, defaultHour);
  if (t.includes("sábado") || t.includes("sabado"))
    return nextWeekdayDate(6, defaultHour);
  if (t.includes("domingo")) return nextWeekdayDate(0, defaultHour);

  const fallback = new Date(now);
  fallback.setHours(now.getHours() + 2, 0, 0, 0);
  return fallback;
}

function buildReminderText({ clientName, amount, tone }) {
  const amtTxt = amount
    ? ` por ${Number(amount).toLocaleString("es-MX", {
        style: "currency",
        currency: "MXN",
      })}`
    : "";
  const name = clientName || "tu cliente";

  if (tone === "amable") {
    return `Hola ${name} 👋 Solo para recordarte el pago pendiente${amtTxt}. ¿Me ayudas con la fecha en la que podrás liquidarlo? Gracias 🙏`;
  }
  if (tone === "firme") {
    return `Hola ${name}. Te escribo para dar seguimiento al pago pendiente${amtTxt}. ¿Podrías confirmarme cuándo lo liquidarás?`;
  }
  return `Hola ${name}. Seguimos pendientes con el pago${amtTxt}. Necesito que hoy me confirmes si podrás liquidarlo o acordar una fecha exacta.`;
}

function estimateDays(dueText) {
  if (!dueText) return 0;
  const t = String(dueText).toLowerCase();

  if (t.includes("año")) return 365;
  if (t.includes("mes")) return 30;
  if (t.includes("semana")) return 7;

  const m = t.match(/(\d+)\s*(año|anos|años|mes|meses|semana|semanas)/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (!Number.isFinite(n)) return 0;
    if (unit.startsWith("a")) return n * 365;
    if (unit.startsWith("mes")) return n * 30;
    if (unit.startsWith("sem")) return n * 7;
  }

  return 0;
}

// =========================
// Helpers WhatsApp
// =========================
function normalizeWhatsAppTo(input) {
  if (!input) return null;
  let s = String(input).trim();

  // quitar espacios y guiones
  s = s.replace(/[^\d+]/g, "");

  // si empieza con 52... sin +, lo agregamos
  if (/^52\d+/.test(s)) s = "+" + s;

  // si no empieza con +, intentamos agregarlo
  if (!s.startsWith("+")) s = "+" + s;

  return `whatsapp:${s}`;
}

app.post("/webhook/whatsapp", async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    console.log("Incoming:", { from, body });

    const phone = from || "whatsapp:unknown";
    const user = await getOrCreateUser(phone);

    // =========================
    // ESTADOS: recordatorio guiado
    // =========================
    if (user.pending_action === "remind_choose_tone") {
      const tone = body.trim().toLowerCase();
      const allowed = ["amable", "firme", "urgente", "cancelar"];

      if (!allowed.includes(tone)) {
        twiml.message(`Elige un tono: amable / firme / urgente (o "cancelar")`);
        return res.type("text/xml").send(twiml.toString());
      }

      if (tone === "cancelar") {
        await updateUser(phone, { pending_action: null, pending_payload: null });
        twiml.message("Cancelado ✅");
        return res.type("text/xml").send(twiml.toString());
      }

      const payload = user.pending_payload || {};
      const clientName = payload.clientName || null;
      const amount = payload.amount || null;
      const toPhone = payload.toPhone || null;

      const preview = buildReminderText({ clientName, amount, tone });

      await updateUser(phone, {
        pending_action: "remind_confirm_send",
        pending_payload: { clientName, amount, tone, preview, toPhone },
      });

      twiml.message(
        `📩 *Mensaje sugerido (${tone})*\n\n${preview}\n\n¿Lo envío ahora?\nResponde: "sí" o "cancelar"`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (user.pending_action === "remind_confirm_send") {
      const ans = body.trim().toLowerCase();
      if (ans !== "sí" && ans !== "si" && ans !== "cancelar") {
        twiml.message(`Responde "sí" para enviar o "cancelar" para abortar.`);
        return res.type("text/xml").send(twiml.toString());
      }

      if (ans === "cancelar") {
        await updateUser(phone, { pending_action: null, pending_payload: null });
        twiml.message("Cancelado ✅");
        return res.type("text/xml").send(twiml.toString());
      }

      const payload = user.pending_payload || {};
      const clientName = payload.clientName || null;
      const preview = payload.preview || "";
      const toPhone = payload.toPhone || null;

      // Si no hay teléfono guardado → copy/paste
      if (!toPhone) {
        await updateUser(phone, { pending_action: null, pending_payload: null });
        twiml.message(
          `✅ Listo. Aquí tienes el mensaje para enviar a *${
            clientName || "tu cliente"
          }*:\n\n${preview}`
        );
        return res.type("text/xml").send(twiml.toString());
      }

      // Envío automático
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const fromWa = process.env.TWILIO_WHATSAPP_FROM;

      if (!accountSid || !authToken || !fromWa) {
        throw new Error(
          "Missing Twilio env vars (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_WHATSAPP_FROM)"
        );
      }

      const twilioClient = twilio(accountSid, authToken);

      await twilioClient.messages.create({
        from: fromWa,
        to: toPhone,
        body: preview,
      });

      await updateUser(phone, { pending_action: null, pending_payload: null });

      twiml.message(`✅ Enviado a *${clientName || "tu cliente"}* (${toPhone}).`);
      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // 1) REGLAS DIRECTAS
    // =========================
    if (/¿?\s*quién\s+me\s+debe\s*\??/i.test(body)) {
      const debts = await listPendingDebts(user.id);

      if (!debts.length) {
        twiml.message("✅ No tienes deudas registradas por cobrar.");
        return res.type("text/xml").send(twiml.toString());
      }

      const lines = debts.map((d, i) => {
        const amt = Number(d.amount_due || 0).toLocaleString("es-MX", {
          style: "currency",
          currency: "MXN",
        });
        const since = d.due_text ? ` (desde ${d.due_text})` : "";
        return `${i + 1}) ${d.client_name}: ${amt}${since}`;
      });

      twiml.message("📌 Te deben:\n" + lines.join("\n"));
      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // C1) GUARDAR TELÉFONO DE CLIENTE
    // Ej: "Guarda teléfono de Juan +5218331112222"
    // =========================
    const mSave = body.match(
      /guarda(?:r)?\s+(?:el\s+)?tel(?:e|é)fono\s+de\s+(.+?)\s+(\+?\d[\d\s-]{7,})$/i
    );
    if (mSave) {
      const clientName = mSave[1].trim();
      const rawPhone = mSave[2].trim();
      const wa = normalizeWhatsAppTo(rawPhone);

      const client = await findClientByName(user.id, clientName);
      if (!client) {
        twiml.message(
          `No encontré al cliente "${clientName}". Primero registra una deuda, por ejemplo: "${clientName} me debe 500".`
        );
        return res.type("text/xml").send(twiml.toString());
      }

      const updated = await setClientPhone(user.id, clientName, wa);
      twiml.message(
        `✅ Listo. Guardé el WhatsApp de *${updated.name}* como:\n${updated.phone}\n\nAhora puedes: "Manda recordatorio a ${updated.name}"`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // 2) OPENAI PARSER
    // =========================
    const parsed = await parseMessage(body);

    // =========================
    // 3) LISTAR
    // =========================
    if (parsed.intent === "list_debts") {
      const debts = await listPendingDebts(user.id);

      if (!debts.length) {
        twiml.message("✅ No tienes deudas registradas por cobrar.");
        return res.type("text/xml").send(twiml.toString());
      }

      const lines = debts.map((d, i) => {
        const amt = Number(d.amount_due || 0).toLocaleString("es-MX", {
          style: "currency",
          currency: "MXN",
        });
        const since = d.due_text ? ` (desde ${d.due_text})` : "";
        return `${i + 1}) ${d.client_name}: ${amt}${since}`;
      });

      twiml.message("📌 Te deben:\n" + lines.join("\n"));
      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // 4) AGREGAR DEUDA
    // =========================
    if (parsed.intent === "add_debt") {
      const clientName = parsed.client_name || "Cliente";
      let amount = parsed.amount_due;

      // Normaliza montos tipo 2k / 2 mil
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
        twiml.message(
          `¿Te refieres a $${amount} o $${amount * 1000}? Responde "${amount}" o "${amount}k".`
        );
        return res.type("text/xml").send(twiml.toString());
      }

      if (!amount) {
        twiml.message(
          `No pude identificar el monto. Ejemplos:\n` +
            `• "Juan me debe 8500 desde el 3 de mayo"\n` +
            `• "me deben 2k"\n` +
            `• "Pedro quedó a deber 300"`
        );
        return res.type("text/xml").send(twiml.toString());
      }

      const since = parsed.since_text || null;

      await upsertClient(user.id, clientName);


      const debt = await addDebt(user.id, clientName, amount, since);
      const amt = Number(debt.amount_due).toLocaleString("es-MX", {
        style: "currency",
        currency: "MXN",
      });

      twiml.message(
        `Registrado ✅\n` +
          `• Cliente: ${debt.client_name}\n` +
          `• Monto: ${amt}\n` +
          (debt.due_text ? `• Desde: ${debt.due_text}\n\n` : `\n`) +
          `¿Quieres agregar otro o preguntar "¿Quién me debe?"`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // 5) PRIORIZAR
    // =========================
    if (parsed.intent === "prioritize") {
      const debts = await listPendingDebts(user.id);

      if (!debts.length) {
        twiml.message("✅ No tienes deudas registradas por cobrar.");
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

      const amt = Number(top.amount_due || 0).toLocaleString("es-MX", {
        style: "currency",
        currency: "MXN",
      });

      twiml.message(
        `📌 *Recomendación de cobranza*\n\n` +
          `Cobra primero a *${top.client_name}* por *${amt}*` +
          (top.due_text ? ` (desde ${top.due_text})` : "") +
          `.\n` +
          (top.days ? `Prioridad por atraso estimado: ~${top.days} días.` : "")
      );

      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // C) INICIAR RECORDATORIO GUIADO
    // =========================
    if (parsed.intent === "remind") {
  const clientName = parsed.client_name || null;

  if (!clientName) {
    twiml.message(
      `¿A quién le mando el recordatorio?\n` +
      `Ejemplo: "Manda recordatorio a Federico"`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  // 1) Buscar teléfono en clients
  const client = await findClientByName(user.id, clientName);

  if (!client || !client.phone) {
    twiml.message(
      `No tengo el teléfono de "${clientName}".\n\n` +
      `Guárdalo así:\n` +
      `Guarda teléfono de ${clientName} +52XXXXXXXXXX`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  // 2) Normaliza a formato Twilio WhatsApp (whatsapp:+52...)
  const rawPhone = String(client.phone).trim();
  const digits = rawPhone.replace(/[^\d+]/g, ""); // quita espacios, guiones, etc.
  const e164 =
    digits.startsWith("+") ? digits : `+${digits}`; // por si guardaron 521...
  const toPhone = e164.startsWith("whatsapp:")
    ? e164
    : `whatsapp:${e164}`;

  // 3) Intenta incluir monto + antigüedad si existe una deuda pendiente para ese cliente
  let debtLine = "";
  try {
    const debts = await listPendingDebts(user.id);
    const match = debts.find(
      (d) => String(d.client_name || "").toLowerCase() === String(clientName).toLowerCase()
    );

    if (match) {
      const amt = Number(match.amount_due || 0).toLocaleString("es-MX", {
        style: "currency",
        currency: "MXN",
      });
      debtLine =
        `\n\nDeuda registrada: ${amt}` +
        (match.due_text ? ` (desde ${match.due_text})` : "");
    }
  } catch (_) {
    // si algo falla aquí, no bloqueamos el envío
  }

  // 4) Enviar WhatsApp vía Twilio
  // === TONO (amable | firme | urgente) ===
// Se detecta desde el texto original del usuario.
// Ejemplos: "Manda recordatorio firme a Juan", "manda recordatorio urgente a Federico"
const t = body.toLowerCase();
const tone =
  /\burgente\b/.test(t) ? "urgente" :
  /\bfirme\b/.test(t) ? "firme" :
  "amable";

// 4) Plantillas por tono
const templates = {
  amable: (name, debtLine) =>
    `Hola ${name} 👋\n` +
    `Solo para recordarte un pago pendiente. ¿Me confirmas cuándo podrías cubrirlo?` +
    debtLine,

  firme: (name, debtLine) =>
    `Hola ${name}.\n` +
    `Te escribo para solicitar el pago pendiente. Por favor indícame hoy mismo cuándo lo vas a liquidar.` +
    debtLine,

  urgente: (name, debtLine) =>
    `Hola ${name}.\n` +
    `⚠️ Urgente: necesito que regularices el pago pendiente hoy. Confírmame en este momento hora/fecha de pago.` +
    debtLine,
};

const msg = templates[tone](clientName, debtLine);

  twiml.message(`✅ Listo. Envié un recordatorio *${tone}* a *${clientName}*.`);

  return res.type("text/xml").send(twiml.toString());
}



    // =========================
    // 6) AYUDA
    // =========================
    if (parsed.intent === "help") {
      twiml.message(
        `Así te ayudo:\n` +
          `1) "Juan me debe 8500 desde el 3 de mayo"\n` +
          `2) "¿Quién me debe?"\n` +
          `3) "¿A quién cobro primero?"\n` +
          `\nTambién entiendo: "me deben 2k".\n` +
          `Y para guardar teléfono: "Guarda teléfono de Juan +5218..."`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // =========================
    // DEFAULT
    // =========================
    twiml.message(
      `Te leo. Prueba:\n` +
        `• "Juan me debe 8500 desde el 3 de mayo"\n` +
        `• "¿Quién me debe?"\n` +
        `• "¿A quién cobro primero?"\n` +
        `• "Guarda teléfono de Juan +5218..."\n` +
        `• "Manda recordatorio a Juan"`
    );
    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Webhook error:", err);
    twiml.message("❌ Ocurrió un error. Revisa los logs del servidor.");
    return res.type("text/xml").send(twiml.toString());
  }
});

app.get("/cron/reminders", async (req, res) => {
  try {
    if (!process.env.CRON_SECRET || req.query.key !== process.env.CRON_SECRET) {
      return res.status(401).send("unauthorized");
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromWa = process.env.TWILIO_WHATSAPP_FROM;

    if (!accountSid || !authToken || !fromWa) {
      return res.status(500).send("missing twilio env");
    }

    const client = twilio(accountSid, authToken);

    const due = await listDueReminders(50);
    let sent = 0;

    for (const r of due) {
      try {
        await client.messages.create({
          from: fromWa,
          to: r.to_phone,
          body: r.message,
        });
        await markReminderSent(r.id);
        sent++;
      } catch (e) {
        console.error("Send reminder failed:", r.id, e?.message || e);
        await markReminderFailed(r.id);
      }
    }

    return res.send(`ok sent=${sent} due=${due.length}`);
  } catch (err) {
    console.error("Cron error:", err);
    return res.status(500).send("error");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log("Server running on port", port, "—", VERSION)
);
