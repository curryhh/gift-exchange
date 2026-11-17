"use strict";
const CONFIG = window.JOY_SPIN_CONFIG || {};
const Core = window.JoyCore;
const APP_KEY = "joy-spin-v3";
const userId = getOrCreateUserId();
const palette = ["#bd4433", "#d5a850", "#7f9365", "#e7b89c", "#aab5a2", "#ede1c1"];
const demoNames = ["小太阳", "彩虹糖", "桃桃", "幸运星", "糯米团", "小火苗", "甜甜圈", "橘子汽水", "云朵", "花花", "小月亮", "奶茶", "星星", "小熊", "小兔", "泡泡", "布丁", "团子", "桃子", "可乐"];
let state = null;
let setupMode = "create";
let demoMode = false;
let sync = null;
let syncUnsubscribe = null;
let toastTimer = null;
let drawTicker = null;
let drawAnimationKey = "";
let confettiTimer = null;
let renderedResultRound = "";
const DRAW_DURATION = Core.DRAW_DURATION;
const DRAW_PRELUDGE = Core.DRAW_PRELUDE;
const $ = (selector) => document.querySelector(selector);
const screens = Object.fromEntries(["home", "setup", "lobby", "draw", "done"].map((key) => [key, $("#" + key + "Screen")]));
const now = () => sync?.now() || Date.now();

window.addEventListener("DOMContentLoaded", boot);

async function boot() {
  bindEvents();
  updateModePill();
  const linkedCode = new URLSearchParams(location.search).get("room");
  const savedRoom = sessionStorage.getItem(APP_KEY + ":current-room");
  if (savedRoom) {
    try {
      const saved = JSON.parse(savedRoom);
      // An invite to a different room takes precedence over automatic restoration.
      if (!linkedCode || cleanCode(linkedCode) === saved.code) {
        demoMode = saved.kind === "demo";
        sync = makeSync();
        $("#modePill").textContent = "正在重返房间…";
        state = await sync.read(saved.code);
        if (!state.participants.some((person) => person.id === userId)) throw new Error("你已离开这个房间");
        clearInviteQuery();
        subscribeToState(state.code);
        applyRoom(state, true);
        updateModePill();
        return;
      }
    } catch (error) {
      sync?.disconnect(); sync = null; state = null;
      sessionStorage.removeItem(APP_KEY + ":current-room");
      showToast(error.message);
    }
  }
  if (linkedCode) { openSetup("join"); $("#codeInput").value = cleanCode(linkedCode); }
}

function makeSync() {
  const options = { userId, onConnection: (connected, kind) => {
    if (!sync) return;
    $("#connectionBanner").classList.toggle("hidden", connected || !state || kind === "demo");
    $("#modePill").textContent = kind === "demo" ? "体验演示" : connected ? "在线房间" : state ? "正在重连…" : "连接中…";
    $("#modePill").dataset.status = connected ? "online" : "offline";
  } };
  return demoMode ? new JoySync.DemoRoom(options) : new JoySync.MqttRoom({ ...options, brokerUrl: CONFIG.mqttBroker || "wss://broker.emqx.io:8084/mqtt" });
}

function bindEvents() {
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state?.status === "drawing" && !screens.done.classList.contains("active")) renderDraw(); });
  document.querySelectorAll("[data-action='show-create']").forEach((button) => button.addEventListener("click", () => openSetup("create")));
  document.querySelectorAll("[data-action='show-join']").forEach((button) => button.addEventListener("click", () => openSetup("join")));
  $("#demoButton").addEventListener("click", () => openSetup("create", true));
  document.querySelector("[data-action='go-home']").addEventListener("click", () => { sync?.disconnect(); sync = null; demoMode = false; updateModePill(); showScreen("home"); });
  $("#brandButton").addEventListener("click", () => { if (state) applyRoom(state, true); else showScreen("home"); });
  $("#setupForm").addEventListener("submit", (event) => { event.preventDefault(); runBusy($("#setupSubmit"), handleSetupSubmit, "正在连接房间…"); });
  $("#copyCodeButton").addEventListener("click", copyCode);
  ["#leaveButton", "#drawLeaveButton", "#doneLeaveButton"].forEach((id) => $(id).addEventListener("click", askLeave));
  $("#cancelLeaveButton").addEventListener("click", () => $("#leaveDialog").close());
  $("#confirmLeaveButton").addEventListener("click", () => runBusy($("#confirmLeaveButton"), async () => { await leaveLounge(); $("#leaveDialog").close(); }, "正在离开…"));
  $("#startDrawButton").addEventListener("click", () => runBusy($("#startDrawButton"), startDraw, "惊喜配对中…"));
  $("#demoAddButton").addEventListener("click", () => runBusy($("#demoAddButton"), addDemoGuest));
  $("#nextTurnButton").addEventListener("click", viewFinalResults);
  $("#restartButton").addEventListener("click", () => runBusy($("#restartButton"), async () => { applyRoom(await sync.dispatch({ type: "restart" }), true); }));
}

async function runBusy(button, task, label = "请稍等…") {
  if (button.dataset.busy) return;
  const previous = button.innerHTML;
  button.dataset.busy = "true";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = label;
  try { await task(); } catch (error) { showToast(error.message || "操作失败，请重试"); }
  finally { delete button.dataset.busy; button.removeAttribute("aria-busy"); button.disabled = false; button.innerHTML = previous; if (state?.status === "lobby") renderLobby(); }
}

function openSetup(mode, isDemo = false) {
  if (state) { applyRoom(state, true); return; }
  sync?.disconnect(); sync = null;
  setupMode = mode; demoMode = isDemo;
  $("#setupIcon").textContent = mode === "join" ? "↗" : "✳";
  $("#setupEyebrow").textContent = isDemo ? "TRY A LITTLE GIFT EXCHANGE" : mode === "create" ? "LET’S EXCHANGE SOME JOY" : "A SURPRISE IS WAITING";
  $("#setupTitle").textContent = isDemo ? "先体验一场惊喜" : mode === "create" ? "发起一场交换局" : "加入这场交换局";
  $("#setupSubtitle").textContent = isDemo ? "邀几位虚拟伙伴，试试礼物如何找到有缘人。" : mode === "create" ? "写下昵称，邀请朋友们带着心意相聚。" : "输入朋友的房间号，一起交换礼物与快乐。";
  $("#setupSubmit").textContent = isDemo ? "开始体验 →" : mode === "create" ? "创建交换房间 →" : "加入交换房间 →";
  $("#formHint").textContent = isDemo ? "这是本机演示，朋友无法通过房间号加入。" : mode === "create" ? "2–20 人同玩，房主需要保持页面打开。" : "请输入朋友分享的 6 位字母或数字。";
  $("#codeField").classList.toggle("hidden", mode === "create");
  $("#codeInput").required = mode === "join";
  $("#nicknameInput").value = isDemo ? "小满" : (localStorage.getItem(APP_KEY + ":name") || "");
  $("#codeInput").value = "";
  updateModePill(); showScreen("setup");
}

async function handleSetupSubmit() {
  const name = cleanName($("#nicknameInput").value);
  if (!name) throw new Error("请先输入一个昵称～");
  if (setupMode === "join" && cleanCode($("#codeInput").value).length !== 6) throw new Error("请输入 6 位房间号～");
  sync?.disconnect(); sync = makeSync();
  try {
    let room;
    if (setupMode === "create") {
      room = Core.createRoom(Core.makeCode(), userId, name);
      room.code = await sync.openHost(room.code, room);
    } else {
      const code = cleanCode($("#codeInput").value);
      await sync.read(code);
      room = await sync.dispatch({ type: "join", name });
    }
    state = room;
    localStorage.setItem(APP_KEY + ":name", name);
    sessionStorage.setItem(APP_KEY + ":current-room", JSON.stringify({ code: state.code, kind: sync.kind }));
    clearInviteQuery();
    subscribeToState(state.code);
    applyRoom(state, true); updateModePill();
    showToast(demoMode ? "体验房间准备好了，添加伙伴一起玩吧" : "加入成功，房间号 " + state.code);
  } catch (error) { sync.disconnect(); sync = null; updateModePill(); throw error; }
}

function subscribeToState(code) {
  syncUnsubscribe?.();
  syncUnsubscribe = sync.subscribe(code, (next) => applyRoom(next));
}

function applyRoom(next, force = false) {
  if (!next) return;
  const previous = state?.status;
  const previousRound = state?.round;
  state = next;
    if (next.status === "closed") { if (next.hostId === userId && $("#confirmLeaveButton").dataset.busy) return; resetToHome(); showToast("房主结束了房间，下次再一起玩～"); return; }
  $("#demoBanner").classList.toggle("hidden", sync?.kind !== "demo");
  if (next.status === "lobby") {
    stopDrawClock(); drawAnimationKey = ""; renderedResultRound = "";
    $("#resultBanner").classList.add("hidden");
    renderLobby(); showScreen("lobby");
  } else if (next.status === "drawing") {
    if (force || previous !== "drawing" || previousRound !== next.round) { showScreen("draw"); renderDraw(); }
  }
}

function renderLobby() {
  if (!state) return;
  $("#roomCodeText").textContent = state.code;
  $("#roundText").textContent = "第 " + state.round + " 轮 · 等待朋友加入";
  $("#participantCount").textContent = state.participants.length;
  $("#liveLabel").textContent = sync?.kind === "demo" ? "本机体验" : "实时同步";
  const list = $("#participantList"); list.innerHTML = "";
  $("#emptyParticipant").classList.toggle("hidden", state.participants.length > 1);
  state.participants.forEach((person, index) => {
    const row = document.createElement("div"); row.className = "participant-row";
    row.innerHTML = avatarMarkup(person, index) + '<div class="participant-copy"><strong>' + escapeHtml(person.name) + (person.id === userId ? ' <span class="you-tag">我</span>' : '') + '</strong><small>' + (person.id === state.hostId ? "这场惊喜的发起人" : "带着心意，等待惊喜") + '</small></div>' + (person.id === state.hostId ? '<span class="host-tag">✳ 房主</span>' : '<span class="ready-tag">已就绪 ✓</span>');
    list.appendChild(row);
  });
  const isHost = state.hostId === userId;
  $("#hostPanel").classList.toggle("hidden", !isHost);
  $("#guestNote").classList.toggle("hidden", isHost);
  const startButton = $("#startDrawButton");
  if (!startButton.dataset.busy) {
    startButton.disabled = state.participants.length < 2;
    startButton.textContent = state.participants.length < 2 ? "等至少 2 人加入" : "人到齐了，揭晓送给谁 ✳";
  }
  $("#demoAddButton").classList.toggle("hidden", !isHost || sync?.kind !== "demo");
  $("#demoAddButton").disabled = state.participants.length >= Core.MAX_PLAYERS;
  $("#copyCodeButton").classList.toggle("hidden", sync?.kind === "demo");
  $("#shareTip").textContent = sync?.kind === "demo" ? "本机体验房间：点击下方按钮添加虚拟伙伴。" : "复制邀请发给朋友，打开链接填写昵称就能加入。房主请保持页面打开。";
}

async function addDemoGuest() {
  if (!state || sync.kind !== "demo") return;
  const name = demoNames.find((item) => !state.participants.some((person) => person.name === item));
  if (!name) return;
  applyRoom(await sync.dispatch({ type: "demo-add", name }));
}

async function startDraw() {
  if (!state || state.hostId !== userId) return;
  applyRoom(await sync.dispatch({ type: "start" }), true);
}

function renderDraw() {
  if (!state || state.status !== "drawing") return;
  const me = state.participants.find((person) => person.id === userId);
  const recipient = me && findPerson(state.assignments[me.id]);
  if (!me || !recipient) {
    $("#turnName").textContent = "配对数据准备中";
    $("#turnDescription").textContent = "请稍等，马上开始全员转盘。";
    return;
  }
  const startedAt = Number(state.drawStartedAt) || now();
  const duration = Number(state.drawDuration) || DRAW_DURATION;
  const readyAt = startedAt + duration;
  buildWheel(recipient, startedAt);
  if (now() < readyAt) {
    startWheelAnimation(recipient, startedAt, readyAt);
    runDrawClock(me, recipient, startedAt, readyAt);
  } else {
    setWheelToTarget(recipient, startedAt);
    finishLocalDraw(me, recipient, startedAt);
  }
}

function runDrawClock(me, recipient, startedAt, readyAt) {
  stopDrawClock();
  const tick = () => {
    if (!state || state.status !== "drawing") return stopDrawClock();
    const currentTime = now();
    if (currentTime < startedAt) {
      $("#turnName").textContent = "3 · 2 · 1，同步启动";
      $("#turnDescription").textContent = "大家的心意准备好了，惊喜马上揭晓！";
      $("#countdownText").textContent = "全员对时中";
      $("#wheelCenterText").textContent = "READY";
      $("#progressBar").style.width = "0%";
      return;
    }
    if (currentTime >= readyAt) {
      stopDrawClock();
      finishLocalDraw(me, recipient, startedAt);
      return;
    }
    const elapsed = currentTime - startedAt;
    const seconds = Math.max(1, Math.ceil((readyAt - currentTime) / 1000));
    const progress = Math.min(99, Math.round(elapsed / (readyAt - startedAt) * 100));
    $("#turnName").textContent = `${me.name}，礼物送给谁？`;
    $("#turnDescription").textContent = "所有转盘同步转动，最后一刻才揭晓！";
    $("#countdownText").textContent = `距离全员揭晓 ${seconds} 秒`;
    $("#wheelCenterText").textContent = String(seconds);
    $("#progressBar").style.width = progress + "%";
    $("#progressText").textContent = `全员同步中 · ${progress}%`;
  };
  tick();
  drawTicker = setInterval(tick, 100);
}

function startWheelAnimation(recipient, startedAt, readyAt) {
  const wheel = $("#wheel");
  if (!wheel) return;
  const animationKey = `${state.code}:${startedAt}:${recipient.id}`;
  if (drawAnimationKey === animationKey) return;
  drawAnimationKey = animationKey;
  const targetRotation = wheelTargetRotation(recipient, startedAt);
  const startDelay = Math.max(0, startedAt - now());
  const spinDuration = Math.max(450, readyAt - Math.max(now(), startedAt));
  $("#wheelWrap").classList.add("spinning");
  $("#wheelWrap").classList.remove("settled");
  $("#resultBanner").classList.add("hidden");
  $("#nextTurnButton").classList.add("hidden");
  wheel.style.transition = "none";
  wheel.style.transform = "rotate(0deg)";
  void wheel.offsetWidth;
  wheel.style.transition = matchMedia("(prefers-reduced-motion: reduce)").matches ? "none" : `transform ${spinDuration}ms cubic-bezier(.08,.72,.12,1) ${startDelay}ms`;
  wheel.style.transform = `rotate(${targetRotation}deg)`;
  wheel.dataset.targetRotation = String(targetRotation);
}

function wheelTargetRotation(recipient, startedAt) {
  const targetIndex = Math.max(0, state.participants.findIndex((person) => person.id === recipient.id));
  const slice = 360 / state.participants.length;
  const targetCenter = (targetIndex + 0.5) * slice;
  const jitterSeed = hashString(`${state.code}:${userId}:${startedAt}`) % 1000;
  const jitter = (jitterSeed / 1000 - 0.5) * slice * 0.58;
  const landing = (360 - (targetCenter % 360) + 360) % 360;
  return 360 * 7 + landing + jitter;
}

function setWheelToTarget(recipient, startedAt) {
  const wheel = $("#wheel");
  if (!wheel) return;
  const targetRotation = wheelTargetRotation(recipient, startedAt);
  wheel.style.transition = "none";
  wheel.style.transform = `rotate(${targetRotation}deg)`;
  wheel.dataset.targetRotation = String(targetRotation);
}

function finishLocalDraw(me, recipient, startedAt) {
  const wheel = $("#wheel");
  $("#wheelWrap").classList.remove("spinning");
  $("#wheelWrap").classList.add("settled");
  if (wheel && !wheel.dataset.targetRotation) setWheelToTarget(recipient, startedAt);
  if (wheel?.dataset.targetRotation) {
    wheel.style.transition = "none";
    wheel.style.transform = `rotate(${wheel.dataset.targetRotation}deg)`;
  }
  $("#turnName").textContent = `你的礼物送给 ${recipient.name}`;
  $("#turnDescription").textContent = "记住这个名字，把准备好的心意送给对方。";
  $("#wheelCenterText").textContent = "LUCKY";
  $("#resultBanner").classList.remove("hidden");

  $("#resultFrom").textContent = `${me.name} 的送礼对象`;
  $("#resultText").textContent = `送给 · ${recipient.name}`;
  $("#resultSubtext").textContent = `与其余 ${state.participants.length - 1} 位朋友同时揭晓`;
  $("#nextTurnButton").classList.remove("hidden");
  $("#countdownText").textContent = "全员揭晓完成";
  $("#progressBar").style.width = "100%";
  $("#progressText").textContent = `${state.participants.length} 位伙伴已同步开奖`;
  const resultKey = state.code + ":" + state.round;
  if (renderedResultRound !== resultKey) { renderedResultRound = resultKey; burstConfetti(); }
}

function viewFinalResults() {
  if (!state || !state.drawStartedAt || now() < state.drawStartedAt + state.drawDuration) return;
  stopDrawClock();
  renderDone();
  showScreen("done");
}

function stopDrawClock() {
  if (drawTicker) clearInterval(drawTicker);
  drawTicker = null;
}

function buildWheel(recipient, startedAt) {
  const wheelKey = `${state.code}:${startedAt}:${state.participants.map((person) => person.name).join("|")}`;
  const svg = $("#wheelSvg");
  if (!svg || svg.dataset.wheelKey === wheelKey) return;
  svg.dataset.wheelKey = wheelKey;
  drawAnimationKey = "";
  const colors = ["#e9bba3", "#e7d7a6", "#bcc9a7", "#e0c7ae", "#d5dccc", "#ebcfbc", "#c7d4cc", "#ddd2ad"];
  const n = state.participants.length;
  const slice = 360 / n;
  const cx = 160;
  const cy = 160;
  const radius = 128;
  let content = `
    <defs>
      <filter id="wheelShadow"><feDropShadow dx="0" dy="3" stdDeviation="2" flood-color="#53654b" flood-opacity=".15"/></filter>
    </defs>
    <circle cx="160" cy="160" r="156" fill="#fffaf0" stroke="#53654b" stroke-width="1" filter="url(#wheelShadow)"/>
    <circle cx="160" cy="160" r="152" fill="none" stroke="#bd4433" stroke-width="1.2"/>
    <circle cx="160" cy="160" r="137" fill="#fffaf0" stroke="#bd4433" stroke-width="1.2"/>
  `;
  state.participants.forEach((person, index) => {
    const a0 = (-90 + index * slice) * Math.PI / 180;
    const a1 = (-90 + (index + 1) * slice) * Math.PI / 180;
    const x0 = cx + Math.cos(a0) * radius;
    const y0 = cy + Math.sin(a0) * radius;
    const x1 = cx + Math.cos(a1) * radius;
    const y1 = cy + Math.sin(a1) * radius;
    const large = slice > 180 ? 1 : 0;
    content += `<path d="M${cx} ${cy} L${x0.toFixed(2)} ${y0.toFixed(2)} A${radius} ${radius} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z" fill="${colors[index % colors.length]}" stroke="#fffaf3" stroke-width="2.4"/>`;
  });
  for (let bulb = 0; bulb < 24; bulb += 1) {
    const angle = bulb * 15 * Math.PI / 180;
    const x = cx + Math.cos(angle) * 148;
    const y = cy + Math.sin(angle) * 148;
    content += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="1.8" fill="${bulb % 2 ? "#bd4433" : "#a8b391"}"/>`;
  }
  state.participants.forEach((person, index) => {
    const centerAngle = -90 + (index + 0.5) * slice;
    const labelRadius = n <= 4 ? 84 : n <= 8 ? 97 : n <= 12 ? 105 : 112;
    const angle = centerAngle * Math.PI / 180;
    const x = cx + Math.cos(angle) * labelRadius;
    const y = cy + Math.sin(angle) * labelRadius;
    const maxChars = n <= 6 ? 6 : n <= 10 ? 5 : 4;
    const label = truncateText(person.name, maxChars);
    const fontSize = n <= 6 ? 14 : n <= 10 ? 11 : 9;
    content += `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" dominant-baseline="middle" fill="#34402f" font-size="${fontSize}" font-weight="700">${escapeHtml(label)}</text>`;
  });
  content += `<circle cx="160" cy="160" r="53" fill="#fffaf0" stroke="#fffaf0" stroke-width="5"/><circle cx="160" cy="160" r="48" fill="none" stroke="#bd4433" stroke-width="1.2"/><circle cx="160" cy="160" r="44" fill="none" stroke="#bd4433" stroke-width=".6"/>`;
  svg.innerHTML = content;
}

function truncateText(value, length) {
  const chars = [...String(value)];
  return chars.length > length ? chars.slice(0, length - 1).join("") + "…" : chars.join("");
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function burstConfetti() {
  document.querySelector(".confetti-layer")?.remove();
  const layer = document.createElement("div");
  layer.className = "confetti-layer";
  for (let index = 0; index < 24; index += 1) {
    const piece = document.createElement("i");
    piece.style.setProperty("--x", `${8 + Math.random() * 84}vw`);
    piece.style.setProperty("--r", `${Math.random() * 360}deg`);
    piece.style.setProperty("--d", `${Math.random() * .35}s`);
    piece.style.setProperty("--c", palette[index % palette.length]);
    layer.appendChild(piece);
  }
  document.body.appendChild(layer);
  clearTimeout(confettiTimer);
  confettiTimer = setTimeout(() => layer.remove(), 2500);
}



function renderDone() {
  if (!state) return;
  const list = $("#resultList"); list.innerHTML = "";
  state.participants.forEach((person, index) => {
    const recipient = findPerson(state.assignments[person.id]);
    const row = document.createElement("div"); row.className = "result-row";
    row.innerHTML = '<span class="result-person"><span class="seat-number">' + String(index + 1).padStart(2, "0") + '</span><strong>' + escapeHtml(person.name) + '</strong></span><span class="arrow">→</span><strong>' + escapeHtml(recipient?.name || "—") + '</strong>';
    list.appendChild(row);
  });
  const isHost = state.hostId === userId;
  $("#restartButton").classList.toggle("hidden", !isHost);
  $("#waitRestart").classList.toggle("hidden", isHost);
  $("#doneRoundText").textContent = "第 " + state.round + " 轮 · " + state.participants.length + " 位朋友的礼物交换清单";
}

function findPerson(id) { return state?.participants.find((person) => person.id === id); }
function avatarMarkup(person, index) {
  return '<span class="avatar" data-tone="' + index % 5 + '" aria-hidden="true">' + escapeHtml([...person.name][0] || "友") + '<i>' + String(index + 1).padStart(2, "0") + '</i></span>';
}
function showScreen(name) {
  const changed = !screens[name].classList.contains("active");
  Object.entries(screens).forEach(([key, screen]) => screen.classList.toggle("active", key === name));
  if (changed) window.scrollTo({ top: 0, behavior: "instant" });
}
async function copyCode() {
  if (!state) return;
  const invite = new URL(location.href); invite.search = ""; invite.hash = ""; invite.searchParams.set("room", state.code);
  const text = "来交换好运！带一份礼物，一起揭晓送给谁。\n房间号：" + state.code + "\n" + invite.href;
  try { await navigator.clipboard.writeText(text); showToast("邀请已复制，发给朋友吧～"); }
  catch { $("#inviteText").value = text; $("#inviteDialog").showModal(); $("#inviteText").select(); }
}
function askLeave() {
  if (!state) return;
  $("#leaveDialogTitle").textContent = state.hostId === userId ? "要结束这个房间吗？" : "要离开这个房间吗？";
  $("#leaveDialogCopy").textContent = state.hostId === userId ? "你是房主，离开会结束所有人的房间。" : state.status === "drawing" ? "本轮配对已确定，离开后你的抽奖结果仍会保留。" : "离开后，你将从本轮的参与名单中移除。";
  $("#leaveDialog").showModal();
}
async function leaveLounge() {
  if (state && sync) {
    try { await sync.dispatch({ type: "leave" }); }
    catch (error) { showToast("已退出页面；网络断开，房间名单可能尚未更新"); }
  }
  resetToHome();
}
function resetToHome() {
  syncUnsubscribe?.(); syncUnsubscribe = null;
  stopDrawClock(); drawAnimationKey = ""; renderedResultRound = "";
  clearTimeout(confettiTimer); document.querySelector(".confetti-layer")?.remove();
  sync?.disconnect(); sync = null; state = null; demoMode = false;
  sessionStorage.removeItem(APP_KEY + ":current-room");
  $("#connectionBanner").classList.add("hidden"); $("#demoBanner").classList.add("hidden");
  updateModePill(); showScreen("home");
}
function showToast(message) {
  const toast = $("#toast"); toast.textContent = message; toast.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 4200);
}
function updateModePill() {
  $("#modePill").textContent = demoMode ? "体验演示" : state ? "在线房间" : "好友同乐 · 2–20 人";
}
function getOrCreateUserId() {
  const key = APP_KEY + ":session-id";
  let id = sessionStorage.getItem(key);
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(key, id); }
  return id;
}
function clearInviteQuery() { history.replaceState({}, "", location.pathname); }
function cleanName(value) { return Core.cleanName(value); }
function cleanCode(value) { return Core.cleanCode(value); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
