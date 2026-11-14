// Local administration without putting bearer keys into command-line arguments or logs.
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

try {
  const env = parseEnv(await readFile(".env", "utf8"));
  const base = `http://127.0.0.1:${env.CPA_PORT || 8317}`;
  const action = process.argv[2] || "status";
  const call = async (path, management = true) => {
    const response = await fetch(base + path, {
      headers: { authorization: `Bearer ${management ? env.CPA_MANAGEMENT_KEY : env.CPA_API_KEY}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`CPA ${path.split("?")[0]} returned HTTP ${response.status}`);
    return response.json();
  };
  if (action === "login") {
    const result = await call("/v8/management/oauth/auth-url?provider=claude&is_webui=true");
    if (typeof result.url !== "string") throw new Error("CPA returned no authorization URL");
    console.log(result.url);
    console.log(
      `Login state: ${result.state}\nComplete authorization in your browser. Use the panel's manual callback if localhost:54545 is unreachable.`,
    );
  } else if (action === "login-status" && process.argv[3]) {
    console.log(
      JSON.stringify(
        await call(`/v8/management/oauth/status?state=${encodeURIComponent(process.argv[3])}`),
      ),
    );
  } else if (action === "status") {
    const [credentials, models] = await Promise.all([
      call("/v8/management/credentials"),
      call("/v1/models", false),
    ]);
    console.log(
      JSON.stringify(
        {
          credentials: (credentials.files || []).map((f) => ({
            provider: f.provider || f.type,
            status: f.status,
            disabled: f.disabled === true,
          })),
          models: (models.data || []).map((m) => m.id),
        },
        null,
        2,
      ),
    );
  } else throw new Error("Use status, login or login-status <state>");
} catch (error) {
  console.error(error instanceof Error ? error.message : "CPA administration failed");
  process.exitCode = 1;
}
