// ===============================
// api/slack.js  — FINAL VERSION
// Signature verification removed
// ===============================

const fetch = require("node-fetch");
const { readPendingPayments, readDataForChatbot } = require("./sheets");
const { askGemini } = require("./ai");

// ----------------------------------------------------
// Helpers
// ----------------------------------------------------
function fmt(n) {
  return "€" + Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2
  });
}

function parseMonthIndex(text = "") {
  const months = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec"
  ];
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

// ----------------------------------------------------
// Slack message sender
// ----------------------------------------------------
async function postMessage(channel, content) {
  const token = process.env.SLACK_BOT_TOKEN;

  const body = typeof content === "string"
    ? { channel, text: content }
    : { channel, blocks: content };

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

// ----------------------------------------------------
// Blocks UI
// ----------------------------------------------------
function buildBlocks(title, summary, rows) {
  const blocks = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: title }
  });

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: summary }
  });

  blocks.push({ type: "divider" });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Invoice* | *Client* | *Date* | *Days* | *Status* | *Amount*"
    }
  });

  rows.forEach((r) => {
    const line = `\`${r.invoiceNo}\` | ${r.client} | ${r.date} | ${r.days} | ${r.status} | ${fmt(r.amount)}`;
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: line }
    });
  });

  return blocks;
}

// ----------------------------------------------------
// MAIN ENTRY POINT
// ----------------------------------------------------
module.exports = async (req, res) => {
  req.rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});

  // *** Signature removed ***
  console.log("⚠ Skipping Slack signature verification");

  // URL Verification
  if (req.body?.type === "url_verification") {
    return res.json({ challenge: req.body.challenge });
  }

  // Slash commands
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = req.body;
    const text = (params.text || "").trim();
    const channel = params.channel_id;

    res.status(200).send("Processing…");

    (async () => {
      await handleCommand(text, channel);
    })();

    return;
  }

  // Event Subscriptions (app_mention)
  if (req.body?.event) {
    const evt = req.body.event;

    res.status(200).send("ok");

    if (evt.bot_id) return;

    const text = (evt.text || "").replace(/<@[^>]+>/, "").trim();
    const channel = evt.channel;

    await postMessage(channel, "Processing… ⏳");
    await handleCommand(text, channel);

    return;
  }

  res.status(200).send("ok");
};

// ----------------------------------------------------
// COMMAND HANDLER
// ----------------------------------------------------
async function handleCommand(text, channel) {
  const lower = text.toLowerCase();

  // ---------------------------
  // PENDING PAYMENTS
  if (lower.includes("pending")) {
    const rows = await readPendingPayments();
    const monthIndex = parseMonthIndex(lower);

    const mapped = rows.map((r) => ({
      invoiceNo: r[0] || "(no)",
      client: r[1] || "",
      date: r[3] instanceof Date ? r[3] : new Date(r[3] || null),
      days: Number(r[4]) || 0,
      status: r[5] || "",
      amount: Number(String(r[6] || "0").replace(/[^0-9.-]/g, ""))
    }));

    let filtered = mapped;
    if (monthIndex !== null) {
      filtered = filtered.filter((r) => r.date && r.date.getMonth() === monthIndex);
    }

    if (filtered.length === 0) {
      await postMessage(channel, "No pending payments found.");
      return;
    }

    const total = filtered.reduce((s, x) => s + x.amount, 0);

    const aiSummary = await askGemini(
      `Summarize pending payments. Total ${fmt(total)}.\n` +
      filtered.map(f => `${f.invoiceNo}|${f.client}|${fmt(f.amount)}`).join("\n")
    );

    const rowsOut = filtered.map((f) => ({
      invoiceNo: f.invoiceNo,
      client: f.client,
      date: f.date ? f.date.toISOString().split("T")[0] : "-",
      days: f.days,
      status: f.status,
      amount: f.amount
    }));

    const blocks = buildBlocks(
      `Pending Payments — Total ${fmt(total)}`,
      aiSummary,
      rowsOut
    );

    await postMessage(channel, blocks);
    return;
  }

  // ---------------------------
  // CASHFLOW
  if (lower.includes("cashflow") || lower.includes("cash")) {
    const rows = await readDataForChatbot();
    const monthIndex = parseMonthIndex(lower);

    const mapped = rows.map((r) => ({
      invoiceNo: r[0] || "(no)",
      client: r[1] || "",
      date: r[2] instanceof Date ? r[2] : new Date(r[2] || null),
      amount: Number(String(r[3] || "0").replace(/[^0-9.-]/g, "")),
      paid: Number(String(r[4] || "0").replace(/[^0-9.-]/g, "")),
      status: r[6] || ""
    }));

    let filtered = mapped;
    if (monthIndex !== null) {
      filtered = filtered.filter((r) => r.date && r.date.getMonth() === monthIndex);
    }

    if (filtered.length === 0) {
      await postMessage(channel, "No cashflow records found.");
      return;
    }

    const totalInv = filtered.reduce((s, x) => s + x.amount, 0);
    const totalPaid = filtered.reduce((s, x) => s + x.paid, 0);

    const aiSummary = await askGemini(
      `Summarize cashflow. Invoiced ${fmt(totalInv)}, Paid ${fmt(totalPaid)}.\n` +
      filtered.map(f => `${f.invoiceNo}|${f.client}|${fmt(f.amount)}`).join("\n")
    );

    const rowsOut = filtered.map((f) => ({
      invoiceNo: f.invoiceNo,
      client: f.client,
      date: f.date ? f.date.toISOString().split("T")[0] : "-",
      days: daysBetween(f.date),
      status: f.status,
      amount: f.amount
    }));

    const blocks = buildBlocks(
      `Cashflow — Total ${fmt(totalInv)}`,
      aiSummary,
      rowsOut
    );

    await postMessage(channel, blocks);
    return;
  }

  // ---------------------------
  // DEFAULT AI RESPONSE
  const ai = await askGemini(`User asked: "${text}". Answer concisely.`);
  await postMessage(channel, ai);
}
