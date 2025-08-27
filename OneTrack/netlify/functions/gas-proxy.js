export async function handler(event) {
  const execBase = process.env.GAS_EXEC_URL;
  if (!execBase) return { statusCode: 500, body: "GAS_EXEC_URL env var is missing" };

  const qs = event.queryStringParameters || {};
  const route = qs.route || "api";

  if (route === "discord_login") {
    const url = execBase + (execBase.includes("?") ? "&" : "?") + "route=discord_login";
    return { statusCode: 302, headers: { Location: url, "Cache-Control": "no-store" }, body: "" };
  }

  const search = new URLSearchParams({ ...qs, ts: Date.now().toString() }).toString();
  const url = execBase + (execBase.includes("?") ? "&" : "?") + search;

  let resp;
  try {
    resp = await fetch(url, { method: "GET", redirect: "follow" });
  } catch (e) {
    return { statusCode: 504, headers: { "Cache-Control": "no-store" }, body: String(e) };
  }
  const text = await resp.text();

  return {
    statusCode: resp.status,
    headers: {
      "Content-Type": resp.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    },
    body: text,
  };
}
