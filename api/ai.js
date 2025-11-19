// /api/ai.js
const fetch = require("node-fetch");

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

async function askGemini(prompt) {
  const payload = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ]
  };

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const txt = await res.text();

  try {
    const json = JSON.parse(txt);
    if (json.contents && json.contents[0] && json.contents[0].parts) {
      return json.contents[0].parts.map((p) => p.text || "").join("\n");
    }
    return txt;
  } catch (e) {
    return txt;
  }
}

module.exports = { askGemini };
