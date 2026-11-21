/*
 * 畫面流程：（登入）→ 首頁 → 棋譜瀏覽 → 對弈（下棋中 → 數目 → 結束）。
 * 講解房也走「對弈」畫面：它是一盤 lecture = true、一直停在擺棋講解的 game（見 match.js 的 createLecture）。
 *
 * 兩種使用方式共用同一套畫面：
 *   單機：兩人共用一台裝置，黑白都在這個畫面操作。
 *   連線：老師與學生各自登入，各自只能操作自己的顏色，對局狀態經由 net.js 同步。
 */
(function () {
  'use strict';
  var E = Go.Engine, S = Go.SGF, G = Go.Game, M = Go.Match, Sound = Go.Sound;
  var BLACK = Go.BLACK, WHITE = Go.WHITE;
  function $(id) { return document.getElementById(id); }
  function side(color) { return G.colorName(color) + '方'; }
  function key(color) { return color === BLACK ? 'b' : 'w'; }

  /* ---------- 連線與身分 ---------- */
  var net = Go.Net.create(window.GO_CONFIG || {}, location.search); // null = 沒有連線設定，純單機
  var session = null;        // 已登入：{ account, role: 'teacher' | 'student' }
  var solo = false;          // 有連線設定，但選擇不登入、單機使用
  var connected = true;
  var presence = { teacher: false, student: false, people: [] };
  var stopWatching = [];
  var loginState = { ready: false, authKnown: false, failed: '' };

  /* 暱稱（config.js 的 names）：畫面上顯示用，資料裡仍然用帳號 */
  var NICK = (function () {
    var src = (window.GO_CONFIG && window.GO_CONFIG.names) || {}, out = {};
    Object.keys(src).forEach(function (k) { if (src[k]) out[k.toLowerCase()] = String(src[k]); });
    return out;
  })();
  function nick(account) { return NICK[String(account || '').toLowerCase()] || account; }
  function nameOf(account, role) {
    return role === 'teacher' ? (NICK[String(account || '').toLowerCase()] || '老師') : nick(account);
  }

  function online() { return !!session; }
  function isTeacher() { return online() && session.role === 'teacher'; }
  function now() { return online() ? net.now() : Date.now(); }
  /* 連線時我執哪一色（單機回傳 0） */
  function myColor() {
    var g = state.game;
    if (!online() || !g || !g.teacherColor) return 0;
    if (isTeacher()) return g.teacherColor;
    if (isWatcher()) return 0;
    return E.other(g.teacherColor);
  }
  /* 連線對弈時，這位學生不是老師指定的對手：只能觀戰 */
  function isWatcher() {
    var g = state.game;
    return online() && !isTeacher() && !!g && !!g.teacherColor && !!g.student && g.student !== session.account;
  }
  /* 這台裝置能不能替 color 這一方操作 */
  function controls(color) { return !online() || myColor() === color; }

  /* ---------- 偏好設定（只存在這台裝置） ---------- */
  var PREF_KEY = 'go-classroom-prefs';
  var prefs = {
    numbers: false,
    confirm: false,
    sound: true,
    rule: 'territory',   // 上次選的數目方式：'territory' 比目法、'area' 數子法
    time: { preset: '300,30,3', main: 20, byo: 30, periods: 3 }
  };
  try {
    var saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (saved.rule === 'area') prefs.rule = 'area';
    prefs.numbers = !!saved.numbers;
    prefs.confirm = !!saved.confirm;
    if (saved.sound === false) prefs.sound = false;
    if (saved.time && typeof saved.time.preset === 'string') {
      prefs.time.preset = saved.time.preset;
      ['main', 'byo', 'periods'].forEach(function (k) {
        if (typeof saved.time[k] === 'number' && isFinite(saved.time[k])) prefs.time[k] = saved.time[k];
      });
    }
  } catch (e) { /* 讀不到就用預設值 */ }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* 存不了不影響使用 */ }
  }
  Sound.enabled = prefs.sound;

  /* ---------- 狀態 ---------- */
  var state = {
    mode: net ? 'login' : 'home',   // login | home | wait | review | play
    source: null,      // 載入的棋譜（瀏覽用，不會被對弈改動）
    cursor: 0,         // 瀏覽到第幾步
    returnCursor: 0,   // 對局結束後回到棋譜的哪一步
    game: null,        // 對弈中的完整狀態（見 match.js）
    snap: null,        // 上一次看到的對局摘要，用來判斷發生了什麼事（連線用）
    pending: -1,       // 「落子前先確認」時暫定的落點
    hover: -1,
    pos: null,         // 目前畫面上的局面
    tool: 'alt'        // 老師擺棋時選的工具：alt / b / w（擺子）、tri / sq / cir / x / letter（標記）、pen / arrow（畫線）
  };
  var RULE_NAME = { territory: '比目法', area: '數子法' };
  var STONE_TOOL = { alt: 0, b: BLACK, w: WHITE };
  var DRAW_TOOL = { pen: true, arrow: true };
  /* 這台裝置能不能開始／結束擺棋講解（連線時只有老師；單機都可以） */
  function canTeach() { return !online() || isTeacher(); }

  /*
   * 擺棋時這台裝置能做什麼（看老師設定的 demo.who）：
   *   admin  結束擺棋、設定學生權限
   *   nav    上一手／下一手、結束試下
   *   marks  加標記
   *   stones 擺變化
   *   turns  學生持黑／持白：老師和學生各擺一色輪流，只有輪到自己的顏色時才能擺
   */
  function demoRights(g) {
    var none = { admin: false, nav: false, marks: false, stones: false, turns: false };
    if (!g || g.status !== 'demo' || !g.demo) return none;
    var who = g.demo.who, turns = who === 'black' || who === 'white';
    if (!online()) return { admin: true, nav: true, marks: true, stones: true, turns: false };
    if (isTeacher()) return { admin: true, nav: true, marks: true, stones: true, turns: turns };
    if (who === 'free') return { admin: false, nav: true, marks: true, stones: true, turns: false };
    if (who === 'stage') {
      return g.demo.stage === session.account ? { admin: false, nav: true, marks: true, stones: true, turns: false } : none;
    }
    if (turns && (!g.demo.stage || g.demo.stage === session.account)) {
      return { admin: false, nav: false, marks: false, stones: true, turns: true };
    }
    return none;
  }
  /* 學生持黑／持白時，這台裝置擺哪一色 */
  function myDemoColor(g) {
    var student = g.demo.who === 'black' ? BLACK : WHITE;
    return isTeacher() ? E.other(student) : student;
  }
  /* 輪流擺時，下一手（盤上最後一手的另一方）是不是這台裝置的顏色 */
  function myDemoTurn(g) { return M.demoNextColor(g) === myDemoColor(g); }
  /* 實際要用的工具：沒有標記權限時一律是擺子；一人一手時固定黑白輪流 */
  function demoTool(g) {
    var r = demoRights(g), isStone = STONE_TOOL[state.tool] !== undefined;
    if (!isStone && !r.marks) return 'alt';
    if (isStone && r.turns) return 'alt';
    return state.tool;
  }
  var byoAnnounced = {};   // 各方進入讀秒後，上次看到的剩餘次數（還沒進讀秒則沒有值）
  var beepKey = '';        // 避免同一秒重複響
  var timeoutBusy = false; // 正在送出「超時」

  var view = new Go.BoardView($('board'));

  function hasNewMoves() { return state.mode === 'play' && M.newMoves(state.game) > 0; }

  /* ---------- 小工具 ---------- */
  var toastTimer = 0;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  function ask(title, text, okLabel, cancelLabel) {
    return new Promise(function (resolve) {
      var dlg = $('dlgAsk');
      $('askTitle').textContent = title;
      $('askText').textContent = text;
      $('askOk').textContent = okLabel;
      $('askCancel').textContent = cancelLabel || '取消';
      // 按下按鈕的當下就回覆結果，不等瀏覽器的 close 事件（那個事件有時會晚將近一秒才來）
      var settled = false;
      function finish(result) {
        if (settled) return;
        settled = true;
        $('askOk').removeEventListener('click', onOk);
        $('askCancel').removeEventListener('click', onCancel);
        dlg.removeEventListener('close', onClose);
        if (dlg.open) dlg.close();
        resolve(result);
      }
      function onOk() { finish(true); }
      function onCancel() { finish(false); }
      function onClose() { if (!dlg.open) finish(false); } // 按 Esc
      $('askOk').addEventListener('click', onOk);
      $('askCancel').addEventListener('click', onCancel);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
    });
  }

  function closeGameDialogs() {
    if ($('dlgAsk').open) $('dlgAsk').close();
    if ($('dlgRequest').open) $('dlgRequest').close();
  }

  function playerName(info, black) {
    var name = black ? info.pb : info.pw, rank = black ? info.br : info.wr;
    if (!name) return black ? '黑方' : '白方';
    return rank ? name + ' ' + rank : name;
  }

  function lastMoveBefore(record, n) {
    for (var i = Math.min(n, record.moves.length) - 1; i >= 0; i--) {
      if (!record.moves[i].edit) return record.moves[i];
    }
    return null;
  }

  function two(v) { return (v < 10 ? '0' : '') + v; }
  function formatTime(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + two(m) : String(m)) + ':' + two(sec);
  }

  function infoRows(box, rows) {
    box.textContent = '';
    rows.forEach(function (r) {
      if (!r[1]) return;
      var div = document.createElement('div'), a = document.createElement('span'), b = document.createElement('span');
      a.textContent = r[0];
      b.textContent = r[1];
      div.appendChild(a);
      div.appendChild(b);
      box.appendChild(div);
    });
  }

  function checkedValue(name) {
    return parseInt(document.querySelector('input[name="' + name + '"]:checked').value, 10);
  }

  /* ---------- 計時設定（首頁與「從局面開始」共用） ---------- */
  var TIME_PRESETS = [
    ['none', '不計時'],
    ['60,20,3', '1 分＋20 秒 × 3 次'],
    ['300,30,3', '5 分＋30 秒 × 3 次'],
    ['3600,60,3', '60 分＋60 秒 × 3 次'],
    ['custom', '自訂']
  ];
  function clampNum(v, lo, hi) {
    var n = parseFloat(v);
    if (isNaN(n)) n = lo;
    return Math.max(lo, Math.min(hi, n));
  }
  function timePicker(prefix) {
    var sel = $(prefix + 'Time'), box = $(prefix + 'TimeCustom');
    var main = $(prefix + 'TimeMain'), byo = $(prefix + 'TimeByo'), per = $(prefix + 'TimePeriods');
    TIME_PRESETS.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p[0];
      o.textContent = p[1];
      sel.appendChild(o);
    });
    function sync() { box.hidden = sel.value !== 'custom'; }
    sel.addEventListener('change', sync);
    return {
      show: function () {
        sel.value = prefs.time.preset;
        if (sel.selectedIndex < 0) {
          // 上次選的是已經拿掉的選項（例如 20 分＋30 秒 × 3 次）：改成自訂並帶入同樣的數字
          var old = /^(\d+),(\d+),(\d+)$/.exec(prefs.time.preset);
          if (old) {
            prefs.time.main = Math.round(old[1] / 60);
            prefs.time.byo = +old[2];
            prefs.time.periods = +old[3];
            prefs.time.preset = 'custom';
          } else {
            prefs.time.preset = 'none';
          }
          sel.value = prefs.time.preset;
        }
        main.value = prefs.time.main;
        byo.value = prefs.time.byo;
        per.value = prefs.time.periods;
        sync();
      },
      /* 回傳 { main: 秒, byo: 秒, periods: 次 }，不計時則回傳 null；同時記住這次的選擇 */
      read: function () {
        var cfg = null;
        if (sel.value === 'custom') {
          prefs.time.main = clampNum(main.value, 0, 600);
          prefs.time.byo = Math.round(clampNum(byo.value, 0, 600));
          prefs.time.periods = Math.round(clampNum(per.value, 0, 99));
          cfg = { main: Math.round(prefs.time.main * 60), byo: prefs.time.byo, periods: prefs.time.periods };
        } else if (sel.value !== 'none') {
          var a = sel.value.split(',').map(Number);
          cfg = { main: a[0], byo: a[1], periods: a[2] };
        }
        prefs.time.preset = sel.value;
        savePrefs();
        return cfg;
      }
    };
  }
  var newTime = timePicker('new'), startTime = timePicker('start');
  newTime.show();

  /* ---------- 對局動作：單機直接改，連線則送到資料庫 ---------- */

  /*
   * fn(game) 對 game 做修改；回傳 false 代表這個動作不成立、什麼都不要改。
   * 連線時 fn 會以資料庫裡最新的對局為準執行（可能執行不只一次），所以 fn 裡不能有畫面操作。
   */
  function act(fn) {
    if (online()) {
      return net.updateGame(function (raw) {
        var g = M.normalize(raw);
        if (!g) return undefined;
        return fn(g) === false ? undefined : g;
      }).then(null, function () {
        toast('連線有問題，剛才的動作沒有送出');
        return false;
      });
    }
    var g = state.game, prev = snapshot(g);
    var ok = fn(g) !== false;
    if (ok) effects(prev, g);
    render();
    return Promise.resolve(ok);
  }

  function snapshot(g) {
    return {
      n: g.record.moves.length,
      status: g.status,
      reply: g.reply ? g.reply.n : 0,
      demo: g.demo ? g.demo.base + g.demo.moves.length : 0,  // 擺棋時盤面走到第幾步
      who: g.demo ? g.demo.who : '',
      stage: g.demo ? g.demo.stage : '',
      quiz: g.quiz ? g.quiz.n + ':' + g.quiz.state : ''
    };
  }

  /* 學生擺棋權限的說明（toast = true 是權限剛改變時跳出的提示） */
  function whoText(g, isToast) {
    var who = g.demo.who, name = g.demo.stage, teacher = isTeacher();
    var me = online() && !teacher && !!name && name === session.account;
    if (who === 'teacher') return isToast ? '回到老師擺' : teacher ? '' : '請看棋盤';
    if (who === 'free') return teacher ? '全部學生都可以擺' : '大家都可以擺';
    if (who === 'stage') return teacher ? nick(name) + ' 自由擺' : me ? (isToast ? '老師請你上台擺！' : '你可以擺') : nick(name) + ' 在擺';
    var c = who === 'black' ? '黑' : '白', t = who === 'black' ? '白' : '黑';
    if (teacher) return (name ? nick(name) : '全部學生') + '持' + c + '，跟老師輪流擺';
    if (!name || me) return '你持' + c + '、老師持' + t + '，輪流擺';
    return nick(name) + '持' + c + '，跟老師輪流擺';
  }

  /* 比對前後狀態，發出對應的音效與提示（自己或對方的動作都走這裡） */
  function effects(prev, g) {
    if (!prev) return;
    var n = g.record.moves.length;
    if (n !== prev.n) { state.pending = -1; beepKey = ''; }

    // 老師擺棋講解：開始、結束、擺了一顆變化
    if (g.status === 'demo') {
      if (prev.status !== 'demo') {
        closeGameDialogs();
        Sound.notice();
        toast(prev.status === 'playing' ? '對局暫停，開始擺棋講解' : '開始擺棋講解');
      } else {
        if (g.demo.base + g.demo.moves.length > prev.demo) Sound.stone();
        var quizKey = g.quiz ? g.quiz.n + ':' + g.quiz.state : '';
        if (quizKey !== prev.quiz && g.quiz && online()) {
          Sound.notice();
          if (g.quiz.state === 'open' && !isTeacher()) toast('老師出題：點棋盤選下一手');
        } else if (prev.who && (g.demo.who !== prev.who || g.demo.stage !== prev.stage) && online()) {
          Sound.notice();
          toast(whoText(g, true));
        }
      }
      return;
    }
    if (prev.status === 'demo') {
      Sound.notice();
      toast(g.status === 'playing' ? '回到對局，輪到' + side(g.turn) : '結束擺棋講解');
      return;
    }

    if (g.status === 'finished' && prev.status !== 'finished') {
      closeGameDialogs();
      Sound.end();
      toast(g.result.text);
      return;
    }
    if (n === prev.n + 1) {
      var m = g.record.moves[n - 1];
      if (m.p >= 0) Sound.stone();
      else {
        Sound.notice();
        if (g.status === 'playing') toast(side(m.c) + '停一手');
      }
    } else if (n < prev.n) {
      Sound.notice();
    }
    if (g.status === 'scoring' && prev.status === 'playing') {
      toast(n === prev.n + 1 ? '雙方都停一手，開始數目' : '開始數目，請標記死子');
    } else if (g.status === 'playing' && prev.status === 'scoring') {
      toast('繼續對局，輪到' + side(g.turn));
    }
    if (g.reply && g.reply.n !== prev.reply && controls(g.reply.from)) {
      toast(side(E.other(g.reply.from)) + (g.reply.ok ? '同意了' : '不同意'));
    }
  }

  /* 連線：資料庫裡的對局有變動（包含自己剛送出的動作） */
  var firstGameEvent = true;   // 登入後第一次讀到的對局（重新整理時）不跳「老師開始了」的提示
  function onRemoteGame(raw) {
    var g = M.normalize(raw);
    var wasPlaying = state.mode === 'play', initial = firstGameEvent;
    firstGameEvent = false;
    if (g) {
      state.game = g;
      if (!wasPlaying) {
        state.mode = 'play';
        state.pending = -1;
        byoAnnounced = {};
        beepKey = '';
        if (!isTeacher() && !initial) {
          Sound.notice();
          toast(g.lecture ? '老師開了講解房' : '老師開始了對局');
        }
      } else {
        effects(state.snap, g);
      }
      state.snap = snapshot(g);
    } else if (wasPlaying) {
      var wasLecture = state.game && state.game.lecture;
      closeGameDialogs();
      state.game = null;
      state.snap = null;
      state.pending = -1;
      if (isTeacher()) {
        if (state.source) { state.mode = 'review'; state.cursor = state.returnCursor; }
        else state.mode = 'home';
      } else {
        state.mode = 'wait';
        toast(wasLecture ? '老師結束了講解' : '老師結束了這盤對局');
      }
    }
    render();
  }

  /* ---------- 畫面更新 ---------- */
  function render() {
    var m = state.mode, table = m === 'review' || m === 'play';
    $('login').hidden = m !== 'login';
    $('home').hidden = m !== 'home';
    $('wait').hidden = m !== 'wait';
    $('table').hidden = !table;

    $('btnHome').hidden = !(m === 'review' || (m === 'play' && (!online() || isTeacher())));
    $('who').hidden = !online();
    if (online()) $('who').textContent = nick(session.account) + '・' + (isTeacher() ? '老師' : '學生');
    $('btnLogout').hidden = !online();
    $('btnLogout').textContent = net && net.kind === 'demo' ? '離開測試' : '登出';
    $('btnLogin').hidden = !(net && !online() && m !== 'login');
    $('connTag').hidden = !(online() && !connected);
    $('newSeatRow').hidden = !isTeacher();
    $('startSeatRow').hidden = !isTeacher();
    $('newStudentRow').hidden = !isTeacher();
    $('startStudentRow').hidden = !isTeacher();
    $('demoBox').hidden = !!net;
    view.setDrawMode('');   // 畫線模式只在擺棋時由 renderPlay 打開

    if (m === 'login') renderLogin();
    renderPresence();
    renderChat();
    if (!table) { $('modeTag').textContent = ''; return; }
    if (m === 'play') renderPlay(); else renderReview();
    updateClocks();
  }

  function renderLogin() {
    var ok = loginState.ready && loginState.authKnown && !loginState.failed;
    $('loginHint').textContent = loginState.failed ? loginState.failed
      : ok ? '請輸入老師發給你的帳號與密碼。' : '連線準備中…';
    $('btnSignIn').disabled = !ok;
  }

  function renderPresence() {
    $('waitTeacher').textContent = presence.teacher ? '老師目前在線上。' : '老師目前不在線上。';
    renderPeople();
    if (isTeacher()) { fillStudents($('newStudent')); fillStudents($('startStudent')); }
    if (state.mode === 'play' && state.game && state.game.status === 'demo' && isTeacher()) {
      renderStage(state.game);
      renderQuiz(state.game, true);
    }
    var g = state.game, show = state.mode === 'play' && online() && g && g.teacherColor;
    [[BLACK, 'B'], [WHITE, 'W']].forEach(function (pair) {
      var el = $('pres' + pair[1]);
      var mine = show && myColor() === pair[0];
      el.hidden = !show || mine;
      if (!show || mine) return;
      var on = g.teacherColor === pair[0] ? presence.teacher
        : g.student ? (presence.people || []).some(function (p) { return p.role === 'student' && p.account === g.student; })
        : presence.student;
      el.textContent = on ? '在線' : '離線';
      el.className = 'presence ' + (on ? 'on' : 'off');
    });
  }

  function cardName(record, color) {
    var g = state.game;
    if (state.mode === 'play' && online() && g.teacherColor) {
      return (g.teacherColor === color ? '老師' : (g.student ? nick(g.student) : '學生')) + (myColor() === color ? '（你）' : '');
    }
    return playerName(record.info, color === BLACK);
  }

  function renderPlayers(record, pos, active, winner) {
    $('nameB').textContent = cardName(record, BLACK);
    $('nameW').textContent = cardName(record, WHITE);
    $('capB').textContent = pos.caps[BLACK];
    $('capW').textContent = pos.caps[WHITE];
    $('playerB').classList.toggle('active', active === BLACK);
    $('playerW').classList.toggle('active', active === WHITE);
    $('playerB').classList.toggle('winner', winner === BLACK);
    $('playerW').classList.toggle('winner', winner === WHITE);
  }

  function setStatus(mainText, subText) {
    var status = $('status');
    status.textContent = '';
    var main = document.createElement('span'), sub = document.createElement('small');
    main.textContent = mainText;
    sub.textContent = subText;
    status.appendChild(main);
    status.appendChild(sub);
  }

  function renderReview() {
    var record = state.source, n = state.cursor;
    var pos = G.replay(record, n);
    state.pos = pos;
    $('modeTag').textContent = '棋譜瀏覽';

    view.setSize(record.size);
    view.render({ board: pos.board, last: pos.last, numbers: prefs.numbers ? pos.numbers : null, ko: -1 });
    view.setGhost(-1);
    $('board').classList.remove('playing', 'scoring');

    renderPlayers(record, pos, G.naturalTurn(record, n), 0);
    var last = lastMoveBefore(record, n);
    setStatus('第 ' + pos.moveNo + ' 手 / 共 ' + G.countMoves(record) + ' 手',
      last ? G.describeMove(record, last) : '起始局面');

    $('reviewBox').hidden = false;
    $('reviewActions').hidden = false;
    $('playBox').hidden = true;
    $('optConfirmRow').hidden = true;
    $('optSoundRow').hidden = true;
    if ($('dlgRequest').open) $('dlgRequest').close();

    var slider = $('slider');
    slider.max = record.moves.length;
    slider.value = n;
    slider.disabled = record.moves.length === 0;
    var info = record.info;
    infoRows($('gameInfo'), [['賽事', info.ev], ['日期', info.dt], ['結果', info.re],
      ['棋盤', record.size + ' 路'], ['貼目', String(record.komi)],
      ['讓子', record.handicap ? record.handicap + ' 子' : '']]);
  }

  var REQUEST_LABEL = { undo: '悔棋', count: '數目', draw: '和棋' };

  function renderPlay() {
    var g = state.game, record = g.record;
    var playing = g.status === 'playing', scoring = g.status === 'scoring', finished = g.status === 'finished';
    var demo = g.status === 'demo', teach = canTeach();
    var rights = demoRights(g);
    var pos = G.replay(record);
    var dv = demo ? M.demoView(g) : null;
    state.pos = demo ? dv.pos : pos;   // 擺棋時，能不能下要看加上變化之後的局面
    var sc = (scoring || (finished && g.result.reason === 'score')) ? M.score(g) : null;
    var myTurn = playing && controls(g.turn);

    var lecture = !!g.lecture;
    $('modeTag').textContent = lecture ? '講解房' : isWatcher() && !demo ? '觀戰中' : playing ? '對弈中' : scoring ? '數目中' : demo ? '擺棋講解' : '對局結束';
    view.setSize(record.size);
    if (demo) {
      // 變化的棋子一律顯示 1、2、3…，方便講解順序
      view.render({ board: dv.board, last: dv.last, numbers: dv.numbers, ko: -1, marks: g.demo.marks, draw: g.demo.draw,
        answers: quizMarks(g) });
    } else {
      view.render({
        board: pos.board,
        last: pos.last,
        numbers: prefs.numbers && !sc ? pos.numbers : null,
        ko: -1,   // 劫點不畫方框；點到時才提示「不能提熱子」
        dead: sc ? sc.dead : null,
        owner: sc ? sc.owner : null
      });
    }
    $('board').classList.toggle('playing', myTurn);
    $('board').classList.toggle('scoring', scoring);
    $('board').classList.toggle('teaching', demo && (rights.stones || rights.marks));
    updateGhost();

    renderPlayers(record, demo ? dv.pos : pos, playing ? g.turn : 0, finished ? g.result.winner : 0);

    var last = lastMoveBefore(record, record.moves.length);
    if (playing) {
      setStatus('輪到' + side(g.turn) + (online() ? (isWatcher() ? '' : myTurn ? '（你）' : '（對方）') : ''),
        '第 ' + (pos.moveNo + 1) + ' 手' + (last ? '　上一手：' + G.describeMove(record, last) : '') +
        '　' + RULE_NAME[g.rule] + '　貼目 ' + record.komi);
    } else if (scoring) {
      setStatus('數目中（' + RULE_NAME[g.rule] + '）',
        online() ? '標記死子後，雙方都按「確認結果」' : '請標記死子，確認後算出勝負');
    } else if (demo) {
      var who = g.demo.who, sub;
      if (!online()) sub = '在棋盤上擺變化或加標記';
      else if (teach) sub = who === 'teacher' ? '學生會同步看到' : whoText(g, false);
      else sub = whoText(g, false);
      if (lecture) {
        setStatus(online() && !teach ? '老師講解中' : '講解房', sub);
      } else {
        setStatus(online() && !teach ? '老師擺棋講解中' : '擺棋講解中',
          (g.demo.from === 'playing' ? '對局暫停，時間不會走。' : '') + sub);
      }
    } else {
      setStatus(g.result.text, '共 ' + pos.moveNo + ' 手');
    }

    $('reviewBox').hidden = true;
    $('reviewActions').hidden = true;
    $('playBox').hidden = false;
    $('optSoundRow').hidden = false;
    $('optConfirmRow').hidden = !playing || isWatcher();

    var busy = !!g.request;
    var undoActor = online() ? myColor() : E.other(g.turn);
    $('btnConfirm').hidden = !(myTurn && prefs.confirm);
    $('btnConfirm').disabled = state.pending < 0;
    $('playButtons').hidden = !playing || isWatcher();
    $('btnPass').disabled = !myTurn || busy;
    $('btnUndo').disabled = busy || !M.canUndo(g, undoActor);
    $('btnCount').disabled = busy;
    $('btnDraw').disabled = busy;
    $('btnForceUndo').hidden = !isTeacher();
    $('btnForceUndo').disabled = M.newMoves(g) <= 0;
    $('scoreBox').hidden = !sc;
    $('scoreHint').hidden = !scoring;
    $('scoreButtons').hidden = !scoring || isWatcher();
    $('btnEnd').hidden = online() && !isTeacher();
    // 匯出 SGF 只在對局結束後（覆盤時）出現，下棋中不需要
    $('btnExport').hidden = !(finished || (demo && g.demo.from === 'finished'));
    $('btnEnd').textContent = lecture ? '結束講解房' : state.source || g.startAt > 0 ? '結束對局，回到棋譜' : '結束對局';

    // 老師擺棋講解
    $('btnTeach').hidden = !(teach && (playing || finished));
    $('btnTeach').textContent = playing ? '暫停對局，擺棋講解' : '擺棋講解';
    var teachUi = demo && (rights.nav || rights.stones || rights.marks);
    $('teachBox').hidden = !teachUi;
    $('lectureBox').hidden = !(lecture && rights.admin);
    var answering = demo && studentAnswering(g);
    view.setDrawMode(teachUi && !answering && DRAW_TOOL[demoTool(g)] ? demoTool(g) : '');
    renderQuiz(g, demo);
    if (teachUi) {
      var tool = demoTool(g);
      Array.prototype.forEach.call($('teachBox').querySelectorAll('[data-tool]'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-tool') === tool);
      });
      if (rights.admin && online()) renderStage(g);
      var dm = g.demo, atEnd = dv.base >= dv.total, start = M.demoFloor(g);
      var noBack = !dm.moves.length && dv.base <= start;   // 最多退到開始下的那一手
      var noFwd = !dm.undone.length && (dm.moves.length > 0 || atEnd);
      Array.prototype.forEach.call($('teachNav').querySelectorAll('[data-step]'), function (b) {
        var s = b.getAttribute('data-step');
        b.disabled = (s === 'first' || parseInt(s, 10) < 0) ? noBack : noFwd;
      });
      $('teachNav').hidden = !rights.nav;   // 空白棋盤也要有：一手一手退回／重擺擺過的變化
      $('btnTeachClear').hidden = !rights.nav;
      $('btnTeachClear').disabled = !dm.moves.length && !dm.marks.length && !dm.undone.length && !dm.draw.length;
      $('btnTeachClear').textContent = lecture ? '清除盤面' : '結束試下';
      $('teachStoneBox').hidden = !rights.stones || rights.turns;
      $('teachMarkBox').hidden = !rights.marks;
      $('teachDrawBox').hidden = !rights.marks;
      $('btnUndraw').disabled = !dm.draw.length;
      $('btnClearDraw').disabled = !dm.draw.length;
      $('teachWhoBox').hidden = !(rights.admin && online());
      $('btnTeachEnd').hidden = !rights.admin || lecture;
      $('teachWhere').textContent = (lecture
        ? (dv.total === 0 ? '' : dv.base <= 0 ? '棋譜的起始局面' : '棋譜第 ' + dv.pos.moveNo + ' 手')
        : atEnd ? (dm.from === 'finished' ? '終局的局面' : '暫停時的局面')
        : dv.base <= 0 ? '退回到起始局面'
        : dv.base === start ? '開始下的局面（第 ' + dv.pos.moveNo + ' 手）'
        : '退回到第 ' + dv.pos.moveNo + ' 手') +
        (dm.moves.length ? (lecture && dv.total === 0 ? '擺了 ' : '＋變化 ') + dm.moves.length + ' 手' : '');
      $('teachWhere').hidden = !$('teachWhere').textContent;
      $('teachTurn').hidden = !rights.turns;
      if (rights.turns) {
        var next = M.demoNextColor(g);
        $('teachTurn').textContent = myDemoTurn(g) ? '輪到你擺（' + G.colorName(next) + '）'
          : '等' + (isTeacher() ? '學生' : '老師') + '擺（' + G.colorName(next) + '）…';
      }
      $('btnTeachEnd').textContent = g.demo.from === 'playing' ? '結束擺棋，回到對局' : '結束擺棋';
    }

    if (sc) {
      var diff = Math.abs(sc.margin);
      var resultText = sc.winner ? G.colorName(sc.winner) + '勝 ' + diff + ' 目' : '和棋';
      if (sc.rule === 'territory') {
        infoRows($('scoreInfo'), [
          ['數目方式', '比目法'],
          ['黑方', '地 ' + sc.terrB + '＋提子 ' + sc.capB + '＝' + sc.black + ' 目'],
          ['白方', '地 ' + sc.terrW + '＋提子 ' + sc.capW + '＝' + sc.white + ' 目'],
          ['貼目', sc.komi + ' 目'],
          ['結果', resultText]
        ]);
      } else {
        infoRows($('scoreInfo'), [
          ['數目方式', '數子法'],
          ['黑方', sc.black + ' 子'],
          ['白方', sc.white + ' 子'],
          ['貼目', sc.komi + ' 目'],
          ['讓子貼還', sc.handicap ? sc.handicap + ' 目' : ''],
          ['結果', resultText]
        ]);
      }
    }
    if (scoring) {
      var mine = online() && g.agree[key(myColor())];
      var theirs = online() && g.agree[key(E.other(myColor()))];
      $('btnAgree').disabled = !!mine;
      $('btnAgree').textContent = mine ? '已確認，等對方' : '確認結果';
      $('scoreHint').textContent = (theirs ? '對方已經確認結果。' : '') +
        '點選棋盤上的死子來標記，再點一次取消。小方塊表示那一點算誰的' +
        (g.rule === 'territory' ? '地；沒有方塊的空點是單官，不算目。' : '。');
    }

    // 申請：輪到這台裝置回覆就跳出視窗；自己提出的則顯示等待中
    var r = playing ? g.request : null;
    var mustAnswer = !!r && controls(E.other(r.from));
    var dlg = $('dlgRequest');
    if (mustAnswer) {
      $('reqTitle').textContent = REQUEST_LABEL[r.type];
      $('reqText').textContent = side(r.from) + ({
        undo: '想要悔棋，',
        count: '提議結束對局、開始數目，',
        draw: '提議和棋，'
      }[r.type]) + side(E.other(r.from)) + '同意嗎？';
      if (!dlg.open) dlg.showModal();
    } else if (dlg.open) {
      dlg.close();
    }
    var waiting = !!r && !mustAnswer && controls(r.from);
    $('waitBox').hidden = !waiting;
    if (waiting) $('waitText').textContent = '已提出' + REQUEST_LABEL[r.type] + '，等待對方回覆…';
  }

  function updateClocks() {
    var g = state.game, show = state.mode === 'play' && g && g.clock;
    [[BLACK, 'B'], [WHITE, 'W']].forEach(function (pair) {
      var box = $('clock' + pair[1]);
      box.hidden = !show;
      if (!show) return;
      var v = M.timeView(g, pair[0], now());
      $('time' + pair[1]).textContent = formatTime(v.remaining);
      $('byo' + pair[1]).textContent = v.out ? '超時'
        : v.inByo ? '讀秒中　剩 ' + v.periods + ' 次'
        : g.clock.periods ? '讀秒 ' + g.clock.byo + ' 秒 × ' + v.periods + ' 次'
        : '沒有讀秒';
      var counting = v.inByo || !g.clock.periods;
      box.classList.toggle('out', v.out);
      box.classList.toggle('urgent', !v.out && g.status === 'playing' && g.turn === pair[0] &&
        counting && v.remaining <= 10000);
    });
  }

  function updateGhost() {
    var g = state.game;
    if (state.mode === 'play' && g.status === 'demo') {
      // 擺棋：選的是擺子工具時，預覽下一顆會是什麼顏色
      var r = demoRights(g), fixed = STONE_TOOL[demoTool(g)];
      if (studentAnswering(g) || !r.stones || fixed === undefined || state.hover < 0 || (r.turns && !myDemoTurn(g))) {
        view.setGhost(-1);
        return;
      }
      var c = fixed || M.demoNextColor(g);
      var free = E.clonePosition(state.pos);
      free.ko = -1;
      if (E.check(free, c, state.hover) === '') view.setGhost(state.hover, c, false);
      else view.setGhost(-1);
      return;
    }
    if (state.mode !== 'play' || g.status !== 'playing' || !controls(g.turn)) { view.setGhost(-1); return; }
    if (state.pending >= 0) { view.setGhost(state.pending, g.turn, true); return; }
    if (state.hover >= 0 && E.check(state.pos, g.turn, state.hover) === '') {
      view.setGhost(state.hover, g.turn, false);
    } else {
      view.setGhost(-1);
    }
  }

  /* 每 0.2 秒：更新時鐘、檢查超時、讀秒倒數聲 */
  function tick() {
    if (state.mode !== 'play') return;
    var g = state.game;
    if (g.status === 'playing' && g.clock) {
      var v = M.timeView(g, g.turn, now());
      if (v.out) {
        if (!timeoutBusy) {
          timeoutBusy = true;
          act(function (x) { return M.checkTimeout(x, now()); })
            .then(function () { timeoutBusy = false; });
        }
        return;
      }
      // 讀秒語音與倒數：不管輪到誰，雙方的裝置都會報
      if (v.inByo) {
        var seen = byoAnnounced[g.turn];
        if (seen === undefined) {
          toast(side(g.turn) + '進入讀秒');
          Sound.say('byo');
        } else if (v.periods < seen) {
          if (v.periods === 1) Sound.say('last');
          else if (v.periods === 2) Sound.say('two');
        }
        byoAnnounced[g.turn] = v.periods;
      }
      var sec = Math.ceil(v.remaining / 1000);
      if ((v.inByo || !g.clock.periods) && sec >= 1 && sec <= 10) {
        var k = g.record.moves.length + ':' + v.periods + ':' + sec;
        if (k !== beepKey) {
          beepKey = k;
          if (!Sound.say(String(sec))) Sound.tick(sec <= 3);
        }
      }
    }
    updateClocks();
  }
  setInterval(tick, 200);

  /* ---------- 進入各個畫面 ---------- */
  function goHome() {
    state.mode = 'home';
    state.source = null;
    state.game = null;
    state.pending = -1;
    newTime.show();
    render();
  }

  function openReview(record, cursor) {
    state.mode = 'review';
    state.source = record;
    state.game = null;
    state.pending = -1;
    state.cursor = cursor === undefined ? record.moves.length : cursor;
    render();
  }

  /* seat：連線時老師執哪一色；rule：'territory' 比目法或 'area' 數子法 */
  function startPlay(record, startAt, turn, time, seat, rule, student) {
    var game = M.create(record, startAt, turn, time, now());
    game.rule = rule === 'area' ? 'area' : 'territory';
    prefs.rule = game.rule;
    savePrefs();
    state.tool = 'alt';
    byoAnnounced = {};
    beepKey = '';
    if (online()) {
      game.teacherColor = seat;
      game.student = student || '';
      state.returnCursor = startAt;
      net.setGame(game).then(null, function () { toast('連線有問題，無法開始對局'); });
      return; // 畫面等資料庫回報後由 onRemoteGame 切換
    }
    state.mode = 'play';
    state.game = game;
    state.pending = -1;
    render();
  }

  /* 開講解房：record 是空白棋盤或棋譜，cursor 是一開始停在第幾步 */
  function startLecture(record, cursor) {
    var game = M.createLecture(G.cloneRecord(record), cursor);
    state.tool = 'alt';
    state.returnCursor = cursor || 0;
    if (online()) {
      net.setGame(game).then(null, function () { toast('連線有問題，無法開講解房'); });
      return; // 畫面等資料庫回報後由 onRemoteGame 切換
    }
    state.mode = 'play';
    state.game = game;
    state.pending = -1;
    render();
  }

  /* 講解房中換棋盤或換棋譜：學生不用離開房間 */
  function lectureReplace(record, cursor) {
    state.source = record.moves.length || record.setup.b.length || record.setup.w.length ? record : null;
    state.returnCursor = cursor || 0;
    act(function (x) { return x.lecture && M.lectureLoad(x, G.cloneRecord(record), cursor); });
  }

  function setCursor(n) {
    var max = state.source.moves.length;
    state.cursor = Math.max(0, Math.min(max, n));
    render();
  }

  /* ---------- 載入棋譜 ---------- */
  function loadText(text) {
    var record;
    try {
      record = S.load(text);
    } catch (e) {
      toast('無法讀取這個棋譜：' + e.message);
      return false;
    }
    if (inLecture()) {
      // 講解房裡載入棋譜：直接換到講解房的棋盤上，從第一手開始講
      lectureReplace(record, 0);
      toast('已載入棋譜，共 ' + G.countMoves(record) + ' 手');
      return true;
    }
    openReview(record);
    return true;
  }

  function inLecture() { return state.mode === 'play' && state.game && state.game.lecture && canTeach(); }

  function loadFile(file) {
    if (!file) return;
    if (state.mode === 'login' || state.mode === 'wait') return; // 學生不能載入棋譜
    if (state.mode === 'play' && !inLecture()) { toast('請先結束目前的對局，再載入棋譜'); return; }
    var reader = new FileReader();
    reader.onload = function () { loadText(S.decode(reader.result)); };
    reader.onerror = function () { toast('檔案讀取失敗'); };
    reader.readAsArrayBuffer(file);
  }

  // 手機與平板不認得 .sgf 這種副檔名，有「只能選 .sgf」的限制時，檔案會變成灰色點不了、
  // 甚至整個資料夾看起來是空的。所以觸控裝置上不設限，任何檔案都能選，內容不對再提示。
  if (navigator.maxTouchPoints > 0 || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) {
    $('fileInput').removeAttribute('accept');
  }
  $('btnPickFile').addEventListener('click', function () { $('fileInput').click(); });
  $('btnOtherFile').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function () {
    loadFile(this.files[0]);
    this.value = '';
  });

  $('btnPaste').addEventListener('click', function () {
    $('pasteText').value = '';
    $('dlgPaste').showModal();
  });
  $('pasteOk').addEventListener('click', function () {
    var text = $('pasteText').value.trim();
    if (!text) { toast('請先貼上棋譜內容'); return; }
    if (loadText(text)) $('dlgPaste').close();
  });

  document.addEventListener('dragover', function (ev) {
    ev.preventDefault();
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', function (ev) {
    if (!ev.relatedTarget) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', function (ev) {
    ev.preventDefault();
    document.body.classList.remove('dragging');
    if (ev.dataTransfer && ev.dataTransfer.files.length) loadFile(ev.dataTransfer.files[0]);
  });

  /* ---------- 新對局 ---------- */
  /* 慣用貼目：比目法 6.5、數子法 7.5；讓子棋 0.5 */
  var STD_KOMI = { territory: 6.5, area: 7.5 };
  function stdKomi(rule, handicap) { return handicap ? 0.5 : STD_KOMI[rule === 'area' ? 'area' : 'territory']; }
  // 換了數目方式或讓子數，貼目就帶入該規則的慣用值；之後仍可以自己改數字
  function defaultKomi() {
    $('newKomi').value = stdKomi($('newRule').value, $('newHandicap').value !== '0');
  }
  $('newRule').value = prefs.rule;
  defaultKomi();
  $('newHandicap').addEventListener('change', defaultKomi);
  $('newRule').addEventListener('change', defaultKomi);
  $('btnNew').addEventListener('click', function () {
    var komi = parseFloat($('newKomi').value);
    var record = G.newRecord({
      size: parseInt($('newSize').value, 10),
      handicap: parseInt($('newHandicap').value, 10),
      komi: isNaN(komi) ? undefined : komi
    });
    state.source = null;
    startPlay(record, 0, record.first, newTime.read(), checkedValue('newSeat'), $('newRule').value, $('newStudent').value);
  });

  /* ---------- 講解房 ---------- */
  $('btnLecture').addEventListener('click', function () {
    state.source = null;
    startLecture(G.newRecord({ size: parseInt($('lectureSize').value, 10) }), 0);
  });
  $('btnLectureHere').addEventListener('click', function () {
    startLecture(state.source, state.cursor);
  });
  $('lectureSizes').addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-lsize]');
    if (!btn || !inLecture()) return;
    var size = parseInt(btn.getAttribute('data-lsize'), 10);
    ask('換成 ' + size + '路棋盤？', '目前的盤面會清掉。', '換棋盤').then(function (ok) {
      if (ok && inLecture()) lectureReplace(G.newRecord({ size: size }), 0);
    });
  });
  $('btnLectureFile').addEventListener('click', function () { $('fileInput').click(); });

  /* ---------- 棋譜瀏覽 ---------- */
  document.querySelector('.nav').addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-go]');
    if (!btn) return;
    var go = btn.getAttribute('data-go');
    if (go === 'first') setCursor(0);
    else if (go === 'last') setCursor(state.source.moves.length);
    else setCursor(state.cursor + parseInt(go, 10));
  });
  $('slider').addEventListener('input', function () { setCursor(parseInt(this.value, 10)); });

  document.addEventListener('keydown', function (ev) {
    if (state.mode !== 'review' || document.querySelector('dialog[open]')) return;
    var tag = ev.target.tagName;
    if (tag === 'INPUT' && ev.target.type !== 'range' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -10, PageDown: 10 }[ev.key];
    if (step) { setCursor(state.cursor + step); ev.preventDefault(); }
    else if (ev.key === 'Home') { setCursor(0); ev.preventDefault(); }
    else if (ev.key === 'End') { setCursor(state.source.moves.length); ev.preventDefault(); }
  });

  $('btnStartHere').addEventListener('click', function () {
    var src = state.source, moveNo = G.countMoves(src, state.cursor), total = G.countMoves(src);
    var desc = moveNo === 0 ? '從起始局面開始。' : '從第 ' + moveNo + ' 手下完的局面開始。';
    if (moveNo < total) desc += '棋譜後面的 ' + (total - moveNo) + ' 手不會帶入。';
    $('startDesc').textContent = desc;
    var turn = G.naturalTurn(src, state.cursor);
    document.querySelector('input[name="startTurn"][value="' + turn + '"]').checked = true;
    // 貼目不沿用棋譜裡的數字，一律依數目方式帶入：比目法 6.5、數子法 7.5（讓子棋 0.5）；之後仍可以自己改
    $('startRule').value = prefs.rule;
    $('startKomi').value = stdKomi(prefs.rule, src.handicap > 0);
    startTime.show();
    $('dlgStart').showModal();
  });
  $('startRule').addEventListener('change', function () {
    $('startKomi').value = stdKomi(this.value, state.source && state.source.handicap > 0);
  });
  $('startOk').addEventListener('click', function () {
    var record = G.cloneRecord(state.source);
    record.moves = record.moves.slice(0, state.cursor);
    record.info.re = '';
    var komi = parseFloat($('startKomi').value);
    if (!isNaN(komi)) record.komi = komi;
    var turn = checkedValue('startTurn');
    var time = startTime.read();
    $('dlgStart').close();
    startPlay(record, record.moves.length, turn, time, checkedValue('startSeat'), $('startRule').value, $('startStudent').value);
  });

  /* ---------- 對弈 ---------- */
  function explain(reason) {
    if (reason === 'ko') toast('不能提熱子：打劫要先在別處下一手，才能提回');
    else if (reason === 'suicide') toast('這裡是禁著點，不能下');
  }

  /* idx = -1 是停一手 */
  function doPlay(idx) {
    var g = state.game;
    if (g.status !== 'playing' || !controls(g.turn)) return;
    if (idx >= 0) {
      var reason = E.check(state.pos, g.turn, idx);
      if (reason) { explain(reason); return; }
    }
    var color = g.turn;
    state.pending = -1;
    act(function (x) {
      if (x.turn !== color) return false;
      var r = M.play(x, idx, now());
      return r.ok || r.reason === 'timeout'; // 超時也要寫回去（對局已結束）
    });
  }

  view.onPoint = function (idx) {
    if (state.mode !== 'play') return;
    var g = state.game;
    if (g.status === 'scoring') {
      if (isWatcher()) return;
      act(function (x) { return M.toggleDead(x, idx); });
      return;
    }
    if (g.status === 'demo' && studentAnswering(g)) {
      if (state.pos && state.pos.board[idx]) { toast('這裡已經有棋子了，請點空的位置'); return; }
      var me = session.account;
      act(function (x) { return M.quizAnswer(x, me, idx); });
      return;
    }
    if (g.status === 'demo') {
      var rights = demoRights(g), tool = demoTool(g), color = STONE_TOOL[tool];
      if (color === undefined) {
        if (!rights.marks) return;
        act(function (x) { return demoRights(x).marks && M.demoMark(x, idx, tool); });
        return;
      }
      if (!rights.stones) return;
      if (rights.turns && !myDemoTurn(g)) {
        toast('還沒輪到你，等' + (isTeacher() ? '學生' : '老師') + '擺');
        return;
      }
      act(function (x) {
        // 以資料庫裡最新的狀態再確認一次權限（老師可能剛好改了設定，或對方剛擺了一手）
        var r = demoRights(x);
        if (!r.stones) return false;
        if (r.turns) return myDemoTurn(x) && M.demoPlay(x, myDemoColor(x), idx);
        return M.demoPlay(x, color, idx);
      }).then(function (ok) {
        if (!ok && state.pos && !state.pos.board[idx]) toast('這裡是禁著點，不能下');
      });
      return;
    }
    if (g.status !== 'playing' || !controls(g.turn)) return;
    if (prefs.confirm) {
      var reason = E.check(state.pos, g.turn, idx);
      if (reason) { explain(reason); return; }
      state.pending = idx;
      updateGhost();
      $('btnConfirm').disabled = false;
      return;
    }
    doPlay(idx);
  };
  view.onHover = function (idx) {
    state.hover = idx;
    if (state.mode === 'play') updateGhost();
  };
  /* 畫完一筆畫線 */
  view.onStroke = function (stroke) {
    if (state.mode !== 'play' || state.game.status !== 'demo') return;
    act(function (x) { return demoRights(x).marks && M.demoDraw(x, stroke); });
  };

  $('btnConfirm').addEventListener('click', function () {
    if (state.pending >= 0) doPlay(state.pending);
  });
  $('btnPass').addEventListener('click', function () { doPlay(-1); });

  /*
   * 申請悔棋／數子／和棋：一方提出，另一方同意才生效。
   * 連線時由自己提出、對方在他的裝置上回覆。
   * 單機時兩人共用畫面：悔棋算「剛下完的一方」提的，數子與和棋算「輪到的一方」提的。
   */
  function requestFlow(type) {
    var g = state.game;
    if (g.status !== 'playing' || g.request) return;
    var from = online() ? myColor() : (type === 'undo' ? E.other(g.turn) : g.turn);
    act(function (x) { return M.request(x, type, from); });
  }
  $('btnUndo').addEventListener('click', function () { requestFlow('undo'); });
  $('btnCount').addEventListener('click', function () { requestFlow('count'); });
  $('btnDraw').addEventListener('click', function () { requestFlow('draw'); });

  function answer(ok) {
    act(function (x) {
      if (!x.request) return false;
      M.respond(x, ok, now());
      return true;
    });
  }
  $('reqOk').addEventListener('click', function () { answer(true); });
  $('reqNo').addEventListener('click', function () { answer(false); });
  $('dlgRequest').addEventListener('cancel', function (ev) { ev.preventDefault(); }); // 一定要回覆，不能按 Esc 略過

  $('btnCancelRequest').addEventListener('click', function () {
    var me = myColor();
    act(function (x) { return M.cancelRequest(x, me); });
  });

  $('btnForceUndo').addEventListener('click', function () {
    act(function (x) { return M.forceUndo(x, now()); });
  });

  $('btnResign').addEventListener('click', function () {
    var g = state.game, color = online() ? myColor() : g.turn;
    ask('認輸', side(color) + '確定要認輸嗎？', '認輸').then(function (ok) {
      if (!ok || state.mode !== 'play') return;
      act(function (x) {
        if (x.status !== 'playing') return false;
        M.resign(x, color, now());
        return true;
      });
    });
  });

  /* ---------- 老師擺棋講解 ---------- */
  $('btnTeach').addEventListener('click', function () {
    if (!canTeach()) return;
    state.tool = 'alt';
    act(function (x) { return M.startDemo(x, now()); });
  });
  $('teachBox').addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-tool]');
    if (!btn) return;
    state.tool = btn.getAttribute('data-tool');
    render();
  });
  /* n：負數往回、正數往前；一次走不完就走到底。'start' 是回到開始下的局面 */
  function teachStep(n) {
    act(function (x) {
      if (!demoRights(x).nav) return false;
      return n === 'start' ? M.demoToStart(x) : M.demoStep(x, n);
    });
  }
  var FAR = 100000;   // 「進到最後」：步數給很大，走到不能走為止
  $('teachNav').addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-step]');
    if (!btn || btn.disabled) return;
    var s = btn.getAttribute('data-step');
    teachStep(s === 'first' ? 'start' : s === 'last' ? FAR : parseInt(s, 10));
  });
  // 擺棋時也可以用鍵盤：← → 一手，PageUp／PageDown 十手，Home 回到開始下的局面，End 到最後
  document.addEventListener('keydown', function (ev) {
    if (state.mode !== 'play' || !demoRights(state.game).nav) return;
    if (document.querySelector('dialog[open]')) return;
    var tag = ev.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var n = { ArrowLeft: -1, ArrowRight: 1, PageUp: -10, PageDown: 10, Home: 'start', End: FAR }[ev.key];
    if (n) { teachStep(n); ev.preventDefault(); }
  });
  $('btnUndraw').addEventListener('click', function () {
    act(function (x) { return demoRights(x).marks && M.demoUndraw(x, false); });
  });
  $('btnClearDraw').addEventListener('click', function () {
    act(function (x) { return demoRights(x).marks && M.demoUndraw(x, true); });
  });
  $('btnTeachClear').addEventListener('click', function () {
    act(function (x) { return demoRights(x).nav && M.demoClear(x); });
  });
  $('btnTeachEnd').addEventListener('click', function () {
    act(function (x) { return M.endDemo(x, now()); });
  });

  $('btnResume').addEventListener('click', function () {
    act(function (x) { return M.resumePlay(x, now()); });
  });
  $('btnAgree').addEventListener('click', function () {
    var me = myColor();
    act(function (x) {
      if (online()) return M.agree(x, me);
      M.agree(x, BLACK);              // 單機：一個按鈕代表雙方都確認
      return M.agree(x, WHITE) || x.status === 'finished';
    });
  });

  $('btnExport').addEventListener('click', function () {
    var g = state.game, record = G.cloneRecord(g.record);
    var d = new Date();
    if (!record.info.dt) record.info.dt = d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
    record.info.re = g.result ? g.result.sgf : '';
    var name = '對局-' + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' +
      two(d.getHours()) + two(d.getMinutes()) + '.sgf';
    var url = URL.createObjectURL(new Blob([S.toSGF(record)], { type: 'application/x-go-sgf' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('已匯出 ' + name);
  });

  /*
   * 結束對局後要回到哪份棋譜：原本載入的棋譜；如果網頁重新整理過、手上已經沒有原棋譜，
   * 但這盤是從棋譜中途開始下的，就用這盤對局本身（含棋譜原有的著手），一樣停在開始下的那一手。
   */
  function returnSource(g) {
    if (state.source) return state.source;
    if (!g || !(g.startAt > 0)) return null;
    var rec = G.cloneRecord(g.record);
    rec.info.re = g.result ? g.result.sgf : '';
    return rec;
  }

  function leavePlay(toHome) {
    if (state.game && state.game.lecture) {
      ask('結束講解房？', online() ? '學生的畫面會回到「等待老師開始上課」。聊天紀錄會保留。'
        : '棋盤上擺的變化、標記和畫線不會保留。', '結束講解').then(function (ok) {
        if (!ok || !state.game || !state.game.lecture) return;
        if (toHome) state.source = null;
        if (online()) {
          net.setGame(null).then(null, function () { toast('連線有問題，無法結束講解房'); });
        } else if (state.source) {
          openReview(state.source, state.returnCursor);
        } else {
          goHome();
        }
      });
      return;
    }
    var back = function () {
      var g = state.game, src = toHome ? null : returnSource(g);
      if (online()) {
        state.source = src;
        state.returnCursor = g.startAt;
        // 清掉資料庫裡的對局，雙方的畫面都會跟著離開（見 onRemoteGame）
        net.setGame(null).then(null, function () { toast('連線有問題，無法結束對局'); });
        return;
      }
      if (src) openReview(src, g.startAt);
      else goHome();
    };
    if (!hasNewMoves() && !(online() && state.game.status !== 'finished')) { back(); return; }
    var over = state.game.status === 'finished' || (state.game.demo && state.game.demo.from === 'finished');
    var text = (online() ? '學生的畫面也會一起結束。' : '') +
      (over ? '還沒匯出的著手不會保留。需要留存的話，請先按「匯出 SGF」。'
        : '這盤棋還沒下完，結束後不會保留。');
    ask('結束這盤對局？', text, '結束對局').then(function (ok) { if (ok) back(); });
  }
  $('btnEnd').addEventListener('click', function () { leavePlay(false); });
  $('btnHome').addEventListener('click', function () {
    if (state.mode === 'play') leavePlay(true);
    else goHome();
  });

  /* ---------- 登入／登出 ---------- */
  if (net) {
    net.onAuth(function (user) {
      session = user;
      loginState.authKnown = true;
      stopWatching.forEach(function (stop) { stop(); });
      stopWatching = [];
      closeGameDialogs();
      state.game = null;
      state.snap = null;
      state.source = null;
      state.pending = -1;
      if (user) {
        solo = false;
        state.mode = user.role === 'teacher' ? 'home' : 'wait';
        newTime.show();
        stopWatching.push(net.watchGame(onRemoteGame, function () {
          // 讀不到教室資料：帳號不在資料庫規則的名單裡
          $('loginError').textContent = '這個帳號沒有進入教室的權限，請向老師確認。';
          net.signOut();
        }));
        stopWatching.push(net.watchPresence(function (p) { presence = p; renderPresence(); }));
        resetChat();
        firstGameEvent = true;
        stopWatching.push(net.watchChat(onChat));
        stopWatching.push(net.watchChatLock(function (on) { chat.locked = on; renderChat(); }));
        hands = [];
        handsSeen = null;
        stopWatching.push(net.watchHands(onHands));
        startVoice(user);
        net.onConnection(function (c) {
          connected = c;
          $('connTag').hidden = !(online() && !connected);
        });
        net.setPresence(user.role);
      } else {
        state.mode = solo ? 'home' : 'login';
        resetChat();
        voice = null;
        voiceOpen = false;
      }
      render();
    });
    net.ready.then(function () {
      loginState.ready = true;
      renderLogin();
    }, function (err) {
      loginState.failed = (err && err.message) || '無法載入連線元件';
      renderLogin();
    });
  }

  $('loginForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var account = $('loginAccount').value.trim(), password = $('loginPassword').value;
    $('loginError').textContent = '';
    if (!account || !password) { $('loginError').textContent = '請輸入帳號與密碼。'; return; }
    $('btnSignIn').disabled = true;
    net.signIn(account, password).then(function () {
      $('loginPassword').value = '';
    }, function (err) {
      $('loginPassword').value = '';
      $('loginError').textContent = err.message;
      renderLogin();
    });
  });
  $('btnSolo').addEventListener('click', function () {
    solo = true;
    state.mode = 'home';
    newTime.show();
    render();
  });
  $('btnLogin').addEventListener('click', function () {
    if (state.mode === 'play') { toast('請先結束目前的對局，再登入'); return; }
    solo = false;
    state.source = null;
    state.mode = 'login';
    render();
  });
  $('btnLogout').addEventListener('click', function () {
    // 登出前先把手放下（登出後就沒有權限改了）
    var lower = online() && !isTeacher() && handUp(session.account) ? net.setHand(false) : null;
    var quit = voice ? voice.leave() : null;   // 先離開語音（登出後就沒有權限改了）
    Promise.all([lower, quit].map(function (p) { return Promise.resolve(p).then(null, function () {}); }))
      .then(function () { net.signOut(); });
  });

  /* ---------- 舉手、上台、一起答題 ---------- */
  var hands = [];          // [{ a: 帳號, t }]，先舉手的在前面
  var handsSeen = null;    // 已經提示過的舉手（剛登入時讀到的不提示）

  function onlineStudents() {
    var seen = {}, out = [];
    (presence.people || []).forEach(function (p) {
      if (p.role === 'student' && !seen[p.account]) { seen[p.account] = true; out.push(p.account); }
    });
    return out.sort(function (a, b) { return String(a).localeCompare(String(b)); });
  }
  function handUp(account) {
    return hands.some(function (h) { return h.a === account; });
  }

  /* 開局時選「對手學生」：在線的學生＋「任何學生」 */
  function fillStudents(sel) {
    var keep = sel.value, list = onlineStudents(), html = [];
    sel.textContent = '';
    list.forEach(function (a) { html.push([a, nick(a)]); });
    html.push(['', list.length ? '任何學生都可以下' : '任何學生（目前沒有學生在線）']);
    html.forEach(function (pair) {
      var o = document.createElement('option');
      o.value = pair[0];
      o.textContent = pair[1];
      sel.appendChild(o);
    });
    // 原本選的學生還在線上就保留；否則預設第一位在線的學生
    sel.value = keep && list.indexOf(keep) >= 0 ? keep : (list[0] || '');
  }

  function onHands(list) {
    var first = handsSeen === null;
    if (first) handsSeen = {};
    hands = list;
    var now = {};
    list.forEach(function (h) {
      var k = h.a + '@' + h.t;
      now[k] = true;
      if (!first && !handsSeen[k] && isTeacher()) {
        Sound.notice();
        toast('🙋 ' + nick(h.a) + ' 舉手了');
      }
    });
    handsSeen = now;
    renderHand();
    renderPeople();
    if (state.mode === 'play' && state.game && state.game.status === 'demo' && isTeacher()) renderStage(state.game);
  }

  function renderHand() {
    var show = online() && !isTeacher() && state.mode !== 'login';
    var up = show && handUp(session.account);
    $('handFab').hidden = !show;
    $('handFab').classList.toggle('up', up);
    $('handFab').textContent = up ? '🙋 放下手' : '🙋 舉手';
  }

  /*
   * 現在是誰在跟老師擺：'*' 全部學生、學生帳號，或 ''（老師自己擺）；mode 是 'stage'／'black'／'white'
   */
  var MODE_NAME = { stage: '自由擺', black: '持黑', white: '持白' };
  function currentPick(g) {
    var d = g.demo;
    if (!d || d.who === 'teacher') return { who: '', mode: '' };
    if (d.who === 'free') return { who: '*', mode: 'stage' };
    return { who: d.stage || '*', mode: d.who };
  }

  /* 老師的在線學生列表：舉手的排前面；第一個是「全部學生」 */
  function renderStage(g) {
    var box = $('stageList'), list = onlineStudents(), pick = currentPick(g);
    if (pick.who && pick.who !== '*' && list.indexOf(pick.who) < 0) list.push(pick.who);
    list.sort(function (a, b) {
      var ha = handUp(a), hb = handUp(b);
      if (ha !== hb) return ha ? -1 : 1;
      return String(a).localeCompare(String(b));
    });
    box.textContent = '';
    if (!list.length) {
      var none = document.createElement('span');
      none.className = 'none';
      none.textContent = '目前沒有學生在線上';
      box.appendChild(none);
      return;
    }
    ['*'].concat(list).forEach(function (a) {
      var b = document.createElement('button'), on = a === pick.who;
      b.type = 'button';
      b.className = 'btn' + (on ? ' on' : handUp(a) ? ' raised' : '');
      b.textContent = (handUp(a) ? '🙋 ' : '') + (a === '*' ? '全部學生' : nick(a)) + (on ? '（' + MODE_NAME[pick.mode] + '）' : '');
      b.setAttribute('data-stage', a);
      box.appendChild(b);
    });
  }

  var stuTarget = '';   // 對話框正在設定的學生（'*' = 全部學生）
  function openStudentDialog(a) {
    var g = state.game;
    if (!g || g.status !== 'demo') return;
    stuTarget = a;
    var pick = currentPick(g);
    $('stuTitle').textContent = a === '*' ? '全部學生' : nick(a);
    Array.prototype.forEach.call($('stuOptions').querySelectorAll('[data-mode]'), function (b) {
      var m = b.getAttribute('data-mode');
      b.hidden = m === 'teacher' && pick.who !== a;
      b.classList.toggle('on', pick.who === a && pick.mode === m);
    });
    $('dlgStudent').showModal();
  }

  /* 學生現在點棋盤是在作答（不是擺子） */
  function studentAnswering(g) {
    return online() && !isTeacher() && !!g.quiz && g.quiz.state === 'open';
  }

  /* 棋盤上要顯示的答案：老師隨時看得到全部；學生在公布前只看得到自己的 */
  function quizMarks(g) {
    var q = g.quiz;
    if (!q || q.size !== g.record.size) return null;
    var me = online() ? session.account : '';
    var all = isTeacher();   // 統計只有老師看得到
    return M.quizGroups(g).filter(function (grp) {
      return all || grp.names.indexOf(me) >= 0;
    }).map(function (grp) {
      var mine = !isTeacher() && grp.names.indexOf(me) >= 0;
      return { p: grp.p, label: all ? String(grp.names.length) : '✓', mine: mine };
    });
  }

  function renderQuiz(g, demo) {
    var show = demo && online() && g.status === 'demo';
    $('quizBox').hidden = !show || (!g.quiz && !isTeacher());
    if ($('quizBox').hidden) return;
    var q = g.quiz, teacher = isTeacher();
    var size = g.record.size, groups = q ? M.quizGroups(g) : [];
    var students = onlineStudents(), answered = q ? q.answers.map(function (x) { return x.a; }) : [];
    var title = '', text = '';
    if (q && teacher) {
      title = '答題中';
      text = '已答 ' + answered.length + (students.length ? ' / ' + students.length : '') + ' 人';
    } else if (q) {
      var mine = q.answers.filter(function (x) { return x.a === session.account; })[0];
      title = '老師出題';
      text = mine ? '你選了 ' + E.label(size, mine.p) + '（可以改）' : '點棋盤選下一手';
    }
    $('quizTitle').textContent = title;
    $('quizText').textContent = text;
    var res = $('quizResults');
    res.textContent = '';
    if (q && teacher) {
      groups.forEach(function (grp) {
        var row = document.createElement('div'), a = document.createElement('b'), names = document.createElement('span');
        a.textContent = E.label(size, grp.p);
        names.textContent = grp.names.length + ' 人：' + grp.names.map(nick).join('、');
        row.appendChild(a);
        row.appendChild(names);
        res.appendChild(row);
      });
    }
    $('btnQuizOpen').hidden = !teacher || !!q;
    $('btnQuizClose').hidden = !teacher || !q;
  }

  $('handFab').addEventListener('click', function () {
    if (!online() || isTeacher()) return;
    var up = !handUp(session.account);
    net.setHand(up).then(function () { if (up) toast('已舉手，等老師點你'); },
      function () { toast('連線有問題，沒有送出'); });
  });
  $('stageList').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-stage]');
    if (b && isTeacher()) openStudentDialog(b.getAttribute('data-stage'));
  });
  $('stuOptions').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-mode]');
    if (!b || !isTeacher()) return;
    var a = stuTarget, m = b.getAttribute('data-mode');
    $('dlgStudent').close();
    act(function (x) {
      if (!x.demo) return false;
      if (m === 'teacher') return M.demoSetWho(x, 'teacher');
      if (a === '*') return m === 'stage' ? M.demoSetWho(x, 'free') : M.demoSetWho(x, m, '');
      return M.demoSetWho(x, m, a);
    }).then(function (ok) { if (ok && m !== 'teacher' && a !== '*' && handUp(a)) net.lowerHand(a); });
  });
  $('btnQuizOpen').addEventListener('click', function () { act(function (x) { return M.quizOpen(x); }); });
  $('btnQuizClose').addEventListener('click', function () { act(function (x) { return M.quizClose(x); }); });

  /* ---------- 語音 ---------- */
  var voice = null;          // Go.Voice，登入後建立
  var voiceOpen = false;     // 語音面板是否打開
  var voiceSeen = { canSpeak: null, teacherIn: null };   // 用來判斷狀態「剛改變」以跳出提示

  function startVoice(user) {
    var cfg = window.GO_CONFIG || {};
    voice = new Go.Voice(net, { account: user.account, role: user.role }, {
      iceServers: cfg.voice && cfg.voice.iceServers,
      fakeMic: net.kind === 'demo' && /[?&]fakemic=1\b/.test(location.search)   // 測試模式：用假的聲音代替麥克風
    });
    voiceSeen = { canSpeak: null, teacherIn: null };
    voice.onChange = renderVoice;
    voice.start();
    var v = voice;
    stopWatching.push(function () { v.stop(); });
  }

  function voiceName(m) {
    return nameOf(m.a, m.r) + (voice && m.pid === voice.pid ? '（你）' : '');
  }

  function renderVoice() {
    var show = online() && state.mode !== 'login' && !!voice;
    $('btnVoice').hidden = !show;
    $('voicePanel').hidden = !show || !voiceOpen;
    if (!show) return;
    var v = voice, teacher = isTeacher(), members = v.members.slice();
    members.sort(function (a, b) {
      if (a.r !== b.r) return a.r === 'teacher' ? -1 : 1;
      return String(a.a).localeCompare(String(b.a));
    });
    var teacherIn = members.some(function (m) { return m.r === 'teacher'; });

    // 狀態剛改變時的提示
    var can = v.canSpeak();
    if (!teacher && v.joined && voiceSeen.canSpeak !== null && can !== voiceSeen.canSpeak) {
      Sound.notice();
      toast(can ? '老師開放你說話了 🎤' : '老師關閉了你的麥克風');
    }
    voiceSeen.canSpeak = v.joined ? can : null;
    if (!teacher && !v.joined && teacherIn && voiceSeen.teacherIn === false) {
      Sound.notice();
      toast('老師開了語音，按上方「🎧 語音」加入');
    }
    voiceSeen.teacherIn = teacherIn;

    var btn = $('btnVoice');
    btn.classList.toggle('on', v.joined);
    btn.textContent = v.joined ? (v.speaking() ? '🎙️ 語音中' : '🎧 語音中')
      : '🎧 語音' + (members.length ? '（' + members.length + '）' : '');
    $('voiceState').textContent = v.joining ? '加入中…' : v.joined ? '已加入' : '尚未加入';
    $('btnVoiceJoin').hidden = v.joined;
    $('btnVoiceJoin').disabled = v.joining;
    $('btnVoiceJoin').textContent = v.joining ? '加入中…' : '加入語音';
    $('btnVoiceLeave').hidden = !v.joined;
    $('btnMic').hidden = !v.joined || !v.stream;
    $('btnMic').textContent = v.micOn ? '🎤 我的麥克風：開（按一下關掉）' : '🔇 我的麥克風：關（按一下打開）';
    $('btnMic').classList.toggle('on', v.micOn && can);

    var hint = $('voiceHint'), warn = false, text = '';
    if (v.micError) { text = v.micError; warn = true; }
    else if (!v.joined) text = teacherIn ? '老師在語音裡，按「加入語音」就聽得到。' : '加入語音後就能和大家說話。';
    else if (!teacher && !can) text = '老師還沒開放你說話，你聽得到大家。想說話可以先舉手。';
    else if (!teacher && can) text = v.micOn ? '老師開放你說話了，大家聽得到你。' : '老師開放你說話了，打開麥克風就能說。';
    hint.textContent = text;
    hint.classList.toggle('warn', warn);

    $('voiceAllRow').hidden = !teacher;
    $('voiceAllowAll').checked = v.allow.all;

    var list = $('voiceList');
    list.textContent = '';
    if (!members.length) {
      var empty = document.createElement('div');
      empty.className = 'voice-empty';
      empty.textContent = '目前沒有人在語音裡';
      list.appendChild(empty);
    }
    members.forEach(function (m) {
      var row = document.createElement('div'), name = document.createElement('span'), st = document.createElement('span');
      row.className = 'voice-row';
      var talking = m.has && m.mic && v.allowed(m.a, m.r);
      name.className = 'vname';
      name.textContent = (talking ? '🎤 ' : '🔇 ') + voiceName(m);
      st.className = 'vstate';
      if (m.pid === v.pid) {
        st.textContent = m.has ? '' : '沒有麥克風';
      } else if (v.joined) {
        var ps = v.peerState(m.pid);
        st.textContent = ps === 'connected' ? '已連線' : ps === 'failed' ? '連不上' : '連線中…';
        st.classList.add(ps === 'connected' ? 'ok' : ps === 'failed' ? 'bad' : 'wait');
      }
      if (!m.has && m.pid !== v.pid) st.textContent = (st.textContent ? st.textContent + '・' : '') + '只聽';
      row.appendChild(name);
      row.appendChild(st);
      if (teacher && m.r === 'student') {
        var b = document.createElement('button'), allowedNow = v.allowed(m.a, m.r);
        b.type = 'button';
        b.className = 'btn' + (allowedNow ? ' on' : '');
        b.textContent = v.allow.all ? '全部開放中' : allowedNow ? '關閉說話' : '開放說話';
        b.disabled = v.allow.all;
        b.setAttribute('data-allow', m.a);
        b.setAttribute('data-on', allowedNow ? '0' : '1');
        row.appendChild(b);
      }
      list.appendChild(row);
    });
  }

  $('btnVoice').addEventListener('click', function () {
    voiceOpen = !voiceOpen;
    renderVoice();
  });
  $('voiceClose').addEventListener('click', function () {
    voiceOpen = false;
    renderVoice();
  });
  $('btnVoiceJoin').addEventListener('click', function () { if (voice) voice.join(); });
  $('btnVoiceLeave').addEventListener('click', function () { if (voice) voice.leave(); });
  $('btnMic').addEventListener('click', function () { if (voice) voice.setMic(!voice.micOn); });
  $('voiceAllowAll').addEventListener('change', function () {
    if (!isTeacher()) return;
    var on = this.checked;
    net.setVoiceAllowAll(on).then(function () {
      toast(on ? '全部學生都可以說話' : '已關閉所有學生的麥克風');
    }, function () { toast('連線有問題，沒有設定成功'); });
  });
  $('voiceList').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-allow]');
    if (!b || !isTeacher()) return;
    net.setVoiceAllow(b.getAttribute('data-allow'), b.getAttribute('data-on') === '1')
      .then(null, function () { toast('連線有問題，沒有設定成功'); });
  });
  // 瀏覽器擋掉自動播放時，點一下畫面就恢復聲音
  document.addEventListener('pointerdown', function () { if (voice) voice.resumeAudio(); }, true);
  window.addEventListener('pagehide', function () { if (voice) voice.leave(); });

  /* ---------- 聊天室 ---------- */
  var QUICK = {
    teacher: ['好的', '很好！', '再想想看', '注意看這裡', '換你擺擺看', '有問題嗎？', '休息一下', '下課囉，再見'],
    student: ['好的', '我懂了', '我不懂', '請再講一次', '等我一下', '我有問題', '老師好', '謝謝老師']
  };
  var STICKERS = ['👍', '👏', '🌸', '⭐', '💯', '😊', '😮', '❓'];
  var chat = { list: [], seen: null, open: false, unread: 0, locked: false };

  function resetChat() {
    chat.list = [];
    chat.seen = null;
    chat.unread = 0;
    chat.locked = false;
    chat.open = false;
  }
  function speaker(m) { return nameOf(m.a, m.r); }
  function isMine(m) { return online() && m.a === session.account && m.r === session.role; }
  function canChat() { return online() && (isTeacher() || !chat.locked); }

  function clock(t) {
    var d = new Date(t || 0);
    return two(d.getHours()) + ':' + two(d.getMinutes());
  }

  /* 線上名單：老師排第一，學生依帳號排序 */
  function renderPeople() {
    var box = $('chatPeople');
    box.textContent = '';
    var people = (presence.people || []).slice().sort(function (a, b) {
      if (a.role !== b.role) return a.role === 'teacher' ? -1 : 1;
      return String(a.account).localeCompare(String(b.account));
    });
    $('chatCount').textContent = people.length ? '在線 ' + people.length + ' 人' : '';
    if (!people.length) { box.textContent = '目前沒有人在線上'; return; }
    box.appendChild(document.createTextNode('在線：'));
    people.forEach(function (p, i) {
      if (i) box.appendChild(document.createTextNode('、'));
      var b = document.createElement('b');
      b.textContent = (p.role === 'student' && handUp(p.account) ? '🙋' : '') + nameOf(p.account, p.role) +
        (online() && p.account === session.account && p.role === session.role ? '（你）' : '');
      box.appendChild(b);
    });
  }

  function renderChatList() {
    var list = $('chatList');
    var nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    list.textContent = '';
    if (!chat.list.length) {
      var empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = '還沒有訊息';
      list.appendChild(empty);
      return;
    }
    chat.list.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'msg ' + (m.r === 'teacher' ? 'teacher' : 'student') + ' ' + m.k + (isMine(m) ? ' mine' : '');
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = (isMine(m) ? '我' : speaker(m)) + '　' + clock(m.t);
      var bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = m.x;
      row.appendChild(meta);
      row.appendChild(bubble);
      list.appendChild(row);
    });
    if (nearBottom || chat.forceScroll) list.scrollTop = list.scrollHeight;
    chat.forceScroll = false;
  }

  function renderChat() {
    renderHand();
    renderVoice();
    var show = online() && state.mode !== 'login';
    $('chatFab').hidden = !show || chat.open;
    $('chatPanel').hidden = !show || !chat.open;
    document.body.classList.toggle('chat-open', show && chat.open);
    $('chatBadge').hidden = !chat.unread;
    $('chatBadge').textContent = chat.unread > 99 ? '99+' : String(chat.unread);
    if (!show) return;
    $('chatAdmin').hidden = !isTeacher();
    $('chatLock').checked = chat.locked;
    var allowed = canChat();
    $('chatPanel').classList.toggle('locked', !allowed);
    $('chatInput').disabled = !allowed;
    $('chatSend').disabled = !allowed;
    $('chatInput').placeholder = allowed ? '輸入訊息…' : '老師開啟了禁言，現在不能發言';
    var role = isTeacher() ? 'teacher' : 'student';
    if ($('chatQuick').getAttribute('data-role') !== role) {
      $('chatQuick').setAttribute('data-role', role);
      $('chatQuick').textContent = '';
      QUICK[role].forEach(function (text) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.textContent = text;
        b.setAttribute('data-quick', text);
        $('chatQuick').appendChild(b);
      });
    }
  }

  /* 貼圖：在每個人的畫面中間跳出來一下 */
  function popSticker(emoji, from) {
    var el = document.createElement('div');
    el.className = 'sticker-pop';
    var e = document.createElement('div'), f = document.createElement('div');
    e.className = 'emoji';
    e.textContent = emoji;
    f.className = 'from';
    f.textContent = from;
    el.appendChild(e);
    el.appendChild(f);
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 1900);
  }

  function onChat(list) {
    var first = chat.seen === null;   // 剛登入時讀到的舊訊息不跳通知
    if (first) chat.seen = {};
    var fresh = [];
    list.forEach(function (m) {
      if (chat.seen[m.id]) return;
      chat.seen[m.id] = true;
      if (!first) fresh.push(m);
    });
    chat.list = list;
    fresh.forEach(function (m) {
      if (m.k === 'sticker') popSticker(m.x, isMine(m) ? '我' : speaker(m));
      if (isMine(m)) return;
      Sound.notice();
      if (!chat.open) {
        chat.unread++;
        if (m.k !== 'sticker') toast(speaker(m) + '：' + m.x);
      }
    });
    renderChatList();
    renderChat();
  }

  function sendChat(kind, text) {
    if (!canChat()) { toast('老師開啟了禁言，現在不能發言'); return; }
    chat.forceScroll = true;
    net.sendChat({ k: kind, x: text }).then(null, function () { toast('連線有問題，訊息沒有送出'); });
  }

  // 第一次載入時把貼圖按鈕放好
  STICKERS.forEach(function (emoji) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = emoji;
    b.setAttribute('data-sticker', emoji);
    b.title = '送出貼圖';
    $('chatStickers').appendChild(b);
  });

  $('chatFab').addEventListener('click', function () {
    chat.open = true;
    chat.unread = 0;
    chat.forceScroll = true;
    renderChat();
    renderChatList();
  });
  $('chatClose').addEventListener('click', function () {
    chat.open = false;
    renderChat();
  });
  $('chatForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var text = $('chatInput').value.trim();
    if (!text) return;
    $('chatInput').value = '';
    sendChat('text', text);
  });
  $('chatQuick').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-quick]');
    if (b) sendChat('quick', b.getAttribute('data-quick'));
  });
  $('chatStickers').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-sticker]');
    if (b) sendChat('sticker', b.getAttribute('data-sticker'));
  });
  $('chatLock').addEventListener('change', function () {
    if (!isTeacher()) return;
    var on = this.checked;
    net.setChatLock(on).then(function () {
      toast(on ? '已開啟學生禁言' : '已關閉學生禁言');
    }, function () { toast('連線有問題，沒有設定成功'); });
  });
  $('btnChatClear').addEventListener('click', function () {
    ask('清空聊天？', '所有人的聊天紀錄都會刪除，無法復原。', '清空').then(function (ok) {
      if (ok) net.clearChat().then(null, function () { toast('連線有問題，沒有清空'); });
    });
  });

  /* ---------- 選項 ---------- */
  $('optNumbers').checked = prefs.numbers;
  $('optConfirm').checked = prefs.confirm;
  $('optSound').checked = prefs.sound;
  $('optNumbers').addEventListener('change', function () {
    prefs.numbers = this.checked;
    savePrefs();
    render();
  });
  $('optConfirm').addEventListener('change', function () {
    prefs.confirm = this.checked;
    state.pending = -1;
    savePrefs();
    render();
  });
  $('optSound').addEventListener('change', function () {
    prefs.sound = this.checked;
    Sound.enabled = this.checked;
    savePrefs();
    if (this.checked) Sound.stone();
  });

  /* ---------- 其他 ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('dialog [data-close]'), function (btn) {
    btn.addEventListener('click', function () { btn.closest('dialog').close(); });
  });

  window.addEventListener('beforeunload', function (ev) {
    // 連線時對局存在資料庫裡，重新整理不會遺失，不需要提醒
    if (!online() && hasNewMoves()) { ev.preventDefault(); ev.returnValue = ''; }
  });

  render();
})();
