var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "node_modules/ws/lib/constants.js"(exports2, module2) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module2.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
      kListener: Symbol("kListener"),
      kStatusCode: Symbol("status-code"),
      kWebSocket: Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "node_modules/ws/lib/buffer-util.js"(exports2, module2) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module2.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = require("bufferutil");
        module2.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module2.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "node_modules/ws/lib/limiter.js"(exports2, module2) {
    "use strict";
    var kDone = Symbol("kDone");
    var kRun = Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module2.exports = Limiter;
  }
});

// node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "node_modules/ws/lib/permessage-deflate.js"(exports2, module2) {
    "use strict";
    var zlib = require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = Symbol("permessage-deflate");
    var kTotalLength = Symbol("total-length");
    var kCallback = Symbol("callback");
    var kBuffers = Symbol("buffers");
    var kError = Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module2.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "node_modules/ws/lib/validation.js"(exports2, module2) {
    "use strict";
    var { isUtf8 } = require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module2.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module2.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = require("utf-8-validate");
        module2.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "node_modules/ws/lib/receiver.js"(exports2, module2) {
    "use strict";
    var { Writable } = require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          if (this._maxFragments > 0 && this._fragments.length >= this._maxFragments) {
            const error = this.createError(
              RangeError,
              "Too many message fragments",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            );
            cb(error);
            return;
          }
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            if (this._maxFragments > 0 && this._fragments.length >= this._maxFragments) {
              const error = this.createError(
                RangeError,
                "Too many message fragments",
                false,
                1008,
                "WS_ERR_TOO_MANY_BUFFERED_PARTS"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module2.exports = Receiver2;
  }
});

// node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "node_modules/ws/lib/sender.js"(exports2, module2) {
    "use strict";
    var { Duplex } = require("stream");
    var { randomFillSync } = require("crypto");
    var {
      types: { isUint8Array }
    } = require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module2.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "node_modules/ws/lib/event-target.js"(exports2, module2) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = Symbol("kCode");
    var kData = Symbol("kData");
    var kError = Symbol("kError");
    var kMessage = Symbol("kMessage");
    var kReason = Symbol("kReason");
    var kTarget = Symbol("kTarget");
    var kType = Symbol("kType");
    var kWasClean = Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module2.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "node_modules/ws/lib/extension.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module2.exports = { format, parse };
  }
});

// node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "node_modules/ws/lib/websocket.js"(exports2, module2) {
    "use strict";
    var EventEmitter2 = require("events");
    var https = require("https");
    var http = require("http");
    var net = require("net");
    var tls = require("tls");
    var { randomBytes, createHash } = require("crypto");
    var { Duplex, Readable } = require("stream");
    var { URL } = require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter2 {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module2.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 1024 * 1024,
        maxFragments: 128 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "node_modules/ws/lib/stream.js"(exports2, module2) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module2.exports = createWebSocketStream2;
  }
});

// node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "node_modules/ws/lib/subprotocol.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module2.exports = { parse };
  }
});

// node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "node_modules/ws/lib/websocket-server.js"(exports2, module2) {
    "use strict";
    var EventEmitter2 = require("events");
    var http = require("http");
    var { Duplex } = require("stream");
    var { createHash } = require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter2 {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=1048576] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=131072] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 1024 * 1024,
          maxFragments: 128 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module2.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// src/index.ts
var import_events = require("events");

// src/mpUtil.ts
function safeGet(mp3, formId, prop, fallback = void 0) {
  try {
    const v = mp3.get(formId, prop);
    return v === void 0 || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}
function safeSet(mp3, formId, prop, value) {
  try {
    mp3.set(formId, prop, value);
  } catch {
  }
}
function sendPacketToActor(mp3, actorId, payload) {
  try {
    const userId = mp3.getUserByActor(actorId);
    if (userId === void 0 || userId === null || userId < 0) return;
    if (!mp3.isConnected(userId)) return;
    mp3.sendCustomPacket(userId, JSON.stringify(payload));
  } catch {
  }
}
function notifyActor(mp3, actorId, text) {
  sendPacketToActor(mp3, actorId, { customPacketType: "notification", text });
}
var g = globalThis;
function newGeneration() {
  g.__alduinakGen = (g.__alduinakGen || 0) + 1;
  return g.__alduinakGen;
}
function currentGeneration() {
  return g.__alduinakGen || 0;
}
function generationLive(gen2) {
  return g.__alduinakGen === gen2;
}

// src/mpFacade.ts
var EVENTS = ["customPacket", "connect", "disconnect"];
var g2 = globalThis;
function makeMpFacade(mp3) {
  g2.__alduinakHandlers = { customPacket: [], connect: [], disconnect: [] };
  if (!g2.__alduinakDispatcherBound) {
    g2.__alduinakDispatcherBound = true;
    for (const ev of EVENTS) {
      mp3.on(ev, (...args) => {
        const handlers = g2.__alduinakHandlers && g2.__alduinakHandlers[ev] || [];
        for (const h of handlers) {
          try {
            h(...args);
          } catch (err) {
            console.error(`[alduinak] ${ev} handler error: ` + (err && err.message));
          }
        }
      });
    }
  }
  return new Proxy(mp3, {
    get(target, prop) {
      if (prop === "on") {
        return (event, fn) => {
          if (EVENTS.includes(event)) g2.__alduinakHandlers[event].push(fn);
          else target.on(event, fn);
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    }
  });
}

// src/store.ts
var CACHE_MS = 1e3;
var PlayerStore = class {
  constructor(mp3) {
    this.mp = mp3;
  }
  cache = [];
  cachedAt = 0;
  refresh() {
    const now = Date.now();
    if (now - this.cachedAt < CACHE_MS) return;
    const entries = [];
    let ids = [];
    try {
      ids = this.mp.get(0, "onlinePlayers") || [];
    } catch {
      ids = [];
    }
    for (const actorId of ids) {
      let userId = -1;
      let name = "";
      try {
        userId = this.mp.getUserByActor(actorId);
      } catch {
        userId = -1;
      }
      try {
        name = this.mp.getActorName(actorId) || "";
      } catch {
        name = "";
      }
      entries.push({
        actorId,
        userId: typeof userId === "number" ? userId : -1,
        name,
        profileId: Number(safeGet(this.mp, actorId, "profileId", -1))
      });
    }
    this.cache = entries;
    this.cachedAt = now;
  }
  getAll() {
    this.refresh();
    return this.cache;
  }
  // Accepts an actor form id or a networking userId; the id spaces never
  // collide (actor ids are 0xff000000+ dynamic forms, user ids small ints).
  get(id) {
    this.refresh();
    return this.cache.find((p) => p.actorId === id || p.userId === id) || null;
  }
  // Name resolution for PMs and console commands: an exact (case-insensitive)
  // match wins; otherwise a prefix match only when it is UNIQUE, so a typo or
  // an offline exact-name target can never silently pick the wrong player.
  findByName(query) {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return { match: null, candidates: [] };
    this.refresh();
    const exact = this.cache.find((p) => p.name.toLowerCase() === q);
    if (exact) return { match: exact, candidates: [exact] };
    const candidates = this.cache.filter((p) => p.name.toLowerCase().startsWith(q));
    return { match: candidates.length === 1 ? candidates[0] : null, candidates };
  }
  byName(name) {
    return this.findByName(name).match;
  }
  byUserId(userId) {
    this.refresh();
    return this.cache.find((p) => p.userId === userId) || null;
  }
};

// src/systems/chat.ts
var RANGE = { whisper: 150, low: 700, say: 2e3, wide: 4e3, shout: 1e4 };
var SAY_RANGE = RANGE.say;
var MAX_LEN = 2e3;
var COLOR = {
  white: "fafafa",
  emote: "c2a3da",
  ooc: "3896f3",
  shout: "772021",
  system: "eda841",
  admin: "ce3131",
  roll: "eda841"
};
var g3 = globalThis;
var mp = null;
var store = null;
var adminOverrides = /* @__PURE__ */ new Set();
function nextNonce() {
  g3.__alduinakChatNonce = (g3.__alduinakChatNonce || 0) % 1e6 + 1;
  return g3.__alduinakChatNonce;
}
function deliver(actorId, line) {
  safeSet(mp, actorId, "ff_chatMsg", `${nextNonce()}${line}`);
}
function sanitize(text) {
  return String(text || "").replace(/[\u0000-\u001f]/g, " ").replace(/#\{/g, "# {").trim().slice(0, MAX_LEN);
}
function sanitizeName(name) {
  return sanitize(String(name || "")).replace(/\|/g, "/").replace(/\[\[/g, "[ [").slice(0, 60) || "Unknown";
}
function color(hex, text) {
  return `#{${hex}}${text}`;
}
function recipientsNear(senderActorId, range) {
  const sender = store.get(senderActorId);
  if (!sender) return null;
  let pos;
  let cell;
  try {
    pos = mp.getActorPos(senderActorId);
    cell = mp.getActorCellOrWorld(senderActorId);
  } catch {
    return null;
  }
  const inRange = [];
  for (const p of store.getAll()) {
    try {
      if (mp.getActorCellOrWorld(p.actorId) !== cell) continue;
      const pp = mp.getActorPos(p.actorId);
      const dx = pp[0] - pos[0], dy = pp[1] - pos[1], dz = pp[2] - pos[2];
      if (dx * dx + dy * dy + dz * dz <= range * range) inRange.push(p);
    } catch {
    }
  }
  return { inRange, sender };
}
function sendNear(senderActorId, range, line, includeSender) {
  const r = recipientsNear(senderActorId, range);
  if (!r) return;
  for (const p of r.inRange) {
    if (!includeSender && p.actorId === senderActorId) continue;
    deliver(p.actorId, line);
  }
}
function permissionsAllowAdmin(perms) {
  if (!Array.isArray(perms)) return false;
  return perms.some((p) => p === "admin.*" || typeof p === "string" && /^admin\./.test(p));
}
function isAdminActor(actorId) {
  const entry = store.get(actorId);
  if (entry && adminOverrides.has(entry.profileId)) return true;
  const settings = (() => {
    try {
      return mp.getServerSettings() || {};
    } catch {
      return {};
    }
  })();
  const listed = Array.isArray(settings.adminProfileIds) ? settings.adminProfileIds : [];
  if (entry && listed.includes(entry.profileId)) return true;
  const access = safeGet(mp, actorId, "private.skympAccess", null);
  return !!(access && permissionsAllowAdmin(access.permissions));
}
function refreshAdminFlags() {
  for (const p of store.getAll()) {
    const want = isAdminActor(p.actorId);
    if (safeGet(mp, p.actorId, "isAdmin", false) !== want) {
      safeSet(mp, p.actorId, "isAdmin", want);
    }
  }
}
function broadcastServer(text) {
  const line = `[[S]]${color(COLOR.system, sanitize(text))}`;
  for (const p of store.getAll()) deliver(p.actorId, line);
}
function broadcastAdmins(line, excludeActorId) {
  for (const p of store.getAll()) {
    if (p.actorId === excludeActorId) continue;
    if (isAdminActor(p.actorId)) deliver(p.actorId, line);
  }
}
var SAY_VERB = { say: "says", low: "says quietly", whisper: "whispers", wide: "says loudly" };
function handleSay(senderActorId, name, kind, body) {
  sendNear(senderActorId, RANGE[kind], `${name} ${SAY_VERB[kind]}: "${body}"`, false);
}
function handleEmote(senderActorId, name, kind, body) {
  let line;
  if (kind === "me") line = color(COLOR.emote, `${name} ${body}`);
  else if (kind === "my") line = color(COLOR.emote, `${name}'s ${body}`);
  else line = color(COLOR.emote, body);
  sendNear(senderActorId, SAY_RANGE, line, false);
}
function handleOoc(senderActorId, name, body) {
  sendNear(senderActorId, SAY_RANGE, color(COLOR.ooc, `${name} (OOC): "${body}"`), false);
}
function handleShout(senderActorId, name, body) {
  sendNear(senderActorId, RANGE.shout, color(COLOR.shout, `${name} shouts: "${body}"`), false);
}
function handleSystem(senderActorId, body) {
  if (!isAdminActor(senderActorId)) {
    notifyActor(mp, senderActorId, "You do not have permission to use /system.");
    return;
  }
  const line = `[[S]]${color(COLOR.system, body)}`;
  for (const p of store.getAll()) {
    if (p.actorId !== senderActorId) deliver(p.actorId, line);
  }
}
function handleAdminChat(senderActorId, name, body) {
  if (!isAdminActor(senderActorId)) {
    notifyActor(mp, senderActorId, "You do not have permission to use the admin channel.");
    return;
  }
  broadcastAdmins(`[[A]]${color(COLOR.admin, `[Staff] ${name}: ${body}`)}`);
}
function handlePm(senderActorId, senderName, args) {
  const words = args.split(/\s+/).filter((w) => w.length);
  if (words.length < 2) {
    notifyActor(mp, senderActorId, "Usage: /pm <name> <message>");
    return;
  }
  let target = null;
  let msgStart = 1;
  for (let n = Math.min(4, words.length - 1); n >= 1 && !target; n--) {
    const r = store.findByName(words.slice(0, n).join(" "));
    if (r.match && r.candidates.length === 1 && r.match.name.toLowerCase() === words.slice(0, n).join(" ").toLowerCase()) {
      target = r.match;
      msgStart = n;
    }
  }
  if (!target) {
    const r = store.findByName(words[0]);
    if (r.candidates.length > 1) {
      notifyActor(mp, senderActorId, `"${words[0]}" matches several players: ${r.candidates.map((c) => c.name).join(", ")}. Be more specific.`);
      return;
    }
    target = r.match;
  }
  if (!target || target.actorId === senderActorId) {
    notifyActor(mp, senderActorId, `No online player found matching "${words[0]}".`);
    return;
  }
  const text = sanitize(words.slice(msgStart).join(" "));
  if (!text) {
    notifyActor(mp, senderActorId, "Usage: /pm <name> <message>");
    return;
  }
  let from = sanitizeName(senderName);
  if (from.toLowerCase() === "system" || from.toLowerCase() === "server") from = `${from} (player)`;
  deliver(target.actorId, `[[PM]]${from}|${text}`);
}
function handleRoll(senderActorId, name, args) {
  const m = (args || "1d100").trim().match(/^(\d{0,2})d(\d{1,4})$/i);
  if (!m) {
    notifyActor(mp, senderActorId, "Usage: /roll [NdM], e.g. /roll 1d20");
    return;
  }
  const n = Math.min(Math.max(parseInt(m[1] || "1", 10) || 1, 1), 10);
  const sides = Math.min(Math.max(parseInt(m[2], 10) || 2, 2), 1e3);
  const rolls = [];
  for (let i = 0; i < n; i++) rolls.push(1 + Math.floor(Math.random() * sides));
  const total = rolls.reduce((a, b) => a + b, 0);
  const detail = n > 1 ? ` (${rolls.join(" + ")})` : "";
  sendNear(senderActorId, SAY_RANGE, color(COLOR.roll, `${name} rolls ${n}d${sides}: ${total}${detail}`), true);
}
function onChatPacket(userId, text) {
  let actorId = 0;
  try {
    actorId = mp.getUserActor(userId);
  } catch {
    return;
  }
  if (!actorId) return;
  const entry = store.get(actorId);
  const name = sanitizeName(entry && entry.name || "Unknown");
  const msg = sanitize(text);
  if (!msg) return;
  if (!msg.startsWith("/")) return handleSay(actorId, name, "say", msg);
  const m = msg.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (!m) return;
  const cmd = m[1].toLowerCase();
  const args = m[2].trim();
  if ((cmd === "low" || cmd === "whisper" || cmd === "wide") && args) return handleSay(actorId, name, cmd, args);
  if ((cmd === "me" || cmd === "my" || cmd === "do") && args) return handleEmote(actorId, name, cmd, args);
  if (cmd === "looc" && args) return handleOoc(actorId, name, args);
  if (cmd === "shout" && args) return handleShout(actorId, name, args);
  if (cmd === "system" && args) return handleSystem(actorId, args);
  if (cmd === "admin" && args) return handleAdminChat(actorId, name, args);
  if (cmd === "pm" || cmd === "dm" || cmd === "to" || cmd === "too") return handlePm(actorId, name, args);
  if (cmd === "roll") return handleRoll(actorId, name, args);
  if (cmd === "help") {
    notifyActor(mp, actorId, "Chat: plain text talks nearby. /low /whisper /wide change range, /me /my /do emote, /looc out of character, /shout carries, /pm <name> <msg>, /roll [NdM].");
    return;
  }
  notifyActor(mp, actorId, `Unknown or unavailable command: /${cmd}`);
}
function init(mpIn, storeIn, admins, gen2) {
  mp = mpIn;
  store = storeIn;
  adminOverrides = admins;
  console.log("[chat] Initializing");
  const opts = { isVisibleByOwner: true, isVisibleByNeighbors: false, updateOwner: "", updateNeighbor: "" };
  try {
    mp.makeProperty("ff_chatMsg", opts);
  } catch (err) {
    console.error("[chat] makeProperty ff_chatMsg: " + (err && err.message));
  }
  try {
    mp.makeProperty("isAdmin", opts);
  } catch (err) {
    console.error("[chat] makeProperty isAdmin: " + (err && err.message));
  }
  mp.on("customPacket", (userId, rawContent) => {
    let content;
    try {
      content = JSON.parse(rawContent);
    } catch {
      return;
    }
    if (!content || content.type !== "cef::chat:send") return;
    try {
      onChatPacket(userId, String(content.data ?? ""));
    } catch (err) {
      console.error("[chat] handler error: " + (err && err.message));
    }
  });
  const adminLoop = () => {
    const t = setTimeout(() => {
      if (!generationLive(gen2)) return;
      try {
        refreshAdminFlags();
      } catch {
      }
      adminLoop();
    }, 5e3);
    if (t && typeof t.unref === "function") t.unref();
  };
  adminLoop();
  console.log("[chat] Started");
}

// src/systems/respawn.ts
var BLEEDOUT_SECONDS = 60;
var WAKE_HEALTH = 0.01;
var FULL_HEALTH = 1;
var REGEN_INTERVAL_MS = 8 * 60 * 60 * 1e3;
var REGEN_NATURAL = 0.01;
var REGEN_HEALER = 0.05;
var ARMED_KILLER_TTL_MS = 60 * 60 * 1e3;
var NEVER_RESPAWN = 1e12;
var TICK_MS = 30 * 1e3;
var HEALTH_EPSILON = 5e-3;
var SOLITUDE = { cellOrWorldDesc: "16a02:Skyrim.esm", pos: [1676.93, 1571.19, 0], rot: [0, 0, 15.75] };
var MARKARTH = { cellOrWorldDesc: "16df3:Skyrim.esm", pos: [-1870.36, 356.02, 156.24], rot: [0, 0, 279.5] };
var FALKREATH = { cellOrWorldDesc: "13a71:Skyrim.esm", pos: [-1728, -391, 0], rot: [0, 0, 180] };
var WHITERUN = { cellOrWorldDesc: "165a7:Skyrim.esm", pos: [223.24, 248.85, 54], rot: [0, 0, 0] };
var WINDHELM = { cellOrWorldDesc: "16785:Skyrim.esm", pos: [0, -2800, 64.35], rot: [0, 0, 0] };
var RIFTEN = { cellOrWorldDesc: "16bd7:Skyrim.esm", pos: [-1414.34, 208.64, 64], rot: [0, 0, 15.75] };
var ANCHORS = [
  { name: "Solitude", x: -68173.96, y: 103311.75, dest: SOLITUDE },
  { name: "Markarth", x: -169535.31, y: 5386.96, dest: MARKARTH },
  { name: "Falkreath", x: -34020.39, y: -89435.8, dest: FALKREATH },
  { name: "Whiterun", x: 16476.68, y: -9595.68, dest: WHITERUN },
  { name: "Windhelm", x: 135019.44, y: 33731.66, dest: WINDHELM },
  { name: "Riften", x: 174274.64, y: -91459.67, dest: RIFTEN },
  { name: "Winterhold", x: 114050.01, y: 94006.28, dest: WINDHELM },
  { name: "Dawnstar", x: 26328.23, y: 101092.58, dest: WINDHELM },
  { name: "Morthal", x: -39547.51, y: 70770.92, dest: SOLITUDE },
  { name: "Riverwood", x: 19233.25, y: -46721.73, dest: WHITERUN },
  { name: "Rorikstead", x: -78931.07, y: 2789.23, dest: WHITERUN },
  { name: "Ivarstead", x: 78291.95, y: -67062.64, dest: RIFTEN },
  { name: "Dragon's Bridge", x: -100811.45, y: 80907.16, dest: SOLITUDE },
  { name: "High Hrothgar", x: 56897.66, y: -31974.11, dest: WHITERUN }
];
var WORLDSPACE_OVERRIDES = [
  { match: (d) => d.endsWith(":Dragonborn.esm"), name: "Windhelm", dest: WINDHELM },
  { match: (d) => d === "bb5:Dawnguard.esm", name: "Markarth", dest: MARKARTH },
  { match: (d) => d === "1408:Dawnguard.esm", name: "Solitude", dest: SOLITUDE }
];
function nearestTemple(pos) {
  const px = Array.isArray(pos) ? pos[0] : 0;
  const py = Array.isArray(pos) ? pos[1] : 0;
  let best = ANCHORS[0], bestSq = Infinity;
  for (const t of ANCHORS) {
    const dx = t.x - px, dy = t.y - py, sq = dx * dx + dy * dy;
    if (sq < bestSq) {
      bestSq = sq;
      best = t;
    }
  }
  return best;
}
function pickTemple(worldDesc, pos) {
  if (typeof worldDesc === "string") {
    for (const o of WORLDSPACE_OVERRIDES) {
      if (o.match(worldDesc)) return o;
    }
    for (const t of ANCHORS) {
      if (t.dest.cellOrWorldDesc === worldDesc) return t;
    }
  }
  return nearestTemple(pos);
}
function isPlayer(store3, actorId) {
  return store3.getAll().some((p) => p.actorId === actorId);
}
function send(mp3, actorId, payload) {
  try {
    const userId = mp3.getUserByActor(actorId);
    if (userId === void 0 || userId === null || userId < 0) return;
    if (!mp3.isConnected(userId)) return;
    mp3.sendCustomPacket(userId, JSON.stringify(payload));
  } catch (e) {
  }
}
function showDeathScreen(mp3, actorId, seconds) {
  send(mp3, actorId, { customPacketType: "deathScreen", show: true, seconds });
}
function hideDeathScreen(mp3, actorId) {
  send(mp3, actorId, { customPacketType: "deathScreen", hide: true });
}
function setHealth(mp3, actorId, health) {
  safeSet(mp3, actorId, "percentages", { health, magicka: 1, stamina: 1 });
}
function setHealthPreserving(mp3, actorId, health) {
  const cur = safeGet(mp3, actorId, "percentages", null);
  const magicka = cur && typeof cur.magicka === "number" ? cur.magicka : 1;
  const stamina = cur && typeof cur.stamina === "number" ? cur.stamina : 1;
  safeSet(mp3, actorId, "percentages", { health, magicka, stamina });
}
function clearArmedKiller(mp3, actorId) {
  safeSet(mp3, actorId, "private.resurrectArmedKiller", 0);
  safeSet(mp3, actorId, "private.resurrectArmedUntilMs", 0);
}
function onPlayerDeath(mp3, store3, dyingActorId, killerId) {
  if (!isPlayer(store3, dyingActorId)) return;
  if (safeGet(mp3, dyingActorId, "private.permaDead", false) === true) {
    safeSet(mp3, dyingActorId, "spawnDelay", NEVER_RESPAWN);
    return;
  }
  const armed = safeGet(mp3, dyingActorId, "private.resurrectArmedKiller", 0);
  const armedUntil = safeGet(mp3, dyingActorId, "private.resurrectArmedUntilMs", 0);
  if (killerId && armed === killerId && Date.now() < armedUntil) {
    console.log("[respawn] " + dyingActorId.toString(16) + " died again to armed killer " + killerId.toString(16) + " within the arming window \u2014 forcing permadeath");
    doPermaDeath(mp3, dyingActorId, "died again to the same player after a resurrect");
    return;
  }
  if (armed) clearArmedKiller(mp3, dyingActorId);
  const pos = safeGet(mp3, dyingActorId, "pos", null);
  const world = safeGet(mp3, dyingActorId, "worldOrCellDesc", null);
  const temple = pickTemple(world, pos);
  safeSet(mp3, dyingActorId, "spawnPoint", temple.dest);
  safeSet(mp3, dyingActorId, "spawnDelay", BLEEDOUT_SECONDS);
  safeSet(mp3, dyingActorId, "respawnPercentages", { health: WAKE_HEALTH, magicka: 1, stamina: 1 });
  safeSet(mp3, dyingActorId, "private.deathKiller", killerId || 0);
  safeSet(mp3, dyingActorId, "private.deathPos", Array.isArray(pos) ? pos : [0, 0, 0]);
  safeSet(mp3, dyingActorId, "private.deathWorld", typeof world === "string" ? world : "");
  safeSet(mp3, dyingActorId, "private.injured", true);
  safeSet(mp3, dyingActorId, "private.injuredHealth", WAKE_HEALTH);
  safeSet(mp3, dyingActorId, "private.regenLastMs", Date.now());
  safeSet(mp3, dyingActorId, "private.regenRate", REGEN_NATURAL);
  safeSet(mp3, dyingActorId, "private.deathChoicePending", true);
  showDeathScreen(mp3, dyingActorId, BLEEDOUT_SECONDS);
  console.log("[respawn] " + dyingActorId.toString(16) + " down \u2014 death screen shown, will wake at " + temple.name + " (1 HP)");
}
function onPlayerRespawn(mp3, store3, actorId) {
  if (!isPlayer(store3, actorId)) return;
  if (safeGet(mp3, actorId, "private.permaDead", false) === true) {
    safeSet(mp3, actorId, "spawnDelay", NEVER_RESPAWN);
    return false;
  }
  safeSet(mp3, actorId, "private.deathChoicePending", false);
  hideDeathScreen(mp3, actorId);
}
function onDeathChoice(mp3, store3, userId, choice) {
  const actorId = mp3.getUserActor(userId);
  if (!actorId || !isPlayer(store3, actorId)) return;
  if (choice !== "permadeath" && choice !== "resurrect" && choice !== "temple") return;
  if (safeGet(mp3, actorId, "isDead", false) !== true) return;
  if (safeGet(mp3, actorId, "private.deathChoicePending", false) !== true) return;
  safeSet(mp3, actorId, "private.deathChoicePending", false);
  if (choice === "permadeath") {
    doPermaDeath(mp3, actorId, "chose permanent death");
  } else if (choice === "resurrect") {
    doResurrectHere(mp3, store3, actorId);
  } else if (choice === "temple") {
    doTempleFullHealth(mp3, actorId);
  }
}
function doPermaDeath(mp3, actorId, reason) {
  safeSet(mp3, actorId, "private.permaDead", true);
  safeSet(mp3, actorId, "private.injured", false);
  safeSet(mp3, actorId, "private.deathChoicePending", false);
  clearArmedKiller(mp3, actorId);
  safeSet(mp3, actorId, "spawnDelay", NEVER_RESPAWN);
  safeSet(mp3, actorId, "isDead", true);
  hideDeathScreen(mp3, actorId);
  console.log("[respawn] PERMADEATH " + actorId.toString(16) + " \u2014 " + reason + " (respawn blocked, slot locked, body remains)");
}
function doResurrectHere(mp3, store3, actorId) {
  const killer = safeGet(mp3, actorId, "private.deathKiller", 0);
  const count = safeGet(mp3, actorId, "private.resurrectCount", 0) + 1;
  safeSet(mp3, actorId, "isDead", false);
  setHealth(mp3, actorId, FULL_HEALTH);
  safeSet(mp3, actorId, "private.injured", false);
  safeSet(mp3, actorId, "respawnPercentages", { health: FULL_HEALTH, magicka: 1, stamina: 1 });
  safeSet(mp3, actorId, "private.resurrectCount", count);
  safeSet(mp3, actorId, "private.resurrectArmedKiller", killer);
  safeSet(mp3, actorId, "private.resurrectArmedUntilMs", Date.now() + ARMED_KILLER_TTL_MS);
  hideDeathScreen(mp3, actorId);
  const name = (store3.getAll().find((p) => p.actorId === actorId) || {}).name || actorId.toString(16);
  console.log("[respawn][AUDIT] RESURRECT-HERE by " + name + " (" + actorId.toString(16) + "), use #" + count + ", armed vs killer " + (killer ? killer.toString(16) : "none") + " for 1h");
}
function doTempleFullHealth(mp3, actorId) {
  const deathPos = safeGet(mp3, actorId, "private.deathPos", null);
  const deathWorld = safeGet(mp3, actorId, "private.deathWorld", null);
  const temple = pickTemple(deathWorld, deathPos);
  safeSet(mp3, actorId, "isDead", false);
  safeSet(mp3, actorId, "locationalData", temple.dest);
  setHealth(mp3, actorId, FULL_HEALTH);
  safeSet(mp3, actorId, "private.injured", false);
  safeSet(mp3, actorId, "respawnPercentages", { health: FULL_HEALTH, magicka: 1, stamina: 1 });
  safeSet(mp3, actorId, "private.noReturnUntilMs", 0);
  console.log("[respawn] " + actorId.toString(16) + " chose Temple w/ Full Health -> " + temple.name);
  hideDeathScreen(mp3, actorId);
}
function tick(mp3, store3) {
  const now = Date.now();
  for (const p of store3.getAll()) {
    const actorId = p.actorId;
    if (!actorId) continue;
    if (safeGet(mp3, actorId, "private.injured", false) === true) {
      const last = safeGet(mp3, actorId, "private.regenLastMs", now);
      const rate = safeGet(mp3, actorId, "private.regenRate", REGEN_NATURAL);
      let ceiling = safeGet(mp3, actorId, "private.injuredHealth", WAKE_HEALTH);
      const intervals = Math.floor((now - last) / REGEN_INTERVAL_MS);
      if (intervals > 0) {
        ceiling = Math.min(FULL_HEALTH, ceiling + intervals * rate);
        safeSet(mp3, actorId, "private.injuredHealth", ceiling);
        safeSet(mp3, actorId, "private.regenLastMs", last + intervals * REGEN_INTERVAL_MS);
      }
      if (ceiling >= FULL_HEALTH) {
        safeSet(mp3, actorId, "private.injured", false);
        safeSet(mp3, actorId, "respawnPercentages", { health: FULL_HEALTH, magicka: 1, stamina: 1 });
      } else {
        const cur = safeGet(mp3, actorId, "percentages", null);
        const curHealth = cur && typeof cur.health === "number" ? cur.health : ceiling;
        if (Math.abs(curHealth - ceiling) > HEALTH_EPSILON) {
          setHealthPreserving(mp3, actorId, ceiling);
        }
      }
    }
    const until = safeGet(mp3, actorId, "private.noReturnUntilMs", 0);
    if (until) {
      safeSet(mp3, actorId, "private.noReturnUntilMs", 0);
    }
  }
}
function applyHealerBoost(mp3, actorId) {
  safeSet(mp3, actorId, "private.regenRate", REGEN_HEALER);
}
function init2(mp3, store3, bus2) {
  console.log("[respawn] Initializing");
  mp3.onDeath = (dyingActorId, killerId) => {
    try {
      onPlayerDeath(mp3, store3, dyingActorId, killerId || 0);
    } catch (err) {
      console.error("[respawn] onDeath error: " + (err && err.message));
    }
  };
  mp3.onRespawn = (actorId) => {
    try {
      return onPlayerRespawn(mp3, store3, actorId);
    } catch (err) {
      console.error("[respawn] onRespawn error: " + (err && err.message));
    }
  };
  mp3.on("customPacket", (userId, content) => {
    let c;
    try {
      c = JSON.parse(content);
    } catch (e) {
      return;
    }
    if (c && c.customPacketType === "deathChoice") {
      try {
        onDeathChoice(mp3, store3, userId, String(c.choice));
      } catch (err) {
        console.error("[respawn] deathChoice error: " + (err && err.message));
      }
    }
  });
  if (bus2 && typeof bus2.on === "function") {
    bus2.on("playerRisen", (e) => {
      try {
        const player = store3.get ? store3.get(e.playerId) : null;
        const actorId = player && player.actorId;
        if (actorId && safeGet(mp3, actorId, "private.injured", false) === true) {
          applyHealerBoost(mp3, actorId);
          console.log("[respawn] " + actorId.toString(16) + " was tended \u2014 recovery boosted to healer rate");
        }
      } catch (err) {
        console.error("[respawn] playerRisen error: " + (err && err.message));
      }
    });
  }
  const gen2 = currentGeneration();
  const loop = () => {
    const t = setTimeout(() => {
      if (!generationLive(gen2)) return;
      try {
        tick(mp3, store3);
      } catch (e) {
      }
      loop();
    }, TICK_MS);
    if (t && typeof t.unref === "function") t.unref();
  };
  loop();
  console.log("[respawn] Started");
}

// src/systems/trade.ts
var MAX_TRADE_DISTANCE = 1024;
var INVITE_TTL_MS = 60 * 1e3;
var INVITE_COOLDOWN_MS = 30 * 1e3;
var sessions = /* @__PURE__ */ new Map();
var inviteCooldowns = /* @__PURE__ */ new Map();
var playerStore = null;
var EXTRA_KEYS = [
  "health",
  "enchantmentId",
  "maxCharge",
  "chargePercent",
  "name",
  "soul",
  "poisonId",
  "poisonCount",
  "worn",
  "wornLeft",
  "removeEnchantmentOnUnequip"
];
function hasExtras(e) {
  for (const k of EXTRA_KEYS) {
    const v = e[k];
    if (v !== void 0 && v !== null && v !== false) {
      return true;
    }
  }
  return false;
}
function readInventory(mp3, actorId) {
  const inv = mp3.get(actorId, "inventory");
  if (inv && Array.isArray(inv.entries)) {
    return inv;
  }
  return { entries: [] };
}
function simpleCount(inv, baseId) {
  let total = 0;
  for (const e of inv.entries) {
    if (e.baseId === baseId && !hasExtras(e)) {
      total += e.count;
    }
  }
  return total;
}
function normalizeOffer(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  const byBase = /* @__PURE__ */ new Map();
  for (const raw of items) {
    const baseId = Number(raw?.baseId);
    const count = Math.floor(Number(raw?.count));
    if (!Number.isFinite(baseId) || !Number.isInteger(count) || count <= 0) {
      continue;
    }
    byBase.set(baseId, (byBase.get(baseId) || 0) + count);
  }
  return Array.from(byBase, ([baseId, count]) => ({ baseId, count }));
}
function offerIsAffordable(inv, offer) {
  for (const item of offer) {
    if (simpleCount(inv, item.baseId) < item.count) {
      return false;
    }
  }
  return true;
}
function removeOffer(inv, offer) {
  for (const item of offer) {
    let remaining = item.count;
    for (const e of inv.entries) {
      if (remaining <= 0) {
        break;
      }
      if (e.baseId === item.baseId && !hasExtras(e)) {
        const take = Math.min(e.count, remaining);
        e.count -= take;
        remaining -= take;
      }
    }
  }
  inv.entries = inv.entries.filter((e) => e.count > 0);
}
function addOffer(inv, offer) {
  for (const item of offer) {
    const stack = inv.entries.find((e) => e.baseId === item.baseId && !hasExtras(e));
    if (stack) {
      stack.count += item.count;
    } else {
      inv.entries.push({ baseId: item.baseId, count: item.count });
    }
  }
}
function isA(s, userId) {
  return s.a === userId;
}
function partnerOf(s, userId) {
  return isA(s, userId) ? s.b : s.a;
}
function offerOf(s, userId) {
  return isA(s, userId) ? s.offerA : s.offerB;
}
function lockedOf(s, userId) {
  return isA(s, userId) ? s.lockedA : s.lockedB;
}
function acceptedOf(s, userId) {
  return isA(s, userId) ? s.acceptedA : s.acceptedB;
}
function setOffer(s, userId, offer) {
  if (isA(s, userId)) {
    s.offerA = offer;
  } else {
    s.offerB = offer;
  }
}
function setLocked(s, userId, v) {
  if (isA(s, userId)) {
    s.lockedA = v;
  } else {
    s.lockedB = v;
  }
}
function setAccepted(s, userId, v) {
  if (isA(s, userId)) {
    s.acceptedA = v;
  } else {
    s.acceptedB = v;
  }
}
function resetCommitments(s) {
  s.lockedA = false;
  s.lockedB = false;
  s.acceptedA = false;
  s.acceptedB = false;
}
function send2(mp3, userId, payload) {
  try {
    mp3.sendCustomPacket(userId, JSON.stringify(payload));
  } catch (err) {
    console.error("[trade] send failed: " + (err && err.message));
  }
}
function notice(mp3, userId, text) {
  send2(mp3, userId, { customPacketType: "tradeNotice", text });
}
function actorOf(mp3, userId) {
  try {
    return mp3.getUserActor(userId);
  } catch {
    return 0;
  }
}
function nameOf(mp3, userId) {
  const actorId = actorOf(mp3, userId);
  if (!actorId) {
    return "Player";
  }
  try {
    return mp3.getActorName(actorId) || "Player";
  } catch {
    return "Player";
  }
}
function sendStateTo(mp3, s, userId) {
  const partner = partnerOf(s, userId);
  const bothLocked = s.lockedA && s.lockedB;
  send2(mp3, userId, {
    customPacketType: "tradeState",
    partnerName: nameOf(mp3, partner),
    myOffer: offerOf(s, userId),
    theirOffer: offerOf(s, partner),
    myLocked: lockedOf(s, userId),
    theirLocked: lockedOf(s, partner),
    bothLocked,
    iAccepted: acceptedOf(s, userId),
    theyAccepted: acceptedOf(s, partner)
  });
}
function broadcastState(mp3, s) {
  sendStateTo(mp3, s, s.a);
  sendStateTo(mp3, s, s.b);
}
function endSession(s) {
  s.inviteSeq++;
  sessions.delete(s.a);
  sessions.delete(s.b);
}
function cancel(mp3, s, reason, blame) {
  endSession(s);
  for (const userId of [s.a, s.b]) {
    if (userId === blame) {
      continue;
    }
    send2(mp3, userId, { customPacketType: "tradeCancelled", reason });
  }
}
function onDisconnect(mp3, userId) {
  const s = sessions.get(userId);
  if (s) {
    cancel(mp3, s, "Your trading partner left.", userId);
  }
}
function bothConnected(mp3, s) {
  try {
    return mp3.isConnected(s.a) && mp3.isConnected(s.b);
  } catch {
    return false;
  }
}
function withinRange(mp3, s) {
  const aId = actorOf(mp3, s.a);
  const bId = actorOf(mp3, s.b);
  if (!aId || !bId) {
    return false;
  }
  try {
    if (mp3.getActorCellOrWorld(aId) !== mp3.getActorCellOrWorld(bId)) {
      return false;
    }
    const pa = mp3.getActorPos(aId);
    const pb = mp3.getActorPos(bId);
    const dx = pa[0] - pb[0];
    const dy = pa[1] - pb[1];
    const dz = pa[2] - pb[2];
    return dx * dx + dy * dy + dz * dz <= MAX_TRADE_DISTANCE * MAX_TRADE_DISTANCE;
  } catch {
    return false;
  }
}
function tradeBlockReason(mp3, userId) {
  const actorId = actorOf(mp3, userId);
  if (!actorId) {
    return "not ready";
  }
  try {
    if (mp3.get(actorId, "isDead") === true) {
      return "dead";
    }
  } catch {
  }
  if (playerStore && typeof playerStore.get === "function") {
    const p = playerStore.get(userId);
    if (p && p.isDown) {
      return "downed";
    }
    if (p && p.isCaptive) {
      return "captive";
    }
  }
  return null;
}
function cooldownKey(a, b) {
  return a + ":" + b;
}
function onInviteCooldown(a, b) {
  const last = inviteCooldowns.get(cooldownKey(a, b)) || 0;
  return Date.now() - last < INVITE_COOLDOWN_MS;
}
function markInviteCooldown(a, b) {
  const now = Date.now();
  inviteCooldowns.forEach((ts, key) => {
    if (now - ts >= INVITE_COOLDOWN_MS) {
      inviteCooldowns.delete(key);
    }
  });
  inviteCooldowns.set(cooldownKey(a, b), now);
}
function sendInvite(mp3, s) {
  s.inviteSeq++;
  const seq = s.inviteSeq;
  markInviteCooldown(s.a, s.b);
  send2(mp3, s.b, { customPacketType: "tradeInvite", fromName: nameOf(mp3, s.a) });
  notice(mp3, s.a, "Trade request sent to " + nameOf(mp3, s.b) + ".");
  setTimeout(() => {
    try {
      if (sessions.get(s.a) !== s || s.active || s.inviteSeq !== seq) {
        return;
      }
      cancel(mp3, s, "The trade request expired.");
    } catch (err) {
      console.error("[trade] invite expiry error: " + (err && err.message));
    }
  }, INVITE_TTL_MS);
}
function onRequest(mp3, userId, content) {
  const recipientActorId = Number(content.recipient);
  if (!Number.isFinite(recipientActorId) || recipientActorId <= 0) {
    return;
  }
  let targetUserId;
  try {
    targetUserId = mp3.getUserByActor(recipientActorId);
  } catch {
    targetUserId = -1;
  }
  if (targetUserId === void 0 || targetUserId === null) {
    targetUserId = -1;
  }
  if (targetUserId < 0 || targetUserId === userId || !mp3.isConnected(targetUserId)) {
    notice(mp3, userId, "That is not someone you can trade with.");
    return;
  }
  const existing = sessions.get(userId);
  if (existing) {
    if (existing.active || existing.a !== userId) {
      notice(mp3, userId, "You are already in a trade.");
      return;
    }
    if (existing.b === targetUserId) {
      if (onInviteCooldown(userId, targetUserId)) {
        notice(mp3, userId, "Please wait before sending another trade request.");
        return;
      }
      sendInvite(mp3, existing);
      return;
    }
    cancel(mp3, existing, nameOf(mp3, userId) + " cancelled the trade.", userId);
  }
  if (sessions.has(targetUserId)) {
    notice(mp3, userId, nameOf(mp3, targetUserId) + " is busy with another trade.");
    return;
  }
  if (onInviteCooldown(userId, targetUserId)) {
    notice(mp3, userId, "Please wait before sending another trade request.");
    return;
  }
  if (tradeBlockReason(mp3, userId)) {
    notice(mp3, userId, "You cannot trade right now.");
    return;
  }
  if (tradeBlockReason(mp3, targetUserId)) {
    notice(mp3, userId, nameOf(mp3, targetUserId) + " cannot trade right now.");
    return;
  }
  const s = {
    a: userId,
    b: targetUserId,
    offerA: [],
    offerB: [],
    lockedA: false,
    lockedB: false,
    acceptedA: false,
    acceptedB: false,
    active: false,
    inviteSeq: 0
  };
  if (!withinRange(mp3, s)) {
    notice(mp3, userId, "You are too far away to trade.");
    return;
  }
  sessions.set(userId, s);
  sessions.set(targetUserId, s);
  sendInvite(mp3, s);
}
function onRespond(mp3, userId, content) {
  const s = sessions.get(userId);
  if (!s || s.active || s.b !== userId) {
    return;
  }
  if (!content.accept) {
    markInviteCooldown(s.a, s.b);
    cancel(mp3, s, nameOf(mp3, userId) + " declined the trade.", userId);
    return;
  }
  if (!bothConnected(mp3, s) || !withinRange(mp3, s)) {
    cancel(mp3, s, "The trade could not start.");
    return;
  }
  if (tradeBlockReason(mp3, s.a) || tradeBlockReason(mp3, s.b)) {
    cancel(mp3, s, "The trade could not start.");
    return;
  }
  s.active = true;
  broadcastState(mp3, s);
}
function onSetOffer(mp3, userId, content) {
  const s = sessions.get(userId);
  if (!s || !s.active) {
    return;
  }
  const offer = normalizeOffer(content.items);
  const inv = readInventory(mp3, actorOf(mp3, userId));
  if (!offerIsAffordable(inv, offer)) {
    notice(mp3, userId, "You no longer have all of those items.");
    sendStateTo(mp3, s, userId);
    return;
  }
  setOffer(s, userId, offer);
  resetCommitments(s);
  broadcastState(mp3, s);
}
function onLock(mp3, userId) {
  const s = sessions.get(userId);
  if (!s || !s.active) {
    return;
  }
  const inv = readInventory(mp3, actorOf(mp3, userId));
  if (!offerIsAffordable(inv, offerOf(s, userId))) {
    notice(mp3, userId, "You no longer have all of those items.");
    setOffer(s, userId, []);
    resetCommitments(s);
    broadcastState(mp3, s);
    return;
  }
  setLocked(s, userId, true);
  broadcastState(mp3, s);
}
function onUnlock(mp3, userId) {
  const s = sessions.get(userId);
  if (!s || !s.active) {
    return;
  }
  setLocked(s, userId, false);
  setAccepted(s, userId, false);
  broadcastState(mp3, s);
}
function onAccept(mp3, userId) {
  const s = sessions.get(userId);
  if (!s || !s.active) {
    return;
  }
  if (!(s.lockedA && s.lockedB)) {
    return;
  }
  setAccepted(s, userId, true);
  if (s.acceptedA && s.acceptedB) {
    completeTrade(mp3, s);
  } else {
    broadcastState(mp3, s);
  }
}
function onCancel(mp3, userId) {
  const s = sessions.get(userId);
  if (s) {
    cancel(mp3, s, nameOf(mp3, userId) + " cancelled the trade.", userId);
  }
}
function completeTrade(mp3, s) {
  if (!bothConnected(mp3, s)) {
    cancel(mp3, s, "Your trading partner left.");
    return;
  }
  if (!withinRange(mp3, s)) {
    cancel(mp3, s, "You moved too far apart to finish the trade.");
    return;
  }
  if (tradeBlockReason(mp3, s.a) || tradeBlockReason(mp3, s.b)) {
    cancel(mp3, s, "The trade was interrupted.");
    return;
  }
  const aId = actorOf(mp3, s.a);
  const bId = actorOf(mp3, s.b);
  const invA = readInventory(mp3, aId);
  const invB = readInventory(mp3, bId);
  if (!offerIsAffordable(invA, s.offerA) || !offerIsAffordable(invB, s.offerB)) {
    cancel(mp3, s, "The trade failed \u2014 an item was no longer available.");
    return;
  }
  const preSwapA = JSON.parse(JSON.stringify(invA));
  removeOffer(invA, s.offerA);
  addOffer(invA, s.offerB);
  removeOffer(invB, s.offerB);
  addOffer(invB, s.offerA);
  let wroteA = false;
  try {
    mp3.set(aId, "inventory", invA);
    wroteA = true;
    mp3.set(bId, "inventory", invB);
  } catch (err) {
    console.error("[trade] swap write failed: " + (err && err.message));
    if (wroteA) {
      try {
        mp3.set(aId, "inventory", preSwapA);
        console.log("[trade] rolled back " + nameOf(mp3, s.a) + "'s inventory after failed swap");
      } catch (rollbackErr) {
        console.error("[trade] ROLLBACK FAILED for " + nameOf(mp3, s.a) + " (" + aId.toString(16) + "): " + (rollbackErr && rollbackErr.message) + " \u2014 pre-swap inventory: " + JSON.stringify(preSwapA));
      }
    }
    cancel(mp3, s, "The trade failed unexpectedly.");
    return;
  }
  endSession(s);
  send2(mp3, s.a, { customPacketType: "tradeCompleted" });
  send2(mp3, s.b, { customPacketType: "tradeCompleted" });
  console.log("[trade] " + nameOf(mp3, s.a) + " <-> " + nameOf(mp3, s.b) + " completed");
}
function route(mp3, userId, content) {
  switch (content.customPacketType) {
    case "tradeRequest":
      onRequest(mp3, userId, content);
      break;
    case "tradeRespond":
      onRespond(mp3, userId, content);
      break;
    case "tradeSetOffer":
      onSetOffer(mp3, userId, content);
      break;
    case "tradeLock":
      onLock(mp3, userId);
      break;
    case "tradeUnlock":
      onUnlock(mp3, userId);
      break;
    case "tradeAccept":
      onAccept(mp3, userId);
      break;
    case "tradeCancel":
      onCancel(mp3, userId);
      break;
    default:
      break;
  }
}
function init3(mp3, store3, bus2) {
  console.log("[trade] Initializing");
  playerStore = store3 || null;
  if (!playerStore) {
    console.warn("[trade] init called without the player store \u2014 downed/captive gating is limited to isDead (wire as trade.init(mp, store, bus))");
  }
  mp3.on("customPacket", (userId, rawContent) => {
    let content;
    try {
      content = JSON.parse(rawContent);
    } catch {
      return;
    }
    if (!content || typeof content.customPacketType !== "string" || content.customPacketType.indexOf("trade") !== 0) {
      return;
    }
    try {
      route(mp3, userId, content);
    } catch (err) {
      console.error("[trade] handler error: " + (err && err.message));
    }
  });
  mp3.on("disconnect", (userId) => {
    try {
      onDisconnect(mp3, userId);
    } catch (err) {
      console.error("[trade] disconnect error: " + (err && err.message));
    }
  });
  if (bus2 && typeof bus2.on === "function") {
    const dropTradeOf = (participantUserId) => {
      const s = sessions.get(participantUserId);
      if (s) {
        cancel(mp3, s, "The trade was interrupted.");
      }
    };
    bus2.on("playerDowned", (e) => {
      try {
        dropTradeOf(e.victimId);
      } catch (err) {
        console.error("[trade] playerDowned error: " + (err && err.message));
      }
    });
    bus2.on("playerCaptured", (e) => {
      try {
        dropTradeOf(e.captiveId);
      } catch (err) {
        console.error("[trade] playerCaptured error: " + (err && err.message));
      }
    });
  }
  console.log("[trade] Started");
}

// src/systems/stubs.ts
function init4(mp3) {
  mp3.on("customPacket", (userId, rawContent) => {
    let content;
    try {
      content = JSON.parse(rawContent);
    } catch {
      return;
    }
    if (!content || typeof content.customPacketType !== "string") return;
    const t = content.customPacketType;
    const reply = (payload) => {
      try {
        mp3.sendCustomPacket(userId, JSON.stringify(payload));
      } catch {
      }
    };
    if (t === "propertyRequest") {
      reply({ customPacketType: "propertyNotice", text: "Property management is not available yet." });
    } else if (t === "factionMenuRequest" || t === "factionRequest") {
      reply({ customPacketType: "factionNotice", text: "Faction management is not available yet." });
    }
  });
  console.log("[stubs] housing/faction stub notices active");
}

// src/systems/consoleRelay.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));

// node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);
var wrapper_default = import_websocket.default;

// src/systems/consoleRelay.ts
function readEnvFile(file) {
  const values = {};
  let txt = "";
  try {
    txt = fs.readFileSync(file, "utf8");
  } catch {
    return values;
  }
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/);
    if (m && !line.trimStart().startsWith("#")) values[m[1]] = m[2].trim();
  }
  return values;
}
function findRelayConfig() {
  let dir = process.cwd();
  let env = {};
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "skymp5-backend", ".env");
    if (fs.existsSync(candidate)) {
      env = readEnvFile(candidate);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const secret = process.env.RELAY_SECRET || env.RELAY_SECRET || "";
  const port = parseInt(process.env.WS_PORT || env.WS_PORT || "7778", 10);
  if (!secret) return null;
  return { port, secret };
}
var HELP = [
  "Gamemode console commands:",
  "  help                       this help",
  "  status                     online count and uptime",
  "  players                    list online players",
  "  say <text>                 server broadcast into every chat tab",
  "  notify <name|all> <text>   corner notification (System tab)",
  "  kick <name>                disconnect a player",
  "  admin list|add <profileId>|remove <profileId>   runtime chat admins (not persisted)"
].join("\n");
function execCommand(mp3, store3, adminOverrides3, text) {
  const parts = String(text || "").trim().split(/\s+/);
  const verb = (parts[0] || "").toLowerCase();
  const rest = parts.slice(1);
  if (!verb || verb === "help") return HELP;
  if (verb === "status") {
    const players = store3.getAll();
    const mins = Math.floor(process.uptime() / 60);
    return `online: ${players.length} player(s), server uptime: ${mins} min`;
  }
  if (verb === "players" || verb === "list") {
    const players = store3.getAll();
    if (!players.length) return "no players online";
    return players.map((p) => `${p.name || "(unnamed)"} (profile ${p.profileId}, actor ${p.actorId.toString(16)}, user ${p.userId})`).join("\n");
  }
  if (verb === "say") {
    const msg = rest.join(" ");
    if (!msg) return "usage: say <text>";
    broadcastServer(msg);
    return `broadcast: ${msg}`;
  }
  if (verb === "notify") {
    const target = rest[0];
    const msg = rest.slice(1).join(" ");
    if (!target || !msg) return "usage: notify <name|all> <text>";
    if (target.toLowerCase() === "all") {
      for (const p2 of store3.getAll()) {
        try {
          mp3.sendCustomPacket(p2.userId, JSON.stringify({ customPacketType: "notification", text: msg }));
        } catch {
        }
      }
      return `notified everyone: ${msg}`;
    }
    const rt = store3.findByName(target);
    if (rt.candidates.length > 1) return `"${target}" matches several players: ${rt.candidates.map((c) => c.name).join(", ")}`;
    const p = rt.match;
    if (!p) return `no online player matching "${target}"`;
    try {
      mp3.sendCustomPacket(p.userId, JSON.stringify({ customPacketType: "notification", text: msg }));
    } catch {
    }
    return `notified ${p.name}: ${msg}`;
  }
  if (verb === "kick") {
    const who = rest.join(" ");
    if (!who) return "usage: kick <name>";
    const rk = store3.findByName(who);
    if (rk.candidates.length > 1) return `"${who}" matches several players: ${rk.candidates.map((c) => c.name).join(", ")}`;
    const p = rk.match;
    if (!p) return `no online player matching "${who}"`;
    try {
      mp3.kick(p.userId);
    } catch (err) {
      return `kick failed: ${err && err.message}`;
    }
    return `kicked ${p.name}`;
  }
  if (verb === "admin") {
    const sub = (rest[0] || "").toLowerCase();
    if (sub === "list") {
      return adminOverrides3.size ? `runtime admins: ${[...adminOverrides3].join(", ")}` : "no runtime admin overrides (backend admin.* permissions still apply)";
    }
    const profileId = parseInt(rest[1], 10);
    if ((sub === "add" || sub === "remove") && Number.isFinite(profileId)) {
      if (sub === "add") {
        adminOverrides3.add(profileId);
        return `profile ${profileId} added as runtime admin`;
      }
      adminOverrides3.delete(profileId);
      return `profile ${profileId} removed from runtime admins`;
    }
    return "usage: admin list | admin add <profileId> | admin remove <profileId>";
  }
  return `unknown command: ${verb} (try help)`;
}
function init5(mp3, store3, adminOverrides3, gen2) {
  if ((process.env.ALDUINAK_RELAY || "").toLowerCase() === "off") {
    console.log("[console] relay client disabled (ALDUINAK_RELAY=off)");
    return () => {
    };
  }
  let ws = null;
  let stopped = false;
  let timer = null;
  let warnedNoConfig = false;
  const sendOutput = (text) => {
    try {
      ws && ws.readyState === wrapper_default.OPEN && ws.send(JSON.stringify({ type: "console_output", text: String(text) }));
    } catch {
    }
  };
  const scheduleReconnect = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!stopped && generationLive(gen2)) connect();
    }, 4e3);
    if (timer && typeof timer.unref === "function") timer.unref();
  };
  const connect = () => {
    if (stopped) return;
    const cfg = findRelayConfig();
    if (!cfg) {
      if (!warnedNoConfig) {
        warnedNoConfig = true;
        console.log("[console] relay config not found yet (RELAY_SECRET in backend .env or env var); retrying");
      }
      return scheduleReconnect();
    }
    try {
      ws = new wrapper_default(`ws://127.0.0.1:${cfg.port}`);
    } catch {
      return scheduleReconnect();
    }
    ws.on("open", () => {
      try {
        ws && ws.send(JSON.stringify({ type: "auth", role: "gamemode", secret: cfg.secret }));
      } catch {
      }
    });
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m && m.type === "auth_ok") {
        console.log("[console] connected to WS relay");
        return;
      }
      if (m && m.type === "console_command") {
        let out;
        try {
          out = execCommand(mp3, store3, adminOverrides3, String(m.text ?? ""));
        } catch (err) {
          out = "command error: " + (err && err.message);
        }
        sendOutput(out);
      }
    });
    ws.on("close", () => {
      ws = null;
      scheduleReconnect();
    });
    ws.on("error", () => {
    });
  };
  connect();
  console.log("[console] relay client started");
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      ws && ws.close();
    } catch {
    }
    ws = null;
  };
}

// src/index.ts
var g4 = globalThis;
var realMp = g4.mp;
if (!realMp) {
  throw new Error("[alduinak] global mp not found - this file must be loaded by skymp5-server");
}
if (typeof g4.__alduinakTeardown === "function") {
  try {
    g4.__alduinakTeardown();
  } catch {
  }
}
var gen = newGeneration();
var mp2 = makeMpFacade(realMp);
var store2 = new PlayerStore(mp2);
var bus = new import_events.EventEmitter();
g4.__alduinakAdminOverrides = g4.__alduinakAdminOverrides || /* @__PURE__ */ new Set();
var adminOverrides2 = g4.__alduinakAdminOverrides;
init(mp2, store2, adminOverrides2, gen);
init2(mp2, store2, bus);
init3(mp2, store2, bus);
init4(mp2);
var stopRelay = init5(mp2, store2, adminOverrides2, gen);
g4.__alduinakTeardown = () => {
  stopRelay();
};
console.log(`[alduinak] gamemode loaded (generation ${gen})`);
