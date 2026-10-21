// Prepended to main.js (see esbuild.config.mjs). Geode mobile's plugin loader only resolves
// obsidian/geode/@codemirror/@lezer; everything else throws. This bundle `require`s Node builtins
// at load time (agent SDK, ws, node-cron...), so wrap `require` and, when the host refuses a
// module, hand back a stub instead. Desktop/Obsidian resolve the real module first, so this is
// inert there. Stubs are import-safe: pure helpers work; anything that needs the OS throws when
// CALLED (the code paths are guarded by Platform.isMobile and use the remote daemon on mobile).
var require = (function (__hostRequire) {
  var cache = Object.create(null);
  function unavailable(name) {
    return function () { throw new Error('"' + name + '" is not available on this platform (mobile)'); };
  }
  // Property reads return further stubs (so `fs.promises.readFile` etc. resolve at import time);
  // calling or constructing throws.
  function deepStub(name) {
    var fn = function () { throw new Error('"' + name + '" is not available on this platform (mobile)'); };
    return new Proxy(fn, {
      get: function (t, k) {
        if (k === '__esModule') return false;
        if (k === 'then') return undefined;
        if (k === Symbol.toPrimitive) return function () { return ''; };
        if (k === 'prototype') return t.prototype;
        return deepStub(name + '.' + String(k));
      },
      set: function () { return true; },
      has: function () { return true; },
    });
  }
  function normalizeParts(parts, abs) {
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || p === '.') continue;
      if (p === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); }
      else out.push(p);
    }
    return out;
  }
  var path = {
    sep: '/', delimiter: ':',
    isAbsolute: function (p) { return p.charAt(0) === '/'; },
    normalize: function (p) {
      var abs = p.charAt(0) === '/', trail = p.slice(-1) === '/';
      var s = normalizeParts(p.split('/'), abs).join('/');
      if (!s && !abs) s = '.';
      if (s && trail) s += '/';
      return (abs ? '/' : '') + s;
    },
    join: function () {
      var a = Array.prototype.filter.call(arguments, function (x) { return x; }).join('/');
      return a ? path.normalize(a) : '.';
    },
    resolve: function () {
      var r = '';
      for (var i = arguments.length - 1; i >= 0 && r.charAt(0) !== '/'; i--) if (arguments[i]) r = arguments[i] + (r ? '/' + r : '');
      if (r.charAt(0) !== '/') r = '/' + r;
      return '/' + normalizeParts(r.split('/'), true).join('/');
    },
    dirname: function (p) {
      var s = p.replace(/\/+$/, ''), i = s.lastIndexOf('/');
      return i < 0 ? '.' : i === 0 ? '/' : s.slice(0, i);
    },
    basename: function (p, ext) {
      var b = p.replace(/\/+$/, '').split('/').pop() || '';
      return ext && b.slice(-ext.length) === ext ? b.slice(0, -ext.length) : b;
    },
    extname: function (p) {
      var b = path.basename(p), i = b.lastIndexOf('.');
      return i <= 0 ? '' : b.slice(i);
    },
    relative: function (from, to) {
      var f = path.resolve(from).split('/').filter(Boolean), t = path.resolve(to).split('/').filter(Boolean), i = 0;
      while (i < f.length && i < t.length && f[i] === t[i]) i++;
      return f.slice(i).map(function () { return '..'; }).concat(t.slice(i)).join('/');
    },
    parse: function (p) {
      var base = path.basename(p), ext = path.extname(p), dir = path.dirname(p);
      return { root: p.charAt(0) === '/' ? '/' : '', dir: dir === '.' && p.indexOf('/') < 0 ? '' : dir, base: base, ext: ext, name: ext ? base.slice(0, -ext.length) : base };
    },
    format: function (o) { return (o.dir ? o.dir + '/' : o.root || '') + (o.base || (o.name || '') + (o.ext || '')); },
  };
  path.posix = path; path.win32 = path;

  function EventEmitter() { this._events = {}; }
  EventEmitter.prototype._ev = function () { return this._events || (this._events = {}); };
  EventEmitter.prototype.on = EventEmitter.prototype.addListener = function (n, f) { (this._ev()[n] || (this._ev()[n] = [])).push(f); return this; };
  EventEmitter.prototype.prependListener = function (n, f) { (this._ev()[n] || (this._ev()[n] = [])).unshift(f); return this; };
  EventEmitter.prototype.once = function (n, f) { var s = this; function w() { s.off(n, w); return f.apply(s, arguments); } w.listener = f; return this.on(n, w); };
  EventEmitter.prototype.off = EventEmitter.prototype.removeListener = function (n, f) {
    var l = this._ev()[n]; if (!l) return this;
    this._ev()[n] = l.filter(function (x) { return x !== f && x.listener !== f; }); return this;
  };
  EventEmitter.prototype.removeAllListeners = function (n) { if (n === undefined) this._events = {}; else delete this._ev()[n]; return this; };
  EventEmitter.prototype.emit = function (n) {
    var l = this._ev()[n]; var args = Array.prototype.slice.call(arguments, 1);
    if (!l || !l.length) { if (n === 'error') throw args[0] instanceof Error ? args[0] : new Error('Unhandled error'); return false; }
    l.slice().forEach(function (f) { f.apply(this, args); }, this); return true;
  };
  EventEmitter.prototype.listenerCount = function (n) { return (this._ev()[n] || []).length; };
  EventEmitter.prototype.listeners = function (n) { return (this._ev()[n] || []).slice(); };
  EventEmitter.prototype.setMaxListeners = function () { return this; };
  EventEmitter.prototype.getMaxListeners = function () { return 10; };
  EventEmitter.prototype.eventNames = function () { return Object.keys(this._ev()); };
  EventEmitter.EventEmitter = EventEmitter; EventEmitter.defaultMaxListeners = 10;
  EventEmitter.once = function (em, n) { return new Promise(function (res, rej) { em.once(n, function () { res(Array.prototype.slice.call(arguments)); }); if (n !== 'error') em.once('error', rej); }); };

  var util = {
    inherits: function (c, s) { c.super_ = s; Object.setPrototypeOf(c.prototype, s.prototype); },
    promisify: function (f) { return function () { var a = Array.prototype.slice.call(arguments), s = this; return new Promise(function (res, rej) { a.push(function (e, v) { e ? rej(e) : res(v); }); f.apply(s, a); }); }; },
    deprecate: function (f) { return f; },
    format: function (f) { var a = Array.prototype.slice.call(arguments, 1); return typeof f === 'string' ? f.replace(/%[sdjoO%]/g, function (m) { return m === '%%' ? '%' : a.length ? (m === '%j' ? JSON.stringify(a.shift()) : String(a.shift())) : m; }) : [f].concat(a).map(String).join(' '); },
    inspect: function (v) { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { return String(v); } },
    isDeepStrictEqual: function (a, b) { return JSON.stringify(a) === JSON.stringify(b); },
    TextEncoder: typeof TextEncoder !== 'undefined' ? TextEncoder : undefined,
    TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : undefined,
    types: { isPromise: function (x) { return !!x && typeof x.then === 'function'; } },
    stripVTControlCharacters: function (s) { return String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''); },
  };

  function fileURLToPath(u) { var s = typeof u === 'string' ? u : u.href; return decodeURIComponent(s.replace(/^file:\/\//, '')); }
  function pathToFileURL(p) { return new URL('file://' + encodeURI(p)); }
  var urlMod = { URL: typeof URL !== 'undefined' ? URL : undefined, URLSearchParams: typeof URLSearchParams !== 'undefined' ? URLSearchParams : undefined, fileURLToPath: fileURLToPath, pathToFileURL: pathToFileURL,
    parse: function (s) { try { var u = new URL(s); return { href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash, query: u.search.slice(1) }; } catch (e) { return { href: s, pathname: s }; } } };

  var webCrypto = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  var cryptoMod = {
    webcrypto: webCrypto,
    subtle: webCrypto && webCrypto.subtle,
    getRandomValues: function (a) { return webCrypto.getRandomValues(a); },
    randomUUID: function () { return webCrypto.randomUUID(); },
    randomBytes: function (n) {
      var u = new Uint8Array(n); webCrypto.getRandomValues(u);
      u.toString = function (enc) { var h = ''; for (var i = 0; i < u.length; i++) h += (u[i] < 16 ? '0' : '') + u[i].toString(16); return enc === 'hex' || !enc ? h : Array.prototype.map.call(u, function (b) { return String.fromCharCode(b); }).join(''); };
      return u;
    },
    createHash: unavailable('crypto.createHash'),
    createHmac: unavailable('crypto.createHmac'),
  };

  function makeRequireStub() {
    var f = function (id) { return load(id); };
    f.resolve = unavailable('require.resolve'); f.cache = {}; return f;
  }
  var moduleMod = { createRequire: function () { return makeRequireStub(); }, builtinModules: [] };
  var osMod = { EOL: '\n', homedir: function () { return '/'; }, tmpdir: function () { return '/tmp'; }, platform: function () { return 'ios'; }, type: function () { return 'Darwin'; },
    arch: function () { return 'arm64'; }, release: function () { return ''; }, hostname: function () { return 'mobile'; }, cpus: function () { return []; }, userInfo: function () { return { username: 'mobile', homedir: '/' }; },
    totalmem: function () { return 0; }, freemem: function () { return 0; }, endianness: function () { return 'LE'; }, constants: { signals: {} } };

  // Minimal AsyncLocalStorage: correct for synchronous scopes only (no async context propagation).
  function AsyncLocalStorage() { this._s = undefined; }
  AsyncLocalStorage.prototype.run = function (store, fn) { var prev = this._s; this._s = store; try { return fn.apply(null, Array.prototype.slice.call(arguments, 2)); } finally { this._s = prev; } };
  AsyncLocalStorage.prototype.getStore = function () { return this._s; };
  AsyncLocalStorage.prototype.enterWith = function (s) { this._s = s; };
  AsyncLocalStorage.prototype.exit = function (fn) { var p = this._s; this._s = undefined; try { return fn(); } finally { this._s = p; } };
  AsyncLocalStorage.prototype.disable = function () { this._s = undefined; };
  var asyncHooks = { AsyncLocalStorage: AsyncLocalStorage, AsyncResource: function () {} };

  var overrides = { async_hooks: asyncHooks, path: path, events: EventEmitter, util: util, url: urlMod, crypto: cryptoMod, module: moduleMod, os: osMod };

  function load(id) {
    if (id === 'obsidian' || id === 'geode' || id.charAt(0) === '@' && /^@(codemirror|lezer)\//.test(id)) return __hostRequire(id);
    try {
      return __hostRequire(id);
    } catch (e) {
      var bare = String(id).replace(/^node:/, '');
      if (cache[bare]) return cache[bare];
      // Optional native accelerators that `ws` probes inside try/catch: they MUST keep throwing, or `ws` takes the
      // stub as the real addon and its first `send()` dies with "bufferutil.mask is not available" (hello never
      // leaves the plugin; the daemon times out and the UI says "rejected the access token").
      if (bare === 'bufferutil' || bare === 'utf-8-validate') throw e;
      return (cache[bare] = overrides[bare] || deepStub(bare));
    }
  }
  return load;
})(require);
// Node's `process` does not exist in the mobile WebView. Provide an inert one so module-level
// reads (process.env.X, process.platform) don't throw. Real `process` wins wherever it exists.
var process = globalThis.process || (function () {
  var noop = function () {};
  var p = { env: {}, platform: 'ios', arch: 'arm64', version: 'v0.0.0', versions: {}, argv: [], execArgv: [], pid: 0, exitCode: undefined,
    cwd: function () { return '/'; }, nextTick: function (f) { var a = Array.prototype.slice.call(arguments, 1); queueMicrotask(function () { f.apply(null, a); }); },
    on: noop, once: noop, off: noop, emit: noop, addListener: noop, removeListener: noop, removeAllListeners: noop, emitWarning: noop,
    hrtime: function () { var t = Date.now(); return [Math.floor(t / 1000), (t % 1000) * 1e6]; },
    uptime: function () { return 0; }, memoryUsage: function () { return { rss: 0, heapTotal: 0, heapUsed: 0 }; },
    stdout: { write: noop, isTTY: false }, stderr: { write: noop, isTTY: false }, stdin: {} };
  p.hrtime.bigint = function () { return BigInt(Date.now()) * 1000000n; };
  return p;
})();
// WKWebView has no SharedArrayBuffer (needs cross-origin isolation). A few dependencies allocate
// one at load time for a synchronous-sleep helper; hand them a plain ArrayBuffer there.
var SharedArrayBuffer = globalThis.SharedArrayBuffer || function SharedArrayBuffer(n) { return new ArrayBuffer(n); };
