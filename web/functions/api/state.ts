/// <reference types="@cloudflare/workers-types" />
interface Env { DB: D1Database }

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** GET /api/state?family=KEY&since=EPOCH_MS
 *  The family key in the URL is the only identity. No accounts by design. */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const family = url.searchParams.get("family");
  if (!family) return json({ error: "family required" }, 400);
  const since = Number(url.searchParams.get("since") ?? 0) || 0;

  const [children, events, dosePlans] = await Promise.all([
    env.DB.prepare("SELECT * FROM children WHERE family_id = ?1").bind(family).all(),
    env.DB.prepare("SELECT * FROM events WHERE family_id = ?1 AND created_at > ?2 ORDER BY created_at")
      .bind(family, since).all(),
    env.DB.prepare("SELECT * FROM dose_plans WHERE family_id = ?1 AND created_at > ?2 ORDER BY created_at")
      .bind(family, since).all(),
  ]);

  return json({
    now: Date.now(),
    children: children.results,
    events: events.results,
    dosePlans: dosePlans.results,
  });
};
