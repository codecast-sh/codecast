export {};
const socket = new WebSocket(`ws://127.0.0.1:${process.argv[2]}/`);
let next = 0;
socket.onopen = () => console.log("ready");
socket.onmessage = event => {
  if (typeof event.data !== "string") throw new Error("expected a text frame");
  const message = JSON.parse(event.data);
  if (message.sequence !== next++) throw new Error(`out-of-order or repeated frame ${message.sequence}, expected ${next - 1}`);
  if (next === Number(process.argv[3])) console.log("received");
};
socket.onclose = () => console.log("closed");
setInterval(() => {}, 1000);
