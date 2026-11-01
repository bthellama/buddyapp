"use strict";

// ---------- Konstanten ----------
const CLASSICS = [
  "Leinenführigkeit", "Sicheres Sitz", "Sicheres Platz", "Freifolge",
  "Platzzuweisung / Deckentraining", "Rückruf", "Bleib / Warten",
  "Aus / Abgeben", "Impulskontrolle", "Ruhe / Entspannung", "Begegnungen",
];
const LEVELS = [
  [0, "Welpe"], [100, "Junghund"], [250, "Schnüffelnase"], [450, "Leinen-Lehrling"],
  [700, "Sitz-Streber"], [1000, "Platz-Profi"], [1400, "Rückruf-Rakete"],
  [1900, "Bootcamp-Veteran"], [2500, "Rudel-Coach"], [3200, "Legende"],
];
const XP_PER_LOG = 10;      // pro Habit und Tag (max. 1× pro Tag)
const XP_WEEK_GOAL = 30;    // Bonus, wenn das Wochenziel eines Habits erreicht ist
const NUDGE_TEMPLATES = [
  "Hey, {habit} wartet noch auf dich! 🐕",
  "{dog} freut sich bestimmt auf eine Runde {habit} 😉",
  "Nur 5 Minuten {habit} – du schaffst das! 💪",
  "Bootcamp-Alarm 📣 {habit} steht heute noch auf deinem Plan!",
  "Kleiner Stupser: {habit}? 🐾",
];
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

// ---------- Setup ----------
const cfg = window.BUDDY_CONFIG || {};
const appEl = document.getElementById("app");
const navEl = document.getElementById("nav");

if (!window.supabase || !cfg.supabaseUrl || cfg.supabaseUrl.includes("DEIN-PROJEKT")) {
  appEl.innerHTML = `<h1>🐾 BuddyApp</h1><div class="card"><p><b>Noch nicht eingerichtet.</b></p>
    <p class="muted">Bitte in <code>config.js</code> die Supabase-URL und den Key eintragen.</p></div>`;
  throw new Error("BuddyApp: config fehlt");
}
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

const state = {
  session: null, me: null, group: null, memberIds: [], profiles: {},
  habits: [], logs: [], nudgesIn: [], nudgesOutToday: [],
  view: "heute", authTab: "login", error: "", busy: false,
};

// ---------- Hilfsfunktionen ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isoDate = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const today = () => isoDate(new Date());
function mondayOf(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoDate(d);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
const weekDays = (monday) => [...Array(7)].map((_, i) => addDays(monday, i));
const uid = () => state.session?.user?.id;
const nameOf = (id) => state.profiles[id]?.display_name || "Jemand";
const dogOf = (id) => state.profiles[id]?.dog_name || "dein Hund";

let toastTimer;
function toast(msg) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2800);
}
function fail(err) {
  console.error(err);
  toast("Fehler: " + (err?.message || err));
}

// ---------- Statistik / Gamification ----------
function logsOf(habitId) { return state.logs.filter((l) => l.habit_id === habitId); }
function weekCount(habitId, monday) {
  const days = new Set(weekDays(monday));
  return logsOf(habitId).filter((l) => days.has(l.day)).length;
}
function doneOn(habitId, day) { return state.logs.some((l) => l.habit_id === habitId && l.day === day); }

// Wochen-Serie: wie viele Wochen in Folge das Wochenziel erreicht wurde.
// Die laufende Woche zählt mit, sobald das Ziel erreicht ist, bricht die Serie aber nicht.
function streak(habit) {
  const thisMonday = mondayOf(today());
  const startMonday = mondayOf(habit.created_at.slice(0, 10));
  let n = weekCount(habit.id, thisMonday) >= habit.per_week ? 1 : 0;
  let m = addDays(thisMonday, -7);
  while (m >= startMonday && weekCount(habit.id, m) >= habit.per_week) { n++; m = addDays(m, -7); }
  return n;
}

function xpOf(userId) {
  const habits = state.habits.filter((h) => h.user_id === userId);
  let xp = 0;
  for (const h of habits) {
    const logs = logsOf(h.id);
    xp += logs.length * XP_PER_LOG;
    const perWeek = {};
    for (const l of logs) { const m = mondayOf(l.day); perWeek[m] = (perWeek[m] || 0) + 1; }
    for (const c of Object.values(perWeek)) if (c >= h.per_week) xp += XP_WEEK_GOAL;
  }
  return xp;
}
function levelInfo(xp) {
  let i = 0;
  while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1][0]) i++;
  const [base, title] = LEVELS[i];
  const next = LEVELS[i + 1]?.[0];
  return { level: i + 1, title, xp, pct: next ? Math.round(((xp - base) / (next - base)) * 100) : 100, toNext: next ? next - xp : 0 };
}

// ---------- Daten laden ----------
let loading = null;
async function loadAll() {
  if (loading) return loading;
  loading = (async () => {
    const me = uid();
    const { data: prof, error: e1 } = await sb.from("profiles").select("*").eq("id", me).maybeSingle();
    if (e1) throw e1;
    state.me = prof;
    if (!prof) return;

    const { data: mem, error: e2 } = await sb.from("group_members").select("group_id").eq("user_id", me).limit(1);
    if (e2) throw e2;
    if (!mem.length) { state.group = null; state.memberIds = [me]; state.profiles = { [me]: prof }; }
    else {
      const gid = mem[0].group_id;
      const [{ data: g, error: e3 }, { data: members, error: e4 }] = await Promise.all([
        sb.from("groups").select("*").eq("id", gid).single(),
        sb.from("group_members").select("user_id").eq("group_id", gid),
      ]);
      if (e3) throw e3; if (e4) throw e4;
      state.group = g;
      state.memberIds = members.map((m) => m.user_id);
      const { data: profs, error: e5 } = await sb.from("profiles").select("*").in("id", state.memberIds);
      if (e5) throw e5;
      state.profiles = Object.fromEntries(profs.map((p) => [p.id, p]));
    }

    const ids = state.memberIds;
    const [h, l, nin, nout] = await Promise.all([
      sb.from("habits").select("*").in("user_id", ids).order("created_at"),
      sb.from("logs").select("id,habit_id,user_id,day").in("user_id", ids),
      sb.from("nudges").select("*").eq("to_user", me).eq("seen", false).order("created_at", { ascending: false }),
      sb.from("nudges").select("habit_id,day").eq("from_user", me).eq("day", today()),
    ]);
    for (const r of [h, l, nin, nout]) if (r.error) throw r.error;
    state.habits = h.data; state.logs = l.data; state.nudgesIn = nin.data; state.nudgesOutToday = nout.data;
  })();
  try { await loading; } finally { loading = null; }
}

async function refresh() {
  try { await loadAll(); render(); } catch (e) { fail(e); }
}
let refreshTimer;
const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 400); };

let channel = null;
function subscribeLive() {
  if (channel) return;
  channel = sb.channel("buddy-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "logs" }, refreshSoon)
    .on("postgres_changes", { event: "*", schema: "public", table: "nudges" }, refreshSoon)
    .subscribe();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.session) refreshSoon(); });

// ---------- Rendering ----------
function render() {
  if (!state.session) return renderAuth();
  if (!state.me) return renderProfileSetup();
  if (!state.group) return renderGroupSetup();
  navEl.hidden = false;
  navEl.innerHTML = `<div>${[["heute", "🏠", "Heute"], ["habits", "📋", "Mein Plan"], ["gruppe", "👥", "Gruppe"]]
    .map(([v, i, t]) => `<button data-action="nav" data-view="${v}" class="${state.view === v ? "active" : ""}"><span>${i}</span>${t}</button>`).join("")}</div>`;
  if (state.view === "habits") return renderHabits();
  if (state.view === "gruppe") return renderGroup();
  renderToday();
}

function renderAuth() {
  navEl.hidden = true;
  const login = state.authTab === "login";
  appEl.innerHTML = `
    <h1>🐾 BuddyApp</h1>
    <p class="muted">Hundetraining-Bootcamp mit Buddy – gegenseitig motivieren, abhaken, anstupsen.</p>
    <div class="tabs">
      <button data-action="authtab" data-tab="login" class="${login ? "active" : ""}">Anmelden</button>
      <button data-action="authtab" data-tab="signup" class="${login ? "" : "active"}">Registrieren</button>
    </div>
    <form class="card" data-form="${login ? "login" : "signup"}">
      <label for="email">E-Mail</label><input id="email" name="email" type="email" autocomplete="email" required>
      <label for="pw">Passwort${login ? "" : " (mind. 6 Zeichen)"}</label>
      <input id="pw" name="password" type="password" minlength="6" autocomplete="${login ? "current-password" : "new-password"}" required>
      <div style="margin-top:14px"><button class="btn">${login ? "Anmelden" : "Konto erstellen"}</button></div>
      ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}
    </form>`;
}

function renderProfileSetup() {
  navEl.hidden = true;
  appEl.innerHTML = `
    <h1>Willkommen! 👋</h1>
    <form class="card" data-form="profile">
      <label for="dn">Dein Name</label><input id="dn" name="display_name" maxlength="40" required>
      <label for="dog">Name deines Hundes</label><input id="dog" name="dog_name" maxlength="40">
      <div style="margin-top:14px"><button class="btn">Weiter</button></div>
    </form>`;
}

function renderGroupSetup() {
  navEl.hidden = true;
  appEl.innerHTML = `
    <h1>Dein Bootcamp</h1>
    <p class="muted">Erstelle eine Gruppe und schick den Code deinem Buddy – oder tritt mit einem Code bei.</p>
    <form class="card" data-form="join">
      <label for="code">Einladungscode</label><input id="code" name="code" maxlength="10" autocomplete="off" style="text-transform:uppercase" required>
      <div style="margin-top:12px"><button class="btn">Beitreten</button></div>
    </form>
    <form class="card" data-form="create">
      <label for="gn">Neue Gruppe</label><input id="gn" name="name" maxlength="60" placeholder="z.B. Herbst-Bootcamp" required>
      <div style="margin-top:12px"><button class="btn ghost">Gruppe erstellen</button></div>
    </form>
    <p><button class="btn ghost small" data-action="logout">Abmelden</button></p>`;
}

function habitWeekDots(h) {
  const t = today();
  return `<div class="dots">${weekDays(mondayOf(t)).map((d, i) =>
    `<span class="dot ${doneOn(h.id, d) ? "on" : ""} ${d === t ? "today" : ""}" title="${d}">${WEEKDAYS[i][0]}</span>`).join("")}</div>`;
}

function renderToday() {
  const me = uid(), t = today(), monday = mondayOf(t);
  const lv = levelInfo(xpOf(me));
  const mine = state.habits.filter((h) => h.user_id === me && h.active);
  const buddies = state.memberIds.filter((id) => id !== me);

  const nudges = state.nudgesIn.map((n) => {
    const h = state.habits.find((x) => x.id === n.habit_id);
    return `<div class="card nudge row"><div class="grow"><b>🐾 ${esc(nameOf(n.from_user))} stupst dich an${h ? ` (${esc(h.name)})` : ""}:</b>
      <p>${esc(n.message)}</p></div><button class="btn small" data-action="seen" data-id="${n.id}">Ok!</button></div>`;
  }).join("");

  const myList = mine.length ? mine.map((h) => {
    const done = doneOn(h.id, t), wc = weekCount(h.id, monday), s = streak(h);
    return `<div class="habit">
      <button class="check ${done ? "done" : ""}" data-action="toggle" data-id="${h.id}" aria-label="${esc(h.name)} heute ${done ? "nicht erledigt" : "erledigt"}">${done ? "✓" : ""}</button>
      <div class="grow"><div class="habit-name">${esc(h.name)}${h.minutes ? ` <span class="pill">~${h.minutes} Min.</span>` : ""}</div>
        <div class="muted">${wc}/${h.per_week} diese Woche ${wc >= h.per_week ? "✅" : ""} ${s ? `<span class="pill">🔥 ${s} Wo.</span>` : ""}</div>
        ${habitWeekDots(h)}</div></div>`;
  }).join("") : `<p class="muted">Noch keine Habits. <button class="btn small" data-action="nav" data-view="habits">Plan erstellen</button></p>`;

  const buddyCards = buddies.length ? buddies.map((bid) => {
    const bl = levelInfo(xpOf(bid));
    const bh = state.habits.filter((h) => h.user_id === bid && h.active);
    const rows = bh.map((h) => {
      const done = doneOn(h.id, t), wc = weekCount(h.id, monday);
      const nudged = state.nudgesOutToday.some((n) => n.habit_id === h.id);
      const action = done ? `<span class="pill ok">✓ heute</span>`
        : nudged ? `<span class="pill">angestupst</span>`
        : `<button class="btn small" data-action="nudge" data-id="${h.id}" data-to="${bid}">Anstupsen</button>`;
      return `<div class="habit"><div class="grow"><div class="habit-name">${esc(h.name)}</div>
        <div class="muted">${wc}/${h.per_week} diese Woche ${wc >= h.per_week ? "✅" : ""}</div>${habitWeekDots(h)}</div>${action}</div>`;
    }).join("") || `<p class="muted">Noch keine Habits erfasst.</p>`;
    return `<div class="card"><div class="hero"><div><b>${esc(nameOf(bid))}</b> <span class="muted">mit ${esc(dogOf(bid))}</span></div>
      <div class="level">Level ${bl.level} · ${esc(bl.title)}</div></div>${rows}</div>`;
  }).join("") : `<div class="card"><p class="muted">Noch kein Buddy in der Gruppe. Schick den Code <b>${esc(state.group.invite_code)}</b> weiter!</p></div>`;

  appEl.innerHTML = `
    <div class="hero"><div><h1>Hallo ${esc(state.me.display_name)}!</h1>
      <p class="muted">${new Date().toLocaleDateString("de-CH", { weekday: "long", day: "numeric", month: "long" })}${state.me.dog_name ? ` · mit ${esc(state.me.dog_name)}` : ""}</p></div>
      <div class="level">Level ${lv.level}<br><b>${esc(lv.title)}</b></div></div>
    <div class="xpbar" title="${lv.xp} XP"><span style="width:${lv.pct}%"></span></div>
    <p class="muted">${lv.xp} XP${lv.toNext ? ` · noch ${lv.toNext} bis zum nächsten Level` : ""}</p>
    ${nudges}
    <h2>Mein Plan heute</h2><div class="card">${myList}</div>
    <h2>Buddys</h2>${buddyCards}`;
}

function renderHabits() {
  const me = uid();
  const mine = state.habits.filter((h) => h.user_id === me);
  const have = new Set(mine.map((h) => h.name.toLowerCase()));
  const classics = CLASSICS.filter((c) => !have.has(c.toLowerCase()));
  const opts = (sel, from, to, extra = "") => extra + [...Array(to - from + 1)].map((_, i) => from + i)
    .map((v) => `<option value="${v}" ${v === sel ? "selected" : ""}>${v}</option>`).join("");

  appEl.innerHTML = `
    <h1>Mein Plan</h1>
    <p class="muted">Wie oft pro Woche willst du was üben? Wie du es übst, entscheidest du – jeder Hund ist anders.</p>
    <div class="card">${mine.length ? mine.map((h) => `
      <div class="habit" style="flex-wrap:wrap">
        <div class="grow"><div class="habit-name" style="${h.active ? "" : "opacity:.5"}">${esc(h.name)}${h.active ? "" : " <span class='pill'>pausiert</span>"}</div></div>
        <div class="row" style="width:100%">
          <label class="grow" style="margin:0">× pro Woche<select data-action="perweek" data-id="${h.id}">${opts(h.per_week, 1, 7)}</select></label>
          <label class="grow" style="margin:0">Minuten<select data-action="minutes" data-id="${h.id}">${opts(h.minutes, 1, 30, `<option value="" ${h.minutes ? "" : "selected"}>–</option>`)}</select></label>
        </div>
        <div class="row"><button class="btn ghost small" data-action="pause" data-id="${h.id}">${h.active ? "Pausieren" : "Aktivieren"}</button>
          <button class="btn ghost small" data-action="delete" data-id="${h.id}">Löschen</button></div>
      </div>`).join("") : `<p class="muted">Noch leer – wähle unten Klassiker aus oder erfasse eigene Habits.</p>`}</div>
    <h2>Klassiker hinzufügen</h2>
    <div class="chips">${classics.map((c) => `<button data-action="addclassic" data-name="${esc(c)}">+ ${esc(c)}</button>`).join("") || `<p class="muted">Alle Klassiker sind schon in deinem Plan.</p>`}</div>
    <h2>Eigenes Habit</h2>
    <form class="card row" data-form="addhabit">
      <input class="grow" name="name" maxlength="60" placeholder="z.B. Warten an der Tür" required>
      <button class="btn">Hinzufügen</button>
    </form>`;
}

function renderGroup() {
  const g = state.group;
  appEl.innerHTML = `
    <h1>${esc(g.name)}</h1>
    <div class="card"><p class="muted">Einladungscode für deinen Buddy</p>
      <div class="row"><span class="code grow">${esc(g.invite_code)}</span>
      <button class="btn small" data-action="copycode">Kopieren</button></div></div>
    <h2>Mitglieder</h2>
    <div class="card">${state.memberIds.map((id) => {
      const lv = levelInfo(xpOf(id));
      return `<div class="habit"><div class="grow"><b>${esc(nameOf(id))}</b>${id === uid() ? " (du)" : ""}<div class="muted">mit ${esc(dogOf(id))}</div></div>
        <div class="level">Level ${lv.level}<br><b>${esc(lv.title)}</b><br>${lv.xp} XP</div></div>`;
    }).join("")}</div>
    <h2>Profil</h2>
    <form class="card" data-form="profile">
      <label for="dn">Dein Name</label><input id="dn" name="display_name" maxlength="40" value="${esc(state.me.display_name)}" required>
      <label for="dog">Name deines Hundes</label><input id="dog" name="dog_name" maxlength="40" value="${esc(state.me.dog_name)}">
      <div style="margin-top:14px"><button class="btn">Speichern</button></div>
    </form>
    <p class="muted">So funktioniert XP: ${XP_PER_LOG} XP pro erledigtem Habit (max. 1× pro Tag) und ${XP_WEEK_GOAL} XP Bonus für jedes erreichte Wochenziel. Mehr trainieren bringt nicht mehr Punkte – Regelmässigkeit schon.</p>
    <p><button class="btn ghost" data-action="logout">Abmelden</button></p>`;
}

// ---------- Aktionen ----------
async function run(fn) {
  try { await fn(); } catch (e) { fail(e); }
}

appEl.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const form = ev.target, kind = form.dataset.form, f = Object.fromEntries(new FormData(form));
  run(async () => {
    if (kind === "login" || kind === "signup") {
      const btn = form.querySelector("button");
      btn.disabled = true;
      const { data, error } = kind === "login"
        ? await sb.auth.signInWithPassword({ email: f.email, password: f.password })
        : await sb.auth.signUp({ email: f.email, password: f.password });
      btn.disabled = false;
      if (error) {
        form.querySelector(".error")?.remove();
        form.insertAdjacentHTML("beforeend", `<p class="error">${esc(error.message)}</p>`);
        return;
      }
      if (kind === "signup" && !data.session) {
        state.authTab = "login";
        state.error = "Fast geschafft: Bitte bestätige deine E-Mail-Adresse über den Link im Mail und melde dich dann an.";
        return render();
      }
      return; // onAuthStateChange übernimmt
    }
    if (kind === "profile") {
      const row = { id: uid(), display_name: f.display_name.trim(), dog_name: f.dog_name.trim() || null };
      const { error } = await sb.from("profiles").upsert(row);
      if (error) throw error;
      toast("Gespeichert");
      return refresh();
    }
    if (kind === "create") {
      const { error } = await sb.rpc("create_group", { group_name: f.name.trim() });
      if (error) throw error;
      state.view = "habits";
      return refresh();
    }
    if (kind === "join") {
      const { error } = await sb.rpc("join_group", { code: f.code });
      if (error) throw error;
      state.view = "habits";
      return refresh();
    }
    if (kind === "addhabit") {
      await addHabit(f.name.trim());
    }
  });
});

async function addHabit(name) {
  if (!name) return;
  const { error } = await sb.from("habits").insert({ name, per_week: 5 });
  if (error) throw error;
  await refresh();
}

appEl.addEventListener("change", (ev) => {
  const el = ev.target, id = el.dataset.id;
  if (el.dataset.action === "perweek") run(async () => {
    const { error } = await sb.from("habits").update({ per_week: Number(el.value) }).eq("id", id);
    if (error) throw error; await refresh();
  });
  if (el.dataset.action === "minutes") run(async () => {
    const { error } = await sb.from("habits").update({ minutes: el.value ? Number(el.value) : null }).eq("id", id);
    if (error) throw error; await refresh();
  });
});

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el || el.tagName === "SELECT") return;
  const a = el.dataset.action, id = el.dataset.id;
  if (a === "nav") { state.view = el.dataset.view; render(); window.scrollTo(0, 0); return; }
  if (a === "authtab") { state.authTab = el.dataset.tab; state.error = ""; render(); return; }
  run(async () => {
    if (a === "logout") { await sb.auth.signOut(); return; }
    if (a === "toggle") {
      el.disabled = true;
      const t = today(), existing = state.logs.find((l) => l.habit_id === id && l.day === t);
      const { error } = existing
        ? await sb.from("logs").delete().eq("id", existing.id)
        : await sb.from("logs").insert({ habit_id: id, day: t });
      if (error) throw error;
      if (!existing) toast(`+${XP_PER_LOG} XP – stark! 🐾`);
      return refresh();
    }
    if (a === "nudge") {
      el.disabled = true;
      const h = state.habits.find((x) => x.id === id), to = el.dataset.to, t = today();
      const myDone = state.habits.find((x) => x.user_id === uid() && x.name.toLowerCase() === h.name.toLowerCase() && doneOn(x.id, t));
      const tpl = myDone ? "Ich hab {habit} heute schon erledigt – jetzt bist du dran! 💪"
        : NUDGE_TEMPLATES[Math.floor(Math.random() * NUDGE_TEMPLATES.length)];
      const message = tpl.replaceAll("{habit}", h.name).replaceAll("{dog}", state.profiles[to]?.dog_name || "Dein Hund");
      const { error } = await sb.from("nudges").insert({ to_user: to, habit_id: id, message, day: t });
      if (error) throw error;
      toast(`${nameOf(to)} wurde angestupst 👉`);
      return refresh();
    }
    if (a === "seen") {
      const { error } = await sb.from("nudges").update({ seen: true }).eq("id", id);
      if (error) throw error; return refresh();
    }
    if (a === "addclassic") return addHabit(el.dataset.name);
    if (a === "pause") {
      const h = state.habits.find((x) => x.id === id);
      const { error } = await sb.from("habits").update({ active: !h.active }).eq("id", id);
      if (error) throw error; return refresh();
    }
    if (a === "delete") {
      const h = state.habits.find((x) => x.id === id);
      if (el.dataset.confirm !== "1") { el.dataset.confirm = "1"; el.textContent = "Wirklich löschen?"; return; }
      const { error } = await sb.from("habits").delete().eq("id", id);
      if (error) throw error;
      toast(`„${h.name}“ gelöscht`);
      return refresh();
    }
    if (a === "copycode") {
      await navigator.clipboard.writeText(state.group.invite_code);
      toast("Code kopiert");
    }
  });
});

// ---------- Start ----------
sb.auth.onAuthStateChange((_event, session) => {
  const changed = session?.user?.id !== state.session?.user?.id;
  state.session = session;
  if (!session) {
    Object.assign(state, { me: null, group: null, habits: [], logs: [], nudgesIn: [], nudgesOutToday: [] });
    if (channel) { sb.removeChannel(channel); channel = null; }
    return render();
  }
  if (changed) {
    // Nicht direkt im Callback auf Supabase warten (vermeidet Deadlock im Auth-Client)
    setTimeout(() => { subscribeLive(); refresh(); }, 0);
  }
});
