import {
  childToRow, eventToRow, overrideToRow, planToRow, rowToChild, rowToEvent,
  rowToOverride, rowToPlan, save, type Store,
} from "./local.js";

/** Push what is new, pull what changed. Append-only events make this a merge,
 *  not a conflict resolution problem - retries are safe and order does not
 *  matter. Offline is not an error state; it is just a sync that has not
 *  happened yet. */
export async function sync(s: Store): Promise<{ store: Store; online: boolean }> {
  if (!s.familyKey) return { store: s, online: false };
  const pushed = new Set(s.pushed);

  try {
    const newEvents = s.events.filter((e) => !pushed.has(e.id));
    const newPlans = s.dosePlans.filter((p) => !pushed.has(p.id));
    const newOv = s.dayOverrides.filter((o) => !pushed.has(o.id));

    if (newEvents.length || newPlans.length || newOv.length || s.children.length) {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          family: s.familyKey,
          children: s.children.map(childToRow),
          events: newEvents.map(eventToRow),
          dosePlans: newPlans.map(planToRow),
          dayOverrides: newOv.map(overrideToRow),
        }),
      });
      if (!res.ok) throw new Error(`sync ${res.status}`);
      for (const e of newEvents) pushed.add(e.id);
      for (const p of newPlans) pushed.add(p.id);
      for (const o of newOv) pushed.add(o.id);
    }

    const res = await fetch(`/api/state?family=${encodeURIComponent(s.familyKey)}&since=0`);
    if (!res.ok) throw new Error(`state ${res.status}`);
    const remote = await res.json() as {
      now: number; children: any[]; events: any[]; dosePlans: any[]; dayOverrides: any[];
    };

    const byId = <T extends { id: string }>(local: T[], incoming: T[]): T[] => {
      const m = new Map(local.map((x) => [x.id, x]));
      for (const x of incoming) if (!m.has(x.id)) m.set(x.id, x);
      return [...m.values()];
    };

    const next: Store = {
      ...s,
      children: byId(s.children, remote.children.map(rowToChild)),
      events: byId(s.events, remote.events.map(rowToEvent)),
      dosePlans: byId(s.dosePlans, remote.dosePlans.map(rowToPlan)),
      dayOverrides: byId(s.dayOverrides, (remote.dayOverrides ?? []).map(rowToOverride)),
      lastSync: remote.now,
      pushed: [...pushed],
    };
    save(next);
    return { store: next, online: true };
  } catch {
    // Offline, or the API is not deployed yet. The local copy still works.
    return { store: s, online: false };
  }
}
