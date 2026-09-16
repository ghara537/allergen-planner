import { addDays, daysBetween, day as D } from "./daymath.js";
import { plan, statuses, amountOn, planFor, label, fmtAmount } from "./planner.js";
import {
  ALLERGENS_BY_JURISDICTION, DEFAULT_SETTINGS,
  type Allergen, type ChildProfile, type ChildSettings, type Day,
  type DosePlan, type FoodEvent, type RiskTier,
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
  clinicianCleared: [], excluded: [],
  settings: { ...DEFAULT_SETTINGS } as ChildSettings, ...o,
});
const ev = (a: Allergen, d: Day, kind: FoodEvent["kind"] = "exposure",
            supersedes: string | null = null): FoodEvent =>
  ({ id: `e${seq++}`, childId: KID, allergen: a, day: d, kind, dose: null, supersedes });
const dp = (o: Partial<DosePlan> = {}): DosePlan => ({
  id: `p${seq++}`, childId: KID, allergen: "peanut", effectiveFrom: D(2026, 8, 1),
  startAmount: 1, unit: "tsp", increment: 1, incrementMode: "add", everyDays: 7,
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
const sustained = [ev("peanut", D(2026, 8, 1)), ev("peanut", D(2026, 8, 15)), ev("peanut", D(2026, 8, 25))];
check("24 days of eating counts as settled",
  statuses(profile(), sustained, [], today).peanut?.kind === "established");
const tasted = [ev("peanut", D(2026, 8, 1))];
check("one taste then silence does NOT count",
  statuses(profile(), tasted, [], today).peanut?.kind === "inProgress");
const tight = [ev("egg", D(2026, 9, 1)), ev("egg", D(2026, 9, 5))];
check("4 days apart is not yet settled",
  statuses(profile(), tight, [], today).egg?.kind === "inProgress");
check("settings are per child",
  statuses(profile({ settings: { newAllergenCadenceDays: 5, daysToEstablish: 3 } }), tight, [], today)
    .egg?.kind === "established");

console.log("\n== Cadence between new foods ==");
const slow = profile({ settings: { newAllergenCadenceDays: 10, daysToEstablish: 21 } });
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
check("no plan, no dose on maintenance",
  one(profile(), sustained).maintenanceDue.every((m) => m.dose === null));
const withPlan = one(profile(), [ev("egg", addDays(-30, today))],
  [dp({ allergen: "egg", startAmount: 3, increment: 0, effectiveFrom: addDays(-30, today) })]);
check("a plan supplies the dose", withPlan.introduce?.dose?.amount === 3);
check("unit rides along", withPlan.introduce?.dose?.unit === "tsp");
check("formats", fmtAmount({ amount: 2.5, unit: "tsp" }) === "2.5 tsp");

console.log("\n== Reaction ==");
const reacted = [...sustained, ev("egg", D(2026, 9, 1), "reaction")];
const r = one(profile(), reacted);
check("reacted food is not scheduled", r.introduce?.allergen !== "egg");
check("other foods still proceed", r.introduce !== null);
check("reaction note present", r.notes.some((n) => n.includes("paused after a reaction")));
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
  all.push(ev(a, d)); all.push(ev(a, addDays(25, d))); d = addDays(30, d);
}
const toddler = one(profile(), all, [], D(2029, 9, 14));
check("nothing left to introduce", toddler.introduce === null);
check("maintenance still due", toddler.maintenanceDue.length > 0);
check("window closes after five years", one(profile(), all, [], D(2032, 9, 14)).maintenanceDue.length === 0);

console.log("\n== Determinism ==");
const a1 = one(profile(), sustained), a2 = one(profile(), sustained);
check("same inputs, same output",
  a1.introduce?.allergen === a2.introduce?.allergen && JSON.stringify(a1.notes) === JSON.stringify(a2.notes));
check("labels resolve", label("cowsMilk") === "Cow's milk");

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
