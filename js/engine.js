/* 圍棋規則引擎：落子、提子、打劫、禁著點。純函式，不碰畫面。 */
(function (global) {
  'use strict';
  var Go = global.Go = global.Go || {};

  var EMPTY = 0, BLACK = 1, WHITE = 2;
  var LETTERS = 'ABCDEFGHJKLMNOPQRST'; // 圍棋座標慣例：跳過 I

  function other(color) { return color === BLACK ? WHITE : BLACK; }

  function neighbors(size, idx) {
    var x = idx % size, y = (idx - x) / size, out = [];
    if (x > 0) out.push(idx - 1);
    if (x < size - 1) out.push(idx + 1);
    if (y > 0) out.push(idx - size);
    if (y < size - 1) out.push(idx + size);
    return out;
  }

  /* 找出 start 所在的整塊棋與它的氣數 */
  function group(board, size, start) {
    var color = board[start];
    var stones = [start];
    var seen = new Uint8Array(size * size);
    var libs = 0;
    seen[start] = 1;
    for (var i = 0; i < stones.length; i++) {
      var nb = neighbors(size, stones[i]);
      for (var j = 0; j < nb.length; j++) {
        var n = nb[j];
        if (seen[n]) continue;
        seen[n] = 1;
        if (board[n] === EMPTY) libs++;
        else if (board[n] === color) stones.push(n);
      }
    }
    return { stones: stones, libs: libs };
  }

  function createPosition(size) {
    return {
      size: size,
      board: new Uint8Array(size * size),
      ko: -1,            // 目前因打劫而不能下的點，沒有則為 -1
      caps: [0, 0, 0]    // caps[BLACK] = 黑方提掉的白子數，caps[WHITE] 反之
    };
  }

  function clonePosition(pos) {
    return { size: pos.size, board: new Uint8Array(pos.board), ko: pos.ko, caps: pos.caps.slice() };
  }

  /*
   * 在 pos 上落子（會直接修改 pos）。
   * strict = true ：對弈用，違規著手會被拒絕且 pos 不變。
   * strict = false：重播棋譜用，盡量照棋譜擺出來（棋譜裡偶爾有不合規的著手）。
   * 回傳 { ok, reason, captured }，captured 是被移除的所有棋子位置。
   */
  function place(pos, color, idx, strict) {
    var size = pos.size, board = pos.board;
    if (idx < 0 || idx >= size * size) return { ok: false, reason: 'offboard', captured: [] };
    if (strict) {
      if (board[idx] !== EMPTY) return { ok: false, reason: 'occupied', captured: [] };
      if (idx === pos.ko) return { ok: false, reason: 'ko', captured: [] };
    }
    var opp = other(color);
    board[idx] = color;

    var captured = [];
    var nb = neighbors(size, idx);
    for (var i = 0; i < nb.length; i++) {
      var n = nb[i];
      if (board[n] !== opp) continue;
      var g = group(board, size, n);
      if (g.libs === 0) {
        for (var k = 0; k < g.stones.length; k++) {
          board[g.stones[k]] = EMPTY;
          captured.push(g.stones[k]);
        }
      }
    }

    var removed = captured.slice();
    if (captured.length === 0) {
      var own = group(board, size, idx);
      if (own.libs === 0) {
        if (strict) {
          board[idx] = EMPTY;
          return { ok: false, reason: 'suicide', captured: [] };
        }
        for (var s = 0; s < own.stones.length; s++) {
          board[own.stones[s]] = EMPTY;
          removed.push(own.stones[s]);
        }
        pos.caps[opp] += own.stones.length;
      }
    }
    pos.caps[color] += captured.length;

    // 打劫：只提一子，且落下的這顆是單獨一子、只剩一口氣
    pos.ko = -1;
    if (captured.length === 1 && board[idx] === color) {
      var me = group(board, size, idx);
      if (me.stones.length === 1 && me.libs === 1) pos.ko = captured[0];
    }
    return { ok: true, reason: '', captured: removed };
  }

  /* 不改動 pos，只檢查能不能下。回傳 '' 表示合法，否則回傳原因。 */
  function check(pos, color, idx) {
    var r = place(clonePosition(pos), color, idx, true);
    return r.ok ? '' : r.reason;
  }

  function pass(pos) { pos.ko = -1; }

  function label(size, idx) {
    var x = idx % size, y = (idx - x) / size;
    return LETTERS.charAt(x) + (size - y);
  }

  Go.EMPTY = EMPTY;
  Go.BLACK = BLACK;
  Go.WHITE = WHITE;
  Go.Engine = {
    LETTERS: LETTERS,
    other: other,
    neighbors: neighbors,
    group: group,
    createPosition: createPosition,
    clonePosition: clonePosition,
    place: place,
    check: check,
    pass: pass,
    label: label
  };
})(window);
