// dashboard.mjs — serves the admin dashboard UI.
// The HTML lives in dashboard.html and is read once at startup from the same
// directory as this module (baked into the container image).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_FILE = process.env.DASHBOARD_FILE || path.join(__dirname, "dashboard.html");

function readDashboardHtml() {
  try {
    return readFileSync(DASHBOARD_FILE, "utf8");
  } catch (error) {
    const file = String(DASHBOARD_FILE);
    return "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Dashboard</title></head>" +
      "<body style='background:#0f1117;color:#e6e8ef;font-family:sans-serif;'>" +
      "<p>Dashboard HTML not present at " + file + ".</p></body></html>";
  }
}

export const DASHBOARD_HTML = readDashboardHtml();
