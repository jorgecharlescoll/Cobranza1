require("dotenv").config();

const express = require("express");
const twilio = require("twilio");

const {
  getOrCreateUser,
  addDebt,
  listPendingDebts,
  createReminder,
  listDueReminders,
  markReminderSent,
  markReminderFailed,
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

  // mañana
  if (t.includes("mañana")) {
    base.setDate(base.getDate() + 1);
    base.setHours(defaultHour, 0, 0, 0);
    return base;
  }

  // hoy
  if (t.includes("hoy")) {
    base.setHours(defaultHour, 0, 0, 0);
    if (base <= now) base.setHours(now.getHours() + 1, 0, 0, 0);
    return base;
  }

  // en N dias
  const m = t.match(/en\s+(\d+)\s+d[ií]as?/);
  if (m) {
    const n = parseInt(m[1], 10);
    base.setDate(base.getDate() + (Number.isFinite(n) ? n : 1));
    base.setHours(defaultHour, 0, 0, 0);
    return base;
  }

  // viernes / lunes / etc
  if (t.includes("lunes")) return nextWeekdayDate(1, defaultHour);
  if (t.includes("martes")) return nextWeekdayDate(2, defaultHour);
  if (t.includes("miércoles") || t.includes("miercoles")) return nextWeekdayDate(3, defaultHour);
  if (t.includes("jueves")) return nextWeekdayDate(4, defaultHour);
  if (t.includes("viernes")) return nextWeekdayDate(5, defaultHour);
  if (t.includes("sábado") || t.includes("sabado")) return nextWeekdayDate(6, defaultHour);
  if (t.includes("domingo")) return nextWeekdayDate(0, defaultHour);

  // si no entiende, por defecto: en 2 horas
  const fallback = new Date(now);
  fallback.setHours(now.getHours() + 2, 0, 0, 0);
  return fallback;
}


app.post("/webhook/whatsapp", async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    console.log("Incoming:", { from, body });

    // Identificar usuario por teléfono
    const phone = from || "whatsapp:unknown";
    const user = await getOrCreateUser(phone);

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

      // Confirmación si aún es ambiguo
      if (/\b(k|mil)\b/i.test(body) && amount && amount < 1000) {
        twiml.message(
          `¿Te refieres a $${amount} o $${amount * 1000}? ` +
            `Responde "${amount}" o "${amount}k".`
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

      debts.sort((a, b) => Number(b.amount_due || 0) - Number(a.amount_due || 0));
      const top = debts[0];

      const amt = Number(top.amount_due || 0).toLocaleString("es-MX", {
        style: "currency",
        currency: "MXN",
      });

      twiml.message(
        `📌 Cobra primero a *${top.client_name}* por *${amt}*` +
          (top.due_text ? ` (desde ${top.due_text})` : "") +
          `.`
      );
      return res.type("text/xml").send(twiml.toString());
    }


if (parsed.intent === "remind") {
  const defaultHour = Number(process.env.DEFAULT_REMIND_HOUR || 10);

  // ¿a quién? MVP: te recordamos a TI (al mismo WhatsApp que escribió)
  const toPhone = from;

  // qué cliente (si lo detectó)
  const clientName = parsed.client_name || null;

  // cuándo
  const whenText = parsed.remind_when_text || body;
  const remindAt = parseWhen(whenText, defaultHour);

  // mensaje que se enviará
  const msg =
    clientName
      ? `👋 Recordatorio: cobrarle a ${clientName}.`
      : `👋 Recordatorio: revisar tus cobros pendientes.`;

  const r = await createReminder({
    userId: user.id,
    toPhone,
    clientName,
    amountDue: null,
    remindAt,
    message: msg,
  });

  twiml.message(
    `⏰ Listo. Te lo recordaré ` +
      `el ${r.remind_at ? new Date(r.remind_at).toLocaleString("es-MX") : "pronto"}.\n` +
      (clientName ? `• Cliente: ${clientName}` : "")
  );
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
          `\nTambién entiendo: "me deben 2k".`
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
        `• "¿A quién cobro primero?"`
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
