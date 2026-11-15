/*
 * 音效：落子與提示音用瀏覽器即時合成；讀秒語音用 audio 資料夾裡的音檔。
 * 瀏覽器規定要先有點擊才能出聲，所以第一次點畫面時才建立，並順便把語音檔載進來。
 *
 * 語音檔（想換成自己錄的聲音，用同樣的檔名蓋掉即可，WAV 格式）：
 *   1.wav ～ 10.wav  倒數「一」到「十」
 *   byo.wav          開始讀秒
 *   two.wav          剩下兩次讀秒
 *   last.wav         最後一次讀秒
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

  function loadVoice(a) {
    if (voiceLoading || !global.fetch) return;
    voiceLoading = true;
    VOICE.forEach(function (name) {
      global.fetch('audio/' + name + '.wav?v=2').then(function (res) {
        if (!res.ok) throw new Error('missing');
        return res.arrayBuffer();
      }).then(function (buf) {
        return new Promise(function (resolve, reject) { a.decodeAudioData(buf, resolve, reject); });
      }).then(function (decoded) {
        clips[name] = decoded;
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

    /* 落子：短促的「叩」一聲 */
    stone: function () {
      var a = audio();
      if (!a) return;
      var t = a.currentTime;
      var osc = a.createOscillator(), gain = a.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(950, t);
      osc.frequency.exponentialRampToValueAtTime(180, t + 0.07);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.5, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      osc.connect(gain);
      gain.connect(a.destination);
      osc.start(t);
      osc.stop(t + 0.14);
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

    /* 對局結束 */
    end: function () {
      tone(523, 0, 0.18, 0.25);
      tone(659, 0.16, 0.18, 0.25);
      tone(784, 0.32, 0.3, 0.25);
    }
  };
})(window);
