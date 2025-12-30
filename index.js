// index.js — FlowSense (hardened production MVP)
// v-2025-12-29-HARDENED-1

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

const VERSION = "v-2025-12-29-HARDENED-1";

/* =========================
   CONFIG HARDENING
========================= */
const WEBHOOK_TIMEOUT_MS = 8000;
const PARSE_TIMEOUT_MS = 3500;

/* =========================
   HELPERS
========================= */
function withTimeout(promise, ms, label = "timeout") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label)), ms)
    ),
  ]);
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
  return String(s || "").trim().replace(/\s+/g, " ");
}

function isYes(text) {
  const t = normalizeText(text).toLowerCase();
  return ["si", "sí", "simon", "ok", "dale", "enviar", "manda", "confirmo"].includes(t);
}

function isNo(text) {
  const t = normalizeText(text).toLowerCase();
  return ["no", "cancelar", "cancela", "alto", "detener"].includes(t);
}

function log(event, data = {}) {
  console.log(`[${event}]`, JSON.stringify(data));
}

async function safeResetPending(phone) {
  try {
    await updateUser(phone, { pending_action: null, pending_payload: null });
  } catch (_) {}
}

/* =========================
   HEALTH
========================= */
app.get("/health", (_, res) => res.send(`ok ${VERSION}`));

/* =========================
   WEBHOOK
========================= */
app.post("/webhook/whatsapp", async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  const from = req.body.From;
  const body = String(req.body.Body || "").trim();

  log("INCOMING", { from, body });

  try {
    await withTimeout(
      (async () => {
        const phone = from;
        const user = await getOrCreateUser(phone);

        if (!user.seen_onboarding) {
          await updateUser(phone, { seen_onboarding: true });
          twiml.message(
            `👋 Soy FlowSense.\n\nPrueba:\n` +
              `• "Juan me debe 8500 desde el 3 de mayo"\n` +
              `• "¿Quién me debe?"\n` +
              `• "¿A quién cobro primero?"\n` +
              `• "Guarda teléfono de Juan +5218..."\n` +
              `• "Manda recordatorio a Juan"`
          );
          return;
        }

        if (isNo(body)) {
          await safeResetPending(phone);
          twiml.message("Cancelado ✅");
          return;
        }

        /* =========================
           PARSER (timeout protegido)
        ========================= */
        let parsed;
        try {
          parsed = await withTimeout(
            parseMessage(body),
            PARSE_TIMEOUT_MS,
            "parse_timeout"
          );
        } catch (err) {
          log("PARSE_ERROR", { error: err.message });
          twiml.message("⚠️ No te entendí bien. ¿Puedes intentar con otra frase?");
          return;
        }

        log("INTENT", { intent: parsed.intent });

        /* =========================
           RECORDATORIO
        ========================= */
        if (parsed.intent === "remind") {
          const clientName = parsed.client_name;
          if (!clientName) {
            twiml.message(`¿A quién? Ejemplo: "Manda recordatorio a Juan"`);
            return;
          }

          let toPhone = null;
          const client = await findClientByName(user.id, clientName);
          if (client?.phone) toPhone = client.phone;

          await updateUser(phone, {
            pending_action: "remind_choose_tone",
            pending_payload: { clientName, toPhone },
          });

          twiml.message(
            `¿Qué tono quieres?\n• amable\n• firme\n• urgente\n\n(O escribe "cancelar")`
          );
          return;
        }

        /* =========================
           DEFAULT
        ========================= */
        twiml.message(
          `Te leo 👀\nPrueba:\n` +
            `• "Juan me debe 8500 desde el 3 de mayo"\n` +
            `• "¿Quién me debe?"\n` +
            `• "Manda recordatorio a Juan"`
        );
      })(),
      WEBHOOK_TIMEOUT_MS,
      "webhook_timeout"
    );

    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    log("WEBHOOK_FATAL", { error: err.message });
    twiml.message("⚠️ Tuve un problema temporal. Intenta de nuevo.");
    return res.type("text/xml").send(twiml.toString());
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000, "—", VERSION);
});
