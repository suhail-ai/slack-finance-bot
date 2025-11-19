// /api/slack.js

// ---------- VERCEL RAW BODY FIX ----------
export const config = {
  api: {
    bodyParser: false
  }
};

// ---------- IMPORTS ----------
const crypto = require("crypto");
const fetch = require("node-fetch");
const getRawBody = require("raw-body");

const { readPendingPayments, readDataForChatbot } = require("./sheets");
const { askGemini } = require("./ai");

// ========================================
// SLACK SIGNATURE VERIFICATION
// ========================================
function verifySlackRequest(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  const timestamp = req.headers["x-slack-request-timestamp"];
  const slackSig = req.headers["x-slack-signature"];
  const rawBody = req.rawBody || "";

  if (!signingSecret || !timestamp || !slackSig) {
    throw new Error("Missing Slack headers");
  }

  const FIVE_MIN = 60 * 5;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > FIVE_MIN) {
    throw new Error("Old timestamp");
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto
    .createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");

  const computed = `v0=${hmac}`;

  if (!crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig))) {
    throw new Error("Invalid Slack signature");
  }
}

// ========================================
// HELPERS
// ========================================
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

  blocks.pu
