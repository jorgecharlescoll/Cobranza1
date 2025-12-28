// cron-reminders.js
// Envía al DUEÑO (user.phone) un resumen de deudas pendientes.
// Diseñado para ejecutarse como Render Cron Job.

require("dotenv").config();

const twilio = require("twilio");
const { pool } = require("./db");

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

// En Twilio Sandbox suele ser: whatsapp:+14155238886
const TWILIO_WHATSAPP_FROM =
  process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";

// Evita mandar la misma deuda muchas veces (cooldown por deuda)
const DEFAULT_COOLDOWN_HOURS = Number(process.env.REMINDER_COOLDOWN_HOURS || 20);

// Cuántas deudas máximo incluir en el mensaje
const MAX_ITEMS = Number(process.env.REMINDER_MAX_ITEMS || 5);

// Paso A: ocultar montos muy pequeños del resumen (solo UX; no borra datos)
const MIN_AMOUNT_TO_SHOW = Number(process.env.REMINDER_MIN_AMOUNT || 50);

function fmtMoney(n) {
  try {
    return new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: "MXN",
    }).format(Number(n || 0));
  } catch {
    return `$${Number(n || 0).toFixed(2)}`;
  }
}

async function ensureTables() {
  // Tabla para registrar envíos y evitar duplicados en el tiempo
  await pool.query(`
    create table if not exists public.reminder_logs (
      id bigserial primary key,
      user_id bigint not null,
      debt_id bigint not null,
      sent_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create index if not exists reminder_logs_user_debt_sent_idx
    on public.reminder_logs (user_id, debt_id, sent_at desc);
  `);
}

async function pickDebtsToRemind() {
  // Selecciona deudas pending, y evita recordar la misma deuda si ya se recordó en las últimas N horas.
  const { rows } = await pool.query(
    `
    select
      u.id as user_id,
      u.phone as user_phone,
      d.id as debt_id,
      d.client_name,
      d.amount_due,
      d.due_text,
      d.created_at
    from public.users u
    join public.debts d on d.user_id = u.id
    where d.status = 'pending'
      and not exists (
        select 1
        from public.reminder_logs rl
        where rl.user_id = u.id
          and rl.debt_id = d.id
          and rl.sent_at > now() - ($1 || ' hours')::interval
      )
    order by d.created_at asc
    limit 200;
    `,
    [String(DEFAULT_COOLDOWN_HOURS)]
  );

  // Agrupar por usuario
  const byUser = new Map();
  for (const r of rows) {
    const key = r.user_id;
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(r);
  }
  return byUser;
}

function buildMessageForUser(items) {
  // PASO A: limpiar resumen
  // 1) filtra montos pequeños
  const filtered = items.filter(
    (it) => Number(it.amount_due || 0) >= MIN_AMOUNT_TO_SHOW
  );

  // si queda vacío, usa la lista original para no mandar mensaje sin contenido
  const baseList = filtered.length ? filtered : items;

  // 2) top N
  const top = baseList.slice(0, MAX_ITEMS);

  // 3) total de lo mostrado
  const total = top.reduce((sum, it) => sum + Number(it.amount_due || 0), 0);

  let msg = `📌 *Recordatorio de cobranza (hoy)*\n\n`;
  msg += `Tengo estas deudas pendientes que conviene revisar:\n`;

  for (const it of top) {
    const name =
      it.client_name && it.client_name.trim() && it.client_name !== "Cliente"
        ? it.client_name
        : "Cliente (sin nombre)";

    const since = it.due_text ? ` (desde: ${it.due_text})` : "";
    msg += `• *${name}*: ${fmtMoney(it.amount_due)}${since}\n`;
  }

  if (baseList.length > top.length) {
    msg += `\n(+${baseList.length - top.length} más pendientes)\n`;
  }

  msg += `\n💰 *Total recuperable hoy (de este resumen):* ${fmtMoney(total)}\n`;

  msg += `\nResponde aquí con uno de estos:\n`;
  msg += `• "¿A quién cobro primero?"\n`;
  msg += `• "Manda recordatorio a {Nombre}"\n`;
  msg += `• "¿Quién me debe?"\n`;

  return msg;
}

async function sendWhatsApp(to, body) {
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  // users.phone debería ser whatsapp:+52...
  const normalizedTo = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;

  return client.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: normalizedTo,
    body,
  });
}

async function logSent(userId, debtIds) {
  if (!debtIds.length) return;

  const values = [];
  const params = [];
  let i = 1;

  for (const debtId of debtIds) {
    params.push(`($${i++}, $${i++})`);
    values.push(userId, debtId);
  }

  await pool.query(
    `insert into public.reminder_logs (user_id, debt_id) values ${params.join(
      ", "
    )};`,
    values
  );
}

async function main() {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Faltan TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN");
  }

  await ensureTables();

  const byUser = await pickDebtsToRemind();
  let totalMsgs = 0;

  for (const [userId, items] of byUser.entries()) {
    const phone = items[0]?.user_phone;
    if (!phone) continue;

    const message = buildMessageForUser(items);

    // Enviar 1 mensaje por usuario
    await sendWhatsApp(phone, message);

    // Registrar enviados (solo los incluidos en el top)
    const baseList = items.filter(
      (it) => Number(it.amount_due || 0) >= MIN_AMOUNT_TO_SHOW
    );
    const useList = baseList.length ? baseList : items;
    const sentDebtIds = useList.slice(0, MAX_ITEMS).map((x) => x.debt_id);

    await logSent(userId, sentDebtIds);
    totalMsgs += 1;
  }

  console.log(`Cron OK. Mensajes enviados: ${totalMsgs}`);
}

main()
  .catch((err) => {
    console.error("Cron ERROR:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch {}
  });
