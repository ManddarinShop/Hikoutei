// One-off check: read the demo spreadsheet directly to prove sync delivery.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { google } = require("@googleapis/sheets");
const { GoogleAuth } = require("google-auth-library");

const env = Object.fromEntries(
  readFileSync(".env", "utf8").trim().split("\n").map((line) => {
    const eq = line.indexOf("=");
    return [line.slice(0, eq), line.slice(eq + 1)];
  }),
);

const auth = new GoogleAuth({
  keyFile: env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });
const id = env.HIKOUTEI_SYNC_SPREADSHEET_URL.match(/\/d\/([^/]+)/)[1];

const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
const titles = meta.data.sheets.map((s) => s.properties.title);
const tab = titles.find((t) => t.toLowerCase().includes("demo")) ?? titles[0];
const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: tab });
const rows = res.data.values ?? [];

console.log("tabs:", titles.join(", "));
console.log(`tab read: "${tab}" | total rows (incl header): ${rows.length}`);
console.log("header:", JSON.stringify(rows[0]));
console.log("first data row:", JSON.stringify(rows[1]));
console.log("last data row:", JSON.stringify(rows[rows.length - 1]));