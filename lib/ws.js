// Minimal, dependency-free WebSocket server (RFC 6455).
// Supports text/binary messages, fragmentation, ping/pong and close.
// Good enough for local development; use the `ws` package for production.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1024 * 1024; // clients only send small JSON commands

class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    this.open = true;
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._teardown());
    socket.on('error', () => this._teardown());
  }

  get bufferedAmount() {
    return this.socket.writableLength;
  }

  sendText(str) {
    return this._send(0x1, Buffer.from(str, 'utf8'));
  }

  sendBinary(buf) {
    return this._send(0x2, buf);
  }

  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    this._send(0x8, p);
    this.socket.end();
    this._teardown();
  }

  _teardown() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _send(opcode, payload) {
    if (!this.open || this.socket.destroyed) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
    return true;
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.open) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return this.close(1009);
        len = Number(big);
        off = 10;
      }
      if (len > MAX_PAYLOAD) return this.close(1009);
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;

      let payload = Buffer.from(this.buf.subarray(off + maskLen, off + maskLen + len));
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(off + maskLen + len);
      this._onFrame(fin, opcode, payload);
    }
  }

  _onFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0x8: // close
        return this.close();
      case 0x9: // ping
        return this._send(0xa, payload);
      case 0xa: // pong
        return;
      case 0x1:
      case 0x2:
        if (fin) return this._emitMessage(opcode, payload);
        this.fragOpcode = opcode;
        this.fragments = [payload];
        return;
      case 0x0: // continuation
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          this._emitMessage(this.fragOpcode, full);
        }
        return;
      default:
        return this.close(1002);
    }
  }

  _emitMessage(opcode, payload) {
    this.emit('message', opcode === 0x1 ? payload.toString('utf8') : payload, opcode === 0x2);
  }
}

function handleUpgrade(req, socket, onConnection) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n')
  );
  socket.setNoDelay(true);
  onConnection(new WsConnection(socket));
}

module.exports = { handleUpgrade };
