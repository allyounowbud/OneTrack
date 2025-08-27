// netlify/functions/gas-proxy.js
export async function handler(event) {
  const execBase = process.env.GAS_EXEC_URL; // e.g. https://script.google.com/macros/s/YOUR_EXEC_ID/exec
  if (!execBase) {
    return { statusCode: 500, body: "GAS_EXEC_URL env var is missing" };
  }

  const qs = event.queryStringParameters || {};
  const route = qs.route || "api";

  // For OAuth we must 302 the browser to Apps Script (not proxy HTML)
  if (route === "discord_login") {
    const url = execBase + (execBase.includes("?") ? "&" : "?") + "route=discord_login";
    return {
      statusCode: 302,
      headers: { Location: url, "Cache-Control": "no-store" },
      body: "",
    };
  }

  // Everything else: forward GET to Apps Script and relay the response
  const url = execBase + (execBase.includes("?") ? "&" : "?") +
              new URLSearchParams(qs).toString();

  const resp = await fetch(url, { method: "GET" });
  const text = await resp.text();

  return {
    statusCode: resp.status,
    headers: {
      "Content-Type": resp.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
    },
    body: text,
  };
}
