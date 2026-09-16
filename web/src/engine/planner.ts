import {
  ALLERGENS_BY_JURISDICTION, DEFAULT_CONFIG, DEFAULT_SETTINGS,
  type Allergen, type AllergenStatus, type ChildProfile, type Config,
  type Day, type DayOverride, type DayPlan, type Dose, type DosePlan,
  type FoodEvent, type ScheduledItem,
} from "./types.js";
import { addDays, compareDay, daysBetween } from "./daymath.js";

// =========================================================================
// THIS ENGINE NEVER SUGGESTS AN AMOUNT. A food carries a dose only when the
// parent has created a DosePlan for it; otherwise it is scheduled by name.
// =========================================================================

/** The amount this plan calls for on a given day.
 *
 *  Steps advance on elapsed days AND at least one logged exposure since the
 *  last step - otherwise forgetting for a fortnight would silently jump two
 *  rungs. Missing doses holds the amount; it never escalates it. */
export function amountOn(plan: DosePlan, day: Day, history: FoodEvent[]): Dose {
  const elapsed = daysBetween(plan.effectiveFrom, day);
  if (elapsed < 0) return { amount: plan.startAmount, unit: plan.unit };

  const exposures = history
    .filter((e) => e.childId === plan.childId && e.allergen === plan.allergen
      && e.kind === "exposure"
      && compareDay(e.day, plan.effectiveFrom) >= 0 && compareDay(e.day, day) <= 0)
    .sort((a, b) => compareDay(a.day, b.day));

  let step = 0;
  let stepStarted = plan.effectiveFrom;
  for (;;) {
    const ready = daysBetween(stepStarted, day) >= plan.everyDays;
    const logged = exposures.some((e) => compareDay(e.day, stepStarted) >= 0);
    if (!ready || !logged) break;
    step++;
    stepStarted = addDays(plan.everyDays, stepStarted);
    if (step > 500) break;   // paranoia
  }

  const amount = plan.incrementMode === "multiply"
    ? plan.startAmount * Math.pow(plan.increment || 1, step)
    : plan.startAmount + (plan.increment || 0) * step;
  return { amount: round(amount), unit: plan.unit };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The plan in force for a food on a given day: the latest one that had
 *  started by then. Superseded plans are kept, not filtered - asking about a
 *  past date must return the rule that was actually in force at the time. */
export function planFor(plans: DosePlan[], a: Allergen, day: Day): DosePlan | null {
  const live = plans
    .filter((p) => p.allergen === a && compareDay(p.effectiveFrom, day) <= 0)
    .sort((x, y) => compareDay(x.effectiveFrom, y.effectiveFrom));
  return live[live.length - 1] ?? null;
}

/** `today` is a PARAMETER, never a clock read. That is what lets one function
 *  answer for past, present and future, and makes every result reproducible. */
export function plan(args: {
  profile: ChildProfile;
  history: FoodEvent[];
  dosePlans?: DosePlan[];
  from: Day;
  through: Day;
  config?: Config;
}): DayPlan[] {
  const config = args.config ?? DEFAULT_CONFIG;
  const hist = effective(args.history.filter((e) => e.childId === args.profile.id));
  const plans = effectivePlans((args.dosePlans ?? []).filter((p) => p.childId === args.profile.id));
  const realHorizon = hist.length ? hist.map((e) => e.day).reduce(maxDay) : null;

  const projected = [...hist];
  const out: DayPlan[] = [];
  let d = args.from;
  let guard = 0;
  while (compareDay(d, args.through) <= 0 && guard++ < 4000) {
    const p = planOne(args.profile, projected, plans, d, config);
    out.push(p);
    // Past days use real history. Future days assume the plan is followed -
    // otherwise no forward calendar can exist at all.
    if (realHorizon && compareDay(realHorizon, d) < 0 && p.introduce) {
      projected.push({
        id: `proj-${out.length}`, childId: args.profile.id,
        allergen: p.introduce.allergen, day: d, kind: "exposure",
        dose: p.introduce.dose, supersedes: null,
      });
    }
    d = addDays(1, d);
  }
  return out;
}

function maxDay(a: Day, b: Day): Day { return compareDay(a, b) >= 0 ? a : b; }

function settingsOf(p: ChildProfile) { return p.settings ?? DEFAULT_SETTINGS; }

function planOne(
  profile: ChildProfile, history: FoodEvent[], plans: DosePlan[],
  day: Day, config: Config,
): DayPlan {
  const age = daysBetween(profile.birthDate, day);
  const st = settingsOf(profile);
  const notes: string[] = [];
  const set = ALLERGENS_BY_JURISDICTION[profile.jurisdiction];
  const blocked = (b: DayPlan["blocked"], note: string): DayPlan => ({
    day, ageInDays: age, introduce: null, alsoDue: [], blocked: b, notes: [note],
  });

  if (age < config.solidsFloorDays) {
    return blocked("tooYoung", "Guidelines advise against starting solids before about four months.");
  }
  if (!profile.readinessConfirmedOn) {
    return blocked("readinessNotConfirmed",
      "Guidelines gate starting solids on developmental readiness - sitting with support, "
      + "steady head control, interest in food. Confirm these before starting.");
  }
  if (compareDay(day, profile.readinessConfirmedOn) < 0) {
    return blocked("readinessNotConfirmed", "Readiness signs were not yet confirmed on this date.");
  }

  const status = statuses(profile, history, plans, day);
  const item = (a: Allergen, isNew: boolean): ScheduledItem => {
    const p = planFor(plans, a, day);
    return {
      allergen: a, isNew,
      dose: p ? amountOn(p, day, history) : null,
      source: p?.source || null,
      reactive: p?.reactive ?? false,
    };
  };

  // --- Everything due today ------------------------------------------------
  // Each food has its own cadence. A dose plan says how often it is served; a
  // food being worked up to wants near-daily contact; a settled food only
  // needs its weekly top-up. Applying one interval to all three was wrong.
  const due: Array<[Allergen, number]> = [];
  if (age <= config.maintenanceThroughDays) {
    for (const a of set) {
      if (profile.excluded.includes(a)) continue;
      const s2 = status[a];
      if (!s2) continue;
      const last = lastExposure(a, history, day);
      const gap = last ? daysBetween(last, day) : Infinity;
      let cadence: number | null = null;
      if (s2.kind === "onDosePlan") {
        cadence = planFor(plans, a, day)?.feedEveryDays || 1;
      } else if (s2.kind === "inProgress") {
        cadence = 1;
      } else if (s2.kind === "established") {
        cadence = config.maintenanceIntervalDays;
      }
      if (cadence !== null && gap >= cadence) due.push([a, last ? gap : 9999]);
    }
  }
  let alsoDue = due.sort((x, y) => y[1] - x[1]).map(([a]) => item(a, false));

  // --- Introduction -------------------------------------------------------
  // Order matters. A food whose amount is actively being managed outranks
  // starting a brand new one: it carries a number, it carries reaction risk,
  // and the new food loses nothing by waiting a day.
  let introduce: ScheduledItem | null = null;

  // Only promote a dose-plan food that is ACTUALLY due - its own cadence
  // decides that, not merely "a day has passed".
  const dueNow = new Set(alsoDue.map((m) => m.allergen));
  const onPlan = config.priority.find((a) =>
    status[a]?.kind === "onDosePlan" && dueNow.has(a));

  if (onPlan) {
    introduce = item(onPlan, false);
    // Promoted out of maintenance so it never appears twice on one day.
    alsoDue = alsoDue.filter((m) => m.allergen !== onPlan);
  } else {
    const active = config.priority.find((a) => status[a]?.kind === "inProgress") ?? null;
    if (active && readyForNextExposure(active, history, day)) {
      introduce = item(active, false);
      alsoDue = alsoDue.filter((m) => m.allergen !== active);
    } else {
      const blockedBySerial = config.serialIntroduction && active !== null;
      const lastStart = lastNewStart(history, day);
      const gapOK = !lastStart || daysBetween(lastStart, day) >= st.newAllergenCadenceDays;
      if (!blockedBySerial && gapOK) {
        const next = config.priority.find((a) =>
          set.includes(a)
          && !profile.excluded.includes(a)
          && status[a]?.kind === "notStarted"
          && !(profile.riskTier === "severeEczemaOrEggAllergy" && !profile.clinicianCleared.includes(a)));
        if (next) introduce = item(next, true);
      }
    }
  }

  // Falling behind EXTENDS the plan; it never compresses it. There is exactly
  // one assignment site for a NEW food and it assigns one value.
  if (config.maxNewAllergensPerDay !== 1) throw new Error("invariant: one new food per day");

  // --- Notes --------------------------------------------------------------
  if (profile.riskTier === "severeEczemaOrEggAllergy") {
    const ungated = set.filter((a) => !profile.excluded.includes(a)
      && !profile.clinicianCleared.includes(a) && status[a]?.kind === "notStarted");
    if (ungated.length) {
      notes.push("Guidelines for infants with severe eczema or existing egg allergy contemplate "
        + "specialist evaluation before introduction at home. Talk to your pediatrician or allergist first.");
    }
  }
  for (const a of set) {
    const s = status[a];
    if (s?.kind === "pausedAfterReaction") {
      notes.push(`${label(a)} is paused after a reaction. Other foods continue as normal. `
        + "Set up a plan for it if you are building the amount back up.");
    }
  }
  const remaining = set.filter((a) => !profile.excluded.includes(a) && status[a]?.kind === "notStarted");
  if (age < config.allergensInDietByDays && remaining.length) {
    const daysLeft = config.allergensInDietByDays - age;
    if (remaining.length * st.newAllergenCadenceDays > daysLeft) {
      notes.push(`${remaining.length} foods left and ${daysLeft} days to twelve months. Guidelines `
        + "require only one new food per meal, so these can be spaced more closely. "
        + "Worth raising with your pediatrician.");
    }
  }
  if (introduce?.isNew && config.preferMorning) {
    notes.push(`Serve earlier in the day and watch for about ${Math.round(config.observationWindowMinutes / 60)} hours.`);
  }

  return { day, ageInDays: age, introduce, alsoDue, blocked: null, notes };
}

// --- derivation -----------------------------------------------------------

export function effective(h: FoodEvent[]): FoodEvent[] {
  const superseded = new Set(h.map((e) => e.supersedes).filter(Boolean) as string[]);
  return h.filter((e) => !superseded.has(e.id));
}
export function effectivePlans(p: DosePlan[]): DosePlan[] {
  const superseded = new Set(p.map((x) => x.supersedes).filter(Boolean) as string[]);
  return p.filter((x) => !superseded.has(x.id));
}

export function statuses(
  profile: ChildProfile, history: FoodEvent[], plans: DosePlan[], day: Day,
): Partial<Record<Allergen, AllergenStatus>> {
  const st = settingsOf(profile);
  const out: Partial<Record<Allergen, AllergenStatus>> = {};
  for (const a of ALLERGENS_BY_JURISDICTION[profile.jurisdiction]) {
    if (profile.excluded.includes(a)) { out[a] = { kind: "excluded" }; continue; }
    const events = history
      .filter((e) => e.allergen === a && e.childId === profile.id && compareDay(e.day, day) <= 0)
      .sort((x, y) => compareDay(x.day, y.day));
    const exposures = events.filter((e) => e.kind === "exposure");

    const p = planFor(plans, a, day);
    if (p) {
      const d = amountOn(p, day, history);
      out[a] = { kind: "onDosePlan", step: exposures.length, amount: d.amount,
                 unit: d.unit, reactive: p.reactive };
      continue;
    }
    // [G] ASCIA: a reaction pauses THAT food only. Others proceed.
    const reaction = [...events].reverse().find((e) => e.kind === "reaction");
    if (reaction) { out[a] = { kind: "pausedAfterReaction", on: reaction.day }; continue; }

    if (!exposures.length) { out[a] = { kind: "notStarted" }; continue; }
    // Settled = sustained exposure across the window, first to LAST - so one
    // exposure followed by silence never counts.
    const first = exposures[0]!.day, last = exposures[exposures.length - 1]!.day;
    if (daysBetween(first, last) >= st.daysToEstablish) out[a] = { kind: "established", on: last };
    else out[a] = { kind: "inProgress", exposures: exposures.length };
  }
  return out;
}

function readyForNextExposure(a: Allergen, history: FoodEvent[], day: Day): boolean {
  const last = lastExposure(a, history, day);
  return !last || daysBetween(last, day) >= 1;
}

function lastExposure(a: Allergen, h: FoodEvent[], onOrBefore: Day): Day | null {
  const days = h.filter((e) => e.allergen === a && e.kind === "exposure"
    && compareDay(e.day, onOrBefore) <= 0).map((e) => e.day);
  return days.length ? days.reduce(maxDay) : null;
}

function lastNewStart(h: FoodEvent[], before: Day): Day | null {
  const firsts = new Map<Allergen, Day>();
  for (const e of h) {
    if (e.kind !== "exposure" || compareDay(e.day, before) >= 0) continue;
    const cur = firsts.get(e.allergen);
    firsts.set(e.allergen, cur && compareDay(cur, e.day) <= 0 ? cur : e.day);
  }
  const vals = [...firsts.values()];
  return vals.length ? vals.reduce(maxDay) : null;
}

const LABELS: Record<Allergen, string> = {
  peanut: "Peanut", egg: "Egg", cowsMilk: "Cow's milk", wheat: "Wheat", soy: "Soy",
  sesame: "Sesame", treeNut: "Tree nut", fish: "Fish", shellfish: "Shellfish",
  celery: "Celery", mustard: "Mustard", lupin: "Lupin", mollusc: "Mollusc",
};
export function label(a: Allergen): string { return LABELS[a]; }

export function fmtAmount(d: Dose | null): string {
  if (!d) return "";
  const n = Number.isInteger(d.amount) ? String(d.amount) : String(round(d.amount));
  return d.unit ? `${n} ${d.unit}` : n;
}

// =========================================================================
// Timeline. Pure, like everything else: naps and a day plan in, blocks out.
// Feed windows are DERIVED from the gaps between naps - they are never
// stored, so moving a nap moves the meals around it for free.
// =========================================================================

import type { NapSlot, TimelineBlock, FeedStatus } from "./types.js";

const FEED_LEN = 30;          // how long a feed block is drawn
const AFTER_WAKE = 15;        // a beat after waking before eating
const OBSERVE = 120;          // [G] ASCIA: watch minutes to two hours

/** Blocks for one day, in order. `nowMin` decides whether an unlogged feed
 *  reads as still due or as missed; omit it for a past or future day. */
export function timeline(args: {
  plan: DayPlan;
  naps: NapSlot[];
  history: FoodEvent[];
  childId: string;
  day: Day;
  dayStartMin: number;
  dayEndMin: number;
  nowMin?: number;
}): TimelineBlock[] {
  const { plan: p, naps, history, childId, day, dayStartMin, dayEndMin, nowMin } = args;
  const sorted = [...naps].sort((a, b) => a.startMin - b.startMin);
  const out: TimelineBlock[] = [];

  sorted.forEach((n, i) => out.push({
    kind: "nap", startMin: n.startMin, endMin: n.startMin + n.durationMin,
    napIndex: i + 1, napDone: !!n.done,
  }));

  // Gaps: before the first nap, between naps, after the last.
  const gaps: Array<[number, number]> = [];
  let cursor = dayStartMin;
  for (const n of sorted) {
    if (n.startMin > cursor) gaps.push([cursor, n.startMin]);
    cursor = Math.max(cursor, n.startMin + n.durationMin);
  }
  if (cursor < dayEndMin) gaps.push([cursor, dayEndMin]);

  // The new food goes first - earlier in the day, so the watch window has
  // room before sleep. Maintenance fills the rest in order.
  const foods = [
    ...(p.introduce ? [p.introduce] : []),
    ...p.alsoDue,
  ];

  foods.forEach((f, i) => {
    const gap = gaps[Math.min(i, gaps.length - 1)];
    if (!gap) return;
    // Stack extras inside the last gap rather than dropping them.
    const overflow = Math.max(0, i - (gaps.length - 1));
    const start = Math.min(gap[0] + AFTER_WAKE + overflow * (FEED_LEN + 10),
                           Math.max(gap[0], gap[1] - FEED_LEN));
    const end = Math.min(start + FEED_LEN, gap[1]);
    out.push({
      kind: "feed", startMin: start, endMin: end,
      allergen: f.allergen, dose: f.dose, isNew: f.isNew,
      status: feedStatus(f.allergen, history, childId, day, end, nowMin),
    });
    if (f.isNew) {
      // Two hours from the END of the feed, not the start - conservative, and
      // easier to explain than a window that overlaps the meal itself.
      const obsEnd = end + OBSERVE;
      out.push({
        kind: "observation", startMin: end, endMin: obsEnd,
        clashesWithNap: sorted.some((n) => n.startMin < obsEnd && n.startMin + n.durationMin > end),
      });
    }
  });

  return out.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
}

function feedStatus(
  a: Allergen | undefined, history: FoodEvent[], childId: string,
  day: Day, endMin: number, nowMin?: number,
): FeedStatus {
  if (!a) return "due";
  const same = history.filter((e) => e.childId === childId && e.allergen === a
    && compareDay(e.day, day) === 0);
  if (same.some((e) => e.kind === "reaction")) return "reacted";
  if (same.some((e) => e.kind === "exposure")) return "done";
  if (nowMin !== undefined && nowMin > endMin) return "missed";
  return "due";
}

/** The naps in force for a day: the latest override for it, else the default. */
export function napsFor(
  overrides: DayOverride[], settings: { naps: NapSlot[] }, childId: string, day: Day,
): NapSlot[] {
  const superseded = new Set(overrides.map((o) => o.supersedes).filter(Boolean) as string[]);
  const forDay = overrides
    .filter((o) => !superseded.has(o.id) && o.childId === childId && compareDay(o.day, day) === 0);
  return forDay.length ? forDay[forDay.length - 1]!.naps : settings.naps;
}

export const hhmm = (m: number) => {
  const h = Math.floor(((m % 1440) + 1440) % 1440 / 60), mi = Math.round(m % 60);
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mi === 0 ? `${h12}${ampm}` : `${h12}:${String(mi).padStart(2, "0")}${ampm}`;
};
