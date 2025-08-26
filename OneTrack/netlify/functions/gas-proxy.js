export async function handler(event) {
  const EXEC =
    process.env.GAS_EXEC_URL ||
    "https://script.google.com/macros/s/REPLACE_WITH_YOUR_EXEC_ID/exec";

  try {
    const url = new URL(event.rawUrl);
    const route = url.searchParams.get("route") || "";

    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: cors(), body: "" };
    }

    if (route === "discord_login") {
      return redirect(`${EXEC}?route=discord_login`);
    }

    if (route === "api") {
      const target = `${EXEC}${url.search}`;
      const resp = await fetch(target, { method: "GET" });
      const body = await resp.text();
      return {
        statusCode: resp.status,
        headers: {
          ...cors(),
          "content-type": resp.headers.get("content-type") || "application/json",
        },
        body,
      };
    }

    return redirect(EXEC);
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors(),
      body: JSON.stringify({ ok: false, error: String(err?.message || err) }),
    };
  }

  function cors() {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    };
  }
  function redirect(location) {
    return { statusCode: 302, headers: { Location: location, ...cors() }, body: "" };
  }
}
