// 复制成 config.js 后，可将地址换成自己的 MQTT WebSocket 服务。
// 浏览器使用 HTTPS 部署时，必须使用 wss://。
window.JOY_SPIN_CONFIG = {
  mqttBroker: "wss://broker.emqx.io:8084/mqtt"
};
