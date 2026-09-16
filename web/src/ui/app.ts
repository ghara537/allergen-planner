import { plan, statuses, planFor, amountOn, label, fmtAmount,
         timeline, napsFor, hhmm } from "../engine/planner.js";
import {
  ALLERGENS_BY_JURISDICTION, DEFAULT_SETTINGS,
  type Allergen, type ChildProfile, type Day, type DayPlan, type DosePlan,
  type FoodEvent, type NapSlot, type RiskTier, type TimelineBlock,
} from "../engine/types.js";
import { addDays, daysBetween, formatDay, parseDay, todayLocal } from "../engine/daymath.js";
import { load, save, uid, type Store } from "../store/local.js";
import { sync } from "../store/sync.js";

type Tab = "today" | "schedule" | "foods" | "setup";
type Exposure = "no" | "trying" | "regular" | "reacts" | "never";

let store: Store = load();
let tab: Tab = "today";
let online = false;
let lastSig = "";
let editing: Allergen | null = null;

/** Walkthrough state. Lives only until it is committed. */
let wiz: null | {
  step: number;
  name: string; dob: string; risk: RiskTier; ready: boolean;
  exposure: Partial<Record<Allergen, Exposure>>;
  doses: Partial<Record<Allergen, { amount: string; unit: string; every: string;
                                    inc: string; mode: "add" | "multiply" }>>;
  cadence: string; settle: string;
} = null;

const root = () => document.getElementById("app")!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? "";
const num = (id: string, dflt: number) => { const n = Number(val(id)); return Number.isFinite(n) && n !== 0 ? n : dflt; };

function signature(): string {
  return JSON.stringify([tab, online, editing, wiz?.step ?? null, store.familyKey,
    store.activeChildId, store.children, store.events.length, store.dosePlans.length]);
}
const isTyping = () => {
  const el = document.activeElement;
  return !!el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
};
function maybeRender() { if (!dragging && !isTyping() && signature() !== lastSig) render(); }

function commit(mut: (s: Store) => void) {
  mut(store); save(store); render();
  void sync(store).then((r) => { store = r.store; online = r.online; maybeRender(); });
}

const activeChild = (): ChildProfile | null =>
  store.children.find((c) => c.id === store.activeChildId) ?? store.children[0] ?? null;
const today = (): Day => todayLocal();
const setOf = (c: ChildProfile) => ALLERGENS_BY_JURISDICTION[c.jurisdiction];

function render() {
  const c = activeChild();
  if (wiz) root().innerHTML = wizardView();
  else if (!store.familyKey || !c) root().innerHTML = startView();
  else if (editing) root().innerHTML = editView(c, editing);
  else root().innerHTML = tabView(c) + navBar() + statusLine();
  wire();
  lastSig = signature();
}

// ------------------------------------------------------------------ chrome

function navBar(): string {
  const item = (id: Tab, ico: string, text: string) =>
    `<button data-tab="${id}" aria-current="${tab === id}">
       <span class="ico" aria-hidden="true">${ico}</span>${text}</button>`;
  return `<nav>${item("today", "●", "Today")}${item("schedule", "☷", "Schedule")}
          ${item("foods", "▦", "Foods")}${item("setup", "⚙", "Setup")}</nav>`;
}
const statusLine = () =>
  `<p class="status ${online ? "on" : ""}"><span class="dot"></span>${
    online ? "Synced" : "Saved on this device"}</p>`;

function tabView(c: ChildProfile): string {
  return tab === "today" ? todayView(c)
    : tab === "schedule" ? scheduleView(c)
    : tab === "foods" ? foodsView(c) : setupView(c);
}

// ------------------------------------------------------------------ start

function startView(): string {
  return `<h1>Allergen Planner</h1>
    <p class="sub">A week-by-week plan for introducing solids and allergens.
      It never suggests an amount — you decide those.</p>
    <div class="card">
      <label for="fam">Family link</label>
      <input id="fam" value="${esc(store.familyKey)}" placeholder="e.g. huang-7f3a" autocapitalize="off">
      <p class="note">Anyone who opens this app with the same family link sees the same plan.
        Pick something not guessable — there are no passwords.</p>
    </div>
    <button class="primary" data-act="begin">Start</button>`;
}

// --------------------------------------------------------------- walkthrough

const EX_LABEL: Record<Exposure, string> = {
  no: "Not yet", trying: "Working up to it", regular: "Eats it regularly",
  reacts: "Reacts to it", never: "We don't eat it",
};

function wizardView(): string {
  const w = wiz!;
  const steps = ["Child", "What they've had", "Amounts", "Pacing"];
  const dots = steps.map((s, i) =>
    `<span class="step ${i === w.step ? "on" : i < w.step ? "done" : ""}">${esc(s)}</span>`).join("");
  let body = "";

  if (w.step === 0) {
    body = `<h1>Who is this for?</h1>
      <div class="card">
        <label for="nm">Name</label>
        <input id="nm" value="${esc(w.name)}" placeholder="Name">
        <label for="bd">Date of birth</label>
        <input id="bd" type="date" value="${esc(w.dob)}">
        <label for="rt">Eczema or known allergy</label>
        <select id="rt">
          <option value="standard"${w.risk === "standard" ? " selected" : ""}>Neither</option>
          <option value="mildEczema"${w.risk === "mildEczema" ? " selected" : ""}>Mild or moderate eczema</option>
          <option value="severeEczemaOrEggAllergy"${w.risk === "severeEczemaOrEggAllergy" ? " selected" : ""}>Severe eczema, or an egg allergy</option>
        </select>
        <label class="check"><input type="checkbox" id="rd"${w.ready ? " checked" : ""}>
          <span>They sit with support, hold their head steady, and show interest in food</span></label>
        <p class="note">Guidelines gate starting solids on those signs rather than on age alone.
          Your pediatrician is the right person to confirm them.</p>
      </div>`;
  }

  if (w.step === 1) {
    body = `<h1>What have they had?</h1>
      <p class="sub">Tap through the list. This is how the plan knows where to pick up
        instead of starting you from zero.</p>
      <div class="card">${ALLERGENS_BY_JURISDICTION.us.map((a) => {
        const cur = w.exposure[a] ?? "no";
        return `<div class="seg-row"><span>${esc(label(a))}</span>
          <div class="seg">${(["no", "trying", "regular", "reacts", "never"] as Exposure[]).map((o) =>
            `<button class="${cur === o ? "on" : ""}" data-act="ex" data-a="${a}" data-v="${o}"
               title="${esc(EX_LABEL[o])}">${esc(EX_LABEL[o])}</button>`).join("")}</div></div>`;
      }).join("")}</div>`;
  }

  if (w.step === 2) {
    const withAmounts = ALLERGENS_BY_JURISDICTION.us.filter((a) =>
      ["trying", "regular", "reacts"].includes(w.exposure[a] ?? "no"));
    body = `<h1>Amounts</h1>
      <p class="sub">Only if you're tracking them. Leave anything blank and that food is
        scheduled by name alone, which is fine for most.</p>` +
      (withAmounts.length ? withAmounts.map((a) => {
        const d = w.doses[a] ?? { amount: "", unit: "", every: "", inc: "", mode: "add" as const };
        return `<div class="card"><div class="eyebrow">${esc(label(a))}${
          w.exposure[a] === "reacts" ? " · reacts" : ""}</div>
          <div class="grid2">
            <div><label for="am-${a}">Current amount</label>
              <input id="am-${a}" inputmode="decimal" value="${esc(d.amount)}" placeholder="e.g. 2"></div>
            <div><label for="un-${a}">Unit</label>
              <input id="un-${a}" value="${esc(d.unit)}" placeholder="tsp, mg, ml"></div>
          </div>
          <div class="grid2">
            <div><label for="in-${a}">Increase by</label>
              <input id="in-${a}" inputmode="decimal" value="${esc(d.inc)}" placeholder="0 to hold"></div>
            <div><label for="ev-${a}">Every (days)</label>
              <input id="ev-${a}" inputmode="numeric" value="${esc(d.every)}" placeholder="7"></div>
          </div>
          <label for="md-${a}">How</label>
          <select id="md-${a}">
            <option value="add"${d.mode === "add" ? " selected" : ""}>Add that much</option>
            <option value="multiply"${d.mode === "multiply" ? " selected" : ""}>Multiply by it</option>
          </select></div>`;
      }).join("") : `<div class="card"><p class="note">Nothing marked as tried yet —
          skip ahead, you can add amounts any time from the Foods tab.</p></div>`);
  }

  if (w.step === 3) {
    body = `<h1>Pacing</h1>
      <p class="sub">Two numbers, both editable later.</p>
      <div class="card">
        <label for="cad">Days between starting new foods</label>
        <input id="cad" inputmode="numeric" value="${esc(w.cadence)}">
        <p class="note">Guidelines only ask for one new food per meal. Longer gaps are a common
          precaution so a reaction is easy to attribute — reactions can also show up on a later
          exposure, not just the first.</p>
        <label for="set">Days of regular eating before a food counts as settled</label>
        <input id="set" inputmode="numeric" value="${esc(w.settle)}">
        <p class="note">Measured from the first time they had it to the most recent, so a single
          taste followed by a gap doesn't count.</p>
      </div>`;
  }

  const back = w.step > 0 ? `<button class="ghost" data-act="wiz-back">Back</button>` : "";
  const next = w.step < 3
    ? `<button class="primary" data-act="wiz-next">Continue</button>`
    : `<button class="primary" data-act="wiz-done">Build the plan</button>`;
  return `<div class="steps">${dots}</div>${body}<div class="row">${back}${next}</div>`;
}

// ------------------------------------------------------------------ today

const PX_PER_MIN = 0.85;          // ~51px an hour: a nap reads as a real block
const SNAP = 5;                   // minutes

function todayView(c: ChildProfile): string {
  const d = today();
  const p = planFrom(c, d, d)[0]!;
  const st = c.settings ?? DEFAULT_SETTINGS;
  const months = Math.floor(p.ageInDays / 30.44);
  let html = `<h1>${esc(c.name)}</h1><p class="sub">${months} months · ${formatDay(d)}</p>`;

  if (p.blocked) {
    html += `<div class="card stop"><div class="eyebrow">Not yet</div>
      <p class="note" style="color:var(--ink)">${esc(p.notes[0] ?? "")}</p></div>`;
    if (p.blocked === "readinessNotConfirmed") {
      html += `<button class="primary" data-act="confirm-readiness">Confirm readiness signs</button>`;
    }
    return html;
  }

  const naps = napsFor(store.dayOverrides, st, c.id, d);
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const blocks = timeline({ plan: p, naps, history: store.events, childId: c.id, day: d,
                            dayStartMin: st.dayStartMin, dayEndMin: st.dayEndMin, nowMin });

  const doneNaps = naps.filter((n) => n.done).length;
  const plannedMin = naps.reduce((t, n) => t + n.durationMin, 0);
  const doneMin = naps.filter((n) => n.done).reduce((t, n) => t + n.durationMin, 0);
  html += `<div class="napbar">
    <span><b>${doneNaps}</b> of ${naps.length} naps</span>
    <span><b>${Math.round(doneMin / 60 * 10) / 10}h</b> of ${Math.round(plannedMin / 60 * 10) / 10}h slept</span>
    <button class="ghost sm" data-act="add-nap">+ nap</button>
  </div>`;

  html += renderTimeline(blocks, st.dayStartMin, st.dayEndMin, nowMin);

  for (const n of p.notes) html += `<div class="card warn"><p class="note">${esc(n)}</p></div>`;
  html += `<div class="row">
    <button class="ghost" data-act="backfill">Log another day</button>
    <button class="ghost" data-act="reset-naps">Reset naps</button></div>`;
  return html;
}

function renderTimeline(blocks: TimelineBlock[], from: number, to: number, nowMin: number): string {
  const h = (to - from) * PX_PER_MIN;
  const y = (m: number) => (m - from) * PX_PER_MIN;

  let hours = "";
  for (let m = Math.ceil(from / 60) * 60; m <= to; m += 60) {
    hours += `<div class="hour" style="top:${y(m)}px"><span>${esc(hhmm(m))}</span></div>`;
  }

  const now = nowMin >= from && nowMin <= to
    ? `<div class="nowline" style="top:${y(nowMin)}px"></div>` : "";

  const items = blocks.map((b, i) => {
    const top = y(Math.max(b.startMin, from));
    const hgt = Math.max(16, y(Math.min(b.endMin, to)) - top);
    const time = `${hhmm(b.startMin)}–${hhmm(b.endMin)}`;

    if (b.kind === "observation") {
      return `<div class="blk obs${b.clashesWithNap ? " clash" : ""}"
        style="top:${top}px;height:${hgt}px">
        <span>watch ${b.clashesWithNap ? "· runs into a nap" : ""}</span></div>`;
    }
    if (b.kind === "nap") {
      return `<div class="blk nap${b.napDone ? " done" : ""}" data-drag="nap"
        data-i="${(b.napIndex ?? 1) - 1}" style="top:${top}px;height:${hgt}px">
        <div class="grip top" data-edge="top"></div>
        <div class="blk-in">
          <b>Nap ${b.napIndex}</b>
          <span class="t">${esc(time)}</span>
          <button class="tick" data-act="nap-done" data-i="${(b.napIndex ?? 1) - 1}"
            aria-label="mark nap slept">${b.napDone ? "✓" : "○"}</button>
        </div>
        <div class="grip bottom" data-edge="bottom"></div></div>`;
    }
    const s = b.status ?? "due";
    return `<div class="blk feed ${s}" style="top:${top}px;height:${hgt}px">
      <div class="blk-in">
        <b>${esc(label(b.allergen!))}${b.isNew ? " · new" : ""}</b>
        <span class="t">${esc(hhmm(b.startMin))}${b.dose ? " · " + esc(fmtAmount(b.dose)) : ""}</span>
        ${s === "done" ? `<span class="tick on">✓</span>`
          : s === "reacted" ? `<span class="tick bad">!</span>`
          : `<button class="tick" data-act="log" data-a="${b.allergen}" aria-label="mark eaten">○</button>`}
      </div></div>`;
  }).join("");

  return `<div class="tl" style="height:${h}px">${hours}${now}${items}</div>
    <p class="status">Drag a nap to move it, or its top and bottom edges to change how long.
      Changes apply to today only and everyone on the family link sees them.</p>`;
}

function planFrom(c: ChildProfile, from: Day, through: Day): DayPlan[] {
  return plan({ profile: c, history: store.events, dosePlans: store.dosePlans, from, through });
}

// --------------------------------------------------------------- schedule

function scheduleView(c: ChildProfile): string {
  const from = today();
  const rows = planFrom(c, from, addDays(29, from))
    .filter((p) => p.introduce || p.maintenanceDue.length)
    .map((p) => {
      const bits: string[] = [];
      if (p.introduce) bits.push(`<span class="pill">${esc(label(p.introduce.allergen))}${
        p.introduce.dose ? ` ${esc(fmtAmount(p.introduce.dose))}` : ""}</span>`);
      if (p.maintenanceDue.length) bits.push(`<span class="pill over">${p.maintenanceDue.length} to keep up</span>`);
      return `<li><span class="when">${formatDay(p.day)}</span><span>${bits.join(" ")}</span></li>`;
    }).join("");
  return `<h1>Next 30 days</h1>
    <p class="sub">A projection. It assumes the plan is followed, and rebuilds itself
      every time you log something or miss a day.</p>
    <div class="card"><ul class="list">${rows || "<li>Nothing scheduled.</li>"}</ul></div>`;
}

// ------------------------------------------------------------------ foods

function foodsView(c: ChildProfile): string {
  const d = today();
  const st = statuses(c, store.events, store.dosePlans, d);
  const items = setOf(c).map((a) => {
    const s = st[a];
    let pill = `<span class="pill">not started</span>`;
    if (s?.kind === "excluded") pill = `<span class="pill stop">skipped</span>`;
    else if (s?.kind === "pausedAfterReaction") pill = `<span class="pill stop">reacted</span>`;
    else if (s?.kind === "onDosePlan") pill = `<span class="pill ${s.reactive ? "over" : ""}">${
      esc(fmtAmount({ amount: s.amount, unit: s.unit }))}</span>`;
    else if (s?.kind === "established") pill = `<span class="pill">settled</span>`;
    else if (s?.kind === "inProgress") pill = `<span class="pill over">${s.exposures} logged</span>`;
    return `<li><span>${esc(label(a))}</span><span class="rt">${pill}
      <button class="ghost sm" data-act="edit" data-a="${a}">Edit</button></span></li>`;
  }).join("");
  return `<h1>Foods</h1>
    <p class="sub">The app never suggests an amount. Anything shown here is what you entered.</p>
    <div class="card"><ul class="list">${items}</ul></div>`;
}

// ------------------------------------------------------------------- edit

function editView(c: ChildProfile, a: Allergen): string {
  const d = today();
  const p = planFor(store.dosePlans, a, d);
  const cur = p ? amountOn(p, d, store.events) : null;
  const st = statuses(c, store.events, store.dosePlans, d)[a];
  const reacted = st?.kind === "pausedAfterReaction";
  const reactive = p?.reactive ?? reacted;
  const excluded = c.excluded.includes(a);

  return `<h1>${esc(label(a))}</h1>
  <p class="sub">${p
    ? `Showing where this food is now — after ${p.effectiveFrom ? `${daysBetween(p.effectiveFrom, d)} days on` : ""} the current plan.
       Saving starts a fresh plan from today at whatever you enter.`
    : "No amounts tracked for this food. It's scheduled by name only."}</p>

  <div class="card">
    <label class="check"><input type="checkbox" id="rx"${reactive ? " checked" : ""}>
      <span>Reacts to this food</span></label>
    <p class="note">Marking this changes the tone — the plan reads as building an amount back up
      rather than introducing something new. It does not change the arithmetic.</p>

    <div class="grid2">
      <div><label for="am">Current amount</label>
        <input id="am" inputmode="decimal" value="${cur ? esc(String(cur.amount)) : ""}" placeholder="leave blank for none"></div>
      <div><label for="un">Unit</label>
        <input id="un" value="${esc(p?.unit ?? "")}" placeholder="tsp, mg, ml"></div>
    </div>
    <div class="grid2">
      <div><label for="in">Increase by</label>
        <input id="in" inputmode="decimal" value="${esc(String(p?.increment ?? ""))}" placeholder="0 to hold"></div>
      <div><label for="ev">Every (days)</label>
        <input id="ev" inputmode="numeric" value="${esc(String(p?.everyDays ?? ""))}" placeholder="7"></div>
    </div>
    <label for="md">How</label>
    <select id="md">
      <option value="add"${p?.incrementMode !== "multiply" ? " selected" : ""}>Add that much</option>
      <option value="multiply"${p?.incrementMode === "multiply" ? " selected" : ""}>Multiply by it</option>
    </select>
    <label for="src">Note (optional)</label>
    <input id="src" value="${esc(p?.source ?? "")}" placeholder="e.g. Dr Nguyen, 14 Sep">
  </div>

  <div class="card">
    <label class="check"><input type="checkbox" id="exc"${excluded ? " checked" : ""}>
      <span>We don't eat this — leave it out of the plan</span></label>
  </div>

  <div class="row">
    <button class="ghost" data-act="edit-cancel">Cancel</button>
    <button class="primary" data-act="edit-save" data-a="${a}">Save</button>
  </div>
  ${p ? `<div class="row"><button class="danger" data-act="edit-clear" data-a="${a}">Stop tracking amounts</button></div>` : ""}`;
}

// ------------------------------------------------------------------ setup

function setupView(c: ChildProfile): string {
  const s = c.settings ?? DEFAULT_SETTINGS;
  return `<h1>Setup</h1>
  <div class="card">
    <label for="fam2">Family link</label>
    <input id="fam2" value="${esc(store.familyKey)}" autocapitalize="off">
    <p class="note">Everyone who opens the app with this link shares the plan.</p>
    <div class="row"><button class="primary" data-act="save-family">Save</button></div>
  </div>

  <h2>Pacing</h2>
  <div class="card">
    <div class="grid2">
      <div><label for="cad2">New food every (days)</label>
        <input id="cad2" inputmode="numeric" value="${s.newAllergenCadenceDays}"></div>
      <div><label for="set2">Settled after (days)</label>
        <input id="set2" inputmode="numeric" value="${s.daysToEstablish}"></div>
    </div>
    <div class="row"><button class="primary" data-act="save-settings">Save</button></div>
  </div>

  <h2>Usual naps</h2>
  <div class="card">
    ${s.naps.map((n, i) => `<div class="grid2">
      <div><label for="ns-${i}">Nap ${i + 1} starts</label>
        <input id="ns-${i}" type="time" value="${esc(toTime(n.startMin))}"></div>
      <div><label for="nd-${i}">For (minutes)</label>
        <input id="nd-${i}" inputmode="numeric" value="${n.durationMin}"></div>
    </div>`).join("")}
    <div class="row">
      <button class="ghost" data-act="naps-fewer">Fewer</button>
      <button class="ghost" data-act="naps-more">More</button>
    </div>
    <div class="grid2">
      <div><label for="ds">Day starts</label>
        <input id="ds" type="time" value="${esc(toTime(s.dayStartMin))}"></div>
      <div><label for="de">Day ends</label>
        <input id="de" type="time" value="${esc(toTime(s.dayEndMin))}"></div>
    </div>
    <p class="note">This is the usual shape. Today can differ without changing it —
      adjust the blocks on the Today tab instead.</p>
    <div class="row"><button class="primary" data-act="save-naps">Save</button></div>
  </div>

  <h2>Children</h2>
  <div class="card"><ul class="list">${store.children.map((k) =>
    `<li><span>${esc(k.name)} <span class="when">· ${formatDay(k.birthDate)}</span></span>
      <button class="ghost sm" data-act="pick" data-id="${k.id}">${
        k.id === c.id ? "Active" : "Switch"}</button></li>`).join("")}</ul></div>
  <div class="row"><button class="ghost" data-act="add-child">Add another child</button></div>

  <p class="status">This app gives no medical advice and never suggests an amount.
    Talk to your pediatrician before starting solids or any allergen, and call emergency
    services if a reaction affects breathing.</p>`;
}

// ------------------------------------------------------------------ events

function wire() {
  root().querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
    b.onclick = () => { tab = b.dataset.tab as Tab; editing = null; render(); });
  root().querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) =>
    b.onclick = () => handle(b.dataset.act!, b.dataset));
  const c = activeChild();
  if (c && tab === "today" && !editing && !wiz) wireDrag(c);
}

function captureWizard() {
  const w = wiz!;
  if (w.step === 0) {
    w.name = val("nm") || w.name; w.dob = val("bd") || w.dob;
    w.risk = (val("rt") as RiskTier) || w.risk;
    w.ready = (document.getElementById("rd") as HTMLInputElement | null)?.checked ?? w.ready;
  }
  if (w.step === 2) {
    for (const a of ALLERGENS_BY_JURISDICTION.us) {
      if (!document.getElementById(`am-${a}`)) continue;
      w.doses[a] = { amount: val(`am-${a}`), unit: val(`un-${a}`), every: val(`ev-${a}`),
                     inc: val(`in-${a}`), mode: (val(`md-${a}`) as "add" | "multiply") || "add" };
    }
  }
  if (w.step === 3) { w.cadence = val("cad") || w.cadence; w.settle = val("set") || w.settle; }
}

function handle(act: string, data: DOMStringMap) {
  const c = activeChild();
  switch (act) {
    case "begin": {
      const k = val("fam").trim();
      if (!k) { alert("Pick a family link first."); return; }
      store.familyKey = k; save(store);
      wiz = { step: 0, name: "", dob: "", risk: "standard", ready: false,
              exposure: {}, doses: {}, cadence: "5", settle: "21" };
      render(); break;
    }
    case "wiz-back": captureWizard(); wiz!.step--; render(); break;
    case "wiz-next": {
      captureWizard();
      if (wiz!.step === 0 && (!wiz!.name || !wiz!.dob)) { alert("Name and date of birth, please."); return; }
      wiz!.step++; render(); break;
    }
    case "ex": { wiz!.exposure[data.a as Allergen] = data.v as Exposure; render(); break; }
    case "wiz-done": { captureWizard(); finishWizard(); break; }

    case "save-family": commit((s) => { s.familyKey = val("fam2").trim(); }); break;
    case "save-settings": {
      if (!c) return;
      const cad = num("cad2", 5), set = num("set2", 21);
      commit((s) => {
        const k = s.children.find((x) => x.id === c.id)!;
        k.settings = { ...(k.settings ?? DEFAULT_SETTINGS),
                       newAllergenCadenceDays: cad, daysToEstablish: set };
      });
      break;
    }
    case "pick": commit((s) => { s.activeChildId = data.id!; }); tab = "today"; break;
    case "add-child":
      wiz = { step: 0, name: "", dob: "", risk: "standard", ready: false,
              exposure: {}, doses: {}, cadence: "5", settle: "21" };
      render(); break;

    case "confirm-readiness": {
      if (!c) return;
      commit((s) => { s.children.find((x) => x.id === c.id)!.readinessConfirmedOn = today(); });
      break;
    }
    case "log": if (c) addEvent(c.id, data.a as Allergen, today(), "exposure"); break;
    case "react": {
      if (!c) return;
      if (!confirm("Log a reaction? This pauses that food only — everything else carries on. "
        + "If breathing is affected, call emergency services now.")) return;
      addEvent(c.id, data.a as Allergen, today(), "reaction"); break;
    }
    case "backfill": {
      if (!c) return;
      const when = prompt("Which day? (YYYY-MM-DD)", formatDay(addDays(-1, today())));
      if (!when) return;
      const a = prompt("Which food?\n" + setOf(c).join(", "));
      if (!a) return;
      addEvent(c.id, a.trim() as Allergen, parseDay(when), "exposure"); break;
    }

    case "add-nap": {
      if (!c) return;
      const naps = napsToday(c);
      const last = naps[naps.length - 1];
      const start = last ? Math.min(last.startMin + last.durationMin + 120,
        (c.settings ?? DEFAULT_SETTINGS).dayEndMin - 45) : 9 * 60;
      writeNaps(c, [...naps, { startMin: start, durationMin: 45 }]);
      break;
    }
    case "nap-done": {
      if (!c) return;
      const naps = napsToday(c);
      const n = naps[Number(data.i)];
      if (n) { n.done = !n.done; writeNaps(c, naps); }
      break;
    }
    case "reset-naps": {
      if (!c) return;
      if (!confirm("Put today's naps back to the usual schedule?")) return;
      writeNaps(c, (c.settings ?? DEFAULT_SETTINGS).naps.map((n) => ({ ...n })));
      break;
    }
    case "naps-more": case "naps-fewer": {
      if (!c) return;
      const cur = readNapInputs(c);
      const naps = act === "naps-more"
        ? [...cur, { startMin: Math.min((cur[cur.length - 1]?.startMin ?? 480) + 180, 19 * 60), durationMin: 45 }]
        : cur.slice(0, -1);
      commit((s) => {
        const k = s.children.find((x) => x.id === c.id)!;
        k.settings = { ...(k.settings ?? DEFAULT_SETTINGS), naps };
      });
      break;
    }
    case "save-naps": {
      if (!c) return;
      const naps = readNapInputs(c);
      const ds = fromTime(val("ds"), 6 * 60), de = fromTime(val("de"), 20 * 60);
      commit((s) => {
        const k = s.children.find((x) => x.id === c.id)!;
        k.settings = { ...(k.settings ?? DEFAULT_SETTINGS), naps,
                       dayStartMin: ds, dayEndMin: Math.max(de, ds + 60) };
      });
      break;
    }
    case "edit": editing = data.a as Allergen; render(); break;
    case "edit-cancel": editing = null; render(); break;
    case "edit-clear": {
      if (!c) return;
      const a = data.a as Allergen;
      const prev = planFor(store.dosePlans, a, today());
      commit((s) => { s.dosePlans = s.dosePlans.filter((p) => p.id !== prev?.id); });
      editing = null; render(); break;
    }
    case "edit-save": {
      if (!c) return;
      const a = data.a as Allergen;
      const amount = Number(val("am"));
      const excl = (document.getElementById("exc") as HTMLInputElement).checked;
      const reactive = (document.getElementById("rx") as HTMLInputElement).checked;
      const prev = planFor(store.dosePlans, a, today());
      const unit = val("un").trim(), src = val("src").trim();
      const inc = Number(val("in")) || 0, every = Number(val("ev")) || 7;

      commit((s) => {
        const k = s.children.find((x) => x.id === c.id)!;
        k.excluded = excl ? [...new Set([...k.excluded, a])] : k.excluded.filter((x) => x !== a);
        if (Number.isFinite(amount) && amount > 0) {
          // An edit never rewrites the old rule; it starts a new one today.
          s.dosePlans.push({
            id: uid(), childId: c.id, allergen: a, effectiveFrom: today(),
            startAmount: amount, unit, increment: inc,
            incrementMode: (val("md") as "add" | "multiply") || "add",
            everyDays: every, reactive, source: src, supersedes: prev?.id ?? null,
          });
        }
      });
      editing = null; render(); break;
    }
  }
}

function readNapInputs(c: ChildProfile): NapSlot[] {
  const cur = (c.settings ?? DEFAULT_SETTINGS).naps;
  return cur.map((n, i) => ({
    startMin: fromTime(val(`ns-${i}`), n.startMin),
    durationMin: Math.max(15, Number(val(`nd-${i}`)) || n.durationMin),
  }));
}

function addEvent(childId: string, a: Allergen, day: Day, kind: FoodEvent["kind"]) {
  commit((s) => {
    s.events.push({ id: uid(), childId, allergen: a, day, kind, dose: null, supersedes: null });
  });
}

/** Turn the walkthrough into a child, a backdated history, and any dose plans.
 *  "Eats it regularly" becomes a span of exposures long enough to read as
 *  settled, because that is what the parent just told us. */
function finishWizard() {
  const w = wiz!;
  const cadence = Number(w.cadence) || 5;
  const settle = Number(w.settle) || 21;
  const d = today();
  const kid: ChildProfile = {
    id: uid(), name: w.name.trim(), birthDate: parseDay(w.dob), riskTier: w.risk,
    jurisdiction: "us", readinessConfirmedOn: w.ready ? d : null,
    clinicianCleared: [], excluded: [],
    settings: { ...DEFAULT_SETTINGS, newAllergenCadenceDays: cadence, daysToEstablish: settle },
  };
  const events: FoodEvent[] = [];
  const plans: DosePlan[] = [];

  for (const a of ALLERGENS_BY_JURISDICTION.us) {
    const e = w.exposure[a] ?? "no";
    if (e === "never") kid.excluded.push(a);
    if (e === "regular") {
      events.push({ id: uid(), childId: kid.id, allergen: a, day: addDays(-(settle + 1), d),
                    kind: "exposure", dose: null, supersedes: null });
      events.push({ id: uid(), childId: kid.id, allergen: a, day: addDays(-2, d),
                    kind: "exposure", dose: null, supersedes: null });
    }
    if (e === "trying") {
      events.push({ id: uid(), childId: kid.id, allergen: a, day: addDays(-3, d),
                    kind: "exposure", dose: null, supersedes: null });
    }
    if (e === "reacts") {
      events.push({ id: uid(), childId: kid.id, allergen: a, day: addDays(-3, d),
                    kind: "reaction", dose: null, supersedes: null });
    }
    const dose = w.doses[a];
    if (dose && Number(dose.amount) > 0) {
      plans.push({
        id: uid(), childId: kid.id, allergen: a, effectiveFrom: d,
        startAmount: Number(dose.amount), unit: dose.unit.trim(),
        increment: Number(dose.inc) || 0, incrementMode: dose.mode,
        everyDays: Number(dose.every) || 7, reactive: e === "reacts",
        source: "", supersedes: null,
      });
    }
  }

  wiz = null; tab = "today";
  commit((s) => {
    s.children.push(kid); s.activeChildId = kid.id;
    s.events.push(...events); s.dosePlans.push(...plans);
  });
}

// ------------------------------------------------------------------- naps

const toTime = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fromTime = (v: string, dflt: number) => {
  const [h, mi] = v.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(mi) ? h! * 60 + mi! : dflt;
};

/** Today's naps, written as a superseding override so the default shape is
 *  untouched and two phones adjusting the same day converge. */
function writeNaps(c: ChildProfile, naps: NapSlot[]) {
  const d = today();
  const prev = store.dayOverrides.filter((o) => o.childId === c.id
    && formatDay(o.day) === formatDay(d));
  const live = prev[prev.length - 1];
  commit((s) => {
    s.dayOverrides.push({ id: uid(), childId: c.id, day: d,
                          naps: naps.map((n) => ({ ...n })), supersedes: live?.id ?? null });
  });
}

const napsToday = (c: ChildProfile): NapSlot[] =>
  napsFor(store.dayOverrides, c.settings ?? DEFAULT_SETTINGS, c.id, today())
    .map((n) => ({ ...n }));

// ------------------------------------------------------------------- drag
// Pointer Events so mouse and touch take the same path. The block follows the
// finger live and nothing is written until release, so a drag that is really
// a scroll costs nothing.

let dragging = false;

function wireDrag(c: ChildProfile) {
  root().querySelectorAll<HTMLElement>('[data-drag="nap"]').forEach((el) => {
    el.addEventListener("pointerdown", (ev) => startDrag(ev, el, c));
  });
}

function startDrag(ev: PointerEvent, el: HTMLElement, c: ChildProfile) {
  const target = ev.target as HTMLElement;
  if (target.closest("button")) return;                 // the tick is not a handle
  const edge = target.dataset.edge as "top" | "bottom" | undefined;
  const i = Number(el.dataset.i);
  const naps = napsToday(c);
  const nap = naps[i];
  if (!nap) return;

  ev.preventDefault();
  el.setPointerCapture(ev.pointerId);
  dragging = true;
  el.classList.add("dragging");

  const startY = ev.clientY;
  const origStart = nap.startMin, origDur = nap.durationMin;
  const st = c.settings ?? DEFAULT_SETTINGS;
  const snap = (m: number) => Math.round(m / SNAP) * SNAP;

  const move = (e: PointerEvent) => {
    const delta = snap((e.clientY - startY) / PX_PER_MIN);
    let start = origStart, dur = origDur;
    if (edge === "top") {
      start = Math.min(origStart + delta, origStart + origDur - 15);
      dur = origDur - (start - origStart);
    } else if (edge === "bottom") {
      dur = Math.max(15, origDur + delta);
    } else {
      start = origStart + delta;
    }
    start = Math.max(st.dayStartMin, Math.min(start, st.dayEndMin - dur));
    dur = Math.min(dur, st.dayEndMin - start);
    nap.startMin = start; nap.durationMin = dur;
    el.style.top = `${(start - st.dayStartMin) * PX_PER_MIN}px`;
    el.style.height = `${dur * PX_PER_MIN}px`;
    const t = el.querySelector(".t");
    if (t) t.textContent = `${hhmm(start)}\u2013${hhmm(start + dur)}`;
  };

  const end = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", end);
    el.removeEventListener("pointercancel", end);
    el.classList.remove("dragging");
    dragging = false;
    if (nap.startMin !== origStart || nap.durationMin !== origDur) writeNaps(c, naps);
  };

  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

// -------------------------------------------------------------------- boot

export function start() {
  const key = new URLSearchParams(location.search).get("family");
  if (key && key !== store.familyKey) { store.familyKey = key; save(store); }
  render();
  void sync(store).then((r) => { store = r.store; online = r.online; maybeRender(); });
  setInterval(() => void sync(store).then((r) => {
    store = r.store; online = r.online; maybeRender();
  }), 30_000);
  document.addEventListener("focusout", () => setTimeout(maybeRender, 0));
}
