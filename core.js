/* Shared rules. Kept independent of the UI so the actual rules can be tested. */
(function (root) {
  "use strict";
  const MAX_PLAYERS = 20;
  const ROOM_LIFETIME = 24 * 60 * 60 * 1000;
  const DRAW_DURATION = 7500;
  const DRAW_PRELUDE = 1500;
  const avatars = ["grapes", "melon", "watermelon", "tangerine", "lemon", "banana", "pineapple", "mango", "redapple", "greenapple", "pear", "peach", "cherries", "strawberry", "kiwi", "tomato", "blueberries", "coconut", "olive", "avocado"];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const cleanName = (value) => Array.from(String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, "")).slice(0, 12).join("");
  const cleanCode = (value) => String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);

  function randomInt(max) {
    if (!Number.isSafeInteger(max) || max < 1 || max > 0x100000000) throw new Error("随机数范围无效");
    const values = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / max) * max;
    do { root.crypto.getRandomValues(values); } while (values[0] >= limit);
    return values[0] % max;
  }

  function makeCode() {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    return Array.from({ length: 6 }, () => chars[randomInt(chars.length)]).join("");
  }

  function makeDerangement(participants) {
    const ids = participants.map((person) => person.id);
    if (ids.length < 2 || new Set(ids).size !== ids.length) throw new Error("至少需要两位不同的伙伴");
    let targets;
    // Fisher–Yates with rejection samples all valid derangements equally.
    do {
      targets = [...ids];
      for (let i = targets.length - 1; i > 0; i -= 1) {
        const j = randomInt(i + 1);
        [targets[i], targets[j]] = [targets[j], targets[i]];
      }
    } while (targets.some((id, index) => id === ids[index]));
    return Object.fromEntries(ids.map((id, index) => [id, targets[index]]));
  }

  function validAssignments(room) {
    const ids = room.participants.map((person) => person.id);
    const targets = ids.map((id) => room.assignments?.[id]);
    return ids.length >= 2 && Object.keys(room.assignments || {}).length === ids.length &&
      new Set(targets).size === ids.length && targets.every((id, i) => ids.includes(id) && id !== ids[i]);
  }

  function validRoom(room) {
    if (!room || !/^[A-Z0-9]{6}$/.test(room.code || "") || !["lobby", "drawing", "closed"].includes(room.status)) return false;
    if (!Number.isSafeInteger(room.revision) || room.revision < 1 || !Number.isFinite(room.createdAt)) return false;
    if (!Array.isArray(room.participants) || !room.participants.length || room.participants.length > MAX_PLAYERS) return false;
    const ids = new Set();
    const names = new Set();
    for (const person of room.participants) {
      if (!person || typeof person.id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(person.id) || !person.name || person.name !== cleanName(person.name)) return false;
      const name = person.name.toLocaleLowerCase();
      if (ids.has(person.id) || names.has(name)) return false;
      ids.add(person.id); names.add(name);
    }
    if (!ids.has(room.hostId)) return false;
    return room.status !== "drawing" || (Number.isFinite(room.drawStartedAt) && room.drawDuration === DRAW_DURATION && validAssignments(room));
  }

  function createRoom(code, hostId, name, now = Date.now()) {
    name = cleanName(name);
    if (!name) throw new Error("请先输入昵称～");
    return {
      code, hostId, status: "lobby", revision: 1, round: 1,
      participants: [{ id: hostId, name, avatar: avatars[0], joinedAt: now }],
      assignments: {}, drawStartedAt: null, drawDuration: DRAW_DURATION,
      createdAt: now, updatedAt: now
    };
  }

  function applyAction(room, action, actor, now = Date.now()) {
    if (!validRoom(room)) throw new Error("房间数据无效，请重新创建");
    if (now - room.createdAt > ROOM_LIFETIME || room.status === "closed") throw new Error("房间已结束，请重新开一局");
    if (!actor || !/^[a-zA-Z0-9-]{1,100}$/.test(actor)) throw new Error("身份无效，请刷新重试");
    const next = clone(room);
    const isHost = actor === room.hostId;
    const person = next.participants.find((item) => item.id === actor);
    switch (action?.type) {
      case "ping": return room;
      case "join": {
        if (person) return room;
        if (room.status !== "lobby") throw new Error("这轮已经开始，等下一轮再加入吧");
        if (next.participants.length >= MAX_PLAYERS) throw new Error("房间已满 20 人啦");
        const name = cleanName(action.name);
        if (!name) throw new Error("请先输入昵称～");
        if (next.participants.some((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("昵称已经有人用啦，换一个吧");
        const used = new Set(next.participants.map((item) => item.avatar));
        next.participants.push({ id: actor, name, avatar: avatars.find((id) => !used.has(id)) || avatars[0], joinedAt: now, ...(action.demo && isHost ? { demo: true } : {}) });
        break;
      }
      case "leave":
        if (isHost) next.status = "closed";
        else if (room.status === "lobby") next.participants = next.participants.filter((item) => item.id !== actor);
        else return room; // Keep the roster and assignments fixed during a round.
        break;
      case "start":
        if (!isHost) throw new Error("只有房主可以开始抽奖");
        if (room.status !== "lobby") return room; // Duplicate clicks never reroll a round.
        if (room.participants.length < 2) throw new Error("至少两位伙伴到场才能开始～");
        next.assignments = makeDerangement(next.participants);
        next.status = "drawing";
        next.drawStartedAt = now + DRAW_PRELUDE;
        break;
      case "restart":
        if (!isHost) throw new Error("等房主开始下一轮吧");
        if (room.status !== "drawing" || now < room.drawStartedAt + room.drawDuration) throw new Error("等这一轮揭晓后再开一轮吧");
        next.status = "lobby";
        next.round += 1;
        next.assignments = {};
        next.drawStartedAt = null;
        break;
      default: throw new Error("不支持的房间操作");
    }
    next.revision += 1;
    next.updatedAt = now;
    return next;
  }

  root.JoyCore = { MAX_PLAYERS, ROOM_LIFETIME, DRAW_DURATION, DRAW_PRELUDE, avatars, cleanName, cleanCode, randomInt, makeCode, makeDerangement, validAssignments, validRoom, createRoom, applyAction, clone };
  if (typeof module !== "undefined") module.exports = root.JoyCore;
})(globalThis);
