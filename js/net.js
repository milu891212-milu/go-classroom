/*
 * 連線層：登入、同步對局、線上狀態。畫面程式只認得下面這組介面，不直接碰 Firebase。
 *
 *   ready                     Promise，連線元件載入完成
 *   onAuth(cb)                登入狀態改變時呼叫 cb({ account, role }) 或 cb(null)
 *   signIn(account, password) 登入；失敗時 Promise 帶中文錯誤訊息
 *   signOut()
 *   now()                     與伺服器對過時的現在時間（毫秒）
 *   watchGame(cb, errCb)      對局資料一有變動就呼叫 cb(資料或 null)；回傳停止用的函式
 *   setGame(game)             直接覆寫整盤對局（開新局、結束對局用）
 *   updateGame(fn)            以最新資料為準修改對局：fn(目前資料) 回傳新資料，回傳 undefined 則放棄
 *   setPresence(role)         宣告自己在線上
 *   watchPresence(cb)         cb({ teacher: 是否在線, student: 是否在線 })
 *   onConnection(cb)          cb(是否連線中)
 *
 * 有兩種實作：
 *   FirebaseBackend 正式使用。
 *   LocalBackend    測試用，網址加上 ?demo=teacher 或 ?demo=student，同一個瀏覽器的兩個視窗會互相同步。
 */
(function (global) {
  'use strict';
  var Go = global.Go = global.Go || {};

  function clean(v) {
    return v === null || v === undefined ? null : JSON.parse(JSON.stringify(v));
  }
  function noop() {}

  /* ================= 測試用：同一個瀏覽器的兩個視窗 ================= */

  var DEMO_GAME = 'go-classroom-demo-game';
  var DEMO_PRESENCE = 'go-classroom-demo-presence-';

  function LocalBackend(role) {
    var self = this;
    this.kind = 'demo';
    this.role = role;
    this.ready = Promise.resolve();
    this.gameCb = null;
    this.presenceCb = null;
    this.beat = 0;
    global.addEventListener('storage', function (ev) {
      if (ev.key === DEMO_GAME) self._emitGame();
      else if (ev.key && ev.key.indexOf(DEMO_PRESENCE) === 0) self._emitPresence();
    });
    global.addEventListener('pagehide', function () { self._stopPresence(); });
  }
  LocalBackend.prototype._read = function () {
    try { return JSON.parse(localStorage.getItem(DEMO_GAME) || 'null'); } catch (e) { return null; }
  };
  LocalBackend.prototype._write = function (game) {
    if (game === null || game === undefined) localStorage.removeItem(DEMO_GAME);
    else localStorage.setItem(DEMO_GAME, JSON.stringify(game));
    this._emitGame();
  };
  LocalBackend.prototype._emitGame = function () { if (this.gameCb) this.gameCb(this._read()); };
  LocalBackend.prototype._emitPresence = function () {
    if (!this.presenceCb) return;
    var t = Date.now();
    function alive(role) { return t - (parseInt(localStorage.getItem(DEMO_PRESENCE + role), 10) || 0) < 4000; }
    this.presenceCb({ teacher: alive('teacher'), student: alive('student') });
  };
  LocalBackend.prototype._stopPresence = function () {
    clearInterval(this.beat);
    this.beat = 0;
    try { localStorage.removeItem(DEMO_PRESENCE + this.role); } catch (e) { /* 忽略 */ }
  };
  LocalBackend.prototype.onAuth = function (cb) {
    var role = this.role;
    setTimeout(function () {
      cb({ account: role === 'teacher' ? '老師（測試）' : '學生（測試）', role: role });
    }, 0);
  };
  LocalBackend.prototype.signIn = function () { return Promise.resolve(); };
  LocalBackend.prototype.signOut = function () {
    this._stopPresence();
    global.location.href = global.location.pathname; // 離開測試模式
    return Promise.resolve();
  };
  LocalBackend.prototype.now = function () { return Date.now(); };
  LocalBackend.prototype.watchGame = function (cb) {
    var self = this;
    this.gameCb = cb;
    setTimeout(function () { self._emitGame(); }, 0);
    return function () { self.gameCb = null; };
  };
  LocalBackend.prototype.setGame = function (game) {
    this._write(clean(game));
    return Promise.resolve();
  };
  LocalBackend.prototype.updateGame = function (fn) {
    var out = fn(this._read());
    if (out === undefined) return Promise.resolve(false);
    this._write(clean(out));
    return Promise.resolve(true);
  };
  LocalBackend.prototype.setPresence = function (role) {
    var self = this;
    function beat() {
      localStorage.setItem(DEMO_PRESENCE + role, String(Date.now()));
      self._emitPresence();
    }
    clearInterval(this.beat);
    beat();
    this.beat = setInterval(beat, 1500);
  };
  LocalBackend.prototype.watchPresence = function (cb) {
    var self = this;
    this.presenceCb = cb;
    this._emitPresence();
    return function () { self.presenceCb = null; };
  };
  LocalBackend.prototype.onConnection = function (cb) { cb(true); };

  /* ================= Firebase ================= */

  var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('無法載入連線元件，請檢查網路')); };
      document.head.appendChild(s);
    });
  }

  function authMessage(err) {
    var code = (err && err.code) || '';
    if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found' ||
        code === 'auth/invalid-email' || code === 'auth/invalid-login-credentials') return '帳號或密碼不正確';
    if (code === 'auth/too-many-requests') return '嘗試太多次，請稍後再試';
    if (code === 'auth/network-request-failed') return '網路連線失敗，請檢查網路';
    if (code === 'auth/user-disabled') return '這個帳號已被停用';
    return '登入失敗' + (code ? '（' + code + '）' : '');
  }

  function FirebaseBackend(cfg) {
    var self = this;
    this.kind = 'firebase';
    this.domain = cfg.accountDomain || 'goclass.example.com';
    this.teachers = (cfg.teachers || ['teacher']).map(function (t) { return String(t).toLowerCase(); });
    this.offset = 0;
    this.connected = false;
    this.user = null;
    this.authCb = null;
    this.connCb = null;
    this.presenceRef = null;
    this.presenceRole = null;

    this.ready = loadScript(SDK + 'firebase-app-compat.js').then(function () {
      return Promise.all([
        loadScript(SDK + 'firebase-auth-compat.js'),
        loadScript(SDK + 'firebase-database-compat.js')
      ]);
    }).then(function () {
      var fb = global.firebase;
      fb.initializeApp(cfg.firebase);
      self.auth = fb.auth();
      self.db = fb.database();
      self.room = self.db.ref('rooms/' + (cfg.room || 'main'));

      self.db.ref('.info/serverTimeOffset').on('value', function (s) { self.offset = s.val() || 0; });
      self.db.ref('.info/connected').on('value', function (s) {
        self.connected = !!s.val();
        if (self.connected) self._announce();   // 斷線重連後重新宣告在線
        if (self.connCb) self.connCb(self.connected);
      });
      self.auth.onAuthStateChanged(function (u) {
        if (u) {
          var account = String(u.email || '').toLowerCase().split('@')[0];
          self.user = { account: account, role: self.teachers.indexOf(account) >= 0 ? 'teacher' : 'student' };
        } else {
          self.user = null;
          self.presenceRef = null;
          self.presenceRole = null;
        }
        if (self.authCb) self.authCb(self.user);
      });
    });
  }

  FirebaseBackend.prototype.onAuth = function (cb) { this.authCb = cb; };

  FirebaseBackend.prototype.signIn = function (account, password) {
    var self = this;
    return this.ready.then(function () {
      var email = account.indexOf('@') >= 0 ? account : account + '@' + self.domain;
      return self.auth.signInWithEmailAndPassword(email.trim().toLowerCase(), password);
    }).then(noop, function (err) {
      throw new Error(err && err.code ? authMessage(err) : (err && err.message) || '登入失敗');
    });
  };

  FirebaseBackend.prototype.signOut = function () {
    var self = this, ref = this.presenceRef;
    this.presenceRef = null;
    this.presenceRole = null;
    // 先把自己的在線標記拿掉再登出（登出後就沒有權限寫入了）
    return Promise.resolve(ref ? ref.remove() : null).then(noop, noop).then(function () {
      return self.auth.signOut();
    });
  };

  FirebaseBackend.prototype.now = function () { return Date.now() + this.offset; };

  FirebaseBackend.prototype.watchGame = function (cb, errCb) {
    var ref = this.room.child('game');
    var handler = ref.on('value', function (s) { cb(s.val()); }, function (err) { if (errCb) errCb(err); });
    return function () { ref.off('value', handler); };
  };

  FirebaseBackend.prototype.setGame = function (game) {
    return this.room.child('game').set(clean(game));
  };

  FirebaseBackend.prototype.updateGame = function (fn) {
    // transaction 會以伺服器上最新的資料重跑 fn，兩邊同時操作也不會互相蓋掉
    return this.room.child('game').transaction(function (current) {
      var out = fn(current);
      return out === undefined ? undefined : clean(out);
    }).then(function (res) { return !!(res && res.committed); });
  };

  FirebaseBackend.prototype._announce = function () {
    if (!this.presenceRole || !this.connected || !this.user) return;
    if (!this.presenceRef) this.presenceRef = this.room.child('presence').push();
    this.presenceRef.onDisconnect().remove();
    this.presenceRef.set({ role: this.presenceRole }).then(noop, noop);
  };

  FirebaseBackend.prototype.setPresence = function (role) {
    this.presenceRole = role;
    this._announce();
  };

  FirebaseBackend.prototype.watchPresence = function (cb) {
    var ref = this.room.child('presence');
    var handler = ref.on('value', function (s) {
      var all = s.val() || {}, out = { teacher: false, student: false };
      Object.keys(all).forEach(function (k) {
        var role = all[k] && all[k].role;
        if (role === 'teacher' || role === 'student') out[role] = true;
      });
      cb(out);
    }, noop);
    return function () { ref.off('value', handler); };
  };

  FirebaseBackend.prototype.onConnection = function (cb) {
    this.connCb = cb;
    cb(this.connected);
  };

  /* ================= 選擇要用哪一種 ================= */

  Go.Net = {
    /* 回傳連線物件；沒有設定 Firebase、也不是測試模式時回傳 null（純單機） */
    create: function (cfg, search) {
      var m = /[?&]demo=(teacher|student)\b/.exec(search || '');
      if (m) return new LocalBackend(m[1]);
      if (cfg && cfg.firebase && cfg.firebase.apiKey) return new FirebaseBackend(cfg);
      return null;
    }
  };
})(window);
