/* Lift Lens - rep counting from pose landmark series (pure functions, browser + node). */
(function (root) {
  "use strict";
  var P = { lS: 11, rS: 12, lE: 13, rE: 14, lW: 15, rW: 16, lH: 23, rH: 24, lK: 25, rK: 26, lA: 27, rA: 28 };
  var SIGNALS = ["elbow", "knee", "hip", "shoulder", "wristY", "hipY", "shoulderY"];
  // typical full range of each signal (deg for angles, torso lengths for positions)
  var SCALE = { elbow: 90, knee: 80, hip: 70, shoulder: 80, wristY: 0.9, hipY: 0.5, shoulderY: 0.5 };

  function angle(a, b, c) {
    var v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
    var d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (!d) return NaN;
    var cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d));
    return Math.acos(cos) * 180 / Math.PI;
  }
  function vis(p) { return p ? (p.visibility == null ? 1 : p.visibility) : 0; }

  // weighted left/right average; side with low visibility is dropped
  function sided(lm, idxL, idxR, fn) {
    var wl = Math.min.apply(null, idxL.map(function (i) { return vis(lm[i]); }));
    var wr = Math.min.apply(null, idxR.map(function (i) { return vis(lm[i]); }));
    var vl = wl > 0.3 ? fn(idxL.map(function (i) { return lm[i]; })) : NaN;
    var vr = wr > 0.3 ? fn(idxR.map(function (i) { return lm[i]; })) : NaN;
    if (isNaN(vl) && isNaN(vr)) return NaN;
    if (isNaN(vl)) return vr;
    if (isNaN(vr)) return vl;
    return (vl * wl + vr * wr) / (wl + wr);
  }
  function ang3(p) { return angle(p[0], p[1], p[2]); }
  function yOf(p) { return p[0].y; }

  function median(arr) {
    var a = arr.filter(function (v) { return !isNaN(v); }).sort(function (x, y) { return x - y; });
    if (!a.length) return NaN;
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function pct(arr, q) {
    var a = arr.filter(function (v) { return !isNaN(v); }).sort(function (x, y) { return x - y; });
    if (!a.length) return NaN;
    var i = Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))));
    return a[i];
  }

  /* frames: [{t: sec, lm: [33 x {x,y,visibility}] | null}], x already scaled by aspect ratio */
  function extractSignals(frames) {
    var torso = median(frames.map(function (f) {
      if (!f.lm) return NaN;
      var s = sided(f.lm, [P.lS, P.lH], [P.rS, P.rH], function (p) { return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); });
      return s;
    })) || 0.3;
    var out = { t: frames.map(function (f) { return f.t; }), torso: torso };
    SIGNALS.forEach(function (k) { out[k] = []; });
    frames.forEach(function (f) {
      var lm = f.lm;
      if (!lm) { SIGNALS.forEach(function (k) { out[k].push(NaN); }); return; }
      out.elbow.push(sided(lm, [P.lS, P.lE, P.lW], [P.rS, P.rE, P.rW], ang3));
      out.knee.push(sided(lm, [P.lH, P.lK, P.lA], [P.rH, P.rK, P.rA], ang3));
      out.hip.push(sided(lm, [P.lS, P.lH, P.lK], [P.rS, P.rH, P.rK], ang3));
      out.shoulder.push(sided(lm, [P.lH, P.lS, P.lE], [P.rH, P.rS, P.rE], ang3));
      out.wristY.push(sided(lm, [P.lW], [P.rW], yOf) / torso);
      out.hipY.push(sided(lm, [P.lH], [P.rH], yOf) / torso);
      out.shoulderY.push(sided(lm, [P.lS], [P.rS], yOf) / torso);
    });
    return out;
  }

  // fill gaps (linear), median-3, moving average. returns null if mostly missing
  function clean(raw, fps) {
    var n = raw.length, valid = raw.filter(function (v) { return !isNaN(v); }).length;
    if (n < 5 || valid < n * 0.5) return null;
    var a = raw.slice(), i, j;
    var first = a.findIndex(function (v) { return !isNaN(v); });
    for (i = 0; i < first; i++) a[i] = a[first];
    for (i = first + 1; i < n; i++) {
      if (!isNaN(a[i])) continue;
      j = i; while (j < n && isNaN(a[j])) j++;
      var left = a[i - 1], right = j < n ? a[j] : left;
      for (var k = i; k < j; k++) a[k] = left + (right - left) * (k - i + 1) / (j - i + 1);
      i = j - 1;
    }
    var m = a.map(function (v, idx) {
      if (idx === 0 || idx === n - 1) return v;
      var w = [a[idx - 1], v, a[idx + 1]].sort(function (x, y) { return x - y; });
      return w[1];
    });
    var half = Math.max(1, Math.round(0.12 * fps));
    var s = new Array(n);
    for (i = 0; i < n; i++) {
      var sum = 0, c = 0;
      for (j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) { sum += m[j]; c++; }
      s[i] = sum / c;
    }
    return s;
  }

  /* hysteresis rep counter. returns {reps:[...], startZone, partial, lo, hi} */
  function countReps(sig, t) {
    var lo = pct(sig, 0.03), hi = pct(sig, 0.97), r = hi - lo;
    var res = { reps: [], partial: false, lo: lo, hi: hi, range: r, startHigh: true };
    if (!(r > 0)) return res;
    var tL = lo + 0.3 * r, tH = lo + 0.7 * r;
    function zone(v) { return v <= tL ? "L" : v >= tH ? "H" : "M"; }
    var n = sig.length, i, S = null;
    for (i = 0; i < n; i++) { var z0 = zone(sig[i]); if (z0 !== "M") { S = z0; break; } }
    if (!S) return res;
    res.startHigh = S === "H";
    var O = S === "H" ? "L" : "H";
    var sgn = S === "H" ? 1 : -1; // +1: start extreme is a maximum
    var state = "S", sExtIdx = i, oExtIdx = -1, deepestM = null;
    for (; i < n; i++) {
      var z = zone(sig[i]), v = sig[i];
      if (state === "S") {
        if (z === S) {
          if (sgn * v >= sgn * sig[sExtIdx]) sExtIdx = i;
          deepestM = null;
        } else if (z === O) {
          state = "O"; oExtIdx = i;
        } else {
          if (deepestM === null || sgn * v < sgn * sig[deepestM]) deepestM = i;
        }
      } else { // state O
        if (z === O) { if (sgn * v <= sgn * sig[oExtIdx]) oExtIdx = i; }
        else if (z === S) {
          res.reps.push(buildRep(sig, t, sExtIdx, oExtIdx, i, sgn));
          state = "S"; sExtIdx = i; deepestM = null;
        }
      }
    }
    // unfinished: reached the opposite zone but never came back = failed rep
    if (state === "O" && res.reps.length) res.partial = true;
    return res;
  }

  function buildRep(sig, t, sIdx, oIdx, reIdx, sgn) {
    var sLevel = sig[sIdx], oLevel = sig[oIdx], amp = Math.abs(sLevel - oLevel);
    // phase 1 starts when the signal leaves the start plateau (moved 10% of amp)
    var a = sIdx;
    while (a < oIdx && Math.abs(sig[a] - sLevel) < 0.1 * amp) a++;
    a = Math.max(sIdx, a - 1);
    // phase 2 ends when the signal is back 90% of the way
    var b = oIdx;
    while (b < sig.length - 1 && Math.abs(sig[b] - oLevel) < 0.9 * amp) b++;
    return { tStart: t[a], tTurn: t[oIdx], tEnd: t[b], p1: t[oIdx] - t[a], p2: t[b] - t[oIdx], amp: amp, iStart: a, iTurn: oIdx, iEnd: b };
  }

  function cv(arr) {
    if (arr.length < 2) return 0.5;
    var m = arr.reduce(function (s, v) { return s + v; }, 0) / arr.length;
    var sd = Math.sqrt(arr.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / arr.length);
    return m ? sd / m : 1;
  }

  /* main entry. hint: preferred signal name; concentricFirst: bool|null */
  function analyze(frames, opts) {
    opts = opts || {};
    var fps = frames.length > 1 ? (frames.length - 1) / (frames[frames.length - 1].t - frames[0].t) : 10;
    var raw = extractSignals(frames), cand = [];
    SIGNALS.forEach(function (k) {
      var s = clean(raw[k], fps);
      if (!s) return;
      var c = countReps(s, raw.t);
      var norm = c.range / SCALE[k];
      var durs = c.reps.map(function (r) { return r.tEnd - r.tStart; });
      var reg = Math.max(0.2, 1 - cv(durs));
      var ampCons = c.reps.length ? Math.max(0.2, 1 - cv(c.reps.map(function (r) { return r.amp; }))) : 0;
      var score = c.reps.length ? Math.min(norm, 1.5) * reg * ampCons : 0;
      cand.push({ key: k, sig: s, count: c, norm: norm, score: score });
    });
    if (!cand.length) return { ok: false, reason: "人物を検出できませんでした" };
    cand.sort(function (a, b) { return b.score - a.score; });
    var best = cand[0];
    if (opts.hint) {
      var h = cand.find(function (c) { return c.key === opts.hint; });
      if (h && h.count.reps.length && h.norm > 0.15) best = h;
    }
    var c = best.count, reps = c.reps;
    // which phase is concentric
    var conFirst = opts.concentricFirst;
    if (conFirst == null) conFirst = defaultConcentricFirst(best.key, c.startHigh);
    reps.forEach(function (r) { r.con = conFirst ? r.p1 : r.p2; r.ecc = conFirst ? r.p2 : r.p1; });
    // split into sets on long pauses
    var sets = [], cur = [];
    reps.forEach(function (r, i) {
      if (i && r.tStart - reps[i - 1].tEnd > 20) { sets.push(cur); cur = []; }
      cur.push(r);
    });
    if (cur.length) sets.push(cur);
    return {
      ok: reps.length > 0, reason: reps.length ? "" : "反復動作を検出できませんでした",
      signal: best.key, reps: reps.length, partial: c.partial, sets: sets.map(setStats),
      motion: cand.map(function (x) { return { key: x.key, range: +(x.count.range || 0).toFixed(2), norm: +x.norm.toFixed(2), reps: x.count.reps.length }; }),
      series: downsample(best.sig, raw.t, reps), concentricFirst: conFirst
    };
  }

  function defaultConcentricFirst(sig, startHigh) {
    // pulls / curls start extended (high angle) and flex first; squats & presses lower first
    if (sig === "knee" || sig === "hipY" || sig === "shoulderY") return false;
    if (sig === "hip") return !startHigh; // deadlift from the floor starts flexed
    return false;
  }

  function setStats(reps) {
    var con = reps.map(function (r) { return r.con; });
    var best = Math.min.apply(null, con.slice(0, Math.min(3, con.length)));
    var last = con[con.length - 1];
    var vl = reps.length >= 3 && last > 0 ? Math.max(0, 1 - best / last) : null;
    var ampMax = Math.max.apply(null, reps.map(function (r) { return r.amp; }));
    return {
      reps: reps.length,
      tStart: reps[0].tStart, tEnd: reps[reps.length - 1].tEnd,
      con: con.map(r2), ecc: reps.map(function (r) { return r2(r.ecc); }),
      tut: r2(reps.reduce(function (s, r) { return s + r.con + r.ecc; }, 0)),
      vl: vl == null ? null : r2(vl),
      romConsistency: r2(reps.reduce(function (s, r) { return s + r.amp / ampMax; }, 0) / reps.length)
    };
  }
  function r2(v) { return Math.round(v * 100) / 100; }

  function downsample(sig, t, reps) {
    var N = 140, n = sig.length, out = [];
    var lo = Math.min.apply(null, sig), hi = Math.max.apply(null, sig), r = hi - lo || 1;
    for (var i = 0; i < N; i++) { var k = Math.round(i * (n - 1) / (N - 1)); out.push(Math.round((sig[k] - lo) / r * 100)); }
    var T = t[n - 1] - t[0] || 1;
    return { v: out, marks: reps.map(function (rp) { return Math.round((rp.tTurn - t[0]) / T * 100) / 100; }) };
  }

  /* reps-in-reserve from velocity loss of the concentric phase (rough mapping) */
  function rirFromVL(vl) {
    if (vl == null) return null;
    return Math.max(0, Math.min(5, Math.round(5 - vl * 10)));
  }

  var api = { analyze: analyze, countReps: countReps, clean: clean, extractSignals: extractSignals, rirFromVL: rirFromVL, SIGNALS: SIGNALS };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Reps = api;
})(this);
