// ------------------------------
// Vercel: disable body parsing
// ------------------------------
export const config = {
  api: {
    bodyParser: false
  }
};

import crypto from "crypto";
import fetch from "node-fetch";
import { readPendingPayments, readDataForChatbot } from "./sheets";
import { askGemini } from "./ai";

// ------------------------------
// Read RAW BODY from Vercel
// ------------------------------
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ------------------------------
// Signature Verification
// ------------------------------
function verifySlackRequest(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const timestamp = req.headers["x-slack-request-timestamp"];
  const slackSig = req.headers["x-slack-signature"];

  if (!signingSecret || !timestamp || !slackSig) {
    throw new Error("Missing Slack headers");
  }

  const baseString = `v0:${timestamp}:${req.rawBody}`;
  const hmac = crypto
    .createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");
  const computed = `v0=${hmac}`;

  if (!crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig))) {
    throw new Error("Signature mismatch");
  }
}

// ------------------------------
// Utility
// ------------------------------
function fmt(n) {
  return "€" + Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2
  });
}

function parseMonthIndex(text = "") {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", 
                  "jul", "aug", "sep", "oct", "nov", "dec"];
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

// ------------------------------
// Slack Handler
// ------------------------------
export default async function handler(req, res) {
  // Read raw body BEFORE parsing
  const raw = await getRawBody(req);
  req.rawBody = raw;

  // Verify signature
  try {
    verifySlackRequest(req);
  } catch (err) {
    return res.status(401).send("Invalid Slack Request: " + err.message);
  }

  // Parse once verified
  let body = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch (_) {}

  req.body = body;

  // Slack URL verification
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  const text =
    body?.text?.replace(/<@[^>]+>/, "").trim() ||
    body?.event?.text?.replace(/<@[^>]+>/, "").trim() ||
    "";

  const channel =
    body?.channel_id || body?.event?.channel;

  // Respond immediately (avoid Slack timeout)
  res.status(200).send("Processing… ⏳");

  await handleCommand(text, channel);
}

// ------------------------------
// Main Bot Logic
// ------------------------------
async function handleCommand(text, channel) {
  const lower = text.toLowerCase();

  // ---------------- Pending Payments ----------------
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
      filtered = mapped.filter(r => r.date && r.date.getMonth() === monthIndex);
    }

    if (filtered.length === 0) {
      return postMessage(channel, "No pending payments found.");
    }

    const total = filtered.reduce((s, x) => s + x.amount, 0);

    const aiSummary = await askGemini(
      `Summarize pending payments. Total ${fmt(total)}.\n` +
      filtered.map(f => `${f.invoiceNo}|${f.client}|${fmt(f.amount)}`).join("\n")
    );

    const rowsOut = filtered.map(f => ({
      invoiceNo: f.invoiceNo,
      client: f.client,
      date: f.date ? f.date.toISOString().split("T")[0] : "-",
      days: f.days,
      status: f.status,
      amount: f.amount
    }));

    return postMessage(
      channel,
      buildBlocks(`Pending Payments — Total ${fmt(total)}`, aiSummary, rowsOut)
    );
  }

  // ---------------- Cashflow ----------------
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
      filtered = mapped.filter(r => r.date && r.date.getMonth() === monthIndex);
    }

    if (filtered.length === 0) {
      return postMessage(channel, "No cashflow records found.");
    }

    const totalInv = filtered.reduce((s, x) => s + x.amount, 0);
    const totalPaid = filtered.reduce((s, x) => s + x.paid, 0);

    const aiSummary = await askGemini(
      `Summarize cashflow. Invoiced ${fmt(totalInv)}, Paid ${fmt(totalPaid)}.\n` +
      filtered.map(f => `${f.invoiceNo}|${f.client}|${fmt(f.amount)}`).join("\n")
    );

    const rowsOut = filtered.map(f => ({
      invoiceNo: f.invoiceNo,
      client: f.client,
      date: f.date ? f.date.toISOString().split("T")[0] : "-",
      days: daysBetween(f.date),
      status: f.status,
      amount: f.amount
    }));

    return postMessage(
      channel,
      buildBlocks(`Cashflow — Total ${fmt(totalInv)}`, aiSummary, rowsOut)
    );
  }

  // ---------------- Fallback AI ----------------
  const ai = await askGemini(`User asked: "${text}". Answer clearly.`);
  return postMessage(channel, ai);
}
