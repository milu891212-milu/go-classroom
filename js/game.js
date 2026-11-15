/*
 * 對局紀錄（record）與局面重播。
 * record 是純資料（可直接存成 JSON，之後連線同步也是同步這個物件）：
 *   { size, komi, handicap, info, setup:{b:[],w:[]}, first, moves:[{c,p} | {edit,ab,aw,ae}] }
 *   p = -1 代表停一手。
 */
(function (global) {
  'use strict';
  var Go = global.Go = global.Go || {};
  var E = Go.Engine, EMPTY = Go.EMPTY, BLACK = Go.BLACK, WHITE = Go.WHITE;

  function starCoords(size) {
    if (size < 7) return [];
    var edge = size >= 13 ? 3 : 2;
    var c = [edge, size - 1 - edge];
    if (size % 2 === 1 && size >= 9) c.splice(1, 0, (size - 1) / 2);
    return c;
  }

  /* 棋盤上要畫的星位 */
  function starPoints(size) {
    var c = starCoords(size), out = [];
    if (c.length < 2) return out;
    var lo = c[0], hi = c[c.length - 1], mid = c.length === 3 ? c[1] : -1;
    out.push(lo * size + lo, lo * size + hi, hi * size + lo, hi * size + hi);
    if (mid >= 0) {
      out.push(mid * size + mid);
      if (size >= 15) out.push(lo * size + mid, hi * size + mid, mid * size + lo, mid * size + hi);
    }
    return out;
  }

  /* 讓子棋的黑子位置（2～9 子） */
  function handicapPoints(size, count) {
    var c = starCoords(size);
    if (count < 2 || c.length < 3) return [];
    var lo = c[0], mid = c[1], hi = c[2];
    function at(x, y) { return y * size + x; }
    var pts = [at(hi, lo), at(lo, hi), at(hi, hi), at(lo, lo)]; // 右上、左下、右下、左上
    var n = Math.min(count, 9);
    var out = pts.slice(0, Math.min(n, 4));
    if (n >= 6) out.push(at(lo, mid), at(hi, mid));
    if (n >= 8) out.push(at(mid, lo), at(mid, hi));
    if (n === 5 || n === 7 || n === 9) out.push(at(mid, mid));
    return out;
  }

  function newRecord(opts) {
    var size = opts.size || 19;
    var handicap = opts.handicap || 0;
    var pts = handicapPoints(size, handicap);
    if (!pts.length) handicap = 0;
    return {
      size: size,
      komi: typeof opts.komi === 'number' ? opts.komi : (handicap ? 0.5 : 7.5),
      handicap: handicap,
      info: { pb: '', pw: '', br: '', wr: '', re: '', dt: '', ev: '' },
      setup: { b: pts, w: [] },
      first: handicap ? WHITE : BLACK,
      moves: []
    };
  }

  function cloneRecord(r) { return JSON.parse(JSON.stringify(r)); }

  /* 重播前 n 步，回傳當下的局面 */
  function replay(record, n) {
    var size = record.size;
    var pos = E.createPosition(size);
    var numbers = new Uint16Array(size * size);
    var i, k;
    for (i = 0; i < record.setup.b.length; i++) pos.board[record.setup.b[i]] = BLACK;
    for (i = 0; i < record.setup.w.length; i++) pos.board[record.setup.w[i]] = WHITE;

    if (n === undefined || n > record.moves.length) n = record.moves.length;
    if (n < 0) n = 0;

    var moveNo = 0, last = -1, lastColor = 0, lastWasPass = false, passes = 0;
    for (i = 0; i < n; i++) {
      var m = record.moves[i];
      if (m.edit) {
        for (k = 0; k < m.ae.length; k++) { pos.board[m.ae[k]] = EMPTY; numbers[m.ae[k]] = 0; }
        for (k = 0; k < m.ab.length; k++) { pos.board[m.ab[k]] = BLACK; numbers[m.ab[k]] = 0; }
        for (k = 0; k < m.aw.length; k++) { pos.board[m.aw[k]] = WHITE; numbers[m.aw[k]] = 0; }
        pos.ko = -1;
        continue;
      }
      moveNo++;
      lastColor = m.c;
      if (m.p < 0) {
        E.pass(pos);
        passes++;
        last = -1;
        lastWasPass = true;
        continue;
      }
      passes = 0;
      lastWasPass = false;
      var r = E.place(pos, m.c, m.p, false);
      for (k = 0; k < r.captured.length; k++) numbers[r.captured[k]] = 0;
      if (pos.board[m.p] !== EMPTY) numbers[m.p] = moveNo;
      last = m.p;
    }

    return {
      size: size,
      board: pos.board,
      ko: pos.ko,
      caps: pos.caps,
      numbers: numbers,        // 每個點上的棋子是第幾手下的（0 = 佈局子）
      moveNo: moveNo,          // 到目前為止下了幾手
      last: last,              // 最後一手的位置（停一手則為 -1）
      lastColor: lastColor,
      lastWasPass: lastWasPass,
      passes: passes           // 結尾連續停一手的次數
    };
  }

  function countMoves(record, n) {
    if (n === undefined || n > record.moves.length) n = record.moves.length;
    var c = 0;
    for (var i = 0; i < n; i++) if (!record.moves[i].edit) c++;
    return c;
  }

  /* 第 n 步之後照理輪到誰 */
  function naturalTurn(record, n) {
    var i;
    for (i = n; i < record.moves.length; i++) {
      if (!record.moves[i].edit) return record.moves[i].c;
    }
    for (i = Math.min(n, record.moves.length) - 1; i >= 0; i--) {
      if (!record.moves[i].edit) return E.other(record.moves[i].c);
    }
    if (record.first) return record.first;
    return (record.setup.b.length && !record.setup.w.length) ? WHITE : BLACK;
  }

  function colorName(c) { return c === BLACK ? '黑' : '白'; }

  function describeMove(record, m) {
    if (!m || m.edit) return '';
    return colorName(m.c) + ' ' + (m.p < 0 ? '停一手' : E.label(record.size, m.p));
  }

  Go.Game = {
    starPoints: starPoints,
    handicapPoints: handicapPoints,
    newRecord: newRecord,
    cloneRecord: cloneRecord,
    replay: replay,
    countMoves: countMoves,
    naturalTurn: naturalTurn,
    colorName: colorName,
    describeMove: describeMove
  };
})(window);
