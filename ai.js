// ai.js
const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/**
 * Devuelve un objeto JSON con:
 *  - intent: add_debt | list_debts | prioritize | remind | help | unknown
 *  - client_name (opcional)
 *  - amount_due (opcional number)
 *  - since_text (opcional string)
 *  - remind_when_text (opcional string: "mañana", "hoy", "en 2 días")
 *  - tone (opcional: "amable" | "firme" | "formal")
 */
async function parseMessage(userText) {
  if (!process.env.OPENAI_API_KEY) {
    return { intent: "unknown" };
  }

  const system = `
Eres un parser para un asistente de cobranza por WhatsApp en México (micro/pyme informal).
Tu trabajo es convertir mensajes informales a un JSON ESTRICTO.

Reglas:
- Responde ÚNICAMENTE con JSON válido (sin markdown, sin texto extra).
- Si el usuario pide "¿Quién me debe?" -> intent="list_debts"
- Si el usuario describe una deuda ("Juan me debe 8500", "me deben 2k", "Pedro quedó a deber 300") -> intent="add_debt"
- Si el usuario pide "¿A quién cobro primero?" o similar -> intent="prioritize"
- Si el usuario pide recordar/cobrar ("Recuérdale a Juan mañana") -> intent="remind"
- Si el usuario pide ayuda -> intent="help"
- Si falta el monto en add_debt, deja amount_due = null
- Interpreta "2k" como 2000. "8,5" no lo uses; si no es claro, null.
- client_name: intenta extraer nombre corto ("Juan", "Juan Pérez"). Si no hay, null.
- since_text: extrae lo que sigue a "desde..." si existe.
- Para recordatorios, remind_when_text: "mañana", "hoy", "en 3 días", etc. Si no hay, null.
- tone: si el usuario pide "amable/firme/formal", inclúyelo; si no, null.

Formato EXACTO:
{
  "intent": "add_debt|list_debts|prioritize|remind|help|unknown",
  "client_name": string|null,
  "amount_due": number|null,
  "since_text": string|null,
  "remind_when_text": string|null,
  "tone": "amable|firme|formal"|null
}
`.trim();

  const user = `Mensaje: ${userText}`;

  const resp = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
  });

  const content = resp.choices?.[0]?.message?.content?.trim() || "{}";

  // Parse robusto
  try {
    const obj = JSON.parse(content);
    if (!obj || typeof obj !== "object") return { intent: "unknown" };

    // Normaliza intent
    const allowed = new Set(["add_debt", "list_debts", "prioritize", "remind", "help", "unknown"]);
    if (!allowed.has(obj.intent)) obj.intent = "unknown";

    // Normaliza campos
    if (!("client_name" in obj)) obj.client_name = null;
    if (!("amount_due" in obj)) obj.amount_due = null;
    if (!("since_text" in obj)) obj.since_text = null;
    if (!("remind_when_text" in obj)) obj.remind_when_text = null;
    if (!("tone" in obj)) obj.tone = null;

    // amount_due debe ser number o null
    if (obj.amount_due !== null && typeof obj.amount_due !== "number") obj.amount_due = null;

    return obj;
  } catch {
    return { intent: "unknown" };
  }
}

module.exports = { parseMessage };
