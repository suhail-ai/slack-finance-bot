// /api/sheets.js
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

// Create Google Sheets API client using service account
function getJwtClient() {
  const clientEmail = process.env.GOOGLE_SA_EMAIL;
  const privateKey = (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    throw new Error('Google Service Account ENV variables not set.');
  }

  return new google.auth.JWT(clientEmail, null, privateKey, SCOPES);
}

async function readRange(range) {
  const jwt = getJwtClient();
  await jwt.authorize();

  const sheets = google.sheets({ version: 'v4', auth: jwt });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  return res.data.values || [];
}

// Reads "Pending Payments" tab
async function readPendingPayments() {
  return await readRange(`'Pending Payments'!A10:J`);
}

// Reads "Data for chatbot" tab
async function readDataForChatbot() {
  return await readRange(`'Data for chatbot'!A12:K`);
}

module.exports = { readPendingPayments, readDataForChatbot };
