/*
 * 音效：落子與提示音用瀏覽器即時合成；讀秒語音用 audio 資料夾裡的音檔。
 * 瀏覽器規定要先有點擊才能出聲，所以第一次點畫面時才建立，並順便把語音檔載進來。
 *
 * 語音檔（微軟自然語音「曉曉」產生；想換成自己錄的聲音，用同樣的檔名蓋掉即可，MP3 格式）：
 *   1.mp3 ～ 10.mp3  倒數「一」到「十」
 *   byo.mp3          開始讀秒
 *   two.mp3          還剩兩次
 *   last.mp3         最後一次
 * 載入時會自動剪掉前後的空白，倒數才不會拖拍。
 */
(function (global) {
  'use strict';
  var Go = global.Go = global.Go || {};
  var ctx = null;

  var VOICE = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'byo', 'two', 'last'];
  var clips = {};          // 已載入的語音
  var voiceLoading = false;
  var speaking = null;     // 正在播放的語音
  var phraseUntil = 0;     // 整句提示播到什麼時候（這段時間內不讓倒數數字蓋掉它）
  var waiting = null;      // 語音檔還在載入時先記下要講的整句

  function audio() {
    if (!Go.Sound.enabled) return null;
    try {
      if (!ctx) {
        var AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume();
      loadVoice(ctx);
      return ctx;
    } catch (e) {
      return null;
    }
  }

  /* 剪掉語音前後的靜音（產生的音檔後面會補一段空白） */
  function trimSilence(a, buf) {
    try {
      var d = buf.getChannelData(0), th = 0.01, s = 0, e = d.length - 1;
      while (s < d.length && Math.abs(d[s]) < th) s++;
      while (e > s && Math.abs(d[e]) < th) e--;
      if (e <= s) return buf;
      s = Math.max(0, s - Math.round(buf.sampleRate * 0.01));
      e = Math.min(d.length - 1, e + Math.round(buf.sampleRate * 0.04));
      var out = a.createBuffer(buf.numberOfChannels, e - s + 1, buf.sampleRate);
      for (var ch = 0; ch < buf.numberOfChannels; ch++) out.getChannelData(ch).set(buf.getChannelData(ch).subarray(s, e + 1));
      return out;
    } catch (err) {
      return buf;
    }
  }

  function loadVoice(a) {
    if (voiceLoading || !global.fetch) return;
    voiceLoading = true;
    VOICE.forEach(function (name) {
      global.fetch('audio/' + name + '.mp3?v=3').then(function (res) {
        if (!res.ok) throw new Error('missing');
        return res.arrayBuffer();
      }).then(function (buf) {
        return new Promise(function (resolve, reject) { a.decodeAudioData(buf, resolve, reject); });
      }).then(function (decoded) {
        clips[name] = trimSilence(a, decoded);
        // 剛開局就要講的那一句（例如沒有基本時間、一開始就讀秒），載好後馬上補播
        if (waiting && waiting.name === name && Date.now() < waiting.until) {
          waiting = null;
          Go.Sound.say(name);
        }
      }).catch(function () { /* 載不到就維持用提示音 */ });
    });
  }

  /* 手機與平板要在「點擊當下」啟動聲音，之後由連線同步觸發的音效才播得出來 */
  function unlock() { audio(); }
  global.addEventListener('pointerdown', unlock, true);
  global.addEventListener('keydown', unlock, true);

  /* 落子聲用的白雜訊（建立一次重複使用） */
  var noiseBuf = null, curve = null;
  function noiseBuffer(a) {
    if (noiseBuf && noiseBuf.sampleRate === a.sampleRate) return noiseBuf;
    var len = Math.round(a.sampleRate * 0.1);
    noiseBuf = a.createBuffer(1, len, a.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }
  function softCurve() {
    if (curve) return curve;
    var n = 2048;
    curve = new Float32Array(n);
    for (var i = 0; i < n; i++) { var x = (i / (n - 1)) * 4 - 2; curve[i] = Math.tanh(x * 1.1) / Math.tanh(2.2); }
    return curve;
  }

  function tone(freq, start, dur, volume, type) {
    var a = audio();
    if (!a) return;
    var t = a.currentTime + start;
    var osc = a.createOscillator(), gain = a.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(a.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  Go.Sound = {
    enabled: true,

    /* 落子：響亮、短促的「搭」一聲（濾過的敲擊雜訊＋很快衰減的木頭共鳴，每一手音高稍有不同） */
    stone: function () {
      var a = audio();
      if (!a) return;
      var t = a.currentTime + 0.005, jitter = 1 + (Math.random() - 0.5) * 0.08;
      var out = a.createGain(), comp = a.createDynamicsCompressor(), mk = a.createGain(), lim = a.createWaveShaper();
      out.gain.value = 1.17;
      comp.threshold.value = -12; comp.ratio.value = 4; comp.attack.value = 0.0005; comp.release.value = 0.06;
      mk.gain.value = 2.8;
      lim.curve = softCurve();   // 柔性限幅：響亮但不破音
      out.connect(comp); comp.connect(mk); mk.connect(lim); lim.connect(a.destination);
      // 敲擊
      var src = a.createBufferSource(), hp = a.createBiquadFilter(), bp = a.createBiquadFilter(), g = a.createGain();
      src.buffer = noiseBuffer(a);
      hp.type = 'highpass'; hp.frequency.value = 1100;
      bp.type = 'bandpass'; bp.frequency.value = 2600 * jitter; bp.Q.value = 1.6;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(2.2, t + 0.0015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.014);
      src.connect(hp); hp.connect(bp); bp.connect(g); g.connect(out);
      src.start(t); src.stop(t + 0.035);
      // 木頭共鳴
      [[2100, 0.20, 0.018], [900, 0.22, 0.02], [320, 0.20, 0.022]].forEach(function (b) {
        var o = a.createOscillator(), og = a.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(b[0] * jitter, t);
        o.frequency.exponentialRampToValueAtTime(b[0] * jitter * 0.92, t + b[2]);
        og.gain.setValueAtTime(0.0001, t);
        og.gain.exponentialRampToValueAtTime(b[1], t + 0.002);
        og.gain.exponentialRampToValueAtTime(0.0001, t + b[2]);
        o.connect(og); og.connect(out);
        o.start(t); o.stop(t + b[2] + 0.02);
      });
    },

    /* 讀秒倒數：每秒一聲，最後三秒音調較高（語音檔載不到時的替代） */
    tick: function (urgent) { tone(urgent ? 1320 : 880, 0, 0.09, 0.25); },

    /* 播放一段語音。name 是 '1'～'10'（倒數）或 'byo'、'two'、'last'（整句提示）。
       回傳 false 表示語音還沒載入，呼叫的人可以改用提示音。 */
    say: function (name) {
      var a = audio();
      if (!a) return true;                    // 音效關閉：不出聲，也不需要替代音
      var clip = clips[name];
      var isNumber = /^\d+$/.test(name);
      if (!clip) {
        if (!isNumber) waiting = { name: name, until: Date.now() + 2000 };
        return false;
      }
      if (isNumber && a.currentTime < phraseUntil) return true;   // 整句還沒講完，這一秒不報數
      if (speaking) {
        try { speaking.stop(); } catch (e) { /* 已經播完 */ }
      }
      var src = a.createBufferSource(), gain = a.createGain();
      src.buffer = clip;
      gain.gain.value = 1;
      src.connect(gain);
      gain.connect(a.destination);
      src.start();
      speaking = src;
      phraseUntil = isNumber ? 0 : a.currentTime + clip.duration;
      return true;
    },

    /* 停一手、申請被同意等一般提示 */
    notice: function () { tone(660, 0, 0.12, 0.2); },

    /* 上課／下課的鐘聲（學校的「噹噹噹噹」）：up = true 上課、false 下課 */
    chime: function (up) {
      var notes = up ? [659.25, 523.25, 587.33, 392.0] : [392.0, 587.33, 659.25, 523.25];
      for (var i = 0; i < notes.length; i++) {
        tone(notes[i], i * 0.42, 1.1, 0.22, 'sine');
        tone(notes[i] * 2, i * 0.42, 0.6, 0.05, 'sine');   // 一點泛音，聽起來比較像鐘
      }
    },

    /* 對局結束 */
    end: function () {
      tone(523, 0, 0.18, 0.25);
      tone(659, 0.16, 0.18, 0.25);
      tone(784, 0.32, 0.3, 0.25);
    }
  };
})(window);
