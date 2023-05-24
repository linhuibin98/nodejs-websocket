import WebSocket from "./WebSocket.js";

const ws = new WebSocket({
    port: 3000
});

ws.on('data', (data) => {
    console.log('receive data:' + data);
    setInterval(() => {
        ws.send(data + ' ' + Date.now());
    }, 2000);
});

ws.on('close', (code, reason) => {
    console.log('close:', code, reason);
});
