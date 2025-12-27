require("dotenv").config();

const express = require("express");
const twilio = require("twilio");

const { getOrCreateUser, addDebt, listPendingDebts } = require("./db");

const app = express();
app.use(express.urlencoded({ extended: false }));

const VERSION = "v-2025-12-25-SUPABASE-1";

const { parseMessage } = require("./ai");


// Util: parseo simple de monto (ej: 8500, 8,500, $8,500.00)
function parseAmount(text) {
  if (!text) return null;
  const m = text.match(/(\$?\s*\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\$?\s*\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const raw = m[0].replace(/\$/g, "").replace(/\s/g, "").replace(/,/g, "");
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

// Util: intenta extraer nombre del cliente (muy simple)
function parseClientName(text) {
  // "Juan me debe 8500..." -> "Juan"
  const m = text.match(/^([a-záéíóúñü\s]+?)\s+me\s+debe/i);
  if (!m) return null;
  return m[1].trim().replace(/\s+/g, " ");
}

// Util: extrae "desde ..." si existe
function parseSince(text) {
  const m = text.match(/\bdesde\b\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

app.get("/health", (_, res) => res.send(`ok ${VERSION}`));

app.post("/webhook/whatsapp", async (req, res) => {
  const from = req.body.From;   // "whatsapp:+52..."
  const body = (req.body.Body || "").trim();

  // Respuesta Twilio
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    console.log("Incoming:", { from, body });

    // Identidad (telefono)
    const phone = from || "whatsapp:unknown";
    const user = await getOrCreateUser(phone);

    // 1) ¿Quién me debe?
    if (/quien\s+me\s+debe/i.test(body) || /¿quién\s+me\s+debe/i.test(body)) {
      const debts = await listPendingDebts(user.id);
      if (!debts.length) {
        twiml.message("✅ No tienes deudas registradas por cobrar.");
        return res.type("text/xml").send(twiml.toString());
      }

      const lines = debts.map((d, i) => {
        const amt = Number(d.amount_due || 0).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
        const since = d.due_text ? ` (desde ${d.due_text})` : "";
        return `${i + 1}) ${d.client_name}: ${amt}${since}`;
      });

      twiml.message("📌 Te deben:\n" + lines.join("\n"));
      return res.type("text/xml").send(twiml.toString());
    }

    // 2) Registrar deuda: "Juan me debe 8500 desde el 3 de mayo"
    if (/me\s+debe/i.test(body)) {
      const client = parseClientName(body) || "Cliente";
      const amount = parseAmount(body);
      const since = parseSince(body);

      if (!amount) {
        twiml.message(
          `No pude identificar el monto. Ejemplo:\n` +
          `• "Juan me debe 8500 desde el 3 de mayo"\n` +
          `• "María me debe $2,000 desde ayer"`
        );
        return res.type("text/xml").send(twiml.toString());
      }

      const debt = await addDebt(user.id, client, amount, since);

      const amt = Number(debt.amount_due).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
      twiml.message(
        `Registrado ✅\n` +
        `• Cliente: ${debt.client_name}\n` +
        `• Monto: ${amt}\n` +
        (debt.due_text ? `• Desde: ${debt.due_text}\n\n` : `\n`) +
        `¿Quieres agregar otro o me preguntas "¿Quién me debe?"`
      );
      return res.type("text/xml").send(twiml.toString());
    }

   // Fallback: OpenAI parser (solo si no cayó en reglas simples)
const parsed = await parseMessage(body);

if (parsed.intent === "list_debts") {
  const debts = await listPendingDebts(user.id);
  if (!debts.length) {
    twiml.message("✅ No tienes deudas registradas por cobrar.");
    return res.type("text/xml").send(twiml.toString());
  }
  const lines = debts.map((d, i) => {
    const amt = Number(d.amount_due || 0).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
    const since = d.due_text ? ` (desde ${d.due_text})` : "";
    return `${i + 1}) ${d.client_name}: ${amt}${since}`;
  });
  twiml.message("📌 Te deben:\n" + lines.join("\n"));
  return res.type("text/xml").send(twiml.toString());
}

if (parsed.intent === "add_debt") {
  const clientName = parsed.client_name || "Cliente";
  let amount = parsed.amount_due;

// Post-proceso: entiende "2k", "2 mil", "2,5k", "1.2k"
if (!amount) {
  // Si OpenAI no dio número, intentamos extraer nosotros
  const m = body.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(k|mil)\b/);
  if (m) {
    const n = Number(m[1].replace(",", "."));
    if (Number.isFinite(n)) amount = Math.round(n * 1000);
  }
} else {
  // Si dio un número pequeño y el texto trae k/mil, corrige
  const hasK = /\b(k|mil)\b/i.test(body);
  if (hasK && amount < 1000) amount = Math.round(amount * 1000);
}

// Guardrail: si detectamos k/mil pero sigue quedando muy bajo, pide confirmación
if (/\b(k|mil)\b/i.test(body) && amount && amount < 1000) {
  twiml.message(`¿Te refieres a $${amount} o $${amount * 1000}? Responde: "${amount}" o "${amount}k"`);
  return res.type("text/xml").send(twiml.toString());
}

  const since = parsed.since_text || null;

  if (!amount) {
    twiml.message(
      `No pude identificar el monto. Ejemplo:\n` +
      `• "Juan me debe 8500 desde el 3 de mayo"\n` +
      `• "María me debe 2k desde ayer"`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  const debt = await addDebt(user.id, clientName, amount, since);
  const amt = Number(debt.amount_due).toLocaleString("es-MX", { style: "currency", currency: "MXN" });

  twiml.message(
    `Registrado ✅\n` +
    `• Cliente: ${debt.client_name}\n` +
    `• Monto: ${amt}\n` +
    (debt.due_text ? `• Desde: ${debt.due_text}\n\n` : `\n`) +
    `¿Quieres agregar otro o me preguntas "¿Quién me debe?"`
  );
  return res.type("text/xml").send(twiml.toString());
}

if (parsed.intent === "prioritize") {
  // MVP: recomendación simple usando deudas pendientes (monto + antigüedad textual si existe)
  const debts = await listPendingDebts(user.id);
  if (!debts.length) {
    twiml.message("✅ No tienes deudas registradas por cobrar.");
    return res.type("text/xml").send(twiml.toString());
  }

  // Heurística MVP: mayor monto primero
  debts.sort((a, b) => Number(b.amount_due || 0) - Number(a.amount_due || 0));
  const top = debts[0];
  const amt = Number(top.amount_due || 0).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
  twiml.message(`📌 Cobra primero a *${top.client_name}* por *${amt}*.` + (top.due_text ? ` (desde ${top.due_text})` : ""));
  return res.type("text/xml").send(twiml.toString());
}

if (parsed.intent === "help") {
  twiml.message(
    `Así te ayudo:\n` +
    `1) Registra: "Juan me debe 8500 desde el 3 de mayo"\n` +
    `2) Consulta: "¿Quién me debe?"\n` +
    `3) Prioriza: "¿A quién cobro primero?"\n` +
    `\nTip: también entiendo "me deben 2k" o "Pedro quedó a deber 300".`
  );
  return res.type("text/xml").send(twiml.toString());
}

// Default final
twiml.message(
  `Te leo. Prueba:\n` +
  `• "Juan me debe 8500 desde el 3 de mayo"\n` +
  `• "¿Quién me debe?"\n` +
  `• "¿A quién cobro primero?"`
);
return res.type("text/xml").send(twiml.toString());

  } catch (err) {
    console.error("Webhook error:", err);
    twiml.message("❌ Ocurrió un error. Revisa la consola del servidor (logs) y tu DATABASE_URL.");
    return res.type("text/xml").send(twiml.toString());
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port, "—", VERSION));
