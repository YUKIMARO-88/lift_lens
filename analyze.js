/* Lift Lens - video -> pose frames (MediaPipe Pose Landmarker, on device). */
const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

let landmarker = null, loading = null, tsClock = 0;

export function initPose() {
  if (landmarker) return Promise.resolve(landmarker);
  if (loading) return loading;
  loading = (async () => {
    const vision = await import(MP + "/vision_bundle.mjs");
    const files = await vision.FilesetResolver.forVisionTasks(MP + "/wasm");
    let err;
    for (const delegate of ["GPU", "CPU"]) {
      try {
        landmarker = await vision.PoseLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: MODEL, delegate },
          runningMode: "VIDEO", numPoses: 1,
          minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5
        });
        return landmarker;
      } catch (e) { err = e; }
    }
    loading = null;
    throw err || new Error("姿勢推定モデルを読み込めませんでした");
  })();
  return loading;
}

function seek(v, t) {
  return new Promise(res => {
    let done = false;
    const fin = () => { if (done) return; done = true; v.removeEventListener("seeked", fin); res(); };
    v.addEventListener("seeked", fin);
    setTimeout(fin, 2000);
    v.currentTime = t;
  });
}

/* returns { frames, shots:[base64 jpeg], shotMeta:[{t, box}], cover:dataURL, duration, created:ms|null }
   opts.blurBg (default true): everything outside the lifter (+ room for bar/plates) is blurred in the stills sent to Gemini */
export async function analyzeVideo(file, onProgress, opts) {
  const blurBg = !opts || opts.blurBg !== false;
  const lmk = await initPose();
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.preload = "auto";
  video.setAttribute("playsinline", ""); video.setAttribute("muted", "");
  video.src = url;
  try {
    await new Promise((res, rej) => {
      video.onloadeddata = res;
      video.onerror = () => rej(new Error("この動画形式は読み込めません"));
      setTimeout(() => rej(new Error("動画の読み込みがタイムアウトしました")), 30000);
    });
    try { await video.play(); video.pause(); } catch (e) { /* autoplay may be blocked; seeking still works */ }

    const dur = video.duration;
    if (!isFinite(dur) || dur <= 0) throw new Error("動画の長さを取得できません");
    const W = video.videoWidth, H = video.videoHeight, aspect = W / H;
    const fps = dur <= 30 ? 10 : dur <= 90 ? 8 : Math.max(3, 720 / dur);
    const step = 1 / fps;

    const SHOTS = 12, shotEvery = dur / SHOTS;
    const cv = document.createElement("canvas");
    const sc = Math.min(1, 448 / Math.max(W, H));
    cv.width = Math.round(W * sc); cv.height = Math.round(H * sc);
    const ctx = cv.getContext("2d");
    const shots = [], shotMeta = []; let nextShot = shotEvery / 2, cover = null, lastBox = null, maxH = 0;

    const frames = [];
    for (let t = 0; t < dur; t += step) {
      await seek(video, t);
      tsClock += Math.max(1, Math.round(step * 1000));
      let lm = null, box = null;
      try {
        const r = lmk.detectForVideo(video, tsClock);
        if (r.landmarks && r.landmarks[0]) {
          lm = r.landmarks[0].map(p => ({ x: p.x * aspect, y: p.y, visibility: p.visibility }));
          box = personBox(r.landmarks[0], aspect, maxH);
          if (box) maxH = Math.max(maxH, bodyH(r.landmarks[0]));
          if (box) lastBox = box;
        }
      } catch (e) { /* skip frame */ }
      frames.push({ t, lm });
      if (t >= nextShot && shots.length < SHOTS) {
        ctx.drawImage(video, 0, 0, cv.width, cv.height);
        if (!cover && t >= dur * 0.4) cover = cv.toDataURL("image/jpeg", 0.7); // local thumbnail only, stays sharp
        const b = box || lastBox;
        if (blurBg) blurOutside(ctx, video, cv.width, cv.height, b);
        shots.push(cv.toDataURL("image/jpeg", 0.7).split(",")[1]);
        shotMeta.push({ t: +t.toFixed(2), box: b && b.map(v => +v.toFixed(3)) });
        nextShot += shotEvery;
      }
      if (onProgress) onProgress(Math.min(1, t / dur));
    }
    const detected = frames.filter(f => f.lm).length;
    if (!cover && shots.length) cover = "data:image/jpeg;base64," + shots[shots.length >> 1];
    return { frames, shots, shotMeta, cover, blurred: blurBg, duration: dur, detectedRatio: detected / frames.length, created: await creationTime(file) };
  } finally {
    video.removeAttribute("src"); video.load();
    URL.revokeObjectURL(url);
  }
}

/* lifter bounding box [x0,y0,x1,y1] (0..1) with room for the bar / plates / dumbbells */
export function personBox(lm, aspect, refH) {
  const pts = lm.filter(p => (p.visibility == null ? 1 : p.visibility) > 0.3);
  if (pts.length < 8) return null;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  pts.forEach(p => { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); });
  const bw = x1 - x0, bh = Math.max(y1 - y0, refH || 0); // refH: tallest pose seen so far (squat bottom keeps the standing margin)
  const px = Math.max(0.35 * bw, 0.35 * bh / aspect), py = 0.12 * bh + 0.03;
  return [Math.max(0, x0 - px), Math.max(0, y0 - py - 0.04), Math.min(1, x1 + px), Math.min(1, y1 + py)];
}

function bodyH(lm) {
  const ys = lm.filter(p => (p.visibility == null ? 1 : p.visibility) > 0.3).map(p => p.y);
  return ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
}

/* heavy blur outside the box. Downscale-upscale instead of ctx.filter so it also works on older iOS Safari */
let tiny = null;
function blurOutside(ctx, video, W, H, box) {
  tiny = tiny || document.createElement("canvas");
  tiny.width = Math.max(6, Math.round(W / 28)); tiny.height = Math.max(6, Math.round(H / 28));
  const tc = tiny.getContext("2d");
  tc.imageSmoothingEnabled = true;
  tc.drawImage(video, 0, 0, tiny.width, tiny.height);
  ctx.save();
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(tiny, 0, 0, W, H);
  ctx.restore();
  if (!box) return; // nobody found yet: send the fully blurred frame
  const vw = video.videoWidth, vh = video.videoHeight;
  const [x0, y0, x1, y1] = box;
  ctx.drawImage(video, x0 * vw, y0 * vh, (x1 - x0) * vw, (y1 - y0) * vh, x0 * W, y0 * H, (x1 - x0) * W, (y1 - y0) * H);
}

/* MP4/MOV 'mvhd' creation time (seconds since 1904, UTC). Falls back to file.lastModified. */
export async function creationTime(file) {
  try {
    const rd = async (o, n) => new DataView(await file.slice(o, o + n).arrayBuffer());
    let off = 0;
    while (off < file.size) {
      const h = await rd(off, 16);
      let size = h.getUint32(0);
      const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
      if (size === 1) size = Number(h.getBigUint64(8));
      if (size === 0) size = file.size - off;
      if (size < 8) break;
      if (type === "moov") {
        const box = new Uint8Array(await file.slice(off, off + Math.min(size, 8 << 20)).arrayBuffer());
        for (let i = 8; i < box.length - 24; i++) {
          if (box[i] === 0x6d && box[i + 1] === 0x76 && box[i + 2] === 0x68 && box[i + 3] === 0x64) { // 'mvhd'
            const dv = new DataView(box.buffer, i + 4);
            const ver = dv.getUint8(0);
            const sec = ver === 1 ? Number(dv.getBigUint64(4)) : dv.getUint32(4);
            const ms = (sec - 2082844800) * 1000;
            if (ms > Date.UTC(2015, 0, 1) && ms < Date.now() + 86400000) return ms;
            break;
          }
        }
        break;
      }
      off += size;
    }
  } catch (e) { /* ignore */ }
  return null;
}
