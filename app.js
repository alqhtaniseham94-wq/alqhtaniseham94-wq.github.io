/* =====================================================================
   مقعد · منطق الصفحة
   - العميل: يحجز، يشوف حجزه، يبحث بجواله، يلغي.
   - صاحب الكوفي: يدخل بإيميل وكلمة مرور، يدير الحجوزات والإعدادات.
   كل القرارات المهمة (الطاقة، التعارض، الصلاحيات) في قاعدة البيانات، مو هنا.
   ===================================================================== */

const CFG = window.MAQAD_CONFIG || {};
const DAYN = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];
const DUR_PRESETS = [25,30,40,45,60,90,120,0];
const $ = id => document.getElementById(id);
const AR = n => String(n).replace(/\d/g, d => "٠١٢٣٤٥٦٧٨٩"[d]);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
// اسم الكوفي من الرابط: maqad.sa/faisal  (ويقبل الشكل القديم ?c=faisal)
const PATH_SLUG = decodeURIComponent(location.pathname.split("/").filter(Boolean)[0] || "");
const SLUG = (/^[a-z0-9-]{2,40}$/i.test(PATH_SLUG) && PATH_SLUG !== "index.html" ? PATH_SLUG
  : new URLSearchParams(location.search).get("c") || CFG.DEFAULT_CAFE || "").toLowerCase();
const HOME = location.origin + "/" + SLUG;          // رابط الكوفي النظيف

let sb = null;          // اتصال Supabase
let cafe = null;        // سطر الكوفي من قاعدة البيانات
let S = null;           // الإعدادات بصيغة سهلة
let busy = [];          // الأوقات المشغولة (للعميل)
let ownerRows = [];     // الحجوزات الكاملة (لصاحب الكوفي فقط)
let session = null;
let view = "book", openToken = null, oneDoc = null, confirming = false, oDate = null, draftTypes = null;
const form = { type: null, date: null, ppl: 2, time: null };

/* ---------------- الوقت: كل شي بتوقيت السعودية ----------------
   "ليلة العمل" (night): لو الكوفي يقفل ١ ص، الحجز ١٢:٣٠ ص يتبع ليلة اليوم اللي قبله. */
const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fmt = m => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const openMin = () => toMin(S.open), closeMin = () => toMin(S.close);
const overnight = () => closeMin() <= openMin();
const rel = t => (toMin(t) - openMin() + 1440) % 1440;
const spanMin = () => ((closeMin() - openMin() + 1440) % 1440) || 1440;
function slotList() { const out = []; for (let r = 0; r <= spanMin() - 60; r += S.slot) out.push(fmt(openMin() + r)); return out; }
const keyFromMs = ms => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
const addDays = (k, n) => new Date(Date.parse(k + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const tonight = () => keyFromMs(Date.now() - (overnight() ? closeMin() * 60000 : 0));
const startMs = (k, t) => Date.parse(k + "T00:00:00+03:00") + (openMin() + rel(t)) * 60000;
const closeAbs = k => Date.parse(k + "T00:00:00+03:00") + (openMin() + spanMin()) * 60000;
const dayIdx = k => new Date(k + "T00:00:00Z").getUTCDay();
const dayLabel = k => { const t = tonight(); return k === t ? "الليلة" : k === addDays(t, 1) ? "بكرة" : DAYN[dayIdx(k)]; };
const dateLong = k => `${DAYN[dayIdx(k)]} ${AR(Number(k.slice(8)))}/${AR(Number(k.slice(5, 7)))}`;
function label12(t) { let [h, m] = t.split(":").map(Number); const s = h < 12 ? "ص" : "م"; h = h % 12 || 12; return `${AR(h)}:${AR(String(m).padStart(2, "0"))} ${s}`; }
function clock(ms) { const d = new Date(ms + 3 * 3600e3); return label12(`${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`); }
function dur(ms) { const m = Math.max(0, Math.round(ms / 60000)); const d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), mm = m % 60;
  if (d) return `${AR(d)} يوم و${AR(h)} ساعة`; if (h) return `${AR(h)} ساعة و${AR(mm)} دقيقة`; return `${AR(mm)} دقيقة`; }
const durTxt = d => d > 0 ? `${AR(d)} دقيقة` : "بدون حد";
const typeOf = id => S.types.find(t => t.id === id) || { id, name: id, cap: 0, dur: 0 };

/* ---------------- تحويل البيانات ---------------- */
function toSettings(c) {
  return { name: c.name, area: c.area || "", open: c.open_time.slice(0, 5), close: c.close_time.slice(0, 5), slot: c.slot_minutes,
    grace: c.grace_minutes, maxGroup: c.max_group, mapUrl: c.map_url || "", closed: c.closed_dates || [],
    types: (c.types || []).map(t => ({ dur: 45, desc: "", ...t })),
    logo: c.logo_url || "", accent: c.accent_color || "", bg: c.bg_color || "" };
}
function toBooking(r) {
  return { token: r.token, code: r.code, date: r.night, time: String(r.slot_time).slice(0, 5), type: r.type_id, ppl: r.people,
    name: r.name, phone: r.phone, status: r.status, s: Date.parse(r.start_at), e: r.end_at ? Date.parse(r.end_at) : null,
    dur: r.dur_minutes, extra: r.extra_minutes || 0, source: r.source };
}
const isActive = b => b.status === "booked" || b.status === "arrived";
function overlapCount(list, k, t, ty) {
  const s = startMs(k, t), d = typeOf(ty).dur, e = d > 0 ? s + d * 60000 : closeAbs(k);
  return list.filter(b => b.type === ty && b.s < e && s < b.e).length;
}
function lifeOf(b) {
  const now = Date.now();
  if (b.status === "done") return ["p-done", "طلع"];
  if (b.status === "arrived") return b.e && now > b.e ? ["p-late", "انتهى وقته"] : ["p-arrived", "جالس"];
  if (b.status === "cancelled") return ["p-cancelled", "ملغي"];
  if (b.status === "noshow") return ["p-noshow", "ما حضر"];
  if (now > b.s + S.grace * 60000) return ["p-late", "تعدّى المهلة"];
  if (now >= b.s) return ["p-late", "وقته الحين"];
  return ["p-booked", "محجوز"];
}
const ERRORS = {
  FULL: "امتلأ هذا الوقت قبل لحظات. اختر وقت ثاني.", CLOSED: "الحجز مقفل في هذا اليوم.", PAST: "هذا الوقت فات أو قريب جداً. اختر وقت بعده.",
  BAD_PHONE: "رقم الجوال لازم يبدأ بـ 05 ويكون ١٠ أرقام.", BAD_NAME: "اكتب اسمك (حرفين على الأقل).", BAD_PEOPLE: "عدد الأشخاص أكبر من المسموح. تواصل مع الكوفي.",
  BAD_TIME: "هذا الوقت مو من أوقات الحجز.", BAD_DATE: "الحجز متاح لسبعة أيام قدام فقط.", BAD_TYPE: "نوع الجلسة غير متاح.",
  TOO_MANY: "عندك ٣ حجوزات قادمة. ألغِ واحد قبل ما تحجز جديد.", NOT_FOUND: "الكوفي غير موجود. تأكد من الرابط."
};
function friendly(err) { const m = (err && err.message) || ""; for (const k in ERRORS) if (m.includes(k)) return ERRORS[k]; return "صار خطأ في الاتصال. جرّب مرة ثانية."; }

/* ---------------- ذاكرة الجوال (للتنبيه "عندك حجز") ---------------- */
const MEM = "maqad." + SLUG;
function myTokens() { try { return JSON.parse(localStorage.getItem(MEM) || "[]"); } catch (_) { return []; } }
function remember(t) { try { const a = myTokens().filter(x => x !== t); a.unshift(t); localStorage.setItem(MEM, JSON.stringify(a.slice(0, 10))); } catch (_) {} }

/* ---------------- الرأس ---------------- */
function renderHeader() {
  $("cafeName").textContent = S.name; $("cafeArea").textContent = S.area;
  $("logo").textContent = (S.name.replace(/^(كوفي|مقهى|مطعم)\s+/, "")[0] || "م");   // أول حرف من الاسم بدون "مطعم/كوفي"
  $("cafeHours").textContent = `كل يوم ${label12(S.open)} – ${label12(S.close)}`;
  document.title = `${S.name} · احجز طاولتك`;
  // الهوية: شعار وألوان المكان لو محفوظة في قاعدة البيانات
  const img = $("brand"), ok = /^(\/|https:\/\/)[^\s"']+$/.test(S.logo);
  img.hidden = !ok; $("hero").classList.toggle("has-brand", ok);
  if (ok && img.getAttribute("src") !== S.logo) { img.src = S.logo; img.alt = S.name; }
  const css = document.documentElement.style, dark = matchMedia("(prefers-color-scheme: dark)").matches, hex = v => !dark && /^#[0-9a-f]{6}$/i.test(v);   // ألوان المكان في الوضع الفاتح فقط
  if (hex(S.accent)) { css.setProperty("--accent", S.accent); css.setProperty("--accent-soft", `color-mix(in srgb, ${S.accent} 12%, #fff)`); } else { css.removeProperty("--accent"); css.removeProperty("--accent-soft"); }
  if (hex(S.bg)) css.setProperty("--bg", S.bg); else css.removeProperty("--bg");
}

/* ================= العميل: الحجز ================= */
function renderBook() {
  const types = S.types.filter(t => t.cap > 0);
  if (!types.find(t => t.id === form.type)) form.type = types[0] && types[0].id;
  $("types").innerHTML = types.map(t => `<button class="opt" data-t="${esc(t.id)}" aria-pressed="${form.type === t.id}">${esc(t.name)}<small>${esc(t.desc)} · ${t.dur > 0 ? AR(t.dur) + " د" : "مفتوح"}</small></button>`).join("");
  const t0 = tonight(); if (!form.date || form.date < t0) form.date = t0; let h = "";
  for (let i = 0; i < 7; i++) { const k = addDays(t0, i), c = S.closed.includes(k);
    h += `<button class="day" data-d="${k}" aria-pressed="${form.date === k}" ${c ? "disabled" : ""}><span>${c ? "مقفل" : dayLabel(k)}</span><b>${AR(Number(k.slice(8)))}</b></button>`; }
  $("days").innerHTML = h; $("ppl").value = AR(form.ppl); renderSlots();
}
function renderSlots() {
  const cap = typeOf(form.type).cap, now = Date.now();
  if (S.closed.includes(form.date)) { $("slots").innerHTML = `<p class="note" style="grid-column:1/-1">الحجز مقفل في هذا اليوم.</p>`; form.time = null; return; }
  $("slots").innerHTML = slotList().map(t => {
    const left = cap - overlapCount(busy, form.date, t, form.type), past = startMs(form.date, t) < now + 10 * 60000;
    const dis = left <= 0 || past; if (dis && form.time === t) form.time = null;
    const note = past ? "انتهى" : left <= 0 ? "ممتلئ" : left <= 2 ? `باقي ${AR(left)}` : "متاح";
    return `<button class="slot ${left <= 2 && !dis ? "few" : ""}" data-s="${t}" ${dis ? "disabled" : ""} aria-pressed="${form.time === t}">${label12(t).replace(/ [صم]$/, "")}<small>${note}</small></button>`;
  }).join("");
  $("groupNote").hidden = form.ppl <= S.maxGroup;
  $("groupNote").textContent = `المجموعات فوق ${AR(S.maxGroup)} أشخاص تحتاج تنسيق مع الكوفي مباشرة.`;
}
$("types").onclick = e => { const b = e.target.closest("[data-t]"); if (b) { form.type = b.dataset.t; renderBook(); } };
$("days").onclick = e => { const b = e.target.closest("[data-d]"); if (b && !b.disabled) { form.date = b.dataset.d; renderBook(); } };
$("slots").onclick = e => { const b = e.target.closest("[data-s]"); if (b && !b.disabled) { form.time = b.dataset.s; renderSlots(); } };
$("minus").onclick = () => { form.ppl = Math.max(1, form.ppl - 1); $("ppl").value = AR(form.ppl); renderSlots(); };
$("plus").onclick = () => { form.ppl = Math.min(20, form.ppl + 1); $("ppl").value = AR(form.ppl); renderSlots(); };

async function loadBusy() {
  const t0 = tonight();
  const { data, error } = await sb.rpc("get_availability", { p_slug: SLUG, p_from: t0, p_to: addDays(t0, 7) });
  if (!error) { busy = data.map(r => ({ type: r.type_id, s: Date.parse(r.start_at), e: Date.parse(r.end_at) })); if (view === "book") renderSlots(); }
}

$("bookBtn").onclick = async () => {
  const name = $("fName").value.trim(), phone = $("fPhone").value.trim(); let msg = "";
  if (form.ppl > S.maxGroup) msg = `للمجموعات فوق ${AR(S.maxGroup)} تواصل مع الكوفي.`;
  else if (!form.time) msg = "اختر وقت من الخانات المتاحة.";
  else if (name.length < 2) msg = "اكتب اسمك عشان الموظف يعرفك.";
  $("bookErr").hidden = !msg; $("bookErr").textContent = msg; if (msg) return;
  const btn = $("bookBtn"); btn.disabled = true; btn.textContent = "جاري التثبيت…";
  const { data, error } = await sb.rpc("create_booking", { p_slug: SLUG, p_night: form.date, p_time: form.time, p_type: form.type, p_people: form.ppl, p_name: name, p_phone: phone });
  btn.disabled = false; btn.textContent = "ثبّت الحجز";
  if (error) { $("bookErr").hidden = false; $("bookErr").textContent = friendly(error); loadBusy(); return; }
  remember(data.token); form.time = null; loadBusy(); openBooking(data.token);
};

/* ================= العميل: صفحة الحجز ================= */
let pollOne = null;
async function fetchOne() {
  const { data } = await sb.rpc("get_booking", { p_token: openToken });
  oneDoc = data ? toBooking(data) : null; if (oneDoc) remember(oneDoc.token); renderOne();
}
function openBooking(token) {
  openToken = token; oneDoc = null; confirming = false;
  history.replaceState(null, "", "/" + SLUG + "#b-" + token);
  show("booking"); renderOne(); fetchOne();
  clearInterval(pollOne); pollOne = setInterval(fetchOne, 20000);   // يتحدث كل ٢٠ ثانية (لو الموظف سجّل وصولك أو مدد لك)
}
function renderOne() {
  const el = $("v-booking");
  if (!oneDoc) { el.innerHTML = `<p class="empty">جاري جلب الحجز… لو طوّل، تأكد من الرابط أو ابحث برقم جوالك.</p><button class="ghost" data-go="mine">ابحث عن حجزي</button>`; return; }
  const b = oneDoc, [cls, lbl] = lifeOf(b), now = Date.now();
  let head = "";
  if (b.status === "booked") {
    const hold = b.s + S.grace * 60000;
    if (now < b.s) head = `<div class="count">باقي ${dur(b.s - now)}</div><p class="note">نمسك طاولتك لين ${clock(hold)}، بعدها تنعطى لغيرك.</p>`;
    else if (now <= hold) head = `<div class="count">وقتك الحين</div><p class="note">طاولتك محجوزة لين ${clock(hold)}. باقي ${dur(hold - now)}.</p>`;
    else head = `<div class="count">انتهت مهلة الحجز</div><p class="note">تعدّى ${clock(hold)}. لو وصلت، كلّم الموظف ويشوف لك مكان.</p>`;
    if (now <= hold && b.dur > 0) head += `<p class="note">مدة الجلسة ${durTxt(b.dur)}، تنتهي ${clock(b.e)}.</p>`;
  } else if (b.status === "arrived") {
    const left = b.e - now;
    if (b.dur <= 0 && !b.extra) head = `<div class="count">أهلاً فيك</div><p class="note">جلستك مفتوحة لين يقفل الكوفي.</p>`;
    else if (left > 10 * 60000) head = `<div class="count">باقي من جلستك ${dur(left)}</div><p class="note">تنتهي ${clock(b.e)}. بنبهك قبلها بـ ١٠ دقائق.</p>`;
    else if (left > 0) head = `<div class="alarm">باقي ${dur(left)} على نهاية جلستك<b>جهّز نفسك للطلعة</b></div>`;
    else head = `<div class="alarm end">انتهى وقت جلستك<b>نشكرك على زيارتك، الطاولة عليها حجز بعدك</b></div>`;
    head += soundOn ? `<p class="note">التنبيه بالصوت مفعّل. خلّ الصفحة مفتوحة.</p>` : `<button class="ghost" data-sound>فعّل تنبيه الصوت</button>`;
    alarmCheck(b, left);
  } else if (b.status === "cancelled") head = `<div class="count">الحجز ملغي</div>`;
  else if (b.status === "done") head = `<div class="count">شكراً لزيارتك</div><p class="note">ننتظرك مرة ثانية.</p>`;
  else head = `<div class="count">ما تم الحضور</div>`;
  const live = b.status === "booked" && now <= b.s + S.grace * 60000, link = HOME + "#b-" + b.token;
  el.innerHTML = `
    <span class="pill ${cls}">${lbl}</span>
    <div class="sub">رقم الحجز، ورّه للموظف</div>
    <div class="code">${esc(b.code)}</div>
    ${head}
    <dl class="kv">
      <dt>الاسم</dt><dd>${esc(b.name)}</dd>
      <dt>المكان</dt><dd>${esc(S.name)}</dd>
      <dt>اليوم</dt><dd>${dateLong(b.date)}${rel(b.time) + openMin() >= 1440 ? " (بعد منتصف الليل)" : ""}</dd>
      <dt>الوقت</dt><dd>${label12(b.time)}</dd>
      <dt>الجلسة</dt><dd>${esc(typeOf(b.type).name)} · ${AR(b.ppl)} ${b.ppl === 1 ? "شخص" : "أشخاص"}</dd>
      <dt>المدة</dt><dd>${durTxt(b.dur)}${b.extra > 0 ? ` + ${AR(b.extra)} دقيقة تمديد` : ""}</dd>
      ${b.phone ? `<dt>الجوال</dt><dd class="ltr">${esc(b.phone)}</dd>` : ""}
    </dl>
    <div class="link"><code>${esc(link)}</code><button class="ghost" data-copy="${esc(link)}" style="flex:none">نسخ</button></div>
    <p class="note">احفظ هذا الرابط أو أرسله لأصحابك اللي جايين معك. يفتح الحجز مباشرة بدون دخول.</p>
    <div class="btns">
      ${live ? `<button class="ghost" data-ics>أضف للتقويم</button>` : ""}
      ${S.mapUrl ? `<a class="ghost" href="${esc(S.mapUrl)}" target="_blank" rel="noopener">الموقع على الخريطة</a>` : ""}
      ${live ? `<button class="ghost danger" data-cancel>إلغاء الحجز</button>` : ""}
      <button class="ghost" data-go="book">حجز جديد</button>
    </div>
    ${confirming ? `<div class="confirm"><b>متأكد تبي تلغي؟</b><span class="note">الطاولة تنفتح لغيرك فوراً.</span><div class="btns"><button class="ghost danger" data-cancel-yes>إيه، ألغِ</button><button class="ghost" data-cancel-no>لا، خلّه</button></div></div>` : ""}
    <p class="err" id="oneErr" hidden></p>`;
}

/* تنبيه نهاية الجلسة: صوت + اهتزاز + عنوان التبويب */
let soundOn = false, actx = null; const alerted = {};
function beep(n) { if (!actx) return; for (let i = 0; i < n; i++) { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = 880; o.connect(g); g.connect(actx.destination);
  const t = actx.currentTime + i * 0.45; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35); o.start(t); o.stop(t + 0.4); } }
function alarmCheck(b, left) {
  const k = b.token + ":" + b.extra;
  if (left <= 0 && !alerted[k + "end"]) { alerted[k + "end"] = alerted[k + "warn"] = true; beep(3); try { navigator.vibrate && navigator.vibrate([300, 150, 300, 150, 300]); } catch (_) {} }
  else if (left > 0 && left <= 10 * 60000 && !alerted[k + "warn"]) { alerted[k + "warn"] = true; beep(1); try { navigator.vibrate && navigator.vibrate(300); } catch (_) {} }
  document.title = left <= 0 ? "انتهى وقتك · " + S.name : left <= 10 * 60000 ? "باقي أقل من ١٠ دقائق · " + S.name : S.name;
}

$("v-booking").onclick = async e => {
  const t = e.target;
  if (t.closest("[data-go]")) return go(t.closest("[data-go]").dataset.go);
  if (t.closest("[data-copy]")) return copy(t.closest("[data-copy]"));
  if (t.closest("[data-sound]")) { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); await actx.resume(); soundOn = true; beep(1); } catch (_) {} return renderOne(); }
  if (t.closest("[data-cancel]")) { confirming = true; return renderOne(); }
  if (t.closest("[data-cancel-no]")) { confirming = false; return renderOne(); }
  if (t.closest("[data-cancel-yes]")) {
    const { data, error } = await sb.rpc("cancel_booking", { p_token: openToken });
    if (error || !data) { const x = $("oneErr"); x.hidden = false; x.textContent = error ? friendly(error) : "ما قدرنا نلغي. يمكن انتهت المهلة."; return; }
    confirming = false; loadBusy(); return fetchOne();
  }
  if (t.closest("[data-ics]")) {
    const b = oneDoc, z = d => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const ics = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Maqad//AR","BEGIN:VEVENT",`UID:${b.token}@maqad`,`DTSTAMP:${z(Date.now())}`,`DTSTART:${z(b.s)}`,`DTEND:${z(b.e)}`,
      `SUMMARY:حجز ${S.name} (${b.code})`,`DESCRIPTION:${typeOf(b.type).name} · ${b.ppl} أشخاص\\n${HOME}#b-${b.token}`,
      "BEGIN:VALARM","TRIGGER:-PT60M","ACTION:DISPLAY","DESCRIPTION:موعد حجزك بعد ساعة","END:VALARM","END:VEVENT","END:VCALENDAR"].join("\r\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" })); a.download = `maqad-${b.code}.ics`; a.click();
  }
};

/* ================= العميل: حجزي ================= */
$("lookupForm").onsubmit = async e => {
  e.preventDefault(); const q = $("lookup").value.trim(), out = $("lookupRes");
  if (!q) return;
  out.innerHTML = `<p class="empty">جاري البحث…</p>`;
  const { data, error } = await sb.rpc("find_bookings", { p_slug: SLUG, p_query: q });
  if (error) { out.innerHTML = `<p class="err">${friendly(error)}</p>`; return; }
  const list = (data || []).map(toBooking).sort((a, b) => a.s - b.s), t0 = tonight();
  if (!list.length) { out.innerHTML = `<p class="empty">ما لقينا حجز. تأكد إنه نفس الرقم اللي حجزت فيه، أو اكتب رقم الحجز مثل S4821.</p>`; return; }
  const up = list.filter(b => b.date >= t0), old = list.filter(b => b.date < t0).reverse().slice(0, 5);
  const row = b => { const [c, l] = lifeOf(b); return `<button class="res" data-tok="${b.token}"><span><b>${label12(b.time)}</b> · ${dateLong(b.date)}<br><span class="sub">${esc(typeOf(b.type).name)} · ${AR(b.ppl)} · ${esc(b.code)}</span></span><span class="pill ${c}">${l}</span></button>`; };
  out.innerHTML = (up.length ? `<h3>القادمة</h3>${up.map(row).join("")}` : `<p class="empty">ما عندك حجوزات قادمة.</p>`) + (old.length ? `<h3>السابقة</h3>${old.map(row).join("")}` : "");
};
$("lookupRes").onclick = e => { const b = e.target.closest("[data-tok]"); if (b) openBooking(b.dataset.tok); };

async function renderUpcoming() {
  const el = $("upcoming"); el.hidden = true;
  if (view !== "book" && view !== "mine") return;
  for (const tok of myTokens().slice(0, 3)) {
    const { data } = await sb.rpc("get_booking", { p_token: tok }); if (!data) continue;
    const b = toBooking(data);
    if (b.status === "booked" && Date.now() <= b.s + S.grace * 60000) {
      el.hidden = false; el.innerHTML = `عندك حجز ${dayLabel(b.date)} الساعة ${label12(b.time)} · ${esc(b.code)} <button data-tok="${b.token}">افتح الحجز</button>`; return;
    }
  }
}
$("upcoming").onclick = e => { const b = e.target.closest("[data-tok]"); if (b) openBooking(b.dataset.tok); };

/* ================= صاحب الكوفي ================= */
$("loginForm").onsubmit = async e => {
  e.preventDefault(); const err = $("lErr"); err.hidden = true;
  const { error } = await sb.auth.signInWithPassword({ email: $("lEmail").value.trim(), password: $("lPass").value });
  if (error) { err.hidden = false; err.textContent = "الإيميل أو كلمة المرور غلط."; return; }
};
$("logout").onclick = async () => { await sb.auth.signOut(); go("book"); };

async function loadOwner() {
  const { data, error } = await sb.from("bookings").select("*").eq("cafe_id", cafe.id).gte("night", addDays(tonight(), -1));
  if (!error) { ownerRows = data.map(toBooking); if (view === "owner") renderOwner(); }
}
let rt = null;
function startRealtime() {
  if (rt) return;
  rt = sb.channel("bookings-" + cafe.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "bookings", filter: `cafe_id=eq.${cafe.id}` }, () => loadOwner())
    .subscribe();
}
function renderOwner() {
  const t0 = tonight(); if (!oDate || oDate < t0) oDate = t0; let h = "";
  for (let i = 0; i < 7; i++) { const k = addDays(t0, i), n = ownerRows.filter(b => b.date === k && isActive(b)).length;
    h += `<button class="day" data-od="${k}" aria-pressed="${oDate === k}"><span>${dayLabel(k)}</span><b>${AR(Number(k.slice(8)))}</b><span>${n ? AR(n) + " حجز" : "—"}</span></button>`; }
  $("oDays").innerHTML = h;
  const list = ownerRows.filter(b => b.date === oDate).sort((a, b) => a.s - b.s), act = list.filter(isActive), now = Date.now();
  $("sTotal").textContent = AR(act.length); $("sPpl").textContent = AR(act.reduce((s, b) => s + b.ppl, 0)); $("sIn").textContent = AR(list.filter(b => b.status === "arrived" || b.status === "done").length);
  const closed = S.closed.includes(oDate);
  $("closeDay").textContent = closed ? "الحجز مقفل هذا اليوم · افتحه" : "قفّل الحجز في هذا اليوم"; $("closeDay").className = "ghost" + (closed ? "" : " danger");
  $("oList").innerHTML = list.length ? list.map(b => { const [c, l] = lifeOf(b);
    const timeLeft = b.status === "arrived" && (b.dur > 0 || b.extra > 0) ? (now < b.e ? `باقي ${dur(b.e - now)} · ` : "انتهى وقته · ") : "";
    const acts = b.status === "booked" ? `<button data-st="arrived" data-tok="${b.token}">وصل</button><button data-st="noshow" data-tok="${b.token}">ما حضر</button><button data-st="cancelled" data-tok="${b.token}">إلغاء</button>`
      : b.status === "arrived" ? `<button data-ext="15" data-tok="${b.token}">+١٥ دقيقة</button><button data-ext="30" data-tok="${b.token}">+٣٠ دقيقة</button><button data-st="done" data-tok="${b.token}">طلع</button>`
      : `<button data-st="booked" data-tok="${b.token}">رجّعه محجوز</button>`;
    return `<div class="bk"><span class="t">${label12(b.time)}</span>
      <div class="who">${esc(b.name)} · ${AR(b.ppl)}<small>${timeLeft}${esc(typeOf(b.type).name)} · ${durTxt(b.dur)}${b.extra > 0 ? "+" + AR(b.extra) : ""} · ${esc(b.code)}${b.phone ? ` · <span class="ltr">${esc(b.phone)}</span>` : ""}${b.source === "manual" ? " · يدوي" : ""}</small></div>
      <span class="pill ${c}">${l}</span><div class="acts">${acts}</div></div>`; }).join("")
    : `<p class="empty">ما فيه حجوزات في هذا اليوم. انسخ رابط الحجز من تحت وحطه في البايو.</p>`;
  const total = S.types.reduce((s, x) => s + x.cap, 0) || 1;
  const rows = slotList().map(tm => { const st = startMs(oDate, tm); return { tm, n: act.filter(b => b.s <= st && st < b.e).length }; }).filter(r => r.n > 0);   // كم طاولة مشغولة في كل وقت
  $("oLoad").innerHTML = rows.length ? rows.map(r => { const p = Math.round(r.n / total * 100); return `<div class="load"><span>${label12(r.tm)}</span><div class="bar ${p >= 70 ? "hot" : ""}"><i style="width:${Math.min(100, p)}%"></i></div><span>${AR(r.n)}/${AR(total)}</span></div>`; }).join("") : `<p class="empty">يبان هنا أي وقت فيه طاولات مشغولة.</p>`;
  $("mType").innerHTML = S.types.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("");
  const keep = $("mTime").value; $("mTime").innerHTML = slotList().map(tm => `<option value="${tm}">${label12(tm)}</option>`).join(""); if (keep) $("mTime").value = keep;
  $("shareLink").textContent = HOME;
}
$("oDays").onclick = e => { const b = e.target.closest("[data-od]"); if (b) { oDate = b.dataset.od; renderOwner(); } };
$("oList").onclick = async e => {
  const x = e.target.closest("[data-ext]"), b = e.target.closest("[data-st]");
  if (x) { x.disabled = true; const { data, error } = await sb.rpc("extend_booking", { p_token: x.dataset.tok, p_minutes: Number(x.dataset.ext) });
    if (!error && data > 0) alert(`انتبه: التمديد يتعارض مع ${data} حجز بعده في نفس النوع.`); return loadOwner(); }
  if (b) { b.disabled = true; await sb.rpc("set_status", { p_token: b.dataset.tok, p_status: b.dataset.st }); return loadOwner(); }
};
$("closeDay").onclick = async () => {
  const next = S.closed.includes(oDate) ? S.closed.filter(k => k !== oDate) : [...S.closed.filter(k => k >= tonight()), oDate];
  const { error } = await sb.from("cafes").update({ closed_dates: next }).eq("id", cafe.id); if (!error) await reloadCafe();
};
$("mAdd").onclick = async () => {
  const err = $("mErr"); err.hidden = true; err.style.color = "";
  const { data, error } = await sb.rpc("create_booking", { p_slug: SLUG, p_night: oDate, p_time: $("mTime").value, p_type: $("mType").value,
    p_people: Math.max(1, parseInt($("mPpl").value, 10) || 1), p_name: $("mName").value.trim(), p_phone: $("mPhone").value.trim() });
  err.hidden = false;
  if (error) { err.textContent = friendly(error); return; }
  err.style.color = "var(--accent)"; err.textContent = `تمت الإضافة · ${data.code}`; $("mName").value = ""; $("mPhone").value = ""; loadOwner();
};

/* إعدادات */
function fillSettings() {
  $("sName").value = S.name; $("sArea").value = S.area; $("sOpen").value = S.open; $("sClose").value = S.close;
  $("sGrace").value = S.grace; $("sMax").value = S.maxGroup; $("sMap").value = S.mapUrl;
  draftTypes = S.types.map(t => ({ ...t })); renderTypeSet();
}
function renderTypeSet() {
  $("typeSet").innerHTML = draftTypes.map((t, i) => `<div class="trow">
    <div class="grid2"><label>الاسم<input data-i="${i}" data-f="name" value="${esc(t.name)}"></label><label>عدد الطاولات<input data-i="${i}" data-f="cap" type="number" min="0" max="99" value="${t.cap}"></label></div>
    <div class="sub">مدة الجلسة: ${durTxt(t.dur)}</div>
    <div class="chips">${DUR_PRESETS.map(m => `<button class="chip" data-i="${i}" data-dm="${m}" aria-pressed="${t.dur === m}">${m ? AR(m) : "بدون حد"}</button>`).join("")}</div></div>`).join("");
}
$("typeSet").oninput = e => { const x = e.target; if (x.dataset.f) draftTypes[x.dataset.i][x.dataset.f] = x.dataset.f === "cap" ? Math.max(0, Math.min(99, parseInt(x.value, 10) || 0)) : x.value; };
$("typeSet").onclick = e => { const c = e.target.closest("[data-dm]"); if (c) { draftTypes[c.dataset.i].dur = Number(c.dataset.dm); renderTypeSet(); } };
$("sSave").onclick = async () => {
  const num = (id, lo, hi) => Math.min(hi, Math.max(lo, parseInt($(id).value, 10) || lo)), err = $("sErr"); err.hidden = true;
  const patch = { name: $("sName").value.trim() || S.name, area: $("sArea").value.trim(), open_time: $("sOpen").value || S.open, close_time: $("sClose").value || S.close,
    grace_minutes: num("sGrace", 5, 60), max_group: num("sMax", 1, 50), map_url: /^https:\/\//.test($("sMap").value.trim()) ? $("sMap").value.trim() : "", types: draftTypes };
  $("sSave").textContent = "جاري الحفظ…";
  const { error } = await sb.from("cafes").update(patch).eq("id", cafe.id);
  $("sSave").textContent = "احفظ الإعدادات";
  if (error) { err.hidden = false; err.textContent = "ما انحفظت. تأكد إنك داخل بحساب صاحب الكوفي."; return; }
  await reloadCafe(); $("sSave").textContent = "تم الحفظ"; setTimeout(() => $("sSave").textContent = "احفظ الإعدادات", 1500);
};

/* ================= التنقل ================= */
function copy(btn) { const t = btn.dataset.copy || $("shareLink").textContent; const o = btn.textContent;
  navigator.clipboard.writeText(t).then(() => { btn.textContent = "تم النسخ"; setTimeout(() => btn.textContent = o, 1500); }, () => {}); }
$("copyShare").onclick = e => copy(e.currentTarget);
function show(v) {
  view = v; for (const x of ["book", "mine", "booking", "login", "owner"]) $("v-" + x).hidden = x !== v;
  $("tabs").hidden = v === "owner" || v === "login";
  document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-current", b.dataset.v === v || (v === "booking" && b.dataset.v === "mine")));
  renderUpcoming();
}
async function go(v) {
  if (v !== "booking") { clearInterval(pollOne); openToken = null; history.replaceState(null, "", "/" + SLUG + (v === "book" ? "" : "#" + v)); }
  if (v === "owner") {
    if (!session) return show("login");
    if (cafe.owner_id !== session.user.id) { show("login"); const e = $("lErr"); e.hidden = false; e.textContent = "هذا الحساب مو صاحب هذا الكوفي."; return; }
    show("owner"); fillSettings(); renderOwner(); loadOwner(); startRealtime(); return;
  }
  show(v); if (v === "book") { renderBook(); loadBusy(); }
}
$("tabs").onclick = e => { const b = e.target.closest("[data-v]"); if (b) go(b.dataset.v); };
$("ownerLink").onclick = e => { e.preventDefault(); go("owner"); };

async function reloadCafe() {
  const { data, error } = await sb.from("cafes").select("*").eq("slug", SLUG).maybeSingle();
  if (error || !data) throw new Error("NOT_FOUND");
  cafe = data; S = toSettings(data); renderHeader();
  if (view === "book") renderBook(); if (view === "owner") { renderOwner(); }
}

/* ================= التشغيل ================= */
(async () => {
  const ban = $("banner");
  if (!window.supabase || !CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes("xxxx")) {
    ban.hidden = false; ban.textContent = "الموقع لسه ما انربط بقاعدة البيانات. عدّل ملف config.js (الخطوة ٣ في الدليل)."; $("bookBtn").disabled = true; return;
  }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  try { await reloadCafe(); }
  catch (_) { ban.hidden = false; ban.textContent = `ما لقينا كوفي باسم "${SLUG}". تأكد من الرابط أو من جدول cafes.`; $("bookBtn").disabled = true; return; }
  session = (await sb.auth.getSession()).data.session;
  sb.auth.onAuthStateChange((_e, s) => { session = s; if (view === "login" && s) go("owner"); });
  const h = location.hash.slice(1);
  if (h.startsWith("b-")) openBooking(h.slice(2));
  else if (h === "mine") go("mine");
  else if (h === "owner") go("owner");
  else go("book");
  window.addEventListener("hashchange", () => {        // لو تغيّر الرابط بدون تحميل الصفحة
    const x = location.hash.slice(1);
    if (x.startsWith("b-")) { if (x.slice(2) !== openToken) openBooking(x.slice(2)); }
    else if (x === "owner" || x === "mine") { if (view !== x && !(x === "owner" && view === "login")) go(x); }
  });
  setInterval(() => {                                   // تحديث دوري: الخانات كل ٢٠ ثانية، والعدادات
    if (view === "book") loadBusy();
    if (view === "booking") renderOne();
    if (view === "owner") renderOwner();
  }, 20000);
})();
