import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

// Load env variables
const SHEET_ID = process.env.SHEET_ID; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");

// Google Sheets Auth
async function loadSheet() {
  const jwt = new JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const doc = new GoogleSpreadsheet(SHEET_ID, jwt);
  await doc.loadInfo();
  return doc;
}

// Gemini call
async function askGemini(question, sheetData) {
  const payload = {
    model: "gemini-1.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { text: "You are a finance assistant. Use ONLY the data below from Google Sheets." },
          { text: `Sheet Data: ${JSON.stringify(sheetData)}` },
          { text: `Question: ${question}` },
        ]
      }
    ]
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "No answer generated.";
}

export default async function handler(req, res) {
  try {
    const payload = req.body;

    // ----------------------------
    // 1️⃣ Slack URL Verification
    // ----------------------------
    if (payload.type === "url_verification") {
      return res.status(200).send(payload.challenge);
    }

    // ----------------------------
    // 2️⃣ Slash Command (/ai)
    // ----------------------------
    if (req.body.command) {
      // Immediate response (required by Slack!)
      res.status(200).json({
        response_type: "ephemeral",
        text: "Processing your request…",
      });

      // Process in background
      setTimeout(async () => {
        const question = req.body.text || "What is the summary?";

        const doc = await loadSheet();
        const sheet = doc.sheetsByIndex[0];
        const rows = await sheet.getRows();
        const rowData = rows.map(r => r._rawData);

        const aiAnswer = await askGemini(question, rowData);

        // Send final answer back to Slack
        await fetch(req.body.response_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: aiAnswer }),
        });
      }, 500);

      return;
    }

    // ----------------------------
    // 3️⃣ Regular Message Events
    // ----------------------------
    if (payload.event?.type === "app_mention") {
      const question = payload.event.text;

      const doc = await loadSheet();
      const sheet = doc.sheetsByIndex[0];
      const rows = await sheet.getRows();
      const rowData = rows.map(r => r._rawData);

      const aiAnswer = await askGemini(question, rowData);

      // Reply back to Slack
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: payload.event.channel,
          text: aiAnswer,
        }),
      });

      return res.status(200).send("OK");
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Internal Error");
  }
}
