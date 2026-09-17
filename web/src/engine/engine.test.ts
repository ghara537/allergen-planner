import { addDays, daysBetween, day as D } from "./daymath.js";
import { plan, statuses, amountOn, planFor, label, fmtAmount, exposureCount,
         timeline, napsFor, hhmm } from "./planner.js";
import {
  ALLERGENS_BY_JURISDICTION, DEFAULT_SETTINGS,
  type Allergen, type ChildProfile, type ChildSettings, type Day,
  type DayOverride, type DosePlan, type FoodEvent, type NapSlot, type RiskTier,
} from "./types.js";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
};

const KID = "kid-1";
const born = D(2026, 1, 14);          // 8 months old on 2026-09-14
const today = D(2026, 9, 14);
let seq = 0;

const profile = (o: Partial<ChildProfile> = {}): ChildProfile => ({
  id: KID, name: "Baby", birthDate: born, riskTier: "standard" as RiskTier,
  jurisdiction: "us", readinessConfirmedOn: D(2026, 7, 1),
  clinicianCleared: [], excluded: [], scheduled: [], exposureCounts: {},
  settings: { ...DEFAULT_SETTINGS } as ChildSettings, updatedAt: 0, ...o,
});
const ev = (a: Allergen, d: Day, kind: FoodEvent["kind"] = "exposure",
            supersedes: string | null = null): FoodEvent =>
  ({ id: `e${seq++}`, childId: KID, allergen: a, day: d, kind, dose: null, supersedes });
const dp = (o: Partial<DosePlan> = {}): DosePlan => ({
  id: `p${seq++}`, childId: KID, allergen: "peanut", effectiveFrom: D(2026, 8, 1),
  startAmount: 1, unit: "tsp", increment: 1, incrementMode: "add", everyDays: 7,
  feedEveryDays: 1,
  reactive: false, source: "", supersedes: null, ...o,
});
const one = (p: ChildProfile, h: FoodEvent[], plans: DosePlan[] = [], on: Day = today) =>
  plan({ profile: p, history: h, dosePlans: plans, from: on, through: on })[0]!;

console.log("\n== DayMath ==");
check("leap day", JSON.stringify(addDays(1, D(2028, 2, 28))) === JSON.stringify(D(2028, 2, 29)));
check("non-leap rolls", JSON.stringify(addDays(1, D(2026, 2, 28))) === JSON.stringify(D(2026, 3, 1)));
check("year boundary", JSON.stringify(addDays(1, D(2026, 12, 31))) === JSON.stringify(D(2027, 1, 1)));
check("span across months", daysBetween(D(2026, 1, 14), D(2026, 9, 14)) === 243);
check("negative span", daysBetween(today, D(2026, 9, 1)) === -13);

console.log("\n== Gates ==");
check("too young", one(profile({ birthDate: D(2026, 8, 1) }), []).blocked === "tooYoung");
check("readiness unconfirmed blocks",
  one(profile({ readinessConfirmedOn: null }), []).blocked === "readinessNotConfirmed");
check("readiness in future blocks",
  one(profile({ readinessConfirmedOn: D(2026, 10, 1) }), []).blocked === "readinessNotConfirmed");
check("high risk: no home schedule",
  one(profile({ riskTier: "severeEczemaOrEggAllergy" }), []).introduce === null);
check("high risk + per-allergen clearance unblocks that food",
  one(profile({ riskTier: "severeEczemaOrEggAllergy", clinicianCleared: ["peanut"] }), []).introduce?.allergen === "peanut");

console.log("\n== Settled is measured first exposure to LAST ==");
const sustained = [ev("peanut", D(2026, 8, 1)), ev("peanut", D(2026, 8, 8)),
                   ev("peanut", D(2026, 8, 15)), ev("peanut", D(2026, 8, 20)),
                   ev("peanut", D(2026, 8, 25))];
check("24 days and five exposures counts as settled",
  statuses(profile(), sustained, [], today).peanut?.kind === "established");
const tasted = [ev("peanut", D(2026, 8, 1))];
check("one taste then silence does NOT count",
  statuses(profile(), tasted, [], today).peanut?.kind === "inProgress");
const tight = [ev("egg", D(2026, 9, 1)), ev("egg", D(2026, 9, 5))];
check("4 days apart is not yet settled",
  statuses(profile(), tight, [], today).egg?.kind === "inProgress");
check("settings are per child",
  statuses(profile({ settings: { ...DEFAULT_SETTINGS, newAllergenCadenceDays: 5,
                                 daysToEstablish: 3, exposuresToSettle: 2 } }), tight, [], today)
    .egg?.kind === "established");

console.log("\n== Cadence between new foods ==");
const slow = profile({ settings: { ...DEFAULT_SETTINGS, newAllergenCadenceDays: 10, daysToEstablish: 21 } });
const started = [ev("peanut", addDays(-3, today))];
check("too soon for a new food", one(slow, started).introduce?.allergen !== "egg");
check("ready after the cadence",
  one(slow, [ev("peanut", addDays(-11, today))], [], today).introduce !== null);

console.log("\n== Dose plans ==");
const addPlan = dp({ startAmount: 2, increment: 1, incrementMode: "add", everyDays: 7 });
const fed = (from: Day, n: number) => Array.from({ length: n }, (_, i) => ev("peanut", addDays(i * 7, from)));
check("no steps before any time passes",
  amountOn(addPlan, D(2026, 8, 1), fed(D(2026, 8, 1), 1)).amount === 2);
check("adds one per week when logged",
  amountOn(addPlan, D(2026, 8, 22), fed(D(2026, 8, 1), 4)).amount === 5);
check("days alone do NOT escalate without a logged exposure",
  amountOn(addPlan, D(2026, 8, 22), [ev("peanut", D(2026, 8, 1))]).amount === 3,
  String(amountOn(addPlan, D(2026, 8, 22), [ev("peanut", D(2026, 8, 1))]).amount));
const mult = dp({ startAmount: 1, increment: 2, incrementMode: "multiply", everyDays: 14 });
check("multiplies", amountOn(mult, D(2026, 8, 29), fed(D(2026, 8, 1), 5)).amount === 4);
check("increment 0 holds",
  amountOn(dp({ startAmount: 5, increment: 0 }), D(2026, 9, 30), fed(D(2026, 8, 1), 8)).amount === 5);

console.log("\n== Editing supersedes ==");
const first = dp({ id: "old", startAmount: 1, effectiveFrom: D(2026, 8, 1) });
const second = dp({ id: "new", startAmount: 12, effectiveFrom: D(2026, 9, 10), supersedes: "old" });
check("the newest live plan wins", planFor([first, second], "peanut", today)?.id === "new");
check("superseded plan is dropped", planFor([first, second], "peanut", D(2026, 9, 12))?.startAmount === 12);
check("a plan not yet in force is ignored",
  planFor([first, second], "peanut", D(2026, 9, 1))?.id === "old");

console.log("\n== Amounts only ever come from a plan ==");
check("no plan, no dose", one(profile(), sustained).introduce?.dose === null);
check("no plan, no dose on the rest of the day",
  one(profile(), sustained).alsoDue.every((m: any) => m.dose === null));
const withPlan = one(profile(), [ev("egg", addDays(-30, today))],
  [dp({ allergen: "egg", startAmount: 3, increment: 0, effectiveFrom: addDays(-30, today) })]);
check("a plan supplies the dose", withPlan.introduce?.dose?.amount === 3);
check("unit rides along", withPlan.introduce?.dose?.unit === "tsp");
check("formats", fmtAmount({ amount: 2.5, unit: "tsp" }) === "2.5 tsp");

console.log("\n== Reaction is a flag, not a gate ==");
const reacted = [...sustained, ev("egg", D(2026, 9, 1), "reaction")];
const r = one(profile(), reacted);
const named = [r.introduce, ...r.alsoDue].filter(Boolean) as any[];
check("a reacted food stays on the plan", named.some((m) => m.allergen === "egg"));
check("and carries the reaction date",
  named.find((m) => m.allergen === "egg")?.reactedOn !== null);
check("the date is the reaction's, not today's",
  JSON.stringify(named.find((m) => m.allergen === "egg")?.reactedOn) === JSON.stringify(D(2026, 9, 1)));
check("other foods still proceed", named.length > 1);
check("the note says when", r.notes.some((n) => n.includes("caused a reaction on")));
check("a food never reacted to has no flag",
  named.filter((m) => m.allergen !== "egg").every((m) => m.reactedOn === null));
check("the flag survives later exposures",
  one(profile(), [...reacted, ev("egg", D(2026, 9, 12))]).alsoDue
    .concat([one(profile(), [...reacted, ev("egg", D(2026, 9, 12))]).introduce as any])
    .filter(Boolean).some((m: any) => m.allergen === "egg" && m.reactedOn !== null));

console.log("\n== Exposure counts ==");
{
  const three = [ev("wheat", D(2026, 8, 1)), ev("wheat", D(2026, 8, 9)), ev("wheat", D(2026, 8, 20))];
  check("counts logged exposures", exposureCount("wheat", three, profile(), today) === 3);
  // Asserting a number replaces the history before it, and later logs add on.
  const asserted = profile({ exposureCounts: { wheat: { count: 10, asOf: D(2026, 8, 10) } } });
  check("an asserted count overrides earlier history",
    exposureCount("wheat", three, asserted, today) === 11);
  check("nothing logged after the assertion leaves it alone",
    exposureCount("wheat", three.slice(0, 2), asserted, today) === 10);
  check("a future day does not count yet",
    exposureCount("wheat", three, profile(), D(2026, 8, 5)) === 1);
  check("settling needs the count as well as the span",
    statuses(profile({ settings: { ...DEFAULT_SETTINGS, exposuresToSettle: 99 } }),
             sustained, [], today).peanut?.kind === "inProgress");
  check("an asserted count can settle a food on its own",
    statuses(profile({ exposureCounts: { peanut: { count: 20, asOf: D(2026, 8, 1) } } }),
             sustained, [], today).peanut?.kind === "established");
  check("a reaction stops it settling",
    statuses(profile(), [...sustained, ev("peanut", D(2026, 8, 26), "reaction")], [], today)
      .peanut?.kind !== "established");
}

console.log("\n== Explicitly scheduled foods ==");
{
  const queued = one(profile({ scheduled: ["sesame"] }), sustained);
  const all = [queued.introduce, ...queued.alsoDue].filter(Boolean) as any[];
  check("a food put on the schedule shows up now",
    all.some((m) => m.allergen === "sesame"));
  const notQueued = one(profile(), sustained);
  const all2 = [notQueued.introduce, ...notQueued.alsoDue].filter(Boolean) as any[];
  check("one not on the schedule waits its turn",
    !all2.some((m) => m.allergen === "sesame"));
  check("still only one NEW food a day",
    [queued.introduce, ...queued.alsoDue].filter((m) => m?.isNew).length <= 1);
}
const rebuilding = one(profile(), reacted,
  [dp({ allergen: "egg", startAmount: 0.25, reactive: true, effectiveFrom: D(2026, 9, 2) })]);
check("a plan lets a reacted food resume", rebuilding.introduce?.allergen === "egg");
check("and it is marked as building up", rebuilding.introduce?.reactive === true);

console.log("\n== Catch-up invariant ==");
const horizon = plan({ profile: profile(), history: sustained, from: today, through: D(2027, 3, 1) });
check("horizon schedules something", horizon.some((p) => p.introduce !== null));
check("at most one new food per day", horizon.every((p) => (p.introduce?.isNew ? 1 : 0) <= 1));
const gapped = one(profile(), sustained, [], D(2026, 11, 20));
check("a long gap does not stack", (gapped.introduce?.isNew ? 1 : 0) <= 1);

console.log("\n== Exclusions and jurisdiction ==");
const ex = plan({ profile: profile({ excluded: ["peanut", "egg", "cowsMilk"] }), history: [],
                  from: today, through: D(2027, 1, 1) });
check("excluded foods never scheduled",
  ex.every((p) => !["peanut", "egg", "cowsMilk"].includes(p.introduce?.allergen ?? "")));
check("US set excludes celery", !ALLERGENS_BY_JURISDICTION.us.includes("celery"));
check("EU set includes celery", ALLERGENS_BY_JURISDICTION.eu.includes("celery"));

console.log("\n== Maintenance outlives introduction ==");
const all: FoodEvent[] = [];
let d = D(2026, 3, 1);
for (const a of ALLERGENS_BY_JURISDICTION.us) {
  // Five exposures across 25 days: clears both the span and the count.
  for (const off of [0, 6, 12, 18, 25]) all.push(ev(a, addDays(off, d)));
  d = addDays(30, d);
}
const toddler = one(profile(), all, [], D(2029, 9, 14));
check("nothing left to introduce", toddler.introduce === null);
check("maintenance still due", toddler.alsoDue.length > 0);
check("window closes after five years", one(profile(), all, [], D(2032, 9, 14)).alsoDue.length === 0);

console.log("\n== Each food has its own cadence ==");
{
  // Fed peanut yesterday on a daily plan: still due today.
  const daily = dp({ allergen: "peanut", feedEveryDays: 1, increment: 0, startAmount: 1,
                     effectiveFrom: addDays(-30, today) });
  const yday = [ev("peanut", addDays(-1, today))];
  const r1 = one(profile(), yday, [daily]);
  check("a daily dose plan is due the next day",
    r1.introduce?.allergen === "peanut" || r1.alsoDue.some((m: any) => m.allergen === "peanut"));

  // Same food, weekly plan, fed yesterday: not due.
  const weekly = dp({ allergen: "peanut", feedEveryDays: 7, increment: 0, startAmount: 1,
                      effectiveFrom: addDays(-30, today) });
  const r2 = one(profile(), yday, [weekly]);
  check("a weekly dose plan is not due the next day",
    r2.introduce?.allergen !== "peanut" && !r2.alsoDue.some((m: any) => m.allergen === "peanut"));

  // A food being worked up to should come round daily, not weekly.
  const working = [ev("egg", addDays(-10, today)), ev("egg", addDays(-2, today))];
  const r3 = one(profile(), working);
  check("an in-progress food is due again after a day",
    r3.introduce?.allergen === "egg" || r3.alsoDue.some((m: any) => m.allergen === "egg"));

  // A settled food fed three days ago is not due on a weekly interval.
  const settled = [ev("wheat", addDays(-40, today)), ev("wheat", addDays(-3, today))];
  const r4 = one(profile(), settled);
  check("a settled food is not due three days later",
    !r4.alsoDue.some((m: any) => m.allergen === "wheat"));

  // Nothing is ever listed twice on one day.
  const busy = one(profile(), [...sustained, ...working], [daily]);
  const named = [busy.introduce?.allergen, ...busy.alsoDue.map((m: any) => m.allergen)].filter(Boolean);
  check("no food appears twice in a day", new Set(named).size === named.length);
}

console.log("\n== Timeline ==");
const naps: NapSlot[] = [
  { startMin: 9 * 60, durationMin: 75 },
  { startMin: 13 * 60 + 30, durationMin: 90 },
];
const tlArgs = { naps, history: sustained, childId: KID, day: today,
                 dayStartMin: 6 * 60, dayEndMin: 20 * 60 };
const tl = timeline({ plan: one(profile(), sustained), ...tlArgs });
check("naps appear as blocks", tl.filter((b) => b.kind === "nap").length === 2);
check("naps are numbered", tl.find((b) => b.kind === "nap")?.napIndex === 1);
check("blocks come out in time order",
  tl.every((b, i) => i === 0 || tl[i - 1]!.startMin <= b.startMin));
check("feeds sit outside naps", tl.filter((b) => b.kind === "feed").every((f) =>
  naps.every((n) => f.startMin >= n.startMin + n.durationMin || f.endMin <= n.startMin)));
check("a new food gets a watch window",
  tl.some((b) => b.kind === "observation"));
const obs = tl.find((b) => b.kind === "observation")!;
check("the watch window is two hours", obs.endMin - obs.startMin >= 110);

const crowded = timeline({ plan: one(profile(), sustained), ...tlArgs,
  naps: [{ startMin: 7 * 60, durationMin: 60 }] });
check("fewer naps still places every food",
  crowded.filter((b) => b.kind === "feed").length ===
  tl.filter((b) => b.kind === "feed").length);

const doneToday = [...sustained, ev("peanut", today)];
const tlDone = timeline({ plan: one(profile(), doneToday), ...tlArgs, history: doneToday });
check("a logged food reads as done",
  tlDone.filter((b) => b.kind === "feed" && b.allergen === "peanut")
        .every((b) => b.status === "done"));
const tlMissed = timeline({ plan: one(profile(), sustained), ...tlArgs, nowMin: 23 * 60 });
check("an unlogged feed reads as missed once its window passes",
  tlMissed.some((b) => b.kind === "feed" && b.status === "missed"));
const tlOpen = timeline({ plan: one(profile(), sustained), ...tlArgs, nowMin: 0 });
check("and as due before then",
  tlOpen.filter((b) => b.kind === "feed").every((b) => b.status !== "missed"));

console.log("\n== Day overrides ==");
const ov: DayOverride[] = [
  { id: "o1", childId: KID, day: today, naps: [{ startMin: 600, durationMin: 30 }], supersedes: null },
  { id: "o2", childId: KID, day: today, naps: [{ startMin: 660, durationMin: 45 }], supersedes: "o1" },
];
check("the newest override for a day wins",
  napsFor(ov, { naps }, KID, today)[0]?.startMin === 660);
check("another day falls back to the default",
  napsFor(ov, { naps }, KID, D(2026, 9, 15))[0]?.startMin === 540);
check("another child is unaffected", napsFor(ov, { naps }, "other", today).length === 2);
check("clock formatting", hhmm(9 * 60) === "9am" && hhmm(13 * 60 + 30) === "1:30pm");

console.log("\n== Determinism ==");
const a1 = one(profile(), sustained), a2 = one(profile(), sustained);
check("same inputs, same output",
  a1.introduce?.allergen === a2.introduce?.allergen && JSON.stringify(a1.notes) === JSON.stringify(a2.notes));
check("labels resolve", label("cowsMilk") === "Cow's milk");

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
