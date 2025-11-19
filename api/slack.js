// Final working slack.js without signature check
export const config = {
  api: { bodyParser: false }
};

const crypto = require("crypto");
const fetch = require("node-fetch");
const { readPendingPayments, readDataForChatbot } = require("./sheets");
const { askGemini } = require("./ai");

// -------------------------
// Helpers
// -------------------------
function fmt(n) {
  return "€" + Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2
  });
}

function parseMonthIndex(text = "") {
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  text = text.toLowerCase();
  return months.findIndex(m => text.includes(m));
}

async function postMessage(channel, content) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(
      typeof content === "string"
        ? { channel, text: content }
        : { channel, blocks: content }
    )
  });
}

function buildBlocks(title, summary, rows) {
  return [
    { type: "header", text: { type: "plain_text", text: title }},
    { type: "section", text: { type: "mrkdwn", text: summary }},
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Invoice* | *Client* | *Date* | *Days* | *Status* | *Amount*"
      }
    },
    ...rows.map(r => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`${r.invoiceNo}\` | ${r.client} | ${r.date} | ${r.days} | ${r.status} | ${fmt(r.amount)}`
      }
    }))
  ];
}

// -------------------------
// MAIN HANDLER
// -------------------------
module.exports = async (req, res) => {
  console.log("Skipping Slack signature verification");

  // For slash commands
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = req.body;
    const text = params.text || "";
    const channel = params.channel_id;

    res.status(200).send("Processing...");
    handleCommand(text, channel);
    return;
  }

  // For app mentions
  if (req.body?.event) {
    const evt = req.body.event;
    res.status(200).send("ok");

    if (evt.bot_id) return;

    const text = (evt.text || "").replace(/<@[^>]+>/, "").trim();
    await postMessage(evt.channel, "Processing… ⏳");
    handleCommand(text, evt.channel);
    return;
  }

  res.status(200).send("ok");
};

// -------------------------
// COMMAND HANDLER
// -------------------------
async function handleCommand(text, channel) {
  const lower = text.toLowerCase();

  // Pending payments
  if (lower.includes("pending")) {
    const rows = await readPendingPayments();
    const monthIndex = parseMonthIndex(lower);

    const mapped = rows.map(r => ({
      invoiceNo: r[0] || "(no)",
      client: r[1] || "",
      date: r[3] ? new Date(r[3]) : null,
      days: r[4] || 0,
      status: r[5] || "",
      amount: Number((r[6] || "0").toString().replace(/[^0-9.-]/g, ""))
    }));

    const filtered = monthIndex < 0
      ? mapped
      : mapped.filter(x => x.date?.getMonth() === monthIndex);

    if (!filtered.length) return postMessage(channel, "No pending found");

    const total = filtered.reduce((s, x) => s + x.amount, 0);

    const summary = await askGemini(`Summarize:\n${filtered.map(x =>
      `${x.invoiceNo}|${x.client}|${fmt(x.amount)}`
    ).join("\n")}`);

    const rowsOut = filtered.map(x => ({
      invoiceNo: x.invoiceNo,
      client: x.client,
      date: x.date ? x.date.toISOString().split("T")[0] : "-",
      days: x.days,
      status: x.status,
      amount: x.amount
    }));

    const blocks = buildBlocks(`Pending — Total ${fmt(total)}`, summary, rowsOut);
    return postMessage(channel, blocks);
  }

  // Cashflow
  if (lower.includes("cashflow") || lower.includes("cash")) {
    const rows = await readDataForChatbot();
    const monthIndex = parseMonthIndex(lower);

    const mapped = rows.map(r => ({
      invoiceNo: r[0] || "(no)",
      client: r[1] || "",
      date: r[2] ? new Date(r[2]) : null,
      amount: Number((r[3] || "0").toString().replace(/[^0-9.-]/g, "")),
      paid: Number((r[4] || "0").toString().replace(/[^0-9.-]/g, "")),
      status: r[6] || ""
    }));

    const filtered = monthIndex < 0
      ? mapped
      : mapped.filter(x => x.date?.getMonth() === monthIndex);

    if (!filtered.length) return postMessage(channel, "No cashflow found");

    const totalInv = filtered.reduce((s, x) => s + x.amount, 0);
    const totalPaid = filtered.reduce((s, x) => s + x.paid, 0);

    const summary = await askGemini(`Summarize cashflow`);

    const rowsOut = filtered.map(x => ({
      invoiceNo: x.invoiceNo,
      client: x.client,
      date: x.date ? x.date.toISOString().split("T")[0] : "-",
      days: "-",
      status: x.status,
      amount: x.amount
    }));

    const blocks = buildBlocks(`Cashflow — Total ${fmt(totalInv)}`, summary, rowsOut);
    return postMessage(channel, blocks);
  }

  // AI fallback
  const reply = await askGemini(`User asked: "${text}"`);
  return postMessage(channel, reply);
}
