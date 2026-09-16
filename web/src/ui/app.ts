import { plan, draftLadder, label } from "../engine/planner.js";
import {
  ALLERGENS_BY_JURISDICTION, DEFAULT_CONFIG,
  type Allergen, type ChildProfile, type Day, type DayPlan, type FoodEvent,
  type Prescription, type RiskTier,
} from "../engine/types.js";
import { addDays, daysBetween, formatDay, parseDay, todayLocal } from "../engine/daymath.js";
import { load, save, uid, type Store } from "../store/local.js";
import { sync } from "../store/sync.js";

type Tab = "today" | "schedule" | "foods" | "setup";

let store: Store = load();
let tab: Tab = "today";
let online = false;
let lastSig = "";

/** Re-rendering blows away the DOM, so a background sync must never do it
 *  while someone is typing, and never when nothing actually changed. */
function signature(): string {
  return JSON.stringify([
    tab, online, store.familyKey, store.activeChildId,
    store.children, store.events.length, store.prescriptions.length,
  ]);
}

function isTyping(): boolean {
  const el = document.activeElement;
  return !!el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
}

/** Background path: only paint when it is safe and something moved. */
function maybeRender() {
  if (isTyping()) return;
  if (signature() === lastSig) return;
  render();
}

const root = () => document.getElementById("app")!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function commit(mut: (s: Store) => void) {
  mut(store); save(store); render();
  void sync(store).then((r) => { store = r.store; online = r.online; maybeRender(); });
}

const activeChild = (): ChildProfile | null =>
  store.children.find((c) => c.id === store.activeChildId) ?? store.children[0] ?? null;

function today(): Day { return todayLocal(); }

function planFor(c: ChildProfile, from: Day, through: Day): DayPlan[] {
  return plan({ profile: c, history: store.events, prescriptions: store.prescriptions, from, through });
}

// ---------------------------------------------------------------- rendering

function render() {
  const c = activeChild();
  root().innerHTML = !store.familyKey || !c ? setupView() : viewFor(tab, c);
  wire();
  lastSig = signature();
}

function viewFor(t: Tab, c: ChildProfile): string {
  const body = t === "today" ? todayView(c)
    : t === "schedule" ? scheduleView(c)
    : t === "foods" ? foodsView(c)
    : setupView();
  return body + navBar(t) + statusLine();
}

function navBar(t: Tab): string {
  const item = (id: Tab, ico: string, text: string) =>
    `<button data-tab="${id}" aria-current="${t === id}">
       <span class="ico" aria-hidden="true">${ico}</span>${text}</button>`;
  return `<nav>${item("today", "●", "Today")}${item("schedule", "☷", "Schedule")}
          ${item("foods", "▦", "Foods")}${item("setup", "⚙", "Setup")}</nav>`;
}

const statusLine = () =>
  `<p class="status ${online ? "on" : ""}"><span class="dot"></span>${
    online ? "Synced" : "Offline — changes are saved on this device"}</p>`;

// ---------------------------------------------------------------- today

function todayView(c: ChildProfile): string {
  const d = today();
  const p = planFor(c, d, d)[0]!;
  const months = Math.floor(p.ageInDays / 30.44);

  let html = `<h1>${esc(c.name)}</h1>
    <p class="sub">${months} months · ${formatDay(d)}</p>`;

  if (p.blocked) {
    html += `<div class="card stop"><div class="eyebrow">Not yet</div>
      <p class="note" style="color:var(--ink)">${esc(p.notes[0] ?? "")}</p></div>`;
    if (p.blocked === "readinessNotConfirmed") {
      html += `<button class="primary" data-act="confirm-readiness">
        Confirm readiness signs</button>`;
    }
    return html;
  }

  if (p.introduce) {
    const i = p.introduce;
    html += `<div class="card hero">
      <div class="eyebrow">${i.isNew ? "New food today" : "Continue"}</div>
      <p class="big">${esc(label(i.allergen))}</p>
      ${i.dose ? `<p class="dose">${fmtDose(i.dose.mgProtein, i.dose.unit)}</p>` : ""}
      ${i.attribution ? `<p class="attrib">From your clinician's plan — ${esc(i.attribution)}</p>` : ""}
      <div class="row">
        <button class="primary" data-act="log" data-a="${i.allergen}">Done</button>
        <button class="danger" data-act="react" data-a="${i.allergen}">Reaction</button>
      </div>
    </div>`;
  } else {
    html += `<div class="card"><div class="eyebrow">Nothing new today</div>
      <p class="note">Next food is spaced out. Maintenance below, if any.</p></div>`;
  }

  if (p.maintenanceDue.length) {
    html += `<h2>Keep in the diet</h2><div class="card"><ul class="list">` +
      p.maintenanceDue.map((m) => {
        const last = lastExposureDay(c.id, m.allergen);
        const gap = last ? daysBetween(last, d) : null;
        return `<li><span>${esc(label(m.allergen))}
          <span class="when"> · ${gap === null ? "never" : `${gap}d ago`}</span></span>
          <button class="ghost" data-act="log" data-a="${m.allergen}"
            style="flex:none;min-height:40px;padding:9px 15px">Done</button></li>`;
      }).join("") + `</ul></div>`;
  }

  for (const n of p.notes) html += `<div class="card warn"><p class="note">${esc(n)}</p></div>`;

  html += `<div class="row"><button class="ghost" data-act="backfill">
    Log for another day</button></div>`;
  return html;
}

function fmtDose(mg: number, unit?: string): string {
  const v = mg >= 1000 ? `${(mg / 1000).toFixed(mg % 1000 ? 2 : 0)} g` : `${+mg.toFixed(2)} mg`;
  return unit ? `${v} · ${esc(unit)}` : v;
}

function lastExposureDay(childId: string, a: Allergen): Day | null {
  const ds = store.events
    .filter((e) => e.childId === childId && e.allergen === a && e.kind === "exposure")
    .map((e) => e.day);
  return ds.length ? ds.reduce((x, y) => (daysBetween(x, y) >= 0 ? y : x)) : null;
}

// ---------------------------------------------------------------- schedule

function scheduleView(c: ChildProfile): string {
  const from = today();
  const days = planFor(c, from, addDays(29, from));
  const rows = days.filter((p) => p.introduce || p.maintenanceDue.length).map((p) => {
    const bits: string[] = [];
    if (p.introduce) {
      bits.push(`<span class="pill">${esc(label(p.introduce.allergen))}${
        p.introduce.isNew ? "" : " · cont."}</span>`);
    }
    if (p.maintenanceDue.length) {
      bits.push(`<span class="pill over">${p.maintenanceDue.length} to keep up</span>`);
    }
    return `<li><span class="when">${formatDay(p.day)}</span><span>${bits.join(" ")}</span></li>`;
  }).join("");

  return `<h1>Next 30 days</h1>
    <p class="sub">A projection — it assumes the plan is followed, and it rebuilds
       itself whenever you log something or miss a day.</p>
    <div class="card"><ul class="list">${rows || "<li>Nothing scheduled.</li>"}</ul></div>`;
}

// ---------------------------------------------------------------- foods

function foodsView(c: ChildProfile): string {
  const set = ALLERGENS_BY_JURISDICTION[c.jurisdiction];
  const d = today();
  const items = set.map((a) => {
    const evs = store.events.filter((e) => e.childId === c.id && e.allergen === a);
    const exposures = evs.filter((e) => e.kind === "exposure").length;
    const reacted = evs.some((e) => e.kind === "reaction");
    const excluded = c.excluded.includes(a);
    const rx = store.prescriptions.find((p) => p.childId === c.id && p.allergen === a);
    let pill = `<span class="pill">${exposures}/${DEFAULT_CONFIG.exposuresToEstablish}</span>`;
    if (excluded) pill = `<span class="pill stop">skipped</span>`;
    else if (reacted) pill = `<span class="pill stop">reacted</span>`;
    else if (rx) pill = `<span class="pill over">on plan</span>`;
    else if (exposures >= DEFAULT_CONFIG.exposuresToEstablish) pill = `<span class="pill">established</span>`;
    return `<li><span>${esc(label(a))}</span>
      <span style="display:flex;gap:8px;align-items:center">${pill}
        <button class="ghost" data-act="food" data-a="${a}"
          style="flex:none;min-height:38px;padding:8px 13px">Edit</button></span></li>`;
  }).join("");

  return `<h1>Foods</h1>
    <p class="sub">The app never suggests an amount. Amounts appear only if you enter a plan
       your clinician gave you, and confirm each step.</p>
    <div class="card"><ul class="list">${items}</ul></div>
    <p class="status">Today is ${formatDay(d)}</p>`;
}

// ---------------------------------------------------------------- setup

function setupView(): string {
  const c = activeChild();
  const fam = store.familyKey;
  return `<h1>Setup</h1>
  <p class="sub">No accounts. Everyone who opens the same family link sees the same plan.</p>

  <h2>Family link</h2>
  <div class="card">
    <label for="fam">Family key</label>
    <input id="fam" value="${esc(fam)}" placeholder="e.g. huang-family-7f3a" autocapitalize="off">
    <p class="note">Share this app's URL plus this key with the other parent. Anyone with it can
       read and add to the plan, so pick something not guessable.</p>
    <div class="row"><button class="primary" data-act="save-family">Save</button></div>
  </div>

  <h2>Child</h2>
  <div class="card">
    <label for="nm">Name</label>
    <input id="nm" value="${esc(c?.name ?? "")}" placeholder="Name">
    <div class="grid2">
      <div><label for="bd">Date of birth</label>
        <input id="bd" type="date" value="${c ? formatDay(c.birthDate) : ""}"></div>
      <div><label for="rt">Risk</label>
        <select id="rt">
          <option value="standard"${c?.riskTier === "standard" ? " selected" : ""}>No eczema or known allergy</option>
          <option value="mildEczema"${c?.riskTier === "mildEczema" ? " selected" : ""}>Mild or moderate eczema</option>
          <option value="severeEczemaOrEggAllergy"${c?.riskTier === "severeEczemaOrEggAllergy" ? " selected" : ""}>Severe eczema or egg allergy</option>
        </select></div>
    </div>
    <p class="note">Severe eczema or an existing egg allergy is the group guidelines say should be
       assessed by a clinician before introducing at home. The app will not build a home schedule
       for that case until you mark a food as cleared.</p>
    <div class="row"><button class="primary" data-act="save-child">${c ? "Save" : "Add child"}</button></div>
  </div>

  ${store.children.length > 1 ? `<h2>Children</h2><div class="card"><ul class="list">${
    store.children.map((k) => `<li><span>${esc(k.name)}</span>
      <button class="ghost" data-act="pick" data-id="${k.id}"
        style="flex:none;min-height:38px;padding:8px 13px">${
        k.id === c?.id ? "Active" : "Switch"}</button></li>`).join("")}</ul></div>` : ""}

  <div class="row"><button class="ghost" data-act="add-child">Add another child</button></div>
  <p class="status">This app does not give medical advice and never suggests an amount.
     Talk to your pediatrician before starting solids or any allergen.</p>`;
}

// ---------------------------------------------------------------- events

function wire() {
  root().querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
    b.onclick = () => { tab = b.dataset.tab as Tab; render(); });

  root().querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) =>
    b.onclick = () => handle(b.dataset.act!, b.dataset));
}

function handle(act: string, data: DOMStringMap) {
  const c = activeChild();
  switch (act) {
    case "save-family": {
      const v = (document.getElementById("fam") as HTMLInputElement).value.trim();
      commit((s) => { s.familyKey = v; });
      break;
    }
    case "save-child":
    case "add-child": {
      const nm = (document.getElementById("nm") as HTMLInputElement | null)?.value.trim();
      const bd = (document.getElementById("bd") as HTMLInputElement | null)?.value;
      const rt = (document.getElementById("rt") as HTMLSelectElement | null)?.value as RiskTier;
      if (act === "add-child") { commit((s) => { s.activeChildId = null; }); tab = "setup"; return; }
      if (!nm || !bd) { alert("Name and date of birth are needed."); return; }
      commit((s) => {
        const existing = s.children.find((x) => x.id === s.activeChildId);
        if (existing) {
          existing.name = nm; existing.birthDate = parseDay(bd); existing.riskTier = rt;
        } else {
          const kid: ChildProfile = {
            id: uid(), name: nm, birthDate: parseDay(bd), riskTier: rt,
            jurisdiction: "us", readinessConfirmedOn: null, clinicianCleared: [], excluded: [],
          };
          s.children.push(kid); s.activeChildId = kid.id;
        }
      });
      tab = "today";
      break;
    }
    case "pick": commit((s) => { s.activeChildId = data.id!; }); tab = "today"; break;
    case "confirm-readiness": {
      if (!c) return;
      if (!confirm("Confirm this child sits with support, holds their head steady, and shows "
        + "interest in food? Your pediatrician is the right person to check this with.")) return;
      commit((s) => {
        const k = s.children.find((x) => x.id === c.id)!;
        k.readinessConfirmedOn = today();
      });
      break;
    }
    case "log": {
      if (!c) return;
      addEvent(c.id, data.a as Allergen, today(), "exposure");
      break;
    }
    case "react": {
      if (!c) return;
      if (!confirm("Log a reaction? This pauses that food only — other foods carry on. "
        + "If breathing is affected, call emergency services now.")) return;
      addEvent(c.id, data.a as Allergen, today(), "reaction");
      break;
    }
    case "backfill": {
      if (!c) return;
      const when = prompt("Which day? (YYYY-MM-DD)", formatDay(addDays(-1, today())));
      if (!when) return;
      const a = prompt("Which food? e.g. peanut, egg, cowsMilk, wheat, soy, sesame, treeNut, fish, shellfish");
      if (!a) return;
      addEvent(c.id, a.trim() as Allergen, parseDay(when), "exposure");
      break;
    }
    case "food": {
      if (!c) return;
      foodSheet(c, data.a as Allergen);
      break;
    }
  }
}

function addEvent(childId: string, a: Allergen, day: Day, kind: FoodEvent["kind"]) {
  commit((s) => {
    s.events.push({ id: uid(), childId, allergen: a, day, kind, dose: null, supersedes: null });
  });
}

/** The per-allergen inputs. Everything here is typed by the parent; nothing is
 *  suggested. The draft ladder is a typing aid, and every step lands
 *  unconfirmed - the engine will not schedule an unconfirmed step. */
function foodSheet(c: ChildProfile, a: Allergen) {
  const choice = prompt(
    `${label(a)}\n\n1 = skip this food in our household\n2 = un-skip it\n`
    + `3 = enter a clinician's plan (amounts)\n4 = mark cleared by our clinician\n`
    + `\nChoose 1-4:`);
  if (!choice) return;

  if (choice === "1" || choice === "2") {
    commit((s) => {
      const k = s.children.find((x) => x.id === c.id)!;
      k.excluded = choice === "1"
        ? [...new Set([...k.excluded, a])]
        : k.excluded.filter((x) => x !== a);
    });
    return;
  }
  if (choice === "4") {
    if (!confirm(`Mark ${label(a)} as cleared by your clinician for home introduction?`)) return;
    commit((s) => {
      const k = s.children.find((x) => x.id === c.id)!;
      k.clinicianCleared = [...new Set([...k.clinicianCleared, a])];
    });
    return;
  }
  if (choice !== "3") return;

  const who = prompt("Who prescribed this? (shown next to every amount)");
  if (!who) return;
  const startRaw = prompt("Starting amount, in milligrams of protein");
  const start = Number(startRaw);
  if (!start || start <= 0) { alert("Needs a number greater than zero."); return; }
  const unit = prompt("How you'll measure it (free text, e.g. 'tsp thinned peanut butter')") ?? "";
  const mult = Number(prompt("Multiply by, each step (e.g. 2)", "2"));
  const steps = Number(prompt("How many steps?", "5"));
  const hold = Number(prompt("Days at each step before increasing?", "14"));
  if (!mult || !steps || !hold) { alert("All four values are needed."); return; }

  const draft = draftLadder({ mgProtein: start, unit }, mult, steps, hold);
  const listing = draft.map((s) => `  step ${s.index + 1}: ${+s.dose.mgProtein.toFixed(2)} mg, hold ${s.holdDays}d`).join("\n");
  if (!confirm(`Check every line against your clinician's sheet:\n\n${listing}\n\n`
    + `Does this match exactly? Tap Cancel if anything differs.`)) return;

  const rx: Prescription = {
    id: uid(), childId: c.id, allergen: a, enteredOn: today(), attribution: who,
    steps: draft.map((s) => ({ ...s, confirmed: true })),
    supersedes: store.prescriptions.find((p) => p.childId === c.id && p.allergen === a)?.id ?? null,
  };
  commit((s) => {
    s.prescriptions.push(rx);
    const k = s.children.find((x) => x.id === c.id)!;
    k.clinicianCleared = [...new Set([...k.clinicianCleared, a])];
  });
}

// ---------------------------------------------------------------- boot

export function start() {
  const key = new URLSearchParams(location.search).get("family");
  if (key && key !== store.familyKey) { store.familyKey = key; save(store); }
  render();
  void sync(store).then((r) => { store = r.store; online = r.online; maybeRender(); });
  setInterval(() => void sync(store).then((r) => {
    store = r.store; online = r.online; maybeRender();
  }), 30_000);
  // Typing is the one time a repaint is unacceptable, so catch up on blur.
  document.addEventListener("focusout", () => setTimeout(maybeRender, 0));
}
