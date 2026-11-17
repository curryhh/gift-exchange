/* The host serializes commands; guests never replace the shared room state. */
(function (root) {
  "use strict";
  const Core = root.JoyCore;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  class MqttRoom {
    constructor({ userId, brokerUrl, onConnection = () => {}, mqttClient = root.mqtt }) {
      this.userId = userId;
      this.brokerUrl = brokerUrl;
      this.mqtt = mqttClient;
      this.onConnection = onConnection;
      this.kind = "mqtt";
      this.clockOffset = 0;
      this.client = null;
      this.latest = null;
      this.listener = null;
      this.pending = new Map();
      this.processed = new Map();
      this.queue = Promise.resolve();
      this.isHost = false;
      this.hostOnline = false;
    }

    now() { return Date.now() + this.clockOffset; }
    topic(suffix) { return `joyspin/v3/${this.code}/${suffix}`; }
    notifyConnection() { this.onConnection(Boolean(this.client?.connected && (this.isHost || this.hostOnline)), this.kind); }

    async connect(code) {
      if (this.code === code && this.client?.connected) return;
      this.disconnect();
      if (!this.mqtt) throw new Error("联机组件未加载，请刷新页面重试");
      this.code = code;
      this.latest = null;
      this.hostOnline = false;
      this.isHost = false;
      this.processed.clear();
      // Only the host will publish to its own presence topic. Guest wills have a different topic.
      const client = this.mqtt.connect(this.brokerUrl, {
        clientId: `joy_${this.userId}_${Core.randomInt(0x100000000).toString(36)}`,
        clean: true, protocolVersion: 4, keepalive: 20,
        connectTimeout: 7000, reconnectPeriod: 1500, resubscribe: true,
        will: { topic: this.topic(`presence/${this.userId}`), payload: "offline", qos: 1, retain: true }
      });
      this.client = client;
      client.on("message", (topic, payload) => this.receive(topic, payload));
      client.on("offline", () => { if (this.client === client) this.notifyConnection(); });
      client.on("close", () => { if (this.client === client) this.notifyConnection(); });
      client.on("error", () => {}); // connect() reports initial failures; later errors show in the connection banner.
      let first = true;
      client.on("connect", () => {
        if (this.client !== client) return;
        if (!first && this.isHost && this.latest) {
          this.publish("state", this.latest).then(() => this.publish(`presence/${this.userId}`, "online")).catch(() => this.notifyConnection());
        }
        first = false;
        this.notifyConnection();
      });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error("连接超时，请检查网络后重试，或先体验演示")), 8500);
          const finish = (error) => {
            clearTimeout(timer);
            client.removeListener("connect", connected);
            client.removeListener("error", failed);
            error ? reject(error) : resolve();
          };
          const connected = () => finish();
          const failed = () => finish(new Error("暂时连不上房间服务，请稍后重试或体验演示"));
          client.once("connect", connected);
          client.once("error", failed);
        });
        await new Promise((resolve, reject) => client.subscribe([
          this.topic("state"), this.topic("command"), this.topic(`reply/${this.userId}`), this.topic("presence/+")
        ], { qos: 1 }, (error, granted) => error || granted?.some((item) => item.qos === 128) ? reject(error || new Error("服务拒绝了房间连接")) : resolve()));
      } catch (error) { this.disconnect(); throw error; }
    }

    async openHost(code, room) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await this.connect(code);
        // Receive any retained snapshot before deciding whether the code is free.
        await delay(650);
        if (this.latest) { code = Core.makeCode(); continue; }
        room.code = code;
        this.isHost = true;
        this.hostOnline = true;
        this.latest = Core.clone(room);
        await this.publish("state", room);
        await this.publish(`presence/${this.userId}`, "online");
        this.notifyConnection();
        return code;
      }
      this.disconnect();
      throw new Error("局号生成失败，请重试一次");
    }

    async read(code) {
      await this.connect(code);
      const started = Date.now();
      while (!this.latest && Date.now() - started < 3500) await delay(50);
      if (!this.latest) throw new Error("没有找到房间，请检查局号和网络");
      if (this.latest.status === "closed" || Date.now() - this.latest.createdAt > Core.ROOM_LIFETIME) throw new Error("房间已经结束，请重新创建");
      this.isHost = this.latest.hostId === this.userId;
      if (this.isHost) {
        this.hostOnline = true;
        await this.publish(`presence/${this.userId}`, "online");
      } else {
        await this.dispatch({ type: "ping" }); // A retained snapshot alone does not prove a host is still there.
      }
      this.notifyConnection();
      return Core.clone(this.latest);
    }

    subscribe(code, listener) {
      this.listener = listener;
      if (this.latest) listener(Core.clone(this.latest));
      return () => { if (this.listener === listener) this.listener = null; };
    }

    receive(topic, payload) {
      if (!this.code || payload.length > 100000) return;
      if (topic.startsWith(this.topic("presence/"))) {
        if (topic === this.topic(`presence/${this.latest?.hostId}`)) {
          this.hostOnline = payload.toString() === "online";
          this.notifyConnection();
        }
        return;
      }
      let message;
      try { message = JSON.parse(payload.toString()); } catch { return; }
      if (topic === this.topic("state")) {
        if (!Core.validRoom(message) || message.code !== this.code) return;
        if (this.latest && (message.hostId !== this.latest.hostId || message.createdAt !== this.latest.createdAt || message.revision <= this.latest.revision)) return;
        this.latest = message;
        this.listener?.(Core.clone(message));
      } else if (topic === this.topic("command") && this.isHost) {
        if (!message || typeof message.id !== "string" || message.id.length > 150 || !/^[a-zA-Z0-9-]{1,100}$/.test(message.actor || "")) return;
        this.enqueue(message).then((reply) => this.publish(`reply/${message.actor}`, reply, false)).catch(() => this.notifyConnection());
      } else if (topic === this.topic(`reply/${this.userId}`)) {
        const pending = this.pending.get(message?.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (!message.ok) { pending.reject(new Error(message.error || "操作失败，请重试")); return; }
        if (!Core.validRoom(message.state)) { pending.reject(new Error("收到无效房间数据，请刷新重试")); return; }
        this.clockOffset = message.hostNow - (Date.now() + pending.sentAt) / 2;
        this.hostOnline = true;
        if (!this.latest || message.state.revision >= this.latest.revision) this.latest = message.state;
        this.notifyConnection();
        pending.resolve(Core.clone(this.latest));
      }
    }

    enqueue(message) {
      const task = this.queue.then(async () => {
        const key = `${message.actor}:${message.id}`;
        if (this.processed.has(key)) return this.processed.get(key);
        let reply;
        try {
          const next = Core.applyAction(this.latest, message.action, message.actor);
          if (next !== this.latest) {
            // Wait for the broker acknowledgement before confirming a successful join or draw.
            await this.publish("state", next);
            this.latest = next;
            this.listener?.(Core.clone(next));
          }
          reply = { id: message.id, ok: true, state: this.latest, hostNow: Date.now() };
        } catch (error) { reply = { id: message.id, ok: false, error: error.message }; }
        this.processed.set(key, reply);
        if (this.processed.size > 200) this.processed.delete(this.processed.keys().next().value);
        return reply;
      });
      this.queue = task.catch(() => {});
      return task;
    }

    async dispatch(action) {
      if (!this.client?.connected) throw new Error("网络正在重连，请稍等再试");
      const id = `${this.userId}-${Core.randomInt(0x100000000).toString(36)}-${Date.now().toString(36)}`;
      const message = { id, actor: this.userId, action };
      if (this.isHost) {
        const reply = await this.enqueue(message);
        if (!reply.ok) throw new Error(reply.error);
        return Core.clone(reply.state);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("房主暂时没有响应，请让房主保持页面打开后重试")); }, 6000);
        this.pending.set(id, { resolve, reject, timer, sentAt: Date.now() });
        this.publish("command", message, false).catch((error) => {
          clearTimeout(timer); this.pending.delete(id); reject(error);
        });
      });
    }

    publish(suffix, value, retain = true) {
      const client = this.client;
      if (!client?.connected) return Promise.reject(new Error("联机已断开，请等待重连"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("同步超时，请重试")), 6000);
        client.publish(this.topic(suffix), typeof value === "string" ? value : JSON.stringify(value), { qos: 1, retain }, (error) => {
          clearTimeout(timer); error ? reject(error) : resolve();
        });
      });
    }

    disconnect() {
      if (this.client) {
        const client = this.client;
        if (client.connected && this.isHost) client.publish(this.topic(`presence/${this.userId}`), "offline", { qos: 1, retain: true });
        this.client = null;
        client.end(false);
      }
      this.isHost = false;
      this.listener = null;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("已离开房间")); }
      this.pending.clear();
    }
  }

  class DemoRoom {
    constructor({ userId, onConnection = () => {} }) { this.userId = userId; this.onConnection = onConnection; this.kind = "demo"; this.latest = null; this.listener = null; }
    now() { return Date.now(); }
    async openHost(code, room) { this.latest = Core.clone(room); this.save(); this.onConnection(true, "demo"); return code; }
    async read(code) { this.latest = JSON.parse(sessionStorage.getItem(`joyspin-demo:${code}`) || "null"); if (!Core.validRoom(this.latest)) throw new Error("演示房间已结束"); return Core.clone(this.latest); }
    subscribe(code, listener) { this.listener = listener; return () => { this.listener = null; }; }
    async dispatch(action) {
      if (action.type === "demo-add") {
        this.latest = Core.applyAction(this.latest, { type: "join", name: action.name }, `demo-${Core.randomInt(0x100000000).toString(36)}`);
      } else this.latest = Core.applyAction(this.latest, action, this.userId);
      this.save(); this.listener?.(Core.clone(this.latest)); return Core.clone(this.latest);
    }
    save() { sessionStorage.setItem(`joyspin-demo:${this.latest.code}`, JSON.stringify(this.latest)); }
    disconnect() { this.listener = null; }
  }
  root.JoySync = { MqttRoom, DemoRoom };
})(globalThis);
