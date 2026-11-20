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
 *   watchPresence(cb)         cb({ teacher: 是否在線, student: 是否在線, people: [{ account, role }] })
 *   onConnection(cb)          cb(是否連線中)
 *   watchChat(cb)             聊天室最近的訊息有變動就呼叫 cb([{ id, a: 帳號, r: 身分, k: 種類, x: 內容, t: 時間 }])
 *   sendChat(msg)             送出一則訊息 { k: 'text'|'quick'|'sticker', x }（帳號、身分、時間自動補上）
 *   clearChat()               清空聊天室（老師）
 *   watchChatLock(cb)         cb(學生是否被禁止發言)
 *   setChatLock(on)           老師開關「學生禁言」
 *   setHand(on)               學生舉手／放下
 *   lowerHand(account)        老師幫某個學生放下手（請上台後）
 *   watchHands(cb)            cb([{ a: 帳號, t: 舉手時間 }])，先舉手的排前面
 *
 *   語音（voice.js 用；聲音本身是瀏覽器之間直接傳，這裡只負責交換連線資訊）：
 *   voiceJoin(pid, info)      宣告自己在語音裡 info = { mic, has }（帳號、身分自動補上）；斷線自動移除
 *   voiceUpdate(pid, info)    更新自己的麥克風狀態
 *   voiceLeave(pid)
 *   watchVoiceMembers(cb)     cb([{ pid, a, r, mic, has }])
 *   voiceSend(toPid, msg)     送連線資訊給某人 msg = { f: 自己的 pid, k: 'offer'|'answer'|'ice', d: 字串 }
 *   watchVoiceInbox(pid, cb)  收到給自己的連線資訊就呼叫 cb(msg)（讀完自動刪除）
 *   setVoiceAllow(account, on)／setVoiceAllowAll(on)  老師開放學生說話
 *   watchVoiceAllow(cb)       cb({ all: 是否全部開放, accounts: { 帳號鍵: true } })
 *
 * 有兩種實作：
 *   FirebaseBackend 正式使用。
 *   LocalBackend    測試用，網址加上 ?demo=teacher 或 ?demo=student，同一個瀏覽器的兩個視窗會互相同步。
 *                   多個學生可以再加 &as=名字，例如 ?demo=student&as=小明。
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
  var DEMO_CHAT = 'go-classroom-demo-chat';
  var DEMO_LOCK = 'go-classroom-demo-chatlock';
  var DEMO_HANDS = 'go-classroom-demo-hands';
  var DEMO_VMEMBER = 'go-classroom-demo-vmember-';   // + pid
  var DEMO_VMSG = 'go-classroom-demo-vmsg-';         // + 收件人 pid + '-' + 亂數
  var DEMO_VALLOW = 'go-classroom-demo-vallow';

  /* 帳號當成資料庫的鍵時，不能有 . # $ [ ] / 這些字元 */
  function safeKey(account) { return String(account).replace(/[.#$\[\]\/]/g, '_') || '_'; }
  function sortHands(obj) {
    return Object.keys(obj || {}).map(function (k) { return obj[k]; })
      .filter(function (h) { return h && h.a; })
      .sort(function (x, y) { return (x.t || 0) - (y.t || 0); });
  }
  var CHAT_KEEP = 100;      // 聊天室只保留、只顯示最近這麼多則
  var CHAT_MAX_LEN = 200;   // 一則訊息最多幾個字

  /* 整理要送出的訊息 */
  function chatMessage(user, msg, t) {
    var k = msg && (msg.k === 'quick' || msg.k === 'sticker') ? msg.k : 'text';
    var x = String((msg && msg.x) || '').trim().slice(0, CHAT_MAX_LEN);
    if (!x) return null;
    return { a: user.account, r: user.role, k: k, x: x, t: t };
  }

  function LocalBackend(role, name) {
    var self = this;
    this.kind = 'demo';
    this.role = role;
    this.account = role === 'teacher' ? '老師（測試）' : (name ? String(name).slice(0, 12) : '學生（測試）');
    this.ready = Promise.resolve();
    this.gameCb = null;
    this.presenceCb = null;
    this.chatCb = null;
    this.lockCb = null;
    this.handsCb = null;
    this.vMembersCb = null;
    this.vInbox = null;      // { pid, cb }
    this.vAllowCb = null;
    this.vMine = {};         // 自己在語音裡的 pid → info（心跳用）
    this.beat = 0;
    setInterval(function () { self._voiceBeat(); }, 1500);
    global.addEventListener('storage', function (ev) {
      if (ev.key === DEMO_GAME) self._emitGame();
      else if (ev.key === DEMO_CHAT) self._emitChat();
      else if (ev.key === DEMO_LOCK) self._emitLock();
      else if (ev.key === DEMO_HANDS) self._emitHands();
      else if (ev.key === DEMO_VALLOW) self._emitAllow();
      else if (ev.key && ev.key.indexOf(DEMO_VMEMBER) === 0) self._emitMembers();
      else if (ev.key && ev.key.indexOf(DEMO_VMSG) === 0 && ev.newValue) self._readInbox();
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
    var t = Date.now(), out = { teacher: false, student: false, people: [] };
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf(DEMO_PRESENCE) !== 0) continue;
      var v;
      try { v = JSON.parse(localStorage.getItem(k)); } catch (e) { v = null; }
      if (!v || !v.role || t - v.t > 4000) continue;
      out[v.role] = true;
      out.people.push({ account: v.account, role: v.role });
    }
    this.presenceCb(out);
  };
  LocalBackend.prototype._stopPresence = function () {
    clearInterval(this.beat);
    this.beat = 0;
    try { localStorage.removeItem(DEMO_PRESENCE + this.account); } catch (e) { /* 忽略 */ }
  };
  LocalBackend.prototype.onAuth = function (cb) {
    var user = { account: this.account, role: this.role };
    setTimeout(function () { cb(user); }, 0);
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
      localStorage.setItem(DEMO_PRESENCE + self.account, JSON.stringify({ role: role, account: self.account, t: Date.now() }));
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
  LocalBackend.prototype._chat = function () {
    try { return JSON.parse(localStorage.getItem(DEMO_CHAT) || '[]'); } catch (e) { return []; }
  };
  LocalBackend.prototype._emitChat = function () { if (this.chatCb) this.chatCb(this._chat()); };
  LocalBackend.prototype._emitLock = function () { if (this.lockCb) this.lockCb(localStorage.getItem(DEMO_LOCK) === '1'); };
  LocalBackend.prototype.watchChat = function (cb) {
    var self = this;
    this.chatCb = cb;
    setTimeout(function () { self._emitChat(); }, 0);
    return function () { self.chatCb = null; };
  };
  LocalBackend.prototype.sendChat = function (msg) {
    var m = chatMessage({ account: this.account, role: this.role }, msg, Date.now());
    if (!m) return Promise.resolve();
    var list = this._chat();
    m.id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    list.push(m);
    localStorage.setItem(DEMO_CHAT, JSON.stringify(list.slice(-CHAT_KEEP)));
    this._emitChat();
    return Promise.resolve();
  };
  LocalBackend.prototype.clearChat = function () {
    localStorage.removeItem(DEMO_CHAT);
    this._emitChat();
    return Promise.resolve();
  };
  LocalBackend.prototype.watchChatLock = function (cb) {
    var self = this;
    this.lockCb = cb;
    setTimeout(function () { self._emitLock(); }, 0);
    return function () { self.lockCb = null; };
  };
  LocalBackend.prototype._hands = function () {
    try { return JSON.parse(localStorage.getItem(DEMO_HANDS) || '{}'); } catch (e) { return {}; }
  };
  LocalBackend.prototype._emitHands = function () { if (this.handsCb) this.handsCb(sortHands(this._hands())); };
  LocalBackend.prototype._setHand = function (account, on) {
    var h = this._hands();
    if (on) h[safeKey(account)] = { a: account, t: Date.now() };
    else delete h[safeKey(account)];
    localStorage.setItem(DEMO_HANDS, JSON.stringify(h));
    this._emitHands();
    return Promise.resolve();
  };
  LocalBackend.prototype.setHand = function (on) { return this._setHand(this.account, on); };
  LocalBackend.prototype.lowerHand = function (account) { return this._setHand(account, false); };
  LocalBackend.prototype.watchHands = function (cb) {
    var self = this;
    this.handsCb = cb;
    setTimeout(function () { self._emitHands(); }, 0);
    return function () { self.handsCb = null; };
  };
  /* --- 語音（測試模式）：每個成員、每則訊息各用一個 localStorage 鍵，避免互相蓋掉 --- */
  LocalBackend.prototype._voiceBeat = function () {
    var self = this, any = false;
    Object.keys(this.vMine).forEach(function (pid) {
      any = true;
      localStorage.setItem(DEMO_VMEMBER + pid, JSON.stringify(self.vMine[pid]));
    });
    if (any || this.vMembersCb) this._emitMembers();
  };
  LocalBackend.prototype._emitMembers = function () {
    if (!this.vMembersCb) return;
    var t = Date.now(), out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf(DEMO_VMEMBER) !== 0) continue;
      var v;
      try { v = JSON.parse(localStorage.getItem(k)); } catch (e) { v = null; }
      // 背景分頁的計時器會被瀏覽器放慢，所以心跳逾時放寬；正常離開時會直接刪掉（voiceLeave）
      if (!v || t - v.t > 120000) continue;
      out.push({ pid: k.slice(DEMO_VMEMBER.length), a: v.a, r: v.r, mic: !!v.mic, has: !!v.has });
    }
    this.vMembersCb(out);
  };
  LocalBackend.prototype.voiceJoin = function (pid, info) {
    this.vMine[pid] = { a: this.account, r: this.role, mic: !!info.mic, has: !!info.has, t: Date.now() };
    this._voiceBeat();
    return Promise.resolve();
  };
  LocalBackend.prototype.voiceUpdate = function (pid, info) {
    if (!this.vMine[pid]) return Promise.resolve();
    this.vMine[pid].mic = !!info.mic;
    this.vMine[pid].has = !!info.has;
    this.vMine[pid].t = Date.now();
    this._voiceBeat();
    return Promise.resolve();
  };
  LocalBackend.prototype.voiceLeave = function (pid) {
    delete this.vMine[pid];
    localStorage.removeItem(DEMO_VMEMBER + pid);
    this._emitMembers();
    return Promise.resolve();
  };
  LocalBackend.prototype.watchVoiceMembers = function (cb) {
    var self = this;
    this.vMembersCb = cb;
    setTimeout(function () { self._emitMembers(); }, 0);
    return function () { self.vMembersCb = null; };
  };
  LocalBackend.prototype.voiceSend = function (toPid, msg) {
    localStorage.setItem(DEMO_VMSG + toPid + '-' + Date.now() + Math.random().toString(36).slice(2, 8), JSON.stringify(msg));
    return Promise.resolve();
  };
  LocalBackend.prototype._readInbox = function () {
    var box = this.vInbox;
    if (!box) return;
    var prefix = DEMO_VMSG + box.pid + '-', keys = [], i;
    for (i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(prefix) === 0) keys.push(k);
    }
    keys.sort();   // 鍵裡有時間，照送出的順序處理
    keys.forEach(function (k) {
      var v = localStorage.getItem(k);
      localStorage.removeItem(k);
      try { if (v) box.cb(JSON.parse(v)); } catch (e) { /* 忽略壞掉的訊息 */ }
    });
  };
  LocalBackend.prototype.watchVoiceInbox = function (pid, cb) {
    var self = this;
    this.vInbox = { pid: pid, cb: cb };
    setTimeout(function () { self._readInbox(); }, 0);
    return function () { self.vInbox = null; };
  };
  LocalBackend.prototype._allow = function () {
    try { return JSON.parse(localStorage.getItem(DEMO_VALLOW) || '{}'); } catch (e) { return {}; }
  };
  LocalBackend.prototype._emitAllow = function () {
    if (!this.vAllowCb) return;
    var a = this._allow();
    this.vAllowCb({ all: !!a.all, accounts: a.accounts || {} });
  };
  LocalBackend.prototype.setVoiceAllow = function (account, on) {
    var a = this._allow();
    a.accounts = a.accounts || {};
    if (on) a.accounts[safeKey(account)] = true; else delete a.accounts[safeKey(account)];
    localStorage.setItem(DEMO_VALLOW, JSON.stringify(a));
    this._emitAllow();
    return Promise.resolve();
  };
  LocalBackend.prototype.setVoiceAllowAll = function (on) {
    var a = this._allow();
    a.all = !!on;
    if (!on) a.accounts = {};   // 關掉「全部開放」時，個別開放的也一起收回
    localStorage.setItem(DEMO_VALLOW, JSON.stringify(a));
    this._emitAllow();
    return Promise.resolve();
  };
  LocalBackend.prototype.watchVoiceAllow = function (cb) {
    var self = this;
    this.vAllowCb = cb;
    setTimeout(function () { self._emitAllow(); }, 0);
    return function () { self.vAllowCb = null; };
  };

  LocalBackend.prototype.setChatLock = function (on) {
    if (on) localStorage.setItem(DEMO_LOCK, '1'); else localStorage.removeItem(DEMO_LOCK);
    this._emitLock();
    return Promise.resolve();
  };

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

  /*
   * 教室分配：每間教室一位老師配幾個學生帳號，不同教室互相看不到對方的棋。
   * 設定寫在 config.js 的 rooms：[{ id, teacher, students: [...] }, ...]
   * （舊寫法只有 teachers 與 room：所有帳號共用一間教室，仍然相容。）
   */
  function roomList(cfg) {
    function low(v) { return String(v).toLowerCase(); }
    if (cfg && Array.isArray(cfg.rooms) && cfg.rooms.length) {
      return cfg.rooms.map(function (r) {
        return { id: String(r.id), teachers: [low(r.teacher)], students: (r.students || []).map(low) };
      });
    }
    return [{ id: (cfg && cfg.room) || 'main', teachers: ((cfg && cfg.teachers) || ['teacher']).map(low), students: null }];
  }

  /* 這個帳號屬於哪間教室、是老師還是學生。沒有分配到教室則回傳 null。 */
  function seatOf(cfg, account) {
    var rooms = roomList(cfg), a = String(account || '').toLowerCase(), i;
    for (i = 0; i < rooms.length; i++) {
      if (rooms[i].teachers.indexOf(a) >= 0) return { room: rooms[i].id, role: 'teacher' };
    }
    for (i = 0; i < rooms.length; i++) {
      if (!rooms[i].students || rooms[i].students.indexOf(a) >= 0) return { room: rooms[i].id, role: 'student' };
    }
    return null;
  }

  var NO_ROOM = '這個帳號還沒有分配教室，請向老師確認。';

  function FirebaseBackend(cfg) {
    var self = this;
    this.kind = 'firebase';
    this.cfg = cfg;
    this.domain = cfg.accountDomain || 'goclass.example.com';
    this.room = null;   // 登入後才知道是哪一間教室
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

      self.db.ref('.info/serverTimeOffset').on('value', function (s) { self.offset = s.val() || 0; });
      self.db.ref('.info/connected').on('value', function (s) {
        self.connected = !!s.val();
        if (self.connected) self._announce();   // 斷線重連後重新宣告在線
        if (self.connCb) self.connCb(self.connected);
      });
      self.auth.onAuthStateChanged(function (u) {
        if (u) {
          var account = String(u.email || '').toLowerCase().split('@')[0];
          var seat = seatOf(self.cfg, account);
          if (!seat) {
            // 帳號存在但沒有分配教室：直接登出（登出後會再進來這裡一次，走下面的 else）
            self.auth.signOut();
            return;
          }
          self.room = self.db.ref('rooms/' + seat.room);
          self.user = { account: account, role: seat.role, room: seat.room };
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
      email = email.trim().toLowerCase();
      return self.auth.signInWithEmailAndPassword(email, password).then(function () {
        if (!seatOf(self.cfg, email.split('@')[0])) throw new Error(NO_ROOM);
      });
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
    this.presenceRef.set({ role: this.presenceRole, account: this.user.account }).then(noop, noop);
  };

  FirebaseBackend.prototype.setPresence = function (role) {
    this.presenceRole = role;
    this._announce();
  };

  FirebaseBackend.prototype.watchPresence = function (cb) {
    var ref = this.room.child('presence');
    var handler = ref.on('value', function (s) {
      var all = s.val() || {}, out = { teacher: false, student: false, people: [] }, seen = {};
      Object.keys(all).forEach(function (k) {
        var role = all[k] && all[k].role, account = (all[k] && all[k].account) || '';
        if (role !== 'teacher' && role !== 'student') return;
        out[role] = true;
        // 同一個帳號開了兩個視窗只算一次
        if (seen[account + '|' + role]) return;
        seen[account + '|' + role] = true;
        out.people.push({ account: account, role: role });
      });
      cb(out);
    }, noop);
    return function () { ref.off('value', handler); };
  };

  FirebaseBackend.prototype.onConnection = function (cb) {
    this.connCb = cb;
    cb(this.connected);
  };

  FirebaseBackend.prototype.watchChat = function (cb) {
    var ref = this.room.child('chat').limitToLast(CHAT_KEEP);
    var handler = ref.on('value', function (s) {
      var list = [];
      s.forEach(function (c) {
        var v = c.val();
        if (v && v.x) { v.id = c.key; list.push(v); }
      });
      cb(list);
    }, noop);
    return function () { ref.off('value', handler); };
  };

  FirebaseBackend.prototype.sendChat = function (msg) {
    var m = chatMessage(this.user, msg, this.now());
    if (!m) return Promise.resolve();
    var ref = this.room.child('chat');
    return ref.push(m).then(function () {
      // 只留最近 CHAT_KEEP 則，舊的刪掉（資料庫不會越積越多）
      return ref.once('value').then(function (s) {
        var keys = [];
        s.forEach(function (c) { keys.push(c.key); });
        if (keys.length <= CHAT_KEEP + 20) return;
        var del = {};
        keys.slice(0, keys.length - CHAT_KEEP).forEach(function (k) { del[k] = null; });
        return ref.update(del);
      }).then(noop, noop);
    });
  };

  FirebaseBackend.prototype.clearChat = function () { return this.room.child('chat').remove(); };

  FirebaseBackend.prototype.watchChatLock = function (cb) {
    var ref = this.room.child('chatLock');
    var handler = ref.on('value', function (s) { cb(!!s.val()); }, noop);
    return function () { ref.off('value', handler); };
  };

  FirebaseBackend.prototype.setChatLock = function (on) {
    return this.room.child('chatLock').set(on ? true : null);
  };

  FirebaseBackend.prototype.setHand = function (on) {
    var ref = this.room.child('hands/' + safeKey(this.user.account));
    if (!on) return ref.remove();
    ref.onDisconnect().remove();   // 斷線（關掉網頁）就自動放下
    return ref.set({ a: this.user.account, t: this.now() });
  };

  FirebaseBackend.prototype.lowerHand = function (account) {
    return this.room.child('hands/' + safeKey(account)).remove();
  };

  /* --- 語音 --- */
  FirebaseBackend.prototype.voiceJoin = function (pid, info) {
    var member = this.room.child('voice/members/' + pid), inbox = this.room.child('voice/signal/' + pid);
    member.onDisconnect().remove();
    inbox.onDisconnect().remove();
    return member.set({ a: this.user.account, r: this.user.role, mic: !!info.mic, has: !!info.has, t: this.now() });
  };
  FirebaseBackend.prototype.voiceUpdate = function (pid, info) {
    return this.room.child('voice/members/' + pid).update({ mic: !!info.mic, has: !!info.has });
  };
  FirebaseBackend.prototype.voiceLeave = function (pid) {
    var v = this.room.child('voice'), del = {};
    del['members/' + pid] = null;
    del['signal/' + pid] = null;
    return v.update(del);
  };
  FirebaseBackend.prototype.watchVoiceMembers = function (cb) {
    var ref = this.room.child('voice/members');
    var handler = ref.on('value', function (s) {
      var out = [];
      s.forEach(function (c) {
        var v = c.val();
        if (v && v.a) out.push({ pid: c.key, a: v.a, r: v.r, mic: !!v.mic, has: !!v.has });
      });
      cb(out);
    }, noop);
    return function () { ref.off('value', handler); };
  };
  FirebaseBackend.prototype.voiceSend = function (toPid, msg) {
    return this.room.child('voice/signal/' + toPid).push(msg);
  };
  FirebaseBackend.prototype.watchVoiceInbox = function (pid, cb) {
    var ref = this.room.child('voice/signal/' + pid);
    var handler = ref.on('child_added', function (s) {
      var v = s.val();
      s.ref.remove().then(noop, noop);
      if (v) cb(v);
    }, noop);
    return function () { ref.off('child_added', handler); };
  };
  FirebaseBackend.prototype.setVoiceAllow = function (account, on) {
    return this.room.child('voice/allow/accounts/' + safeKey(account)).set(on ? true : null);
  };
  FirebaseBackend.prototype.setVoiceAllowAll = function (on) {
    return this.room.child('voice/allow').set(on ? { all: true } : null);
  };
  FirebaseBackend.prototype.watchVoiceAllow = function (cb) {
    var ref = this.room.child('voice/allow');
    var handler = ref.on('value', function (s) {
      var v = s.val() || {};
      cb({ all: !!v.all, accounts: v.accounts || {} });
    }, noop);
    return function () { ref.off('value', handler); };
  };

  FirebaseBackend.prototype.watchHands = function (cb) {
    var ref = this.room.child('hands');
    var handler = ref.on('value', function (s) { cb(sortHands(s.val())); }, noop);
    return function () { ref.off('value', handler); };
  };

  /* ================= 選擇要用哪一種 ================= */

  Go.Net = {
    seatOf: seatOf,
    safeKey: safeKey,
    /* 回傳連線物件；沒有設定 Firebase、也不是測試模式時回傳 null（純單機） */
    create: function (cfg, search) {
      var m = /[?&]demo=(teacher|student)\b/.exec(search || '');
      var as = /[?&]as=([^&]*)/.exec(search || '');
      if (m) return new LocalBackend(m[1], as ? decodeURIComponent(as[1]) : '');
      if (cfg && cfg.firebase && cfg.firebase.apiKey) return new FirebaseBackend(cfg);
      return null;
    }
  };
})(window);
