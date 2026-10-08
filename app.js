/* Lift Lens - UI, storage and the video -> set record pipeline. */
import { initPose, analyzeVideo } from "./analyze.js";
import { identify } from "./gemini.js";

const Reps = window.Reps, Calc = window.Calc;
const KEY = "liftlens.v1";
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, "0");
const ymd = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const parseYmd = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
const addDays = (s, n) => { const d = new Date(parseYmd(s)); d.setDate(d.getDate() + n); return ymd(d.getTime()); };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 0) => v == null || isNaN(v) ? "–" : Number(v).toFixed(d);
const WD = ["日", "月", "火", "水", "木", "金", "土"];

/* ---------- storage ---------- */
function defaults() { return { settings: { bodyKg: 70, apiKey: "", model: "gemini-3.5-flash", blurBg: true }, weights: {}, custom: {}, sets: [], lastEx: null }; }
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.sets)) { const def = defaults(); return { ...def, ...d, settings: { ...def.settings, ...d.settings } }; }
  } catch (e) { /* ignore */ }
  return defaults();
}
let db = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast("保存できませんでした（容量不足の可能性）。設定から書き出してください"); }
}
const exOf = k => k ? Calc.exInfo(k, db.custom) : null;

/* ---------- derived numbers ---------- */
function derive(s) {
  const ex = exOf(s.exKey);
  const bodyKg = db.settings.bodyKg || 70;
  const k = Calc.setKcal(ex ? ex.cls : "upper", bodyKg, s.tut, s.reps);
  const load = Calc.effLoad(ex, s.weightKg, bodyKg);
  return {
    ex, kcal: k.kcal, workSec: k.sec,
    eff: Calc.effectiveReps(s.reps, s.rir),
    hard: Calc.hardSet(s.rir, s.reps),
    e1rm: Calc.e1rm(load, s.reps, s.rir), load
  };
}
function setsOn(date) { return db.sets.filter(s => s.date === date).sort((a, b) => a.ts - b.ts); }
function setsBetween(from, to) { return db.sets.filter(s => s.date >= from && s.date <= to); }

// rest between consecutive sets of the day (gap capped at 8 min; unknown timestamps -> 2 min)
function dayEnergy(list) {
  const bodyKg = db.settings.bodyKg || 70;
  let work = 0, rest = 0, restSec = 0;
  list.forEach((s, i) => {
    const d = derive(s);
    work += d.kcal;
    if (i) {
      const prev = list[i - 1];
      let gap = (s.ts - (prev.ts + (prev.dur || 30) * 1000)) / 1000;
      if (s.video !== prev.video && gap < 15) gap = 120;
      if (gap > 0 && gap <= 480) { restSec += gap; rest += Calc.restKcal(bodyKg, gap); }
    }
  });
  return { work, rest, total: work + rest, restSec };
}

/* ---------- state ---------- */
let view = "day", curDate = ymd(Date.now()), openSet = null;
const jobs = [];

/* ---------- pipeline ---------- */
async function handleFiles(files) {
  files = [...files].filter(f => f.type.startsWith("video/") || /\.(mov|mp4|m4v|webm)$/i.test(f.name));
  if (!files.length) return;
  if (!db.settings.apiKey && !localStorage.getItem("liftlens.nokeyWarned")) {
    toast("APIキー未設定のため種目は自動判定しません（設定タブで登録できます）");
    try { localStorage.setItem("liftlens.nokeyWarned", "1"); } catch (e) { /* ignore */ }
  }
  const mine = files.map(f => ({ id: Math.random().toString(36).slice(2), name: f.name, file: f, p: 0, stage: "待機中", err: null, cover: null }));
  jobs.push(...mine);
  view = "day"; render();
  initPose().catch(() => {}); // warm up while queueing
  for (const j of mine) {
    try { await processJob(j); jobs.splice(jobs.indexOf(j), 1); }
    catch (e) { j.err = e.message || String(e); j.stage = "失敗"; console.error(e); }
    render();
  }
}

async function processJob(j) {
  j.stage = "姿勢推定モデルを準備中"; renderJobs();
  await initPose();
  j.stage = "骨格を解析中"; renderJobs();
  const v = await analyzeVideo(j.file, p => { j.p = p; renderJobs(); }, { blurBg: db.settings.blurBg !== false });
  j.cover = v.cover;
  if (v.detectedRatio < 0.3) throw new Error("人物がほとんど検出できませんでした（全身が映る角度で撮ってください）");
  return processFrames(v, j);
}

// separated from the video step so it can also be driven by test data
async function processFrames(v, j) {
  j = j || { name: "test", stage: "" };
  let loc = Reps.analyze(v.frames, {});
  let ai = null, aiErr = null;
  if (db.settings.apiKey && v.shots && v.shots.length) {
    j.stage = "種目を判定中（Gemini）"; renderJobs();
    try {
      ai = await identify({
        apiKey: db.settings.apiKey, model: db.settings.model || "gemini-3.5-flash", shots: v.shots,
        motion: loc.motion || [], known: Calc.allExercises(db.custom).map(e => ({ key: e.key, name: e.name })),
        muscles: Object.keys(Calc.MUSCLES), blurred: !!v.blurred
      });
    } catch (e) { aiErr = e.message; console.warn(e); }
  }
  let exKey = null;
  if (ai) {
    exKey = String(ai.exercise_key || "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, "") || null;
    if (exKey && !Calc.EX[exKey]) {
      db.custom[exKey] = {
        key: exKey, name: ai.exercise_name_ja || exKey, cls: ai.movement_class || "upper", signal: ai.signal,
        concentricFirst: !!ai.concentric_first, primary: ai.primary_muscles || [], secondary: ai.secondary_muscles || [],
        bwFrac: Math.max(0, Math.min(1, +ai.bodyweight_fraction || 0))
      };
    }
    const info = exOf(exKey);
    const cf = ai.concentric_first != null ? ai.concentric_first : info && info.concentricFirst;
    loc = Reps.analyze(v.frames, { hint: ai.signal || (info && info.signal), concentricFirst: cf });
  }
  if (!loc.ok) throw new Error((loc.reason || "回数を数えられませんでした") + (aiErr ? ` / ${aiErr}` : ""));

  const created = v.created || (j.file && j.file.lastModified) || Date.now();
  const videoId = Math.random().toString(36).slice(2);
  const info = exOf(exKey);
  let weight = null, wSrc = "none";
  if (exKey && db.weights[exKey] != null) { weight = db.weights[exKey]; wSrc = "memory"; }
  else if (info && info.bwFrac) { weight = 0; wSrc = "bodyweight"; }
  else if (ai && ai.load_estimate_kg > 0) { weight = Math.round(ai.load_estimate_kg * 2) / 2; wSrc = "ai"; }
  const aiRir = ai && ai.rir_visual != null ? Math.max(0, Math.min(5, Math.round(ai.rir_visual))) : null;

  let firstDate = null;
  loc.sets.forEach((st, i) => {
    const last = i === loc.sets.length - 1;
    const vlRir = Reps.rirFromVL(st.vl);
    let rir, rirSrc;
    if (last && loc.partial) { rir = 0; rirSrc = "fail"; }
    else if (vlRir != null && aiRir != null && last) { rir = Math.round((vlRir + aiRir) / 2); rirSrc = "both"; }
    else if (vlRir != null) { rir = vlRir; rirSrc = "vl"; }
    else if (aiRir != null && last) { rir = aiRir; rirSrc = "ai"; }
    else { rir = 2; rirSrc = "default"; }
    const ts = created + st.tStart * 1000;
    const rec = {
      id: Math.random().toString(36).slice(2), video: videoId, file: j.name, ts, date: ymd(ts),
      exKey, weightKg: weight, weightSrc: wSrc, reps: st.reps, partial: last && loc.partial,
      rir, rirSrc, vl: st.vl, vlRir, aiRir, tut: st.tut, con: st.con, ecc: st.ecc, romC: st.romConsistency,
      dur: Math.round(st.tEnd - st.tStart), signal: loc.signal,
      series: loc.sets.length === 1 ? loc.series : null,
      note: ai ? ai.form_note_ja : "", conf: ai ? ai.confidence : null, aiErr
    };
    db.sets.push(rec);
    if (!firstDate) firstDate = rec.date;
  });
  if (exKey) db.lastEx = exKey;
  save();
  if (firstDate) curDate = firstDate;
  if (aiErr) toast("種目の自動判定に失敗: " + aiErr.slice(0, 80));
  return loc;
}

/* ---------- edits ---------- */
function updateSet(id, patch) {
  const s = db.sets.find(x => x.id === id); if (!s) return;
  Object.assign(s, patch);
  if ("weightKg" in patch && s.exKey) { db.weights[s.exKey] = s.weightKg; s.weightSrc = "manual"; propagateWeight(s); }
  if ("exKey" in patch) {
    // same video = same exercise
    db.sets.filter(x => x.video === s.video).forEach(x => { x.exKey = s.exKey; });
    if (db.weights[s.exKey] != null) db.sets.filter(x => x.video === s.video).forEach(x => { x.weightKg = db.weights[s.exKey]; x.weightSrc = "memory"; });
    else { const ex = exOf(s.exKey); if (ex && ex.bwFrac) db.sets.filter(x => x.video === s.video).forEach(x => { x.weightKg = 0; x.weightSrc = "bodyweight"; }); }
    db.lastEx = s.exKey;
  }
  save(); render();
}
// a corrected weight also applies to this exercise's other sets today that still carry a guessed weight
function propagateWeight(s) {
  db.sets.filter(x => x !== s && x.date === s.date && x.exKey === s.exKey && x.weightSrc !== "manual")
    .forEach(x => { x.weightKg = s.weightKg; x.weightSrc = "memory"; });
}

/* ---------- rendering ---------- */
function render() {
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.view === view));
  const today = ymd(Date.now());
  const d = new Date(parseYmd(curDate));
  if (view === "week") {
    const from = addDays(curDate, -6);
    $("#dateLabel").textContent = `${from.slice(5).replace("-", "/")} 〜 ${curDate.slice(5).replace("-", "/")}`;
    $("#dateSub").textContent = "直近7日間";
  } else {
    $("#dateLabel").textContent = `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`;
    $("#dateSub").textContent = curDate === today ? "今日" : curDate;
  }
  $("#nextDay").disabled = curDate >= today;
  const showNav = view === "day" || view === "week";
  $("#prevDay").style.visibility = $("#nextDay").style.visibility = showNav ? "visible" : "hidden";
  const m = $("#main");
  if (view === "day") m.innerHTML = dayView();
  else if (view === "week") m.innerHTML = weekView();
  else if (view === "ex") m.innerHTML = exView();
  else m.innerHTML = settingsView();
  bindView();
}

function renderJobs() {
  const box = $("#jobs"); if (!box) return;
  box.innerHTML = jobs.map(j => `
    <div class="card job ${j.err ? "err" : ""}">
      ${j.cover ? `<img src="${j.cover}" alt="">` : `<img alt="">`}
      <div style="flex:1;min-width:0">
        <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(j.name)}</div>
        <div class="st">${esc(j.err || j.stage)}${!j.err && j.stage === "骨格を解析中" ? ` ${Math.round(j.p * 100)}%` : ""}</div>
        ${j.err ? `<button class="btn" data-dismiss="${j.id}" style="margin-top:6px;padding:4px 10px">閉じる</button>` : `<div class="bar"><i style="width:${Math.round(j.p * 100)}%"></i></div>`}
      </div>
    </div>`).join("");
  box.querySelectorAll("[data-dismiss]").forEach(b => b.onclick = () => { const i = jobs.findIndex(x => x.id === b.dataset.dismiss); if (i >= 0) jobs.splice(i, 1); renderJobs(); });
}

function spark(series) {
  if (!series || !series.v) return "";
  const n = series.v.length, pts = series.v.map((y, i) => `${(i / (n - 1) * 90 + 1).toFixed(1)},${(32 - y * 0.3).toFixed(1)}`).join(" ");
  const marks = (series.marks || []).map(x => {
    const i = Math.round(x * (n - 1)); return `<circle cx="${(x * 90 + 1).toFixed(1)}" cy="${(32 - series.v[i] * 0.3).toFixed(1)}" r="1.8"/>`;
  }).join("");
  return `<svg class="spark" viewBox="0 0 92 34" aria-hidden="true"><polyline points="${pts}"/>${marks}</svg>`;
}
const rirClass = r => r === 0 ? "r0" : r <= 2 ? "r1" : r <= 4 ? "r2" : "r3";
const SRC = { vl: "失速から推定", ai: "映像から推定", both: "失速＋映像", fail: "最終レップ失敗", default: "仮定値", manual: "手入力" };

function dayView() {
  const list = setsOn(curDate);
  const en = dayEnergy(list);
  const ds = list.map(derive);
  const eff = ds.reduce((a, x) => a + x.eff, 0), hard = ds.reduce((a, x) => a + x.hard, 0);
  const wk = Calc.weeklyScore(Calc.weeklyMuscles(setsBetween(addDays(curDate, -6), curDate), exOf));
  let h = `
    <div class="drop" id="drop">
      <button class="add" id="addBtn">＋ 動画を読み込む<small>カメラロールから複数選べます</small></button>
    </div>
    <div id="jobs" style="margin-top:10px"></div>`;
  if (list.length) {
    h += `<div class="stats">
      <div class="stat hl"><div class="k">消費カロリー</div><div class="v num">${fmt(en.total)}<small>kcal</small></div><div class="d">運動 ${fmt(en.work)} ＋ 休憩 ${fmt(en.rest)}</div></div>
      <div class="stat"><div class="k">筋肥大スコア（7日）</div><div class="v num">${wk}<small>/100</small></div><div class="d">今週タブで部位別に確認</div></div>
      <div class="stat"><div class="k">有効レップ</div><div class="v num">${eff}<small>回</small></div><div class="d">限界5回手前以内の反復</div></div>
      <div class="stat"><div class="k">ハードセット</div><div class="v num">${hard}<small>/ ${list.length}セット</small></div><div class="d">余力4回以下のセット</div></div>
    </div>`;
    // group by exercise in order of appearance
    const groups = [];
    list.forEach(s => { let g = groups.find(x => x.key === (s.exKey || "?" + s.video)); if (!g) { g = { key: s.exKey || "?" + s.video, sets: [] }; groups.push(g); } g.sets.push(s); });
    h += `<h2>種目</h2>`;
    groups.forEach(g => {
      const ex = exOf(g.sets[0].exKey);
      const best = Math.max(0, ...g.sets.map(s => derive(s).e1rm || 0));
      const vol = g.sets.reduce((a, s) => a + derive(s).load * s.reps, 0);
      h += `<div class="card"><div class="ex-head">
          <div class="ex-name">${ex ? esc(ex.name) : "種目未設定"}</div>
          <div class="ex-meta">${best ? `推定1RM ${fmt(best, 1)}kg<br>` : ""}${vol ? `総負荷量 ${fmt(vol)}kg` : ""}</div></div>`;
      if (!ex) h += `<div class="warnline">種目を判定できませんでした。セットをタップして選んでください（次回からはAPIキー設定で自動）</div>`;
      else if (g.sets.some(s => s.weightKg == null)) h += `<div class="warnline">初めての種目です。重量を一度入れると、次からは自動で引き継ぎます</div>`;
      g.sets.forEach((s, i) => {
        const d = derive(s);
        const wTxt = s.weightKg == null ? "重量？" : ex && ex.bwFrac ? (s.weightKg ? `自重+${fmt(s.weightKg, 1)}kg` : "自重") : `${fmt(s.weightKg, 1)}kg`;
        h += `<button class="set" data-set="${s.id}">
          <div class="no">${i + 1}</div>
          <div><div class="main num">${s.reps}回 <small>× ${wTxt}</small></div>
            <div class="tags">
              <span class="tag ${rirClass(s.rir)}">余力${s.rir} ${Calc.rirLabel(s.rir)}</span>
              <span class="tag">有効${d.eff}</span>
              <span class="tag">${fmt(d.kcal, 1)}kcal</span>
              ${s.vl != null ? `<span class="tag">失速${Math.round(s.vl * 100)}%</span>` : ""}
            </div></div>
          ${spark(s.series)}
        </button>`;
        if (openSet === s.id) h += editPanel(s, d);
      });
      const note = g.sets.find(s => s.note);
      if (note) h += `<div class="note">💬 ${esc(note.note)}</div>`;
      h += `</div>`;
    });
  } else if (!jobs.length) {
    h += `<div class="empty"><b>この日の記録はまだありません</b><br><br>
      セット中の動画を撮って読み込むだけで、<br>回数・余力・消費カロリー・筋肥大刺激を自動で記録します。<br><br>
      <span class="small">撮り方のコツ：体の横か斜め前から、全身（少なくとも動く関節）が入るように。1本に1セットが最も正確です。</span></div>`;
  }
  return h;
}

function editPanel(s, d) {
  const opts = Calc.allExercises(db.custom).sort((a, b) => a.name.localeCompare(b.name, "ja"))
    .map(e => `<option value="${e.key}" ${e.key === s.exKey ? "selected" : ""}>${esc(e.name)}</option>`).join("");
  const chips = [0, 1, 2, 3, 4, 5].map(r => `<button class="chip ${s.rir === r ? "on" : ""}" data-rir="${r}">${r === 5 ? "5+" : r}</button>`).join("");
  return `<div class="edit" data-edit="${s.id}">
    <div class="row"><label>種目</label><select data-f="ex">${s.exKey ? "" : `<option value="" selected>選んでください</option>`}${opts}</select></div>
    <div class="row"><label>重量</label><button class="step" data-w="-2.5">−</button>
      <input type="number" inputmode="decimal" step="0.5" data-f="w" value="${s.weightKg == null ? "" : s.weightKg}" placeholder="kg">
      <button class="step" data-w="2.5">＋</button><span class="small">${d.ex && d.ex.bwFrac ? "追加重量（自重分は自動）" : "kg"}</span></div>
    <div class="row"><label>回数</label><button class="step" data-r="-1">−</button>
      <input type="number" inputmode="numeric" data-f="r" value="${s.reps}"><button class="step" data-r="1">＋</button></div>
    <div class="row"><label>余力</label><div class="chips">${chips}</div></div>
    <div class="detail">余力の根拠：${SRC[s.rirSrc] || "–"}${s.vlRir != null ? `（失速→${s.vlRir}）` : ""}${s.aiRir != null ? `（映像→${s.aiRir}）` : ""}<br>
      挙上時間：${(s.con || []).map(x => fmt(x, 1)).join(" / ")} 秒<br>
      緊張時間 ${fmt(s.tut, 1)}秒 ・ 可動域の安定度 ${s.romC != null ? Math.round(s.romC * 100) + "%" : "–"} ・ 計測信号 ${esc(s.signal)}<br>
      ${d.e1rm ? `推定1RM ${fmt(d.e1rm, 1)}kg ・ ` : ""}${esc(s.file || "")}</div>
    <button class="del" data-delset="${s.id}">このセットを削除</button>
  </div>`;
}

function weekView() {
  const from = addDays(curDate, -6);
  const list = setsBetween(from, curDate);
  const mus = Calc.weeklyMuscles(list, exOf);
  const score = Calc.weeklyScore(mus);
  const C = 2 * Math.PI * 40;
  let h = `<div class="card score">
    <svg class="ring" viewBox="0 0 100 100"><circle class="bgc" cx="50" cy="50" r="40"/>
      <circle class="fg" cx="50" cy="50" r="40" stroke-dasharray="${(C * score / 100).toFixed(1)} ${C.toFixed(1)}"/><text x="50" y="52">${score}</text></svg>
    <div><b>筋肥大の可能性スコア</b><p>鍛えた部位それぞれが「週10〜20ハードセット」にどれだけ届いているか＋全身のカバー率。</p></div>
  </div>
  <h2>部位別ハードセット数（直近7日）</h2><div class="card">`;
  const keys = Object.keys(Calc.MUSCLES).sort((a, b) => mus[b] - mus[a]);
  keys.forEach(k => {
    const n = mus[k], z = Calc.zone(n), w = Math.min(100, n / 30 * 100);
    h += `<div class="mus"><div>${Calc.MUSCLES[k]}</div><div class="track"><span class="z"></span><i class="z-${z.id}" style="width:${w}%"></i></div><div class="n num">${fmt(n, 1)}</div></div>`;
  });
  h += `<div class="legend"><span><i class="z-low"></i>不足 &lt;4</span><span><i class="z-mid"></i>維持〜成長 4–9</span><span><i class="z-opt"></i>筋肥大ゾーン 10–20</span><span><i class="z-over"></i>多すぎ &gt;20</span></div>
    <p class="small">補助的に使われる部位は0.5セットとして数えます。緑の帯が10〜20セットの範囲です。</p></div>`;
  // calories per day
  const days = [];
  for (let i = 6; i >= 0; i--) { const dd = addDays(curDate, -i); days.push({ dd, e: dayEnergy(setsOn(dd)).total }); }
  const max = Math.max(1, ...days.map(x => x.e));
  const total = days.reduce((a, x) => a + x.e, 0);
  h += `<h2>消費カロリー（合計 ${fmt(total)} kcal）</h2><div class="card"><div class="days">` +
    days.map(x => { const wd = WD[new Date(parseYmd(x.dd)).getDay()]; return `<div class="b ${x.dd === curDate ? "today" : ""}"><span class="num">${x.e ? fmt(x.e) : ""}</span><i style="height:${(x.e / max * 70).toFixed(0)}%"></i>${wd}</div>`; }).join("") +
    `</div></div>`;
  const eff = list.reduce((a, s) => a + derive(s).eff, 0);
  h += `<div class="stats"><div class="stat"><div class="k">セット数</div><div class="v num">${list.length}</div></div>
    <div class="stat"><div class="k">有効レップ合計</div><div class="v num">${eff}</div></div></div>`;
  return h;
}

function exView() {
  const byEx = {};
  db.sets.forEach(s => { if (s.exKey) (byEx[s.exKey] = byEx[s.exKey] || []).push(s); });
  const keys = Object.keys(byEx).sort((a, b) => Math.max(...byEx[b].map(s => s.ts)) - Math.max(...byEx[a].map(s => s.ts)));
  if (!keys.length) return `<div class="empty"><b>まだ種目の記録がありません</b><br>動画を読み込むと、種目ごとの推定1RMの推移と次回の重量の目安が出ます。</div>`;
  let h = `<h2>種目ごとの推移（推定1RM）</h2>`;
  keys.forEach(k => {
    const ex = exOf(k), sets = byEx[k];
    const byDay = {};
    sets.forEach(s => { const e = derive(s).e1rm; if (e) byDay[s.date] = Math.max(byDay[s.date] || 0, e); });
    const days = Object.keys(byDay).sort();
    const vals = days.map(d => byDay[d]);
    let trend = "";
    if (vals.length >= 2) {
      const lo = Math.min(...vals), hi = Math.max(...vals), r = hi - lo || 1, n = vals.length;
      const pts = vals.map((v, i) => `${(i / (n - 1) * 296 + 2).toFixed(1)},${(50 - (v - lo) / r * 44).toFixed(1)}`);
      trend = `<svg class="trend" viewBox="0 0 300 54" preserveAspectRatio="none"><polyline points="${pts.join(" ")}"/>${pts.map(p => `<circle cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="2.5"/>`).join("")}</svg>`;
    }
    // overload advice from the most recent session
    const lastDay = sets.reduce((a, s) => s.date > a ? s.date : a, "");
    const ls = sets.filter(s => s.date === lastDay);
    const minRir = Math.min(...ls.map(s => s.rir)), w = db.weights[k];
    let adv = "";
    if (w != null && !(ex && ex.bwFrac && !w)) {
      if (minRir >= 3) adv = `<div class="advice up">↑ 前回は全セット余力3回以上。次回は ${fmt(w + (ex.cls === "isolation" ? 1 : 2.5), 1)}kg を試す価値あり</div>`;
      else if (minRir === 0 && ls.length > 1) adv = `<div class="advice">→ 前回は限界まで到達。同じ重量で回数を伸ばしましょう</div>`;
      else adv = `<div class="advice">→ 適正な強度です。次回も ${fmt(w, 1)}kg で回数を1回増やせれば前進</div>`;
    } else if (ex && ex.bwFrac) {
      adv = minRir >= 3 ? `<div class="advice up">↑ 余裕あり。回数を増やすか加重を検討</div>` : `<div class="advice">→ 適正な強度です</div>`;
    }
    const diff = vals.length >= 2 ? vals[vals.length - 1] - vals[0] : null;
    h += `<div class="card exl"><div class="ex-head"><div class="ex-name">${esc(ex ? ex.name : k)}</div>
      <div class="ex-meta">${vals.length ? `最新 ${fmt(vals[vals.length - 1], 1)}kg` : "1RM推定なし"}${diff != null ? `<br>${diff >= 0 ? "+" : ""}${fmt(diff, 1)}kg（${days.length}回分）` : ""}</div></div>
      ${trend}${adv}
      <div class="small">${sets.length}セット記録 ・ 記憶中の重量 ${ex && ex.bwFrac && !w ? "自重" : w != null ? fmt(w, 1) + "kg" : "未設定"} ・ 主働筋 ${(ex ? ex.primary : []).map(m => Calc.MUSCLES[m]).join("・")}</div></div>`;
  });
  return h;
}

function settingsView() {
  const s = db.settings;
  return `<h2>からだ</h2><div class="card">
    <label class="field"><span>体重（kg）— 消費カロリーと自重種目の負荷に使います</span>
      <input id="bodyKg" type="number" inputmode="decimal" step="0.1" value="${s.bodyKg}"></label></div>
  <h2>種目の自動判定（Gemini API）</h2><div class="card">
    <label class="field"><span>APIキー（この端末の中にだけ保存されます）</span>
      <input id="apiKey" type="password" autocomplete="off" value="${esc(s.apiKey)}" placeholder="AIza… または AQ.…"></label>
    <label class="field"><span>モデル</span><select id="model">
      ${["gemini-3.5-flash", "gemini-2.5-flash", "gemini-flash-latest"].map(m => `<option ${m === s.model ? "selected" : ""}>${m}</option>`).join("")}
    </select></label>
    <label class="row" style="margin-bottom:10px"><input id="blurBg" type="checkbox" ${s.blurBg !== false ? "checked" : ""} style="width:22px;height:22px">
      <span>本人の周り以外をぼかしてから送る（映り込んだ他の人・ジムの様子を隠す）</span></label>
    <p class="small">送るのは動画から切り出した縮小静止画12枚だけで、動画そのものは送りません。回数・テンポ・失速の計測はすべてこの端末の中で行います。キーは <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> で発行できます。</p>
    <div class="btns"><button class="btn" id="testKey">接続テスト</button></div></div>
  <h2>データ</h2><div class="card">
    <p class="small" style="margin-top:0">記録はこの端末のブラウザ内に保存されます。<b>ホーム画面に追加して使う</b>と、iPhoneが自動で消すことはありません。機種変更に備えて時々書き出してください。</p>
    <div class="btns"><button class="btn" id="exportBtn">書き出し（JSON）</button><button class="btn" id="importBtn">読み込み</button>
      <button class="btn danger" id="wipeBtn">全記録を削除</button></div>
    <input id="importFile" type="file" accept="application/json,.json" hidden>
    <p class="small">記録 ${db.sets.length} セット ・ 記憶中の重量 ${Object.keys(db.weights).length} 種目</p></div>
  <h2>計算の考え方</h2><div class="card"><details><summary>回数・余力・カロリー・筋肥大スコアの出し方</summary>
    <ul>
      <li><b>回数</b>：端末内の骨格推定（MediaPipe Pose）で肘・膝・股関節などの角度を毎秒10コマ追い、往復を数えます。どの関節で数えるかは種目から決めます。</li>
      <li><b>余力（あと何回できたか）</b>：挙上局面の速度低下（失速率）から推定し、Geminiが映像から見た推定と平均します。最終レップが上がりきらなかった場合は余力0。外れていたらタップして直せます。</li>
      <li><b>消費カロリー</b>：運動時間×体重×MET（身体活動のCompendium：多関節の高強度6.0／上半身5.0／単関節3.5、休憩1.8）。セット間の休憩は撮影時刻の間隔から計算します（最大8分）。</li>
      <li><b>有効レップ</b>：限界の5回手前からの反復だけが強い成長刺激になる、という考え方（effective reps）に基づく目安です。</li>
      <li><b>筋肥大スコア</b>：余力4回以下のセットを「ハードセット」として部位別に数え（補助筋は0.5）、週10〜20セットを筋肥大の目安（Schoenfeld ら 2017 のメタ分析）として達成度を出します。</li>
    </ul>
    <p>どれも推定です。実際の筋肥大はタンパク質・睡眠・継続期間にも大きく左右されます。</p></details></div>
  <p class="small" style="text-align:center">Lift Lens v1.1</p>`;
}

/* ---------- events ---------- */
function bindView() {
  const add = $("#addBtn");
  if (add) add.onclick = () => $("#fileInput").click();
  const drop = $("#drop");
  if (drop) {
    drop.ondragover = e => { e.preventDefault(); drop.classList.add("hover"); };
    drop.ondragleave = () => drop.classList.remove("hover");
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove("hover"); handleFiles(e.dataTransfer.files); };
  }
  renderJobs();
  document.querySelectorAll("[data-set]").forEach(b => b.onclick = () => { openSet = openSet === b.dataset.set ? null : b.dataset.set; render(); });
  document.querySelectorAll("[data-edit]").forEach(p => {
    const id = p.dataset.edit, s = db.sets.find(x => x.id === id);
    p.querySelector('[data-f="ex"]').onchange = e => e.target.value && updateSet(id, { exKey: e.target.value });
    p.querySelector('[data-f="w"]').onchange = e => { const v = parseFloat(e.target.value); updateSet(id, { weightKg: isNaN(v) ? null : Math.max(0, v) }); };
    p.querySelectorAll("[data-w]").forEach(b => b.onclick = () => updateSet(id, { weightKg: Math.max(0, (s.weightKg || 0) + parseFloat(b.dataset.w)) }));
    p.querySelector('[data-f="r"]').onchange = e => { const v = parseInt(e.target.value, 10); if (v > 0) updateSet(id, { reps: v }); };
    p.querySelectorAll("[data-r]").forEach(b => b.onclick = () => updateSet(id, { reps: Math.max(1, s.reps + parseInt(b.dataset.r, 10)) }));
    p.querySelectorAll("[data-rir]").forEach(b => b.onclick = () => updateSet(id, { rir: parseInt(b.dataset.rir, 10), rirSrc: "manual" }));
    p.querySelector("[data-delset]").onclick = () => {
      if (!confirm("このセットを削除しますか？")) return;
      db.sets = db.sets.filter(x => x.id !== id); openSet = null; save(); render();
    };
  });
  if (view === "settings") {
    $("#bodyKg").onchange = e => { const v = parseFloat(e.target.value); if (v > 20 && v < 300) { db.settings.bodyKg = v; save(); toast("保存しました"); } };
    $("#apiKey").onchange = e => { db.settings.apiKey = e.target.value.trim(); save(); toast(db.settings.apiKey ? "APIキーを保存しました" : "APIキーを削除しました"); };
    $("#model").onchange = e => { db.settings.model = e.target.value; save(); };
    $("#blurBg").onchange = e => { db.settings.blurBg = e.target.checked; save(); toast(e.target.checked ? "背景をぼかして送ります" : "ぼかさずに送ります"); };
    $("#testKey").onclick = testKey;
    $("#exportBtn").onclick = exportData;
    $("#importBtn").onclick = () => $("#importFile").click();
    $("#importFile").onchange = e => importData(e.target.files[0]);
    $("#wipeBtn").onclick = () => {
      if (!confirm("全記録と記憶中の重量を削除します。元に戻せません。よろしいですか？")) return;
      const keep = db.settings; db = defaults(); db.settings = keep; save(); render(); toast("削除しました");
    };
  }
}

async function testKey() {
  const k = db.settings.apiKey; if (!k) return toast("先にAPIキーを入力してください");
  toast("接続を確認中…");
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(db.settings.model)}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": k },
      body: JSON.stringify({ contents: [{ parts: [{ text: "OKとだけ返答" }] }] })
    });
    const b = await r.json().catch(() => ({}));
    toast(r.ok ? "接続OK：種目の自動判定が使えます" : `接続エラー ${r.status}: ${(b.error && b.error.message || "").slice(0, 80)}`);
  } catch (e) { toast("接続できませんでした（ネットワークを確認）"); }
}

function exportData() {
  const out = { ...db, settings: { ...db.settings, apiKey: "" } };
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `lift_lens_${ymd(Date.now())}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importData(f) {
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.sets)) throw new Error("形式が違います");
    const ids = new Set(db.sets.map(s => s.id));
    const added = d.sets.filter(s => !ids.has(s.id));
    db.sets.push(...added);
    db.weights = { ...d.weights, ...db.weights };
    db.custom = { ...d.custom, ...db.custom };
    save(); render(); toast(`${added.length}セットを読み込みました`);
  } catch (e) { toast("読み込めませんでした: " + e.message); }
}

let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3800);
}

$("#fileInput").onchange = e => { handleFiles(e.target.files); e.target.value = ""; };
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => { view = b.dataset.view; openSet = null; render(); window.scrollTo(0, 0); });
$("#prevDay").onclick = () => { curDate = addDays(curDate, view === "week" ? -7 : -1); openSet = null; render(); };
$("#nextDay").onclick = () => { const n = addDays(curDate, view === "week" ? 7 : 1); const t = ymd(Date.now()); curDate = n > t ? t : n; openSet = null; render(); };
// share target / drag from desktop also works on the whole page
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => { if (e.target.closest && !e.target.closest("#drop")) { e.preventDefault(); handleFiles(e.dataTransfer.files); } });

if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
window.LiftLens = { processFrames: async (v, j) => { const r = await processFrames(v, j); render(); return r; }, db: () => db, analyzeVideo, initPose };
render();
