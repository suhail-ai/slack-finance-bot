// /api/sheets.js
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

function getJwtClient() {
  const email = process.env.GOOGLE_SA_EMAIL;
  const key = (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!email || !key) throw new Error("Missing Google service account env vars");

  return new google.auth.JWT(email, null, key, SCOPES);
}

async function readRange(range) {
  const jwt = getJwtClient();
  await jwt.authorize();

  const sheets = google.sheets({ version: 'v4', auth: jwt });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range,
    valueRenderOption: "UNFORMATTED_VALUE"
  });

  return res.data.values || [];
}

// ======================
// SPECIFIC TABS
// ======================

async function readPendingPayments() {
  // Tab: Pending Payments — starting row 10, cols A:J
  return await readRange(`'Pending Payments'!A10:J`);
}

async function readDataForChatbot() {
  // Tab: Data for chatbot — starting row 12, cols A:K
  return await readRange(`'Data for chatbot'!A12:K`);
}

module.exports = {
  readPendingPayments,
  readDataForChatbot
};
