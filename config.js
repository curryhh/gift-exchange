// 无须填写密钥，默认通过公共 MQTT WebSocket 服务同步房间。
// 自有 MQTT 服务可以替换下方地址。此文件会公开，不能填写秘密密钥。
window.JOY_SPIN_CONFIG = {
  mqttBroker: "wss://broker.emqx.io:8084/mqtt"
};
