import http from 'node:http';
import { EventEmitter } from 'node:events';
import crypto from 'crypto';

const OPCODES = {
    CONTINUE: 0,
    TEXT: 1,
    BINARY: 2,
    CLOSE: 8,
    PING: 9,
    PONG: 10,
};

class WebSocket extends EventEmitter {
    /**
     * @type {http.Server}
     */
    server;
    /**
     * @type {*}
     */
    socket;
    /**
     * @type {Buffer}
     */
    buffer;
    /**
     * @type {boolean}
     */
    closed;
    /**
     * Create websocket instance
     * @constructor
     * @param {Object} [options] - websocket options
     * @param {http.Server} [options.server] - http server
     * @param {number} [options.port] - server port number
     */
    constructor(options) {
        super();
        this.buffer = Buffer.alloc(0); // 初始化一个字节数据都没有的buffer
        this.closed = false;

        if (options.server) {
            this.server = options.server; // 使用了传递的 http server
        } else {
            this.server = http.createServer(); // 自己创建一个 web server
            this.server.listen(options.port || 3000)
        }

        this.server.on('upgrade', (req, socket, upgradeHead) => {
            this.socket = socket;
            socket.setKeepAlive(true);
            // 处理协议升级请求
            const resKey = hashWebSocketKey(req.headers['sec-websocket-key']); // 对浏览器生成的 key 进行加密
            // 构造响应头
            const resHeaders = [
                'HTTP/1.1 101 Switching Protocols',
                'Upgrade: websocket',
                'Connection: Upgrade',
                'Sec-WebSocket-Accept: ' + resKey,
                '',
                ''
            ].join('\r\n');

            socket.write(resHeaders); // 返回响应头部

            socket.on('data', (data) => {
                this.buffer = data; // 将客户端发送过来的帧数据保存到 buffer 变量中
                this.processData();
            });
            socket.on('close', (error) => {
                if (!this.closed) {
                    this.emit('close', 1006, "timeout");
                    this.closed = true;
                }
            });
        });
    }

    processData() {
        const buffer = this.buffer;
        /** 处理第一个字节 */
        const byte1 = buffer.readUInt8(0); // 读取 buffer 数据的前 8 bit并转换为十进制整数
        // 取第一个字节的最高位，看是 0 还是 1
        const str1 = byte1.toString(2); // 将第一个字节转换为二进制的字符串形式
        const FIN = str1[0];
        // 获取第一个字节的后四位，让第一个字节与 00001111 进行与运算，即可拿到后四位
        let opcode = byte1 & 0x0f; // 截取第一个字节的后 4 位，即 opcode 码, 等价于 (byte1 & 15)
        /** 处理第二个字节 */
        const byte2 = buffer.readUInt8(1); // 从第一个字节开始读取 8 位，即读取数据帧第二个字节数据
        const str2 = byte2.toString(2); // 将第二个字节转换为二进制的字符串形式
        const MASK = str2[0]; // 获取第二个字节的第一位，判断是否有掩码，客户端必须要有

        let payloadLength = parseInt(str2.substring(1), 2); // 获取第二个字节除第一位掩码之后的字符串并转换为整数
        let curByteIndex = 2; // 首先分析前两个字节

        if (payloadLength === 126) { // 说明 125 < 数据长度 < 65535（16 个位能描述的最大值，也就是 16 个 1 的时候)
            payloadLength = buffer.readUInt16BE(2); // 就用第三个字节及第四个字节表示数据的长度
            curByteIndex += 2; // 偏移两个字节
        } else if (payloadLength === 127) { // 说明数据长度已经大于 65535，16 个位也已经不足以描述数据长度了，就用第三到第十个字节这八个字节来描述数据长度
            const highBits = buffer.readUInt32BE(2); // 从第二个字节开始读取 32 位，即 4 个字节，表示后 8 个字节（64位）用于表示数据长度，其中高 4 字节是 0
            if (highBits !== 0) { // 前四个字节必须为 0，否则数据异常，需要关闭连接
                this.emit('close', 1009, ''); // 1009 关闭代码，说明数据太大； 协议里是支持 63 位长度，不过这里我们自己实现的话，只支持 32 位长度，防止数据过大；
            }
            payloadLength = buffer.readUInt32BE(6); // 获取八个字节中的后四个字节用于表示数据长度，即从第 6 到第 10 个字节，为真实存放的数据长度
            curByteIndex += 8;
        }

        let realData = null; // 保存真实数据对应字符串形式
        if (MASK) { // 如果存在 MASK 掩码，表示是客户端发送过来的数据，是加密过的数据，需要进行数据解码
            const maskKey = buffer.slice(curByteIndex, curByteIndex + 4); // 获取掩码数据, 其中前四个字节为掩码数据
            curByteIndex += 4; // 指针前移到真实数据段
            const payloadData = buffer.slice(curByteIndex, curByteIndex + payloadLength); // 获取真实数据对应的 Buffer
            realData = handleMask(maskKey, payloadData); // 解码真实数据
        } else {
            realData = buffer.slice(curByteIndex, curByteIndex + payloadLength);
        }

        let realDataBuffer = Buffer.from(realData);
        this.buffer = buffer.slice(curByteIndex + payloadLength); // 清除已处理的 buffer 数据
        if (FIN) { // 如果第一个字节的第一位为1,表示是消息的最后一个分片，即全部消息结束了(发送的数据比较少，一次发送完成)
            this.handleRealData(opcode, realDataBuffer);
        }
    }
    /**
     * 处理 payload 数据
     * @param {number} opcode 
     * @param {Buffer} realDataBuffer 
     */
    handleRealData(opcode, realDataBuffer) {
        switch (opcode) {
            case OPCODES.TEXT:
                this.emit('data', realDataBuffer.toString('utf8')); // 服务端 WebSocket 监听 data 事件即可拿到数据
                break;
            case OPCODES.BINARY:
                this.emit('data', realDataBuffer); // 二进制文件直接交付
                break;
            default:
                this.emit('close', 1002, 'unHandle opcode:' + opcode);
                break;
        }
    }
    /**
     * 根据发送数据的类型设置上对应的操作码，将数据转换为 Buffer 形式
     * @param {(string | Buffer)} data - 发送的数据
     */
    send(data) {
        let opcode;
        let buffer;
        if (Buffer.isBuffer(data)) { // 如果是二进制数据
            opcode = OPCODES.BINARY; // 操作码设置为二进制类型
            buffer = data;
        } else if (typeof data === "string") { // 如果是字符串
            opcode = OPCODES.TEXT; // 操作码设置为文本类型
            buffer = Buffer.from(data, 'utf8'); // 将字符串转换为 Buffer 数据
        } else {
            throw new Error('暂不支持发送的数据类型');
        }
        this.doSend(opcode, buffer);
    }
    /**
     * 开始发送数据
     * @param {number} opcode 
     * @param {Buffer} buffer 
     */
    doSend(opcode, buffer) {
        this.socket.write(encodeMessage(opcode, buffer)); // 编码后直接通过 socket 发送
    }
}

export default WebSocket;

/**
* 标准化 websocket 数据
* @param {number} opcode 
* @param {Buffer} payload 
*/
function encodeMessage(opcode, payload) {
    let buf;
    // 0x80 二进制为 10000000 | opcode 进行或运算就相当于是将首位置为 1
    let b1 = 0x80 | opcode; // 如果没有数据了将 FIN 置为1
    let b2; // 存放数据长度
    let length = payload.length;

    if (length < 126) {
        buf = Buffer.alloc(payload.length + 2 + 0); // 服务器返回的数据不需要加密，直接加 2 个字节即可
        b2 = length; // MASK 为 0，直接赋值为 length 值即可
        buf.writeUInt8(b1, 0); // 从第 0 个字节开始写入 8 位，即将 b1 写入到第一个字节中
        buf.writeUInt8(b2, 1); // 读 8―15 bit，将字节长度写入到第二个字节中
        payload.copy(buf, 2); // 复制数据,从 2 (第三)字节开始,将数据插入到第二个字节后面
    }
    return buf;
}

/**
 * @param {Buffer} maskBytes 
 * @param {Buffer} data 
 */
function handleMask(maskBytes, data) {
    const payload = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
        payload[i] = maskBytes[i % 4] ^ data[i];
    }
    return payload;
}

const MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // 固定的字符串

/**
 * 编码客户端 Sec-WebSocket-Key
 * @param {string} key - 客户端 Sec-WebSocket-Key
 * @returns 编码后的 Sec-WebSocket-Accept
 */
function hashWebSocketKey(key) {
    var sha1 = crypto.createHash('sha1'); // 拿到sha1算法
    sha1.update(key + MAGIC_STRING, 'ascii');
    return sha1.digest('base64');
};
