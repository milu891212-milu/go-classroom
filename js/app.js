/*
 * 畫面流程：（登入）→ 首頁 → 棋譜瀏覽 → 對弈（下棋中 → 數目 → 結束）。
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
  var presence = { teacher: false, student: false };
  var stopWatching = [];
  var loginState = { ready: false, authKnown: false, failed: '' };

  function online() { return !!session; }
  function isTeacher() { return online() && session.role === 'teacher'; }
  function now() { return online() ? net.now() : Date.now(); }
  /* 連線時我執哪一色（單機回傳 0） */
  function myColor() {
    var g = state.game;
    if (!online() || !g || !g.teacherColor) return 0;
    return isTeacher() ? g.teacherColor : E.other(g.teacherColor);
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
    time: { preset: '1200,30,3', main: 20, byo: 30, periods: 3 }
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
    tool: 'alt'        // 老師擺棋時選的工具：alt / b / w（擺子）或 tri / sq / cir / x / letter（標記）
  };
  var RULE_NAME = { territory: '比目法', area: '數子法' };
  var STONE_TOOL = { alt: 0, b: BLACK, w: WHITE };
  /* 這台裝置能不能擺棋講解（連線時只有老師；單機都可以） */
  function canTeach() { return !online() || isTeacher(); }
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
    ['600,30,3', '10 分＋30 秒 × 3 次'],
    ['1200,30,3', '20 分＋30 秒 × 3 次'],
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
        if (sel.selectedIndex < 0) sel.value = 'none';
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
      demo: g.demo ? g.demo.base + g.demo.moves.length : 0   // 擺棋時盤面走到第幾步
    };
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
      } else if (g.demo.base + g.demo.moves.length > prev.demo) {
        Sound.stone();
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
  function onRemoteGame(raw) {
    var g = M.normalize(raw);
    var wasPlaying = state.mode === 'play';
    if (g) {
      state.game = g;
      if (!wasPlaying) {
        state.mode = 'play';
        state.pending = -1;
        byoAnnounced = {};
        beepKey = '';
      } else {
        effects(state.snap, g);
      }
      state.snap = snapshot(g);
    } else if (wasPlaying) {
      closeGameDialogs();
      state.game = null;
      state.snap = null;
      state.pending = -1;
      if (isTeacher()) {
        if (state.source) { state.mode = 'review'; state.cursor = state.returnCursor; }
        else state.mode = 'home';
      } else {
        state.mode = 'wait';
        toast('老師結束了這盤對局');
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
    if (online()) $('who').textContent = session.account + '・' + (isTeacher() ? '老師' : '學生');
    $('btnLogout').hidden = !online();
    $('btnLogout').textContent = net && net.kind === 'demo' ? '離開測試' : '登出';
    $('btnLogin').hidden = !(net && !online() && m !== 'login');
    $('connTag').hidden = !(online() && !connected);
    $('newSeatRow').hidden = !isTeacher();
    $('startSeatRow').hidden = !isTeacher();
    $('demoBox').hidden = !!net;

    if (m === 'login') renderLogin();
    renderPresence();
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
    var g = state.game, show = state.mode === 'play' && online() && g && g.teacherColor;
    [[BLACK, 'B'], [WHITE, 'W']].forEach(function (pair) {
      var el = $('pres' + pair[1]);
      var mine = show && myColor() === pair[0];
      el.hidden = !show || mine;
      if (!show || mine) return;
      var on = presence[g.teacherColor === pair[0] ? 'teacher' : 'student'];
      el.textContent = on ? '在線' : '離線';
      el.className = 'presence ' + (on ? 'on' : 'off');
    });
  }

  function cardName(record, color) {
    var g = state.game;
    if (state.mode === 'play' && online() && g.teacherColor) {
      return (g.teacherColor === color ? '老師' : '學生') + (myColor() === color ? '（你）' : '');
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
    var pos = G.replay(record);
    var dv = demo ? M.demoView(g) : null;
    state.pos = demo ? dv.pos : pos;   // 擺棋時，能不能下要看加上變化之後的局面
    var sc = (scoring || (finished && g.result.reason === 'score')) ? M.score(g) : null;
    var myTurn = playing && controls(g.turn);

    $('modeTag').textContent = playing ? '對弈中' : scoring ? '數目中' : demo ? '擺棋講解' : '對局結束';
    view.setSize(record.size);
    if (demo) {
      // 變化的棋子一律顯示 1、2、3…，方便講解順序
      view.render({ board: dv.board, last: dv.last, numbers: dv.numbers, ko: -1, marks: g.demo.marks });
    } else {
      view.render({
        board: pos.board,
        last: pos.last,
        numbers: prefs.numbers && !sc ? pos.numbers : null,
        ko: playing ? pos.ko : -1,
        dead: sc ? sc.dead : null,
        owner: sc ? sc.owner : null
      });
    }
    $('board').classList.toggle('playing', myTurn);
    $('board').classList.toggle('scoring', scoring);
    $('board').classList.toggle('teaching', demo && teach);
    updateGhost();

    renderPlayers(record, demo ? dv.pos : pos, playing ? g.turn : 0, finished ? g.result.winner : 0);

    var last = lastMoveBefore(record, record.moves.length);
    if (playing) {
      setStatus('輪到' + side(g.turn) + (online() ? (myTurn ? '（你）' : '（對方）') : ''),
        '第 ' + (pos.moveNo + 1) + ' 手' + (last ? '　上一手：' + G.describeMove(record, last) : '') +
        '　' + RULE_NAME[g.rule] + '　貼目 ' + record.komi);
    } else if (scoring) {
      setStatus('數目中（' + RULE_NAME[g.rule] + '）',
        online() ? '標記死子後，雙方都按「確認結果」' : '請標記死子，確認後算出勝負');
    } else if (demo) {
      setStatus(online() && !teach ? '老師擺棋講解中' : '擺棋講解中',
        (g.demo.from === 'playing' ? '對局暫停，時間不會走。' : '') +
        (teach ? '在棋盤上擺變化或加標記' + (online() ? '，學生會同步看到' : '') : '請看棋盤'));
    } else {
      setStatus(g.result.text, '共 ' + pos.moveNo + ' 手');
    }

    $('reviewBox').hidden = true;
    $('reviewActions').hidden = true;
    $('playBox').hidden = false;
    $('optSoundRow').hidden = false;
    $('optConfirmRow').hidden = !playing;

    var busy = !!g.request;
    var undoActor = online() ? myColor() : E.other(g.turn);
    $('btnConfirm').hidden = !(myTurn && prefs.confirm);
    $('btnConfirm').disabled = state.pending < 0;
    $('playButtons').hidden = !playing;
    $('btnPass').disabled = !myTurn || busy;
    $('btnUndo').disabled = busy || !M.canUndo(g, undoActor);
    $('btnCount').disabled = busy;
    $('btnDraw').disabled = busy;
    $('btnForceUndo').hidden = !isTeacher();
    $('btnForceUndo').disabled = M.newMoves(g) <= 0;
    $('scoreBox').hidden = !sc;
    $('scoreHint').hidden = !scoring;
    $('scoreButtons').hidden = !scoring;
    $('btnEnd').hidden = online() && !isTeacher();
    $('btnEnd').textContent = state.source ? '結束對局，回到棋譜' : '結束對局';

    // 老師擺棋講解
    $('btnTeach').hidden = !(teach && (playing || finished));
    $('btnTeach').textContent = playing ? '暫停對局，擺棋講解' : '擺棋講解';
    $('teachBox').hidden = !(demo && teach);
    if (demo && teach) {
      Array.prototype.forEach.call($('teachBox').querySelectorAll('[data-tool]'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-tool') === state.tool);
      });
      var dm = g.demo, atEnd = dv.base >= dv.total;
      $('btnTeachBack').disabled = !dm.moves.length && dv.base <= 0;
      $('btnTeachFwd').disabled = !dm.undone.length && (dm.moves.length > 0 || atEnd);
      $('btnTeachClear').disabled = !dm.moves.length && !dm.marks.length && !dm.undone.length && atEnd;
      $('teachWhere').textContent = (atEnd ? '暫停時的局面' : '退回到第 ' + dv.pos.moveNo + ' 手') +
        (dm.moves.length ? '＋變化 ' + dm.moves.length + ' 手' : '');
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
      var fixed = STONE_TOOL[state.tool];
      if (!canTeach() || fixed === undefined || state.hover < 0) { view.setGhost(-1); return; }
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
  function startPlay(record, startAt, turn, time, seat, rule) {
    var game = M.create(record, startAt, turn, time, now());
    game.rule = rule === 'area' ? 'area' : 'territory';
    prefs.rule = game.rule;
    savePrefs();
    state.tool = 'alt';
    byoAnnounced = {};
    beepKey = '';
    if (online()) {
      game.teacherColor = seat;
      state.returnCursor = startAt;
      net.setGame(game).then(null, function () { toast('連線有問題，無法開始對局'); });
      return; // 畫面等資料庫回報後由 onRemoteGame 切換
    }
    state.mode = 'play';
    state.game = game;
    state.pending = -1;
    render();
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
    openReview(record);
    return true;
  }

  function loadFile(file) {
    if (!file) return;
    if (state.mode === 'login' || state.mode === 'wait') return; // 學生不能載入棋譜
    if (state.mode === 'play') { toast('請先結束目前的對局，再載入棋譜'); return; }
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
  var komiTouched = false;
  function defaultKomi() {
    if (komiTouched) return;
    $('newKomi').value = $('newHandicap').value === '0' ? STD_KOMI[$('newRule').value] : 0.5;
  }
  $('newRule').value = prefs.rule;
  defaultKomi();
  $('newKomi').addEventListener('input', function () { komiTouched = true; });
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
    startPlay(record, 0, record.first, newTime.read(), checkedValue('newSeat'), $('newRule').value);
  });

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
    $('startKomi').value = src.komi;
    $('startRule').value = prefs.rule;
    startTime.show();
    $('dlgStart').showModal();
  });
  // 貼目是另一種規則的慣用值時，換規則就跟著換（自己填的其他數字不動）
  $('startRule').addEventListener('change', function () {
    var komi = parseFloat($('startKomi').value);
    if (komi === STD_KOMI.territory || komi === STD_KOMI.area) $('startKomi').value = STD_KOMI[this.value];
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
    startPlay(record, record.moves.length, turn, time, checkedValue('startSeat'), $('startRule').value);
  });

  /* ---------- 對弈 ---------- */
  function explain(reason) {
    if (reason === 'ko') toast('打劫：要先在別處下一手，才能提回');
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
      act(function (x) { return M.toggleDead(x, idx); });
      return;
    }
    if (g.status === 'demo') {
      if (!canTeach()) return;
      var tool = state.tool, color = STONE_TOOL[tool];
      if (color === undefined) {
        act(function (x) { return M.demoMark(x, idx, tool); });
      } else {
        act(function (x) { return M.demoPlay(x, color, idx); }).then(function (ok) {
          if (!ok && state.pos && !state.pos.board[idx]) toast('這裡是禁著點，不能下');
        });
      }
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
  function teachStep(forward) {
    act(function (x) { return forward ? M.demoForward(x) : M.demoBack(x); });
  }
  $('btnTeachBack').addEventListener('click', function () { teachStep(false); });
  $('btnTeachFwd').addEventListener('click', function () { teachStep(true); });
  // 擺棋時也可以用鍵盤左右鍵
  document.addEventListener('keydown', function (ev) {
    if (state.mode !== 'play' || !state.game || state.game.status !== 'demo' || !canTeach()) return;
    if (document.querySelector('dialog[open]')) return;
    var tag = ev.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (ev.key === 'ArrowLeft') { teachStep(false); ev.preventDefault(); }
    else if (ev.key === 'ArrowRight') { teachStep(true); ev.preventDefault(); }
  });
  $('btnTeachClear').addEventListener('click', function () {
    act(function (x) { return M.demoClear(x); });
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

  function leavePlay(toHome) {
    var back = function () {
      if (online()) {
        if (toHome) state.source = null;
        // 清掉資料庫裡的對局，雙方的畫面都會跟著離開（見 onRemoteGame）
        net.setGame(null).then(null, function () { toast('連線有問題，無法結束對局'); });
        return;
      }
      if (!toHome && state.source) openReview(state.source, state.game.startAt);
      else goHome();
    };
    if (!hasNewMoves() && !(online() && state.game.status !== 'finished')) { back(); return; }
    var text = (online() ? '學生的畫面也會一起結束。' : '') +
      '還沒匯出的著手不會保留。需要留存的話，請先按「匯出 SGF」。';
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
        net.onConnection(function (c) {
          connected = c;
          $('connTag').hidden = !(online() && !connected);
        });
        net.setPresence(user.role);
      } else {
        state.mode = solo ? 'home' : 'login';
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
  $('btnLogout').addEventListener('click', function () { net.signOut(); });

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
