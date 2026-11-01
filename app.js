// 언제바껴 — 내 주변 횡단보도의 다음 초록불까지 남은 시간을 "예상"해 주는 웹앱
// 데이터: data/regions.json + data/rXX.json (전국횡단보도표준데이터에서 보행자신호등 있는 곳만 추림)
// 행: [위도, 경도, 녹색초, 적색초, 버튼식(1/0), 음향(1/0), 주소, ID, 차로수]
"use strict";
const $ = id => document.getElementById(id);
const NEAR_M = 400;            // 주변 목록 반경
const MIN_ZOOM_MARKERS = 15;   // 이 줌 이상에서만 지도에 점 표시

// ---------------- 기록 저장 (이 폰 안에만) ----------------
const STORE_KEY = "ujbk-records-v1";
let records = {};
try { records = JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch (e) { records = {}; }
function saveRecords() { try { localStorage.setItem(STORE_KEY, JSON.stringify(records)); } catch (e) {} }

// ---------------- 데이터 로딩 ----------------
let regions = [], loaded = {}, all = [];   // all: 로드된 횡단보도 객체들
async function loadIndex() {
  const r = await fetch("data/regions.json"); regions = (await r.json()).regions;
}
async function ensureRegionsFor(bounds) {
  const need = regions.filter(g => !loaded[g.file] &&
    !(g.bbox[2] < bounds.getSouth() || g.bbox[0] > bounds.getNorth() || g.bbox[3] < bounds.getWest() || g.bbox[1] > bounds.getEast()));
  await Promise.all(need.map(async g => {
    loaded[g.file] = "loading";
    const rows = await (await fetch("data/" + g.file)).json();
    rows.forEach(r => all.push({ lat: r[0], lon: r[1], green: r[2], red: r[3], button: !!r[4], sound: !!r[5], addr: r[6], id: r[7], lanes: r[8] }));
    loaded[g.file] = true;
  }));
}

// ---------------- 예측 ----------------
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const weekend = t => { const d = new Date(t).getDay(); return d === 0 || d === 6; };
const tod = t => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };
function cycleSamples(ev) {
  const g = ev.filter(e => e.k === "g"), out = [];
  for (let i = 1; i < g.length; i++) { const d = (g[i].t - g[i - 1].t) / 1000; if (d >= 40 && d <= 240) out.push(d); }
  return out;
}
function predict(cw, now) {
  const dataCycle = cw.green && cw.red ? cw.green + cw.red : null;
  const base = { dataCycle, dataGreen: cw.green || null };
  if (cw.button) return { ...base, state: "button" };
  const ev = [...(records[cw.id] || [])].sort((a, b) => a.t - b.t);
  const near = ev.filter(e => weekend(e.t) === weekend(now) && Math.abs(tod(e.t) - tod(now)) <= 90);
  const src = cycleSamples(near).length ? near : ev;
  const samples = cycleSamples(src);
  let cycle = samples.length ? median(samples) : dataCycle;
  if (!cycle) return { ...base, state: ev.length ? "needcycle" : "nodata" };
  // 오래 떨어진 초록 기록도 주기의 배수면 보정에 사용
  const allS = [...samples], g = src.filter(e => e.k === "g");
  for (let i = 1; i < g.length; i++) { const d = (g[i].t - g[i - 1].t) / 1000; if (d > 240 && d < 3600) { const k = Math.round(d / cycle); if (Math.abs(d / k - cycle) <= 3) allS.push(d / k); } }
  if (allS.length) cycle = median(allS);
  const spread = samples.length ? Math.max(...samples.map(s => Math.abs(s - cycle))) : 0;
  const gd = []; for (let i = 0; i < src.length - 1; i++) if (src[i].k === "g" && src[i + 1].k === "r") { const d = (src[i + 1].t - src[i].t) / 1000; if (d > 3 && d < cycle) gd.push(d); }
  const green = gd.length ? median(gd) : (cw.green || null);
  let anchor = null;
  for (const e of ev) { const a = e.k === "g" ? e.t : (green ? e.t - green * 1000 : null); if (a !== null && (anchor === null || a > anchor)) anchor = a; }
  const out = { ...base, cycle, green, measured: allS.length > 0, count: ev.length };
  if (anchor === null) return { ...out, state: "needtap" };
  const cms = cycle * 1000, n = Math.max(0, (now - anchor) / cms);
  const perCycle = allS.length ? Math.max(0.15, spread / Math.sqrt(allS.length)) : 1.0; // 측정 없이 데이터 주기만 쓰면 오차가 빨리 커짐
  const err = Math.round(1 + n * perCycle);
  const phase = ((now - anchor) % cms + cms) % cms;
  const left = Math.ceil((cms - phase) / 1000);
  let conf = "hi"; if (!allS.length || err > 5) conf = "mid"; if (err > 10) conf = "lo";
  const res = { ...out, err, phase, cms, left, conf, next: now + cms - phase };
  if (spread > 6) return { ...res, state: "irregular" };
  if (err > 15) return { ...res, state: "stale" };
  return { ...res, state: "ok" };
}

// ---------------- 지도 ----------------
const map = L.map("map", { zoomControl: false, attributionControl: true }).setView([36.35, 127.8], 7);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
const renderer = L.canvas({ padding: 0.3 });
const layer = L.layerGroup().addTo(map);
let me = null, meMarker = null, selected = null, following = false;

function colorFor(cw) {
  if (cw.button) return getVar("--violet");
  const p = predict(cw, Date.now());
  if (p.state === "ok") return p.phase < (p.green || 0) * 1000 ? getVar("--green") : getVar("--red");
  return cw.green && cw.red ? getVar("--amber") : getVar("--gray");
}
const getVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function drawMarkers() {
  layer.clearLayers();
  if (map.getZoom() < MIN_ZOOM_MARKERS) return;
  const b = map.getBounds().pad(0.2);
  for (const cw of all) {
    if (!b.contains([cw.lat, cw.lon])) continue;
    const m = L.circleMarker([cw.lat, cw.lon], {
      renderer, radius: cw === selected ? 10 : 7, weight: cw === selected ? 3 : 2,
      color: "#fff", fillColor: colorFor(cw), fillOpacity: 1
    });
    m.on("click", () => openDetail(cw));
    m.addTo(layer);
  }
}
map.on("moveend", async () => { await ensureRegionsFor(map.getBounds()); drawMarkers(); renderNear(); });
map.on("dragstart", () => { following = false; $("locate").classList.remove("on"); });

// ---------------- 위치 ----------------
function startLocation() {
  if (!("geolocation" in navigator)) { $("introMsg").textContent = "이 브라우저는 위치 기능을 지원하지 않아요. 지도를 직접 움직여 찾아보세요."; showNear(); return; }
  $("introMsg").textContent = "위치를 찾는 중…";
  navigator.geolocation.watchPosition(pos => {
    const first = !me;
    me = [pos.coords.latitude, pos.coords.longitude];
    if (!meMarker) meMarker = L.marker(me, { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [18, 18] }), interactive: false }).addTo(map);
    else meMarker.setLatLng(me);
    if (first) { following = true; $("locate").classList.add("on"); map.setView(me, 17); showNear(); }
    else if (following) map.panTo(me, { animate: true });
    renderNear();
  }, err => {
    $("introMsg").textContent = err.code === 1
      ? "위치 권한이 꺼져 있어요. 브라우저 설정에서 이 사이트의 위치 권한을 허용해 주세요. 지금은 지도를 직접 움직여 찾을 수 있어요."
      : "위치를 찾지 못했어요. 잠시 후 다시 시도하거나 지도를 직접 움직여 주세요.";
    showNear();
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
$("allow").onclick = startLocation;
$("locate").onclick = () => { if (!me) { startLocation(); return; } following = true; $("locate").classList.add("on"); map.setView(me, Math.max(map.getZoom(), 17)); };

// ---------------- 시트: 주변 목록 ----------------
function dist(a, b) {
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(b[0] - a[0]), dLon = toR(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function dir8(a, b) {
  const toR = x => x * Math.PI / 180, y = Math.sin(toR(b[1] - a[1])) * Math.cos(toR(b[0])),
    x = Math.cos(toR(a[0])) * Math.sin(toR(b[0])) - Math.sin(toR(a[0])) * Math.cos(toR(b[0])) * Math.cos(toR(b[1] - a[1]));
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return ["북쪽", "북동쪽", "동쪽", "남동쪽", "남쪽", "남서쪽", "서쪽", "북서쪽"][Math.round(deg / 45) % 8];
}
const mmss = s => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
function showNear() { $("vIntro").hidden = true; $("vDetail").hidden = true; $("vNear").hidden = false; selected = null; renderNear(); drawMarkers(); }
function shortStatus(cw) {
  const p = predict(cw, Date.now());
  if (p.state === "button") return ["버튼식", "누르면 바뀌는 신호"];
  if (p.state === "ok") return [mmss(p.left), "초록까지 약"];
  if (p.state === "nodata") return ["-", "탭해서 기록"];
  if (p.state === "needtap") return ["?", "초록 켜질 때 탭"];
  return ["!", "다시 기록 필요"];
}
function renderNear() {
  if ($("vNear").hidden) return;
  const center = me || [map.getCenter().lat, map.getCenter().lng];
  const list = all.map(cw => ({ cw, d: dist(center, [cw.lat, cw.lon]) })).filter(x => x.d <= NEAR_M).sort((a, b) => a.d - b.d).slice(0, 8);
  const box = $("nearList"); box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<p class="muted small">${me ? "400m 안에 신호 있는 횡단보도 데이터가 없어요." : "지도 가운데 주변에 데이터가 없어요."} 지도를 움직여 보세요. 지금 데이터는 전국 일부 지역만 들어 있어요.</p>`;
    return;
  }
  for (const { cw, d } of list) {
    const [t, s] = shortStatus(cw);
    const b = document.createElement("button"); b.type = "button"; b.className = "item";
    b.innerHTML = `<span class="dot" style="background:${colorFor(cw)}"></span><span class="a"></span><span class="r">${t}<small>${s}</small></span>`;
    b.querySelector(".a").textContent = `${dir8(center, [cw.lat, cw.lon])} ${Math.round(d)}m · ${cw.addr || "주소 없음"}${cw.lanes ? " · " + cw.lanes + "차로" : ""} · #${cw.id.slice(-4)}`;
    b.onclick = () => openDetail(cw);
    box.appendChild(b);
  }
}

// ---------------- 시트: 상세 ----------------
function openDetail(cw) {
  selected = cw; $("vIntro").hidden = true; $("vNear").hidden = true; $("vDetail").hidden = false;
  $("dAddr").textContent = cw.addr || "주소 없음";
  const meta = [];
  if (cw.green && cw.red) meta.push(`데이터상 초록 ${cw.green}초 · 빨강 ${cw.red}초`);
  else meta.push("신호 시간 데이터 없음");
  if (cw.lanes) meta.push(`${cw.lanes}차로`);
  if (cw.sound) meta.push("음향신호기");
  if (me) meta.push(`${dir8(me, [cw.lat, cw.lon])} ${Math.round(dist(me, [cw.lat, cw.lon]))}m`);
  const same = all.filter(x => x.lat === cw.lat && x.lon === cw.lon).length;
  if (same > 1) meta.push(`같은 위치에 횡단보도 ${same}개가 함께 등록돼 있어 방향 구분이 어려워요`);
  meta.push("#" + cw.id.slice(-4));
  $("dMeta").textContent = meta.join(" · ");
  $("toast").textContent = "";
  renderDetail(); drawMarkers();
}
$("back").onclick = showNear;
function renderDetail() {
  if (!selected || $("vDetail").hidden) return;
  const p = predict(selected, Date.now());
  const big = $("big"), warn = $("warn"), conf = $("conf"), track = $("track"), sub = $("sub");
  warn.hidden = true; track.hidden = true; conf.hidden = true; sub.textContent = "";
  $("tapG").disabled = $("tapR").disabled = p.state === "button";
  $("undo").hidden = !(records[selected.id] || []).length;
  const txt = (m, s) => { big.className = "big txt"; big.textContent = m; sub.textContent = s || ""; };
  switch (p.state) {
    case "button": return txt("버튼을 눌러야 바뀌는 신호예요", "예측할 수 없어요. 신호등의 보행자 버튼을 눌러주세요.");
    case "nodata": return txt("초록불이 켜질 때 탭하고, 다음 초록 때 한 번 더 탭해 주세요", "이 횡단보도는 신호 시간 데이터가 없어서 직접 기록한 주기로 계산해요.");
    case "needcycle": return txt("초록불을 한 번 더 기록하면 계산할 수 있어요");
    case "needtap": return txt("초록불이 켜지는 순간 한 번만 탭해 주세요", `데이터상 주기 ${Math.round(p.cycle)}초로 다음 초록불을 계산해요.`);
    case "irregular": txt("예측이 어려운 횡단보도예요"); warn.hidden = false; warn.textContent = "기록할 때마다 주기가 달라요. 교통량에 따라 신호가 바뀌는 곳일 수 있어요."; return;
    case "stale": return txt("기록이 오래돼서 다시 기록이 필요해요", "초록불이 켜질 때 한 번만 탭해 주세요.");
  }
  big.className = "big"; big.innerHTML = "<small>약</small>" + mmss(p.left);
  const at = new Date(p.next).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  let s = `${at}쯤 · 오차 ±${p.err}초 · 주기 ${Math.round(p.cycle)}초${p.measured ? "(측정)" : "(데이터)"}`;
  if (p.measured && p.dataCycle && Math.abs(p.cycle - p.dataCycle) > 5) s += ` · 데이터 ${p.dataCycle}초와 달라요`;
  sub.textContent = s;
  conf.hidden = false; conf.className = "conf " + p.conf; conf.textContent = { hi: "믿을 만함", mid: "참고용", lo: "부정확할 수 있음" }[p.conf];
  if (p.green) {
    track.hidden = false; $("tg").style.width = (100 * p.green * 1000 / p.cms) + "%"; $("tn").style.left = (100 * p.phase / p.cms) + "%";
    if (p.phase < p.green * 1000) { warn.hidden = false; warn.textContent = "지금은 초록일 수도 있어요. 남은 시간이 짧을 수 있으니 뛰어서 건너지 말고 신호등을 직접 확인하세요."; }
  }
}
function record(k) {
  if (!selected) return;
  const t = Date.now();
  (records[selected.id] = records[selected.id] || []).push({ t, k });
  if (records[selected.id].length > 300) records[selected.id] = records[selected.id].slice(-300);
  saveRecords();
  $("toast").textContent = `${k === "g" ? "초록 켜짐" : "빨강 바뀜"} 기록 · ${new Date(t).toLocaleTimeString("ko-KR")}`;
  renderDetail(); drawMarkers();
}
$("tapG").onclick = () => record("g");
$("tapR").onclick = () => record("r");
$("undo").onclick = () => {
  const ev = records[selected?.id]; if (!ev || !ev.length) return;
  ev.sort((a, b) => a.t - b.t).pop(); saveRecords(); $("toast").textContent = "마지막 기록을 지웠어요"; renderDetail(); drawMarkers();
};

// ---------------- 시작 ----------------
setInterval(() => { renderDetail(); renderNear(); }, 1000);
setInterval(drawMarkers, 5000);
loadIndex().then(() => ensureRegionsFor(map.getBounds())).then(() => { drawMarkers(); })
  .catch(() => { $("introMsg").textContent = "횡단보도 데이터를 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요."; });
if (navigator.permissions?.query) {
  navigator.permissions.query({ name: "geolocation" }).then(s => { if (s.state === "granted") startLocation(); }).catch(() => {});
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
