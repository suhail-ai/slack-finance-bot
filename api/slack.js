const fetch = require("node-fetch");
const { readPendingPayments, readDataForChatbot } = require("./sheets");
const { askGemini } = require("./ai");

// -------------------------------
// Helpers
// -------------------------------
function fmt(n) {
  return "€" + Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2
  });
}

function parseMonthIndex(text = "") {
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  text = text.toLowerCase();
  for (let i = 0; i < 12; i++) {
    if (text.includes(months[i])) return i;
  }
  return null;
}

function daysBetween(dateObj) {
  if (!dateObj) return "-";
  return Math.floor((Date.now() - dateObj.getTime()) / (1000 * 60 * 60 * 24));
}

async function postMessage(channel, content) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(
      typeof content === "string" ? { channel, text: content } : { channel, blocks: content }
    )
  });
}

// -------------------------------
// Main Slack Handler
// -------------------------------
module.exports = async (req, res) => {

  // Slack URL verification
  if (req.body?.type === "url_verification") {
    return res.json({ challenge: req.body.challenge });
  }

  const contentType = req.headers["content-type"] || "";

  // Slash command
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = req.body;
    const text = (params.text || "").trim();
    const channel = params.channel_id;

    res.status(200).send("Processing…");

    await handleCommand(text, channel);
    return;
  }

  // Events API (app_mention)
  if (req.body?.event) {
    const evt = req.body.event;
    res.status(200).send("ok");

    if (!evt.bot_id) {
      const text = evt.text.replace(/<@[^>]+>/, "").trim();
      await postMessage(evt.channel, "Processing… ⏳");
      await handleCommand(text, evt.channel);
    }
    return;
  }

  res.status(200).send("ok");
};

// -------------------------------
// Command Logic
// -------------------------------
async function handleCommand(text, channel) {
  const lower = text.toLowerCase();

  // ----- Pending Payments -----
  if (lower.includes("pending")) {
    const rows = await readPendingPayments();
    const monthIndex = parseMonthIndex(lower);

    const mapped = rows.map(r => ({
      invoiceNo: r[0] || "(no)",
      client: r[1] || "",
      date: r[3] instanceof Date ? r[3] : new Date(r[3]),
      days: Number(r[4]) || 0,
      status: r[5] || "",
      amount: Number(String(r[6]).replace(/[^0-9.-]/g, ""))
    }));

    const filtered = monthIndex !== null
      ? mapped.filter(r => r.date.getMonth() === monthIndex)
      : mapped;

    if (!filtered.length) {
      await postMessage(channel, "No pending payments found.");
      return;
    }

    const total = filtered.reduce((s, x) => s + x.amount, 0);

    const aiSummary = await askGemini(
      `Summarize pending payments: Total ${fmt(total)}.\n` +
      filtered.map(f => `${f.invoiceNo}|${f.client}|${fmt(f.amount)}`).join("\n")
    );

    const blocks = filtered.map(f => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`${f.invoiceNo}\` | ${f.client} | ${f.date.toISOString().split("T")[0]} | ${f.days} | ${f.status} | ${fmt(f.amount)}`
      }
    }));

    await postMessage(channel, blocks);
    return;
  }

  // ----- Cashflow -----
  if (lower.includes("cash")) {
    const rows = await readDataForChatbot();
    const monthIndex = parseMonthIndex(lower);

    const mapped = rows.map(r => ({
      invoiceNo: r[0] || "(no)",
      client: r[1] || "",
      date: r[2] instanceof Date ? r[2] : new Date(r[2]),
      amount: Number(String(r[3]).replace(/[^0-9.-]/g, "")),
      paid: Number(String(r[4]).replace(/[^0-9.-]/g, "")),
      status: r[6] || ""
    }));

    const filtered = monthIndex !== null
      ? mapped.filter(r => r.date.getMonth() === monthIndex)
      : mapped;

    if (!filtered.length) {
      await postMessage(channel, "No cashflow records found.");
      return;
    }

    const totalInv = filtered.reduce((a, b) => a + b.amount, 0);
    const totalPaid = filtered.reduce((a, b) => a + b.paid, 0);

    const aiSummary = await askGemini(
      `Summarize cashflow.\nInvoiced: ${fmt(totalInv)} Paid: ${fmt(totalPaid)}`
    );

    await postMessage(channel, aiSummary);
    return;
  }

  // ----- AI fallback -----
  const ai = await askGemini(`User asked: "${text}"`);
  await postMessage(channel, ai);
}
