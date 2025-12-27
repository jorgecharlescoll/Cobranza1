require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const { getOrCreateUser, updateUser, addDebt, listPendingDebts } = require("./db");

const {
  getOrCreateUser,
  updateUser,
  addDebt,
  listPendingDebts,
} = require("./db");

const app = express();
app.use(express.urlencoded({ extended: false }));

const VERSION = "v-2025-12-25-SUPABASE-1";

// Estado temporal en memoria (solo para flujos tipo “borrador de mensaje”)
const sessions = {}; // sessions[phone] = { pendingDraft: {...} }

function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { pendingDraft: null };
  return sessions[phone];
}

function normalize(text) {
  return (text || "").trim();
}

function parseMoney(text) {
  // Extrae primer número tipo 8500, 8,500, 8500.50
  const m = (text || "").replace(/[, ]/g, "").match(/(\d+(\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function formatMoneyMXN(n) {
  const num = Number(n);
  try {
    return num.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
  } catch {
    return `$${num}`;
  }
}

function extractDebt(text) {
  const raw = (text || "").trim().toLowerCase();

  // Blindaje anti-falsos positivos: preguntas tipo “¿Quién me debe?”
  if (
    raw.includes("?") ||
    raw.startsWith("¿") ||
    raw.startsWith("quien me debe") ||
    raw.startsWith("quién me debe") ||
    raw === "quien me debe" ||
    raw === "quién me debe"
  ) {
    return null;
  }

  const isDebt = /(me debe|debe|a deber|qued[oó] a deber)/i.test(text || "");
  if (!isDebt) return null;

  const amount = parseMoney(text);
  if (!amount) return { error: "No pude identificar el monto." };

  const split = text.split(/me debe|debe|a deber|quedó a deber|quedo a deber/i);
  const name = (split[0] || "").trim().replace(/^[\-–—:]/, "").trim();

  const dueTextMatch = text.match(/desde\s+(.+)$/i);
  const dueText = dueTextMatch ? dueTextMatch[1].trim() : null;

  if (!name) return { error: "No pude identificar el nombre del cliente." };

  return { name, amount, dueText };
}

function priorityScore(debtRow, cashStress) {
  const amount = Number(debtRow.amount_due || 0);
  const stressBoost = (cashStress === 3 || cashStress === 4) ? 1.15 : 1.0;

  const createdAt = debtRow.created_at ? new Date(debtRow.created_at).getTime() : Date.now();
  const days = Math.floor((Date.now() - createdAt) / (1000 * 60 * 60 * 24));

  return (amount * 0.0001) * stressBoost + (days * 0.3);
}

function draftReminder(clientName, amount, dueText, tone) {
  const m = formatMoneyMXN(amount);
  const fecha = dueText ? ` (${dueText})` : "";

  if (tone === "amable") {
    return `Hola ${clientName}, espero estés muy bien.\nSolo para confirmar el pago pendiente de ${m}${fecha}. Quedo atento, muchas gracias.`;
  }
  if (tone === "firme") {
    return `Hola ${clientName}, buen día.\nTe escribo para dar seguimiento al pago pendiente de ${m}${fecha}. Agradezco me confirmes cuándo podríamos contar con él.`;
  }
  return `Hola ${clientName}.\nSeguimos pendientes del pago de ${m}${fecha}. Es importante regularizarlo a la brevedad. Quedo atento.`;
}

app.post("/webhook/whatsapp", async (req, res) => {
  const from = req.body.From; // "whatsapp:+52..."
  const body = normalize(req.body.Body);
  const lower = body.toLowerCase();

  const twiml = new twilio.twiml.MessagingResponse();
  const session = getSession(from);

  try {
    if (!process.env.DATABASE_URL) {
      twiml.message("❌ Falta DATABASE_URL en tu .env. Agrega la conexión de Supabase y reinicia.");
      return res.type("text/xml").send(twiml.toString());
    }

    // Usuario (persistente)
    const user = await getOrCreateUser(from);

    console.log("Incoming:", { from, body, version: VERSION });

    // ==== Menú / ayuda ====
    if (lower === "ayuda" || lower === "menu" || lower === "menú") {
      twiml.message(
        `FlowSense (${VERSION})\n\n` +
        `Comandos:\n` +
        `• Registrar deuda: "Juan Pérez me debe 8500 desde el 3 de mayo"\n` +
        `• Ver deudores: "¿Quién me debe?"\n` +
        `• Prioridad: "¿A quién cobro primero?"\n` +
        `• Recordatorio: "Manda recordatorio a Juan Pérez"\n\n` +
        `Si quieres reiniciar onboarding: "empezar"`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // ==== Reiniciar onboarding ====
    if (lower === "empezar" || lower === "inicio" || lower === "start") {
      await updateUser(from, {
        onboarding_step: 1,
        monthly_sales_est: null,
        cash_stress: null,
      });
      twiml.message("Perfecto. Aproximadamente, ¿cuánto vendes al mes? (solo un estimado numérico)");
      return res.type("text/xml").send(twiml.toString());
    }

    // ==== Confirmación de borrador ====
    if (session.pendingDraft && session.pendingDraft.type === "reminder_final") {
      if (lower === "enviar") {
        session.pendingDraft = null;
        twiml.message("Listo ✅ Mensaje confirmado. (Por ahora listo para copiar/pegar; envío automatizado después).");
        return res.type("text/xml").send(twiml.toString());
      }
      if (lower === "cancelar") {
        session.pendingDraft = null;
        twiml.message("Cancelado. ¿Qué hacemos ahora? (deudores / prioridad / recordatorio)");
        return res.type("text/xml").send(twiml.toString());
      }

      // Si escribe algo distinto, lo tratamos como “edición”
      const edited = body;
      twiml.message(
        "Perfecto. Usa este texto editado. ¿Lo confirmamos?\n\n" +
        edited +
        "\n\nResponde:\n✅ Enviar\n❌ Cancelar"
      );
      // Mantenemos el estado como confirmación final
      session.pendingDraft = { type: "reminder_final" };
      return res.type("text/xml").send(twiml.toString());
    }

    // ==== Onboarding (persistente) ====
    if (user.onboarding_step === 0) {
      await updateUser(from, { onboarding_step: 1 });
      twiml.message(
        `Hola 👋 Soy FlowSense.\n` +
        `Te ayudo a cobrar mejor y a evitar quedarte sin efectivo.\n\n` +
        `Para empezar: ¿aprox. cuánto vendes al mes?`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (user.onboarding_step === 1) {
      const sales = parseMoney(body);
      if (!sales) {
        twiml.message('¿Me das un estimado con número? Ej: "80000"');
        return res.type("text/xml").send(twiml.toString());
      }
      await updateUser(from, { monthly_sales_est: sales, onboarding_step: 2 });
      twiml.message("Gracias. ¿Cuántos clientes te deben dinero ahora? (aprox. número)");
      return res.type("text/xml").send(twiml.toString());
    }

    if (user.onboarding_step === 2) {
      const debtCount = parseMoney(body);
      if (!debtCount) {
        twiml.message('Aunque sea aproximado. Ej: "10" o "15"');
        return res.type("text/xml").send(twiml.toString());
      }
      await updateUser(from, { onboarding_step: 3 });
      twiml.message(
        `Última: ¿qué tanto te preocupa quedarte sin efectivo este mes?\n` +
        `1) Nada  2) Poco  3) Bastante  4) Mucho`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (user.onboarding_step === 3) {
      const v = parseInt(body, 10);
      if (![1, 2, 3, 4].includes(v)) {
        twiml.message("Responde con 1, 2, 3 o 4 🙂");
        return res.type("text/xml").send(twiml.toString());
      }
      await updateUser(from, { cash_stress: v, onboarding_step: 4 });

      const risk = (v >= 3) ? "🔴 Riesgo medio/alto" : "🟡 Riesgo moderado";
      twiml.message(
        `Listo ✅\n\n${risk} de falta de efectivo si no entran pagos pendientes.\n` +
        `Empecemos: escribe\n👉 "Juan Pérez me debe 8500 desde el 3 de mayo"\n\n` +
        `También puedes escribir "ayuda".`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // Releer usuario ya con onboarding_step=4 (por si venía de un update)
    const user2 = (user.onboarding_step === 4) ? user : await getOrCreateUser(from);

    // ==== LISTAR DEUDORES (antes de parsear deuda) ====
    if (/(qu[ií]en me debe|deudores|pendientes|clientes con deuda)/i.test(body)) {
      const pending = await listPendingDebts(user2.id);
      if (!pending.length) {
        twiml.message(`Aún no tengo deudas registradas.\nEscribe: "Juan Pérez me debe 8500 desde el 3 de mayo"`);
        return res.type("text/xml").send(twiml.toString());
      }
      const lines = pending
        .slice(0, 10)
        .map((c, i) => {
          const monto = formatMoneyMXN(c.amount_due);
          const since = c.due_text ? ` (desde ${c.due_text})` : "";
          return `${i + 1}) ${c.client_name} – ${monto}${since}`;
        });

      twiml.message("Pendientes:\n" + lines.join("\n") + `\n\nEscribe: "¿A quién cobro primero?"`);
      return res.type("text/xml").send(twiml.toString());
    }

    // ==== PRIORIDAD ====
    if (/(a qui[eé]n cobro|cobro primero|prioridad)/i.test(body)) {
      const pending = await listPendingDebts(user2.id);
      if (!pending.length) {
        twiml.message(`Para priorizar necesito al menos 1 deuda.\nEj: "Juan Pérez me debe 8500 desde el 3 de mayo"`);
        return res.type("text/xml").send(twiml.toString());
      }

      const ranked = [...pending]
        .sort((a, b) => priorityScore(b, user2.cash_stress) - priorityScore(a, user2.cash_stress))
        .slice(0, 3);

      const lines = ranked.map((c) => {
        const reason = Number(c.amount_due) >= 10000 ? "monto alto" : "atraso/impacto en liquidez";
        return `• ${c.client_name} – ${formatMoneyMXN(c.amount_due)} (${reason})`;
      });

      twiml.message(
        `Te recomiendo cobrar primero a:\n${lines.join("\n")}\n\n` +
        `Si quieres: "Manda recordatorio a ${ranked[0].client_name}"`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // ==== RECORDATORIO (inicia flujo de tono) ====
    const remMatch = body.match(/manda recordatorio a\s+(.+)/i) || body.match(/c[oó]brale a\s+(.+)/i);
    if (remMatch) {
      const name = remMatch[1].trim();
      const pending = await listPendingDebts(user2.id);
      const client = pending.find(c => c.client_name.toLowerCase() === name.toLowerCase());

      if (!client) {
        twiml.message(`No encuentro a "${name}" como pendiente.\nEscribe "¿Quién me debe?" para ver la lista.`);
        return res.type("text/xml").send(twiml.toString());
      }

      session.pendingDraft = { type: "reminder_choose_tone", clientName: client.client_name };
      twiml.message(`¿Qué tono quieres?\n1) Amable\n2) Firme\n3) Urgente`);
      return res.type("text/xml").send(twiml.toString());
    }

    // ==== Elegir tono ====
    if (session.pendingDraft && session.pendingDraft.type === "reminder_choose_tone") {
      const tone = (body === "1") ? "amable" : (body === "2") ? "firme" : (body === "3") ? "urgente" : null;
      if (!tone) {
        twiml.message("Responde 1, 2 o 3 🙂");
        return res.type("text/xml").send(twiml.toString());
      }

      const pending = await listPendingDebts(user2.id);
      const client = pending.find(c => c.client_name.toLowerCase() === session.pendingDraft.clientName.toLowerCase());
      if (!client) {
        session.pendingDraft = null;
        twiml.message(`Ya no encuentro esa deuda como pendiente. Escribe "¿Quién me debe?" para verificar.`);
        return res.type("text/xml").send(twiml.toString());
      }

      const msg = draftReminder(client.client_name, client.amount_due, client.due_text, tone);

      session.pendingDraft = { type: "reminder_final" };

      twiml.message(
        `Este es el mensaje:\n\n${msg}\n\n` +
        `Responde:\n✅ Enviar\n✏️ (o escribe tu versión para editar)\n❌ Cancelar`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // ==== Registrar deuda (texto libre) ====
    const debt = extractDebt(body);
    if (debt) {
      if (debt.error) {
        twiml.message(debt.error + `\nEjemplo: "Juan Pérez me debe 8500 desde el 3 de mayo"`);
        return res.type("text/xml").send(twiml.toString());
      }

      await addDebt(user2.id, debt.name, debt.amount, debt.dueText);

      twiml.message(
        `Registrado ✅\n` +
        `• Cliente: ${debt.name}\n` +
        `• Monto: ${formatMoneyMXN(debt.amount)}\n` +
        (debt.dueText ? `• Desde: ${debt.dueText}\n` : "") +
        `\n¿Quieres agregar otro o te digo a quién cobrar primero?`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // ==== Flujo / efectivo (mini) ====
    if (/(flujo|efectivo|me alcanza|n[oó]mina|gastos fijos)/i.test(body)) {
      const pending = await listPendingDebts(user2.id);
      const total = pending.reduce((s, c) => s + Number(c.amount_due || 0), 0);

      if (!pending.length) {
        twiml.message("No tengo deudas registradas aún. Registra una con: 'Juan Pérez me debe 8500 desde el 3 de mayo'");
        return res.type("text/xml").send(twiml.toString());
      }

      const level = (user2.cash_stress >= 3 || total >= 20000) ? "⚠️" : "🟡";
      twiml.message(
        `${level} Pendiente por cobrar aprox: ${formatMoneyMXN(total)}.\n` +
        `Si no entra una parte esta semana, podrías tener presión de liquidez.\n\n` +
        `Escribe: "¿A quién cobro primero?"`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // ==== Default ====
    twiml.message(
      `Te leo. Prueba:\n` +
      `• "Juan Pérez me debe 8500 desde el 3 de mayo"\n` +
      `• "¿Quién me debe?"\n` +
      `• "¿A quién cobro primero?"\n` +
      `• "Manda recordatorio a Juan Pérez"\n` +
      `• "ayuda"`
    );
    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Webhook error:", err);
    twiml.message("❌ Ocurrió un error. Revisa la consola del servidor (logs) y tu DATABASE_URL.");
    return res.type("text/xml").send(twiml.toString());
  }
});

app.get("/health", (_, res) => res.send("ok " + VERSION));

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000, "—", VERSION);
});
