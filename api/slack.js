/*****************************************************************
   Slack Finance Bot – Google Sheets + Gemini (Vercel Version)
*****************************************************************/
const crypto = require("crypto");
const fetch = require("node-fetch");
const { readPendingPayments, readDataForChatbot } = require("./sheets");
const { askGemini } = require("./ai");

/**************************************
  VERIFY SLACK SIGNATURE
**************************************/
function verifySlackRequest(req) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) throw new Error("Missing SLACK_SIGNING_SECRET env");

  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  const rawBody = req.rawBody || "";

  // Prevent replay attacks (5 mins)
  if (Math.abs(Date.now() / 1000 - timestamp) > 60 * 5) {
    throw new Error("Timestamp too old");
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const hash = `v0=${crypto
    .createHmac("sha256", secret)
    .update(base)
    .digest("hex")}`;

  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) {
    throw new Error("Invalid Slack signature");
  }
}

/**************************************
  HELPERS
**************************************/
function fmt(amount) {
  return "€" + Number(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
}

function monthIndex(text = "") {
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  text = text.toLowerCase();
  for (let i = 0; i < 12; i++) {
    if (text.includes(months[i])) return i;
  }
  return null;
}

function daysBetween(date) {
  if (!date) return "-";
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
}

async function sendSlackMessage(channel, blocksOrText) {
  const token = process.env.SLACK_BOT_TOKEN;

  const payload =
    typeof blocksOrText === "string"
      ? { channel, text: blocksOrText }
      : { channel, blocks: blocksOrText };

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

/**************************************
  BUILD BLOCK KIT TABLE
**************************************/
function buildTableBlocks(title, summary, rows) {
  const blocks = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: title },
  });

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: summary },
  });

  blocks.push({ type: "divider" });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Invoice* | *Client* | *Date* | *Days* | *Status* | *Amount*",
    },
  });

  rows.slice(0, 40).forEach((r) => {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`${r.invoiceNo}\` | ${r.client} | ${r.invoiceDate} | ${r.pendingDays} | ${r.status} | ${fmt(r.amount)}`,
      },
    });
  });

  return blocks;
}

/**************************************
  MAIN HANDLER
**************************************/
module.exports = async (req, res) => {
  try {
    req.rawBody = req.body && typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    verifySlackRequest(req);
  } catch (e) {
    return res.status(401).send("Slack verification failed: " + e.message);
  }

  const body = req.body;

  // Slack URL challenge
  if (body.type === "url_verification") {
    return res.json({ challenge: body.challenge });
  }

  /**********************************************
   SLASH COMMAND HANDLER: /finance
  **********************************************/
  if (req.headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
    const text = body.text || "";
    const channel = body.channel_id;

    res.status(200).send("Processing…");

    // async background processing
    (async () => {
      if (text.startsWith("pending")) {
        return await handlePending(text, channel);
      }
      if (text.startsWith("cashflow") || text.startsWith("cash")) {
        return await handleCashflow(text, channel);
      }
      return await sendSlackMessage(channel, "Unknown command.");
    })();

    return;
  }

  /**********************************************
   EVENT HANDLER (mentions, messages)
  **********************************************/
  if (body.event) {
    res.status(200).send("ok"); // immediate ACK

    const evt = body.event;

    if (evt.bot_id) return;

    const channel = evt.channel;
    let text = evt.text || "";
    text = text.replace(/<@[^>]+>/, "").trim();

    await sendSlackMessage(channel, `<@${evt.user}> Processing…`);

    if (/pending/i.test(text)) return await handlePending(text, channel);
    if (/cashflow|cash flow|cash/i.test(text)) return await handleCashflow(text, channel);

    return await sendSlackMessage(channel, "Please type: pending or cashflow");
  }

  res.status(200).send("ok");
};

/**************************************
  PENDING HANDLER
**************************************/
async function handlePending(text, channel) {
  const rows = await readPendingPayments();

  const mapped = rows.map((r) => ({
    invoiceNo: r[0] || "(no)",
    client: r[1] || "",
    invoiceDate: r[3] instanceof Date ? r[3] : new Date(r[3]),
    pendingDays: Number(r[4]) || 0,
    status: r[5] || "",
    amount: Number(String(r[6]).replace(/[^0-9.-]/g, "")) || 0,
  }));

  const mIndex = monthIndex(text);
  let filtered = mapped;

  if (mIndex !== null) {
    filtered = filtered.filter((x) => x.invoiceDate?.getMonth() === mIndex);
  }

  if (!filtered.length) {
    return await sendSlackMessage(channel, `No pending results for "${text}"`);
  }

  const total = filtered.reduce((s, x) => s + x.amount, 0);

  // AI summary
  const summary = await askGemini(
    `Summarize these pending payments. Total: ${fmt(total)}. Count: ${filtered.length}.`
  );

  const blocks = buildTableBlocks("Pending Payments", summary, filtered);
  return await sendSlackMessage(channel, blocks);
}

/**************************************
  CASHFLOW HANDLER
**************************************/
async function handleCashflow(text, channel) {
  const rows = await readDataForChatbot();

  const mapped = rows.map((r) => ({
    invoiceNo: r[0] || "(no)",
    client: r[1] || "",
    invoiceDate: r[2] instanceof Date ? r[2] : new Date(r[2]),
    amount: Number(String(r[3]).replace(/[^0-9.-]/g, "")) || 0,
    paid: Number(String(r[4]).replace(/[^0-9.-]/g, "")) || 0,
    status: r[6] || "",
    pendingDays: daysBetween(r[2] instanceof Date ? r[2] : new Date(r[2])),
  }));

  const mIndex = monthIndex(text);
  let filtered = mapped;

  if (mIndex !== null) {
    filtered = filtered.filter((x) => x.invoiceDate?.getMonth() === mIndex);
  }

  if (!filtered.length) {
    return await sendSlackMessage(channel, `No cashflow results for "${text}"`);
  }

  const totalInv = filtered.reduce((s, x) => s + x.amount, 0);
  const totalPaid = filtered.reduce((s, x) => s + x.paid, 0);

  const summary = await askGemini(
    `Summarize cashflow. Invoiced: ${fmt(totalInv)}, Paid: ${fmt(totalPaid)}, Pending: ${fmt(totalInv - totalPaid)}.`
  );

  const blocks = buildTableBlocks("Cashflow", summary, filtered);
  return await sendSlackMessage(channel, blocks);
}
