const ws = new WebSocket("ws://localhost:3000");

ws.onopen = function () {
    ws.send("发送数据");
    setTimeout(() => {
        ws.send("发送数据2");
    }, 3000);
};

ws.onmessage = function (evt) {
    console.log(evt);
};

ws.onclose = function () {
};