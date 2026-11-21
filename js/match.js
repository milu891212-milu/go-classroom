/*
 * 一盤對局的完整狀態與所有動作：落子、計時、悔棋、認輸、數目。
 * game 是純資料（可存成 JSON），之後連線同步就是同步這個物件：
 *   {
 *     record, startAt, turn,
 *     rule:   'territory'（比目法）或 'area'（數子法）,
 *     status: 'playing' | 'scoring' | 'finished' | 'demo'（老師擺棋講解，對局暫停）,
 *     demo:   null 或 { from:'playing'|'finished'|'lecture', base, moves:[{c,p}], undone:[{c,p}], marks:[{p,t}],
 *                       draw:[{t:'pen'|'arrow', pts:[x,y,x,y…]}], who:'teacher'|'free'|'black'|'white'|'stage',
 *                       stage: 'stage' 時被老師請上台的學生帳號 },
 *     quiz:   null 或 { n: 第幾題, state:'open'（作答中）|'shown'（已公布）, size, answers:[{a: 帳號, p: 位置}] }
 *             擺棋講解（含講解房）時老師出題，學生各自點一個位置，老師公布後大家才看得到彼此的答案,
 *     student: 連線對弈時跟老師下的學生帳號（'' 表示任何學生都能下）,
 *     lecture: true 表示這是講解房（沒有對局，一直停在擺棋講解，見 createLecture）,
 *     clock:  null（不計時）或 { main, byo, periods, left:{b:{main,periods}, w:{...}}, since },
 *     request: null 或 { type:'undo'|'count'|'draw', from },
 *     dead:   [數目時被標為死子的位置],
 *     result: null 或 { winner, reason, margin, text, sgf }
 *   }
 * 時間一律由呼叫端傳入 now（毫秒），方便測試，連線後也能改用伺服器時間。
 */
(function (global) {
  'use strict';
  var Go = global.Go = global.Go || {};
  var E = Go.Engine, G = Go.Game, BLACK = Go.BLACK, WHITE = Go.WHITE;

  function key(color) { return color === BLACK ? 'b' : 'w'; }

  /* time: { main: 秒, byo: 秒, periods: 次 }，或 null 表示不計時 */
  function create(record, startAt, turn, time, now) {
    var game = {
      record: record,
      startAt: startAt,
      turn: turn,
      status: 'playing',
      clock: null,
      request: null,
      reply: null,                    // 最近一次申請的回覆 { type, from, ok, n }，讓提出的一方知道結果
      dead: [],
      agree: { b: false, w: false },  // 數目時雙方是否已確認結果
      result: null,
      teacherColor: 0,                // 連線對弈時老師執哪一色（單機為 0）
      student: '',                    // 連線對弈時跟老師下的學生帳號（'' = 不限定）
      quiz: null,                     // 擺棋講解時的「一起答題」
      rule: 'area',                   // 數目方式：'territory' 比目法、'area' 數子法
      demo: null                      // 老師擺棋講解時的變化與標記
    };
    if (time) {
      var main = Math.max(0, time.main || 0);
      var byoOn = time.byo > 0 && time.periods > 0;
      if (main > 0 || byoOn) {
        var periods = byoOn ? time.periods : 0;
        game.clock = {
          main: main,
          byo: byoOn ? time.byo : 0,
          periods: periods,
          left: {
            b: { main: main * 1000, periods: periods },
            w: { main: main * 1000, periods: periods }
          },
          since: now   // 目前這一手從什麼時候開始計時；0 = 時鐘停止
        };
      }
    }
    return game;
  }

  /* ---------- 計時 ---------- */

  /*
   * 壓秒緩衝（毫秒）：時間顯示到 0 之後，再過這麼久才真的扣一次讀秒（或超時）。
   * 倒數到最後一秒才落子時，網路與手指的延遲不會害人多扣一次。
   */
  var GRACE = 500;

  /*
   * 某一方此刻的時間。回傳 null（不計時）或
   *   { inByo, remaining(毫秒，壓秒緩衝期間是 0), periods(剩餘讀秒次數), out(是否超時) }
   */
  function timeView(game, color, now) {
    var c = game.clock;
    if (!c) return null;
    var left = c.left[key(color)];
    var running = game.status === 'playing' && game.turn === color && c.since > 0;
    var elapsed = running ? Math.max(0, now - c.since) : 0;

    if (elapsed < left.main) {
      return { inByo: false, remaining: left.main - elapsed, periods: left.periods, out: false };
    }
    var byoMs = c.byo * 1000;
    if (left.periods <= 0 || byoMs <= 0) {
      // 沒有讀秒：基本時間到 0 之後，壓秒緩衝內落子仍然算數
      return { inByo: false, remaining: 0, periods: 0, out: elapsed >= left.main + GRACE };
    }
    // 每一次讀秒實際長度 = 讀秒秒數 + 壓秒緩衝；緩衝的那一段畫面停在 0
    var span = byoMs + GRACE;
    var over = elapsed - left.main;
    var used = Math.floor(over / span);
    if (used >= left.periods) {
      return { inByo: true, remaining: 0, periods: 0, out: true };
    }
    return {
      inByo: true,
      remaining: Math.max(0, byoMs - (over - used * span)),
      periods: left.periods - used,
      out: false
    };
  }

  /* 把輪到的一方用掉的時間結算進去。超時會直接判負並回傳 false。 */
  function settle(game, now) {
    var c = game.clock;
    if (!c || !c.since) return true;
    var v = timeView(game, game.turn, now);
    var left = c.left[key(game.turn)];
    if (v.out) {
      left.main = 0;
      left.periods = 0;
      c.since = 0;
      finish(game, { winner: E.other(game.turn), reason: 'time' });
      return false;
    }
    left.main = v.inByo ? 0 : v.remaining;
    left.periods = v.periods;
    c.since = now;
    return true;
  }

  function stopClock(game, now) {
    if (!settle(game, now)) return false;
    if (game.clock) game.clock.since = 0;
    return true;
  }

  /* 定時呼叫：有人超時就結束對局，回傳 true */
  function checkTimeout(game, now) {
    if (game.status !== 'playing' || !game.clock || !game.clock.since) return false;
    if (!timeView(game, game.turn, now).out) return false;
    settle(game, now);
    return true;
  }

  /* ---------- 落子 ---------- */

  function newMoves(game) { return game.record.moves.length - game.startAt; }

  /* idx = -1 代表停一手。回傳 { ok, reason } */
  function play(game, idx, now) {
    if (game.status !== 'playing') return { ok: false, reason: 'notplaying' };
    if (idx >= 0) {
      var reason = E.check(G.replay(game.record), game.turn, idx);
      if (reason) return { ok: false, reason: reason };
    }
    if (!settle(game, now)) return { ok: false, reason: 'timeout' };

    game.record.moves.push({ c: game.turn, p: idx });
    game.turn = E.other(game.turn);

    var m = game.record.moves, n = m.length;
    if (idx < 0 && newMoves(game) >= 2 && !m[n - 2].edit && m[n - 2].p < 0) {
      enterScoring(game, now);   // 雙方連續停一手 → 進入數目
    }
    return { ok: true, reason: '' };
  }

  /* color 這一方能不能悔棋（最近兩手內有自己的著手，且不是棋譜原有的） */
  function undoCount(game, color) {
    if (game.status !== 'playing') return 0;
    var m = game.record.moves, n = m.length;
    if (n - 1 >= game.startAt && m[n - 1].c === color) return 1;
    if (n - 2 >= game.startAt && m[n - 2].c === color) return 2;
    return 0;
  }
  function canUndo(game, color) { return undoCount(game, color) > 0; }

  /* 退回到 color 上一手之前，換 color 重新下。時間不退還。 */
  function undo(game, color, now) {
    var k = undoCount(game, color);
    if (!k) return false;
    if (!settle(game, now)) return false;
    game.record.moves.length -= k;
    game.turn = color;
    return true;
  }

  /* 老師專用：不需對方同意，直接退掉最後一手 */
  function forceUndo(game, now) {
    if (game.status !== 'playing' || newMoves(game) <= 0) return false;
    if (!settle(game, now)) return false;
    var m = game.record.moves.pop();
    game.turn = m.c;
    game.request = null;
    return true;
  }

  /* ---------- 結束對局 ---------- */

  function finish(game, res) {
    var w = res.winner, name = w ? G.colorName(w) : '', loser = w ? G.colorName(E.other(w)) : '';
    var letter = w === BLACK ? 'B' : 'W';
    if (res.reason === 'resign') { res.text = name + '勝（' + loser + '方認輸）'; res.sgf = letter + '+R'; }
    else if (res.reason === 'time') { res.text = name + '勝（' + loser + '方超時）'; res.sgf = letter + '+T'; }
    else if (res.reason === 'draw') { res.text = '和棋（雙方同意）'; res.sgf = '0'; }
    else if (w) { res.text = name + '勝 ' + res.margin + ' 目'; res.sgf = letter + '+' + res.margin; }
    else { res.text = '和棋'; res.sgf = '0'; }
    game.status = 'finished';
    game.result = res;
    game.request = null;
    if (game.clock) game.clock.since = 0;
  }

  function resign(game, color, now) {
    if (game.status === 'finished') return;
    if (game.status === 'playing' && !stopClock(game, now)) return; // 剛好超時
    finish(game, { winner: E.other(color), reason: 'resign' });
  }

  function draw(game, now) {
    if (game.status !== 'playing') return;
    if (!stopClock(game, now)) return;
    finish(game, { winner: 0, reason: 'draw' });
  }

  /* ---------- 數目（比目法或數子法，看 game.rule） ---------- */

  function enterScoring(game, now) {
    if (game.status !== 'playing') return;
    if (!stopClock(game, now)) return;
    game.status = 'scoring';
    game.dead = [];
    game.agree = { b: false, w: false };
    game.request = null;
  }

  function resumePlay(game, now) {
    if (game.status !== 'scoring') return false;
    game.status = 'playing';
    game.dead = [];
    game.agree = { b: false, w: false };
    if (game.clock) game.clock.since = now;
    return true;
  }

  /* 點一顆棋子：把它所在的整塊棋標成死子，再點一次取消。死子有變動，雙方要重新確認。 */
  function toggleDead(game, idx) {
    if (game.status !== 'scoring') return false;
    var pos = G.replay(game.record);
    if (!pos.board[idx]) return false;
    game.agree = { b: false, w: false };
    var stones = E.group(pos.board, pos.size, idx).stones;
    var isDead = game.dead.indexOf(idx) >= 0;
    var set = {};
    var i;
    for (i = 0; i < game.dead.length; i++) set[game.dead[i]] = true;
    for (i = 0; i < stones.length; i++) {
      if (isDead) delete set[stones[i]];
      else set[stones[i]] = true;
    }
    game.dead = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    return true;
  }

  /* 一方確認數目結果；雙方都確認就結束對局 */
  function agree(game, color) {
    if (game.status !== 'scoring') return false;
    game.agree[key(color)] = true;
    if (game.agree.b && game.agree.w) finishByScore(game);
    return true;
  }

  /*
   * 計算勝負。
   *   owner[i]：1 黑、2 白、3 雙方共有（數子法各算半子；比目法是單官，不算）
   *   margin：正數黑勝、負數白勝（單位：目）
   *
   * 數子法（rule = 'area'）
   *   black / white：雙方的子數（活子 + 圍住的空點）
   *   margin = 黑子數 − 白子數 − 貼目 − 讓子貼還
   *
   * 比目法（rule = 'territory'）
   *   terrB / terrW：圍住的空點（含對方死子所在的點）
   *   capB / capW ：提子數（對局中提掉的 + 盤上的對方死子）
   *   black / white：地 + 提子
   *   margin = 黑 − 白 − 貼目
   */
  function score(game) {
    var pos = G.replay(game.record), size = pos.size, n = size * size, board = pos.board;
    var dead = new Uint8Array(n), i;
    for (i = 0; i < game.dead.length; i++) if (board[game.dead[i]]) dead[game.dead[i]] = 1;

    var owner = new Uint8Array(n), seen = new Uint8Array(n);
    function alive(p) { return board[p] && !dead[p]; }

    for (i = 0; i < n; i++) {
      if (alive(i)) { owner[i] = board[i]; continue; }
      if (seen[i]) continue;
      // 一片相連的空點（含死子的位置），看它被誰的活棋圍住
      var region = [i], touchB = false, touchW = false;
      seen[i] = 1;
      for (var k = 0; k < region.length; k++) {
        var nb = E.neighbors(size, region[k]);
        for (var j = 0; j < nb.length; j++) {
          var q = nb[j];
          if (alive(q)) {
            if (board[q] === BLACK) touchB = true; else touchW = true;
          } else if (!seen[q]) {
            seen[q] = 1;
            region.push(q);
          }
        }
      }
      var who = touchB && !touchW ? BLACK : (touchW && !touchB ? WHITE : 3);
      for (k = 0; k < region.length; k++) owner[region[k]] = who;
    }

    var komi = game.record.komi || 0, handicap = game.record.handicap || 0;
    var black = 0, white = 0, margin;

    if (game.rule === 'territory') {
      var terrB = 0, terrW = 0, deadB = 0, deadW = 0;
      for (i = 0; i < n; i++) {
        if (dead[i]) { if (board[i] === BLACK) deadB += 1; else deadW += 1; }
        if (alive(i)) continue;
        if (owner[i] === BLACK) terrB += 1;
        else if (owner[i] === WHITE) terrW += 1;
      }
      var capB = pos.caps[BLACK] + deadW, capW = pos.caps[WHITE] + deadB;
      black = terrB + capB;
      white = terrW + capW;
      margin = black - white - komi;
      return {
        rule: 'territory',
        owner: owner,
        dead: dead,
        terrB: terrB, terrW: terrW,
        capB: capB, capW: capW,
        black: black,
        white: white,
        komi: komi,
        handicap: 0,
        margin: margin,
        winner: margin > 0 ? BLACK : (margin < 0 ? WHITE : 0)
      };
    }

    for (i = 0; i < n; i++) {
      if (owner[i] === BLACK) black += 1;
      else if (owner[i] === WHITE) white += 1;
      else { black += 0.5; white += 0.5; }
    }
    margin = black - white - komi - handicap;
    return {
      rule: 'area',
      owner: owner,
      dead: dead,
      black: black,
      white: white,
      komi: komi,
      handicap: handicap,
      margin: margin,
      winner: margin > 0 ? BLACK : (margin < 0 ? WHITE : 0)
    };
  }

  function finishByScore(game) {
    if (game.status !== 'scoring') return;
    var s = score(game);
    finish(game, { winner: s.winner, reason: 'score', margin: Math.abs(s.margin), black: s.black, white: s.white });
  }

  /* ---------- 申請（悔棋／數子／和棋）：一方提出，另一方同意才生效 ---------- */

  function request(game, type, from) {
    if (game.status !== 'playing' || game.request) return false;
    if (type === 'undo' && !canUndo(game, from)) return false;
    game.request = { type: type, from: from };
    return true;
  }

  function respond(game, accept, now) {
    var r = game.request;
    game.request = null;
    if (!r || game.status !== 'playing') return false;
    game.reply = { type: r.type, from: r.from, ok: !!accept, n: (game.reply ? game.reply.n : 0) + 1 };
    if (!accept) return false;
    if (r.type === 'undo') return undo(game, r.from, now);
    if (r.type === 'count') { enterScoring(game, now); return game.status === 'scoring'; }
    if (r.type === 'draw') { draw(game, now); return game.status === 'finished'; }
    return false;
  }

  /* 提出的一方自己收回申請 */
  function cancelRequest(game, from) {
    if (!game.request || game.request.from !== from) return false;
    game.request = null;
    return true;
  }

  /* ---------- 老師擺棋講解：對局暫停，在棋盤上擺變化、加標記，結束後原局面不變 ---------- */

  var MARK_SHAPES = { tri: true, sq: true, cir: true, x: true };
  var MARK_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  /* 對局中或對局結束後都可以開始；對局中會先把時鐘停下來 */
  function startDemo(game, now) {
    if (game.status !== 'playing' && game.status !== 'finished') return false;
    var from = game.status;
    if (from === 'playing' && !stopClock(game, now)) return true;   // 剛好超時：對局已結束，照樣要存回去
    game.status = 'demo';
    game.request = null;
    game.demo = {
      from: from,
      base: game.record.moves.length,   // 目前退到對局的第幾步（可以往回退，從之前的局面擺變化）
      moves: [],                        // 擺的變化
      undone: [],                       // 被「上一手」收回的變化，「下一手」可以再擺回來
      marks: [],
      draw: [],                         // 畫筆與箭頭（棋盤的 SVG 座標）
      who: 'teacher',  // 誰可以擺：'teacher' 只有老師、'free' 學生控制、'black'／'white' 學生持黑／持白和老師輪流、'stage' 上台的學生
      stage: ''        // 被請上台的學生帳號（who = 'stage' 時）
    };
    return true;
  }

  /*
   * 講解房：不下對局，一開始就是擺棋講解。record 可以是空白棋盤或載入的棋譜，
   * cursor 是一開始停在棋譜的第幾步（之後可以前後瀏覽整份棋譜）。
   */
  function createLecture(record, cursor) {
    var n = record.moves.length;
    var game = create(record, 0, G.naturalTurn(record, n), null, 0);
    game.lecture = true;
    game.status = 'demo';
    game.demo = {
      from: 'lecture',
      base: Math.max(0, Math.min(n, cursor === undefined ? n : cursor)),
      moves: [], undone: [], marks: [], draw: [],
      who: 'teacher', stage: ''
    };
    return game;
  }

  /* 講解房換一份棋譜（或換成空白棋盤）：變化、標記、畫線都清掉，學生權限保留 */
  function lectureLoad(game, record, cursor) {
    if (!game.lecture) return false;
    var who = game.demo ? game.demo.who : 'teacher';
    var stage = game.demo ? game.demo.stage : '';
    var fresh = createLecture(record, cursor);
    game.record = fresh.record;
    game.turn = fresh.turn;
    game.demo = fresh.demo;
    game.demo.who = who;
    game.demo.stage = stage || '';
    game.quiz = null;   // 換了棋盤，原本的題目作廢
    return true;
  }

  var MAX_STROKES = 80, MAX_POINTS = 400;

  /* 畫一筆。stroke = { t:'pen'|'arrow', pts:[x,y,x,y…] }（棋盤的 SVG 座標） */
  function demoDraw(game, stroke) {
    if (game.status !== 'demo' || !stroke) return false;
    var t = stroke.t === 'arrow' ? 'arrow' : 'pen';
    var pts = (stroke.pts || []).slice(0, MAX_POINTS * 2).map(function (v) { return Math.round(+v || 0); });
    if (pts.length % 2) pts.pop();
    if (pts.length < 4) return false;
    var d = game.demo, st = { t: t, pts: pts };
    if (/^#[0-9a-fA-F]{6}$/.test(stroke.c || '')) st.c = stroke.c;   // 畫筆顏色
    d.draw = d.draw || [];
    d.draw.push(st);
    if (d.draw.length > MAX_STROKES) d.draw.splice(0, d.draw.length - MAX_STROKES);
    return true;
  }

  /* 拿掉畫線：all = true 全部清除，否則只拿掉最後一筆 */
  function demoUndraw(game, all) {
    if (game.status !== 'demo' || !game.demo.draw || !game.demo.draw.length) return false;
    if (all) game.demo.draw = [];
    else game.demo.draw.pop();
    return true;
  }

  var DEMO_WHO = { teacher: true, free: true, black: true, white: true, stage: true };

  /*
   * 老師設定學生能不能擺棋。account 是指定的學生：
   *   'stage' 這位學生自由擺（一定要指定）；'black'／'white' 這位學生持黑／持白跟老師輪流（'' = 全部學生）
   */
  function demoSetWho(game, who, account) {
    if (game.status !== 'demo' || !DEMO_WHO[who]) return false;
    var stage = who === 'stage' || who === 'black' || who === 'white' ? String(account || '') : '';
    if (who === 'stage' && !stage) return false;
    if (game.demo.who === who && (game.demo.stage || '') === stage) return false;
    game.demo.who = who;
    game.demo.stage = stage;
    return true;
  }

  /* ---------- 一起答題 ---------- */

  /* 老師出題：學生各自點一個位置 */
  function quizOpen(game) {
    if (game.status !== 'demo' || (game.quiz && game.quiz.state === 'open')) return false;
    // c：這題是輪到哪一色下（學生端用這個顏色顯示自己的答案）
    game.quiz = { n: ((game.quiz && game.quiz.n) || 0) + 1, state: 'open', size: game.record.size, c: demoNextColor(game), answers: [] };
    return true;
  }

  /* 學生作答（公布前可以改）；點同一點兩次就收回答案 */
  function quizAnswer(game, account, idx) {
    var q = game.quiz, size = game.record.size;
    if (game.status !== 'demo' || !q || q.state !== 'open' || !account) return false;
    if (q.size !== size || !(idx >= 0 && idx < size * size)) return false;
    var list = q.answers, i;
    for (i = 0; i < list.length; i++) {
      if (list[i].a !== account) continue;
      if (list[i].p === idx) list.splice(i, 1);
      else list[i].p = idx;
      return true;
    }
    list.push({ a: account, p: idx });
    return true;
  }

  function quizShow(game) {
    if (!game.quiz || game.quiz.state !== 'open') return false;
    game.quiz.state = 'shown';
    return true;
  }

  /* 結束（或取消）答題 */
  function quizClose(game) {
    if (!game.quiz) return false;
    game.quiz = null;
    return true;
  }

  /* 答案依位置分組：[{ p, names: [...] }]，人多的排前面 */
  function quizGroups(game) {
    var q = game.quiz, by = {}, out = [];
    if (!q) return out;
    q.answers.forEach(function (x) {
      if (!by[x.p]) { by[x.p] = { p: x.p, names: [] }; out.push(by[x.p]); }
      by[x.p].names.push(x.a);
    });
    return out.sort(function (a, b) { return b.names.length - a.names.length || a.p - b.p; });
  }

  /* 擺棋時最多退回到哪一手：開始下的那一手（例如從棋譜第 75 手開始下，就是 75） */
  function demoFloor(game) {
    return Math.max(0, Math.min(game.startAt || 0, game.record.moves.length));
  }

  function demoBase(game) {
    var total = game.record.moves.length, d = game.demo;
    if (!d || typeof d.base !== 'number') return total;
    return Math.max(demoFloor(game), Math.min(total, d.base));
  }

  /*
   * 擺棋時畫面上的局面：對局（退到 base 那一步）的局面再加上擺的變化。
   * 回傳 { pos, board, numbers(變化的手數 1,2,3…), last, base, total }
   */
  function demoView(game) {
    var base = demoBase(game);
    var pos = G.replay(game.record, base), numbers = new Uint16Array(pos.size * pos.size), last = pos.last;
    var moves = game.demo ? game.demo.moves : [], n = 0;
    for (var i = 0; i < moves.length; i++) {
      var r = E.place(pos, moves[i].c, moves[i].p, false);
      if (!r.ok) continue;
      for (var k = 0; k < r.captured.length; k++) numbers[r.captured[k]] = 0;
      if (moves[i].s) continue;   // 只落黑子／白子（擺題目）：不算手數、不標最後一手
      n++;
      if (pos.board[moves[i].p]) numbers[moves[i].p] = n;
      last = moves[i].p;
    }
    return { pos: pos, board: pos.board, numbers: numbers, last: last, base: base, total: game.record.moves.length };
  }

  /* 擺變化時「黑白輪流」的下一手是誰：看盤上最後一手是誰下的，換另一方 */
  function demoNextColor(game) {
    var moves = game.demo ? game.demo.moves : [];
    for (var i = moves.length - 1; i >= 0; i--) {
      if (!moves[i].s) return E.other(moves[i].c);   // 擺題目的棋子不影響輪到誰
    }
    var base = demoBase(game);
    return base >= game.record.moves.length ? game.turn : G.naturalTurn(game.record, base);
  }

  /* 擺一顆變化的棋。color = 0 表示黑白輪流。會提子；已有棋子或禁著點不能下，打劫不限制。
     setup = true 是「只落黑子／白子」擺題目：不算手數 */
  function demoPlay(game, color, idx, setup) {
    if (game.status !== 'demo') return false;
    var c = color === BLACK || color === WHITE ? color : demoNextColor(game);
    var pos = demoView(game).pos;
    pos.ko = -1;
    if (E.check(pos, c, idx)) return false;
    game.demo.moves.push(setup ? { c: c, p: idx, s: 1 } : { c: c, p: idx });
    game.demo.undone = [];
    return true;
  }

  /* 上一手：先收回擺的變化；變化都收完了，就往回退對局的著手（最多退到開始下的那一手） */
  function demoBack(game) {
    if (game.status !== 'demo') return false;
    var d = game.demo, keep = d.trial ? d.trial.at : 0;   // 試下中：只收回試下的棋，不動試下前的盤面
    if (d.moves.length > keep) {
      d.undone.push(d.moves.pop());
      return true;
    }
    if (keep > 0) return false;
    var base = demoBase(game);
    if (base <= demoFloor(game)) return false;
    d.base = base - 1;
    d.undone = [];
    return true;
  }

  /* 下一手：把收回的變化擺回來；沒有變化時，往前進對局的著手 */
  function demoForward(game) {
    if (game.status !== 'demo') return false;
    var d = game.demo;
    if (d.undone.length) {
      d.moves.push(d.undone.pop());
      return true;
    }
    var base = demoBase(game);
    if (d.moves.length || base >= game.record.moves.length) return false;
    d.base = base + 1;
    return true;
  }

  /* 一次走很多步：n < 0 往回、n > 0 往前，走到不能走為止。有動到就回傳 true。 */
  function demoStep(game, n) {
    if (game.status !== 'demo' || !n) return false;
    var limit = Math.min(Math.abs(n), game.record.moves.length + game.demo.moves.length + game.demo.undone.length);
    var moved = false;
    for (var i = 0; i < limit; i++) {
      if (!(n < 0 ? demoBack(game) : demoForward(game))) break;
      moved = true;
    }
    return moved;
  }

  /*
   * 在某一點加標記；那一點已經有標記就改成拿掉。
   * type：'tri' 三角形、'sq' 方塊、'cir' 圓圈、'x' 叉、'letter' 字母（自動用還沒用過的 A、B、C…）
   */
  function demoMark(game, idx, type) {
    if (game.status !== 'demo') return false;
    var size = game.record.size;
    if (!(idx >= 0 && idx < size * size)) return false;
    var marks = game.demo.marks, i;
    for (i = 0; i < marks.length; i++) {
      if (marks[i].p === idx) { marks.splice(i, 1); return true; }
    }
    var t = type;
    if (type === 'letter') {
      var used = {};
      for (i = 0; i < marks.length; i++) used[marks[i].t] = true;
      t = '';
      for (i = 0; i < MARK_LETTERS.length; i++) {
        if (!used[MARK_LETTERS.charAt(i)]) { t = MARK_LETTERS.charAt(i); break; }
      }
      if (!t) return false;   // 26 個字母都用完了
    } else if (!MARK_SHAPES[type]) {
      return false;
    }
    marks.push({ p: idx, t: t });
    return true;
  }

  /* 清除所有標記 */
  function demoUnmark(game) {
    if (game.status !== 'demo' || !game.demo.marks.length) return false;
    game.demo.marks = [];
    return true;
  }

  /* 結束試下：剛才擺的變化與標記全部拿掉，回到開始擺變化之前的那個局面（對局的著手停在原處） */
  function demoClear(game) {
    if (game.status !== 'demo') return false;
    var d = game.demo;
    if (!d.moves.length && !d.undone.length && !d.marks.length && !(d.draw && d.draw.length) && !d.trial) return false;
    if (d.trial) d.base = d.trial.base;
    d.moves = [];
    d.undone = [];
    d.marks = [];
    d.draw = [];
    delete d.trial;
    return true;
  }

  /*
   * 試下：從目前的盤面開始擺變化，結束試下就回到開始試下時的盤面（試下擺的棋全部拿掉）。
   * demo.trial = { at: 開始時已經擺了幾手, base: 開始時停在棋譜第幾步 }
   */
  function demoTrial(game, on) {
    if (game.status !== 'demo') return false;
    var d = game.demo;
    if (on) {
      if (d.trial) return false;
      d.trial = { at: d.moves.length, base: demoBase(game) };
      d.undone = [];
      return true;
    }
    if (!d.trial) return false;
    d.moves = d.moves.slice(0, d.trial.at);
    d.undone = [];
    d.base = d.trial.base;
    delete d.trial;
    return true;
  }

  /* 回到開始對弈時的局面（例如從棋譜第 75 手開始下，就回到第 75 手）。變化拿掉，標記保留。 */
  function demoToStart(game) {
    if (game.status !== 'demo') return false;
    var d = game.demo, floor = demoFloor(game);
    if (d.trial) {
      // 試下中：回到開始試下的那一手
      if (d.moves.length === d.trial.at && !d.undone.length && demoBase(game) === d.trial.base) return false;
      d.moves = d.moves.slice(0, d.trial.at);
      d.undone = [];
      d.base = d.trial.base;
      return true;
    }
    if (!d.moves.length && !d.undone.length && demoBase(game) === floor) return false;
    d.moves = [];
    d.undone = [];
    d.base = floor;
    delete d.trial;
    return true;
  }

  /* 結束擺棋：變化與標記全部拿掉，回到原本的對局；對局中的話時鐘從現在繼續走 */
  function endDemo(game, now) {
    if (game.status !== 'demo' || game.lecture) return false;   // 講解房沒有對局可以回去
    var from = game.demo && game.demo.from === 'finished' && game.result ? 'finished' : 'playing';
    game.status = from;
    game.demo = null;
    game.quiz = null;
    if (from === 'playing' && game.clock) game.clock.since = now;
    return true;
  }

  /* ---------- 連線同步 ---------- */

  function toArray(v) {
    if (Array.isArray(v)) return v.filter(function (x) { return x !== null && x !== undefined; });
    if (v && typeof v === 'object') {
      return Object.keys(v).sort(function (a, b) { return a - b; }).map(function (k) { return v[k]; });
    }
    return [];
  }

  /*
   * 把從資料庫讀回來的資料整理成完整的 game。
   * 即時資料庫不會儲存空陣列與 null，讀回來時那些欄位會整個不見，這裡補回來。
   * 沒有對局時回傳 null。
   */
  function normalize(raw) {
    if (!raw || !raw.record) return null;
    var g = JSON.parse(JSON.stringify(raw));
    var r = g.record, info = r.info || {};
    r.size = r.size || 19;
    r.komi = typeof r.komi === 'number' ? r.komi : 7.5;
    r.handicap = r.handicap || 0;
    r.first = r.first || 0;
    r.info = {
      pb: info.pb || '', pw: info.pw || '', br: info.br || '', wr: info.wr || '',
      re: info.re || '', dt: info.dt || '', ev: info.ev || ''
    };
    r.setup = { b: toArray(r.setup && r.setup.b), w: toArray(r.setup && r.setup.w) };
    r.moves = toArray(r.moves).map(function (m) {
      if (m.edit) return { edit: true, ab: toArray(m.ab), aw: toArray(m.aw), ae: toArray(m.ae) };
      return { c: m.c, p: m.p };
    });
    g.startAt = g.startAt || 0;
    g.turn = g.turn === WHITE ? WHITE : BLACK;
    g.status = g.status || 'playing';
    g.clock = g.clock || null;
    g.request = g.request || null;
    g.reply = g.reply || null;
    g.dead = toArray(g.dead);
    g.agree = { b: !!(g.agree && g.agree.b), w: !!(g.agree && g.agree.w) };
    g.result = g.result || null;
    g.teacherColor = g.teacherColor || 0;
    g.student = typeof g.student === 'string' ? g.student : '';
    g.rule = g.rule === 'territory' ? 'territory' : 'area';
    g.lecture = !!g.lecture;
    if (g.lecture) g.status = 'demo';
    if (g.status === 'demo') {
      var d = g.demo || {};
      var stone = function (m) { return m.s ? { c: m.c, p: m.p, s: 1 } : { c: m.c, p: m.p }; };
      g.demo = {
        from: g.lecture ? 'lecture' : d.from === 'finished' ? 'finished' : 'playing',
        base: typeof d.base === 'number' ? Math.max(0, Math.min(r.moves.length, d.base)) : r.moves.length,
        moves: toArray(d.moves).map(stone),
        undone: toArray(d.undone).map(stone),
        marks: toArray(d.marks).map(function (m) { return { p: m.p, t: m.t }; }),
        draw: toArray(d.draw).map(function (s) {
          var st = { t: s.t === 'arrow' ? 'arrow' : 'pen', pts: toArray(s.pts) };
          if (s.c) st.c = s.c;
          return st;
        }),
        who: DEMO_WHO[d.who] ? d.who : 'teacher',
        stage: typeof d.stage === 'string' ? d.stage : ''
      };
      if (g.demo.who === 'stage' && !g.demo.stage) g.demo.who = 'teacher';
      if (d.trial && typeof d.trial.at === 'number') {
        g.demo.trial = {
          at: Math.max(0, Math.min(g.demo.moves.length, d.trial.at)),
          base: typeof d.trial.base === 'number' ? Math.max(0, Math.min(r.moves.length, d.trial.base)) : g.demo.base
        };
      }
      var q = g.quiz;
      g.quiz = q && (q.state === 'open' || q.state === 'shown') ? {
        n: q.n || 1,
        state: q.state,
        size: q.size || r.size,
        c: q.c === WHITE ? WHITE : BLACK,
        answers: toArray(q.answers).filter(function (x) { return x && x.a; }).map(function (x) { return { a: x.a, p: x.p }; })
      } : null;
    } else {
      g.demo = null;
      g.quiz = null;
    }
    return g;
  }

  Go.Match = {
    create: create,
    normalize: normalize,
    forceUndo: forceUndo,
    agree: agree,
    cancelRequest: cancelRequest,
    timeView: timeView,
    checkTimeout: checkTimeout,
    play: play,
    newMoves: newMoves,
    canUndo: canUndo,
    undo: undo,
    resign: resign,
    enterScoring: enterScoring,
    resumePlay: resumePlay,
    toggleDead: toggleDead,
    score: score,
    finishByScore: finishByScore,
    request: request,
    respond: respond,
    startDemo: startDemo,
    createLecture: createLecture,
    lectureLoad: lectureLoad,
    demoDraw: demoDraw,
    demoTrial: demoTrial,
    demoUnmark: demoUnmark,
    demoUndraw: demoUndraw,
    demoView: demoView,
    demoNextColor: demoNextColor,
    demoPlay: demoPlay,
    demoBack: demoBack,
    demoForward: demoForward,
    demoStep: demoStep,
    demoToStart: demoToStart,
    demoFloor: demoFloor,
    demoSetWho: demoSetWho,
    quizOpen: quizOpen,
    quizAnswer: quizAnswer,
    quizShow: quizShow,
    quizClose: quizClose,
    quizGroups: quizGroups,
    demoMark: demoMark,
    demoClear: demoClear,
    endDemo: endDemo
  };
})(window);
