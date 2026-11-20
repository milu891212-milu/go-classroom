/*
 * 語音：教室裡每個加入語音的人兩兩直接連線（WebRTC），聲音不經過伺服器。
 * 連線前要交換的資訊（offer／answer／ice）透過 net.js 傳遞。
 *
 *   var v = new Go.Voice(net, { account, role }, { iceServers, fakeMic });
 *   v.onChange = function () { 畫面更新 };
 *   v.start()          開始看「誰在語音裡」與開麥權限（還沒加入，聽不到也說不了）
 *   v.join()           加入語音（會詢問麥克風權限；沒有麥克風也能只聽）
 *   v.leave()
 *   v.setMic(on)       自己的麥克風開關
 *   v.stop()           登出時呼叫
 *
 * 學生的聲音要「自己的麥克風開著」而且「老師開放說話」才會送出；老師一律可以說話。
 */
(function (global) {
  'use strict';
  var Go = global.Go = global.Go || {};

  var DEFAULT_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

  function randomId() {
    return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* 測試用的假麥克風：一直發出小小的嗡嗡聲 */
  function fakeStream() {
    var Ctx = global.AudioContext || global.webkitAudioContext;
    var ctx = new Ctx(), osc = ctx.createOscillator(), gain = ctx.createGain(), dest = ctx.createMediaStreamDestination();
    osc.frequency.value = 440;
    gain.gain.value = 0.2;
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    return dest.stream;
  }

  function Voice(net, me, opts) {
    this.net = net;
    this.me = me;
    this.iceServers = (opts && opts.iceServers) || DEFAULT_ICE;
    this.fakeMic = !!(opts && opts.fakeMic);
    this.onChange = null;
    this.members = [];           // 語音裡的人 [{ pid, a, r, mic, has }]
    this.allow = { all: false, accounts: {} };
    this.joined = false;
    this.joining = false;
    this.pid = '';
    this.stream = null;          // 自己的麥克風；null = 沒有麥克風或不允許，只能聽
    this.micOn = true;           // 自己的麥克風開關
    this.micError = '';
    this.peers = {};             // pid → { pc, audio, state, queue: [] }
    this.stops = [];
    this.inboxStop = null;
  }

  Voice.prototype._emit = function () { if (this.onChange) this.onChange(); };

  Voice.prototype.start = function () {
    var self = this;
    this.stops.push(this.net.watchVoiceMembers(function (list) {
      self.members = list;
      self._sync();
      self._emit();
    }));
    this.stops.push(this.net.watchVoiceAllow(function (a) {
      self.allow = a;
      self._applyMic();
      self._emit();
    }));
  };

  Voice.prototype.stop = function () {
    this.leave();
    this.stops.forEach(function (f) { f(); });
    this.stops = [];
  };

  /* 這個帳號是否被允許說話 */
  Voice.prototype.allowed = function (account, role) {
    if (role === 'teacher') return true;
    return !!(this.allow.all || this.allow.accounts[Go.Net.safeKey(account)]);
  };
  Voice.prototype.canSpeak = function () { return this.allowed(this.me.account, this.me.role); };
  Voice.prototype.speaking = function () { return !!this.stream && this.micOn && this.canSpeak(); };

  Voice.prototype.join = function () {
    var self = this;
    if (this.joined || this.joining) return Promise.resolve();
    this.joining = true;
    this.micError = '';
    this._emit();
    var get;
    if (this.fakeMic) {
      get = Promise.resolve(fakeStream());
    } else if (global.navigator.mediaDevices && global.navigator.mediaDevices.getUserMedia) {
      get = global.navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false
      });
    } else {
      get = Promise.reject(new Error('unsupported'));
    }
    return get.then(null, function (err) {
      var name = err && err.name;
      self.micError = name === 'NotAllowedError' ? '沒有允許使用麥克風，只能聽不能說。要說話請在瀏覽器網址列旁允許麥克風後重新加入。'
        : name === 'NotFoundError' ? '這台裝置找不到麥克風，只能聽不能說。'
        : '無法使用麥克風，只能聽不能說。';
      return null;
    }).then(function (stream) {
      self.stream = stream;
      self.pid = randomId();
      self.joined = true;
      self.joining = false;
      self._applyMic();
      self.inboxStop = self.net.watchVoiceInbox(self.pid, function (m) { self._onMessage(m); });
      return self.net.voiceJoin(self.pid, self._info());
    }).then(function () {
      self._sync();
      self._emit();
    }, function () {
      self.joining = false;
      self.leave();
      self.micError = '連線有問題，沒有加入語音。';
      self._emit();
    });
  };

  Voice.prototype.leave = function () {
    var self = this, pid = this.joined ? this.pid : '';
    // 先標成「已離開」再通知大家：通知時名單會更新，不能再對任何人撥號
    this.joined = false;
    this.pid = '';
    if (this.inboxStop) { this.inboxStop(); this.inboxStop = null; }
    Object.keys(this.peers).forEach(function (p) { self._drop(p); });
    if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); });
    this.stream = null;
    var done = pid ? this.net.voiceLeave(pid).then(null, function () {}) : Promise.resolve();
    this._emit();
    return done;
  };

  Voice.prototype.setMic = function (on) {
    this.micOn = !!on;
    this._applyMic();
    if (this.joined) this.net.voiceUpdate(this.pid, this._info()).then(null, function () {});
    this._emit();
  };

  Voice.prototype._info = function () { return { mic: this.micOn, has: !!this.stream }; };

  /* 依權限打開或關掉送出去的聲音（不用重新連線） */
  Voice.prototype._applyMic = function () {
    var on = this.speaking();
    if (this.stream) this.stream.getAudioTracks().forEach(function (t) { t.enabled = on; });
  };

  /* 依目前語音裡的人建立或拆掉連線。兩人之間由 pid 比較小的一方主動撥。 */
  Voice.prototype._sync = function () {
    if (!this.joined) return;
    var self = this, live = {};
    this.members.forEach(function (m) {
      if (m.pid === self.pid) return;
      live[m.pid] = true;
      if (!self.peers[m.pid] && self.pid < m.pid) self._call(m.pid);
    });
    Object.keys(this.peers).forEach(function (pid) { if (!live[pid]) self._drop(pid); });
  };

  Voice.prototype._peer = function (pid) {
    var self = this;
    var pc = new global.RTCPeerConnection({ iceServers: this.iceServers });
    var audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.hidden = true;
    document.body.appendChild(audio);
    var peer = { pc: pc, audio: audio, state: 'connecting', queue: [] };
    this.peers[pid] = peer;
    if (this.stream) {
      this.stream.getAudioTracks().forEach(function (t) { pc.addTrack(t, self.stream); });
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    pc.onicecandidate = function (ev) {
      if (ev.candidate) self._send(pid, 'ice', JSON.stringify(ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate));
    };
    pc.ontrack = function (ev) {
      audio.srcObject = (ev.streams && ev.streams[0]) || new global.MediaStream([ev.track]);
      var p = audio.play();
      if (p && p.catch) p.catch(function () { /* 瀏覽器擋自動播放時，下一次點畫面會再試 */ });
    };
    pc.onconnectionstatechange = function () {
      var s = pc.connectionState;
      peer.state = s === 'connected' ? 'connected' : s === 'failed' ? 'failed' : s === 'disconnected' ? 'connecting' : peer.state;
      self._emit();
    };
    pc.oniceconnectionstatechange = function () {
      // 舊版 Safari 沒有 connectionState，改看 iceConnectionState
      if (pc.connectionState) return;
      var s = pc.iceConnectionState;
      peer.state = s === 'connected' || s === 'completed' ? 'connected' : s === 'failed' ? 'failed' : peer.state;
      self._emit();
    };
    return peer;
  };

  Voice.prototype._send = function (pid, kind, data) {
    this.net.voiceSend(pid, { f: this.pid, k: kind, d: data }).then(null, function () {});
  };

  Voice.prototype._call = function (pid) {
    var self = this, pc = this._peer(pid).pc;
    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer).then(function () { self._send(pid, 'offer', offer.sdp); });
    }).then(null, function () { self._fail(pid); });
  };

  Voice.prototype._flush = function (peer) {
    var q = peer.queue;
    peer.queue = [];
    q.forEach(function (c) { peer.pc.addIceCandidate(c).then(null, function () {}); });
  };

  Voice.prototype._onMessage = function (m) {
    if (!this.joined || !m || !m.f) return;
    var self = this, peer = this.peers[m.f];
    if (m.k === 'offer') {
      if (peer) this._drop(m.f);   // 對方重新撥過來（例如重新整理）：用新的連線
      peer = this._peer(m.f);
      var pc = peer.pc;
      pc.setRemoteDescription({ type: 'offer', sdp: m.d }).then(function () {
        self._flush(peer);
        return pc.createAnswer();
      }).then(function (answer) {
        return pc.setLocalDescription(answer).then(function () { self._send(m.f, 'answer', answer.sdp); });
      }).then(null, function () { self._fail(m.f); });
    } else if (m.k === 'answer' && peer) {
      peer.pc.setRemoteDescription({ type: 'answer', sdp: m.d }).then(function () { self._flush(peer); },
        function () { self._fail(m.f); });
    } else if (m.k === 'ice' && peer) {
      var cand;
      try { cand = JSON.parse(m.d); } catch (e) { return; }
      if (peer.pc.remoteDescription) peer.pc.addIceCandidate(cand).then(null, function () {});
      else peer.queue.push(cand);
    }
  };

  Voice.prototype._fail = function (pid) {
    if (this.peers[pid]) this.peers[pid].state = 'failed';
    this._emit();
  };

  Voice.prototype._drop = function (pid) {
    var peer = this.peers[pid];
    if (!peer) return;
    try { peer.pc.close(); } catch (e) { /* 忽略 */ }
    peer.audio.srcObject = null;
    peer.audio.remove();
    delete this.peers[pid];
  };

  /* 瀏覽器擋掉自動播放時，使用者點一下畫面就重新播放 */
  Voice.prototype.resumeAudio = function () {
    var self = this;
    Object.keys(this.peers).forEach(function (pid) {
      var a = self.peers[pid].audio;
      if (a.srcObject && a.paused) { var p = a.play(); if (p && p.catch) p.catch(function () {}); }
    });
  };

  /* 和某人的連線狀態：'connecting' | 'connected' | 'failed' | ''（自己或沒有連線） */
  Voice.prototype.peerState = function (pid) {
    return this.peers[pid] ? this.peers[pid].state : '';
  };

  Go.Voice = Voice;
})(window);
