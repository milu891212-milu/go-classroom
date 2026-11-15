/* SGF 棋譜：解碼、解析（取主線）、輸出。 */
(function (global) {
  'use strict';
  var Go = global.Go = global.Go || {};
  var BLACK = Go.BLACK, WHITE = Go.WHITE;

  function isSpace(ch) { return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t'; }

  /* 把檔案位元組轉成文字。優先 UTF-8，其次依棋譜內的 CA 標記，再試 Big5、GB18030。 */
  function decode(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) { /* 不是 UTF-8，往下試 */ }

    var ascii = '';
    var head = Math.min(bytes.length, 4000);
    for (var i = 0; i < head; i++) ascii += String.fromCharCode(bytes[i] < 128 ? bytes[i] : 63);
    var m = /CA\[([^\]]+)\]/i.exec(ascii);
    var tries = [];
    if (m) tries.push(m[1].trim().toLowerCase());
    tries.push('big5', 'gb18030');
    for (var t = 0; t < tries.length; t++) {
      try {
        return new TextDecoder(tries[t], { fatal: true }).decode(bytes);
      } catch (e2) { /* 換下一種編碼 */ }
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  /* 解析成樹狀結構：{ nodes: [ {屬性: [值...]} ], children: [樹...] } */
  function parse(text) {
    var n = text.length, i = 0;

    var start = text.indexOf('(');
    while (start >= 0) {
      var j = start + 1;
      while (j < n && isSpace(text.charAt(j))) j++;
      if (text.charAt(j) === ';') break;
      start = text.indexOf('(', start + 1);
    }
    if (start < 0) throw new Error('找不到棋譜內容');
    i = start;

    function readNode() {
      var props = {};
      for (;;) {
        while (i < n && isSpace(text.charAt(i))) i++;
        if (i >= n) return props;
        var ch = text.charAt(i);
        if (ch === ';' || ch === '(' || ch === ')') return props;

        var id = '';
        while (i < n) {
          ch = text.charAt(i);
          if (ch === '[' || ch === ';' || ch === '(' || ch === ')') break;
          if (ch >= 'A' && ch <= 'Z') id += ch;
          i++;
        }
        if (text.charAt(i) !== '[') continue;

        var vals = [];
        while (i < n && text.charAt(i) === '[') {
          i++;
          var v = '';
          while (i < n && text.charAt(i) !== ']') {
            ch = text.charAt(i);
            if (ch === '\\') {
              i++;
              if (i >= n) break;
              ch = text.charAt(i);
              if (ch === '\r') { if (text.charAt(i + 1) === '\n') i++; }
              else if (ch !== '\n') v += ch;
              i++;
            } else {
              v += ch;
              i++;
            }
          }
          i++; // 跳過 ]
          vals.push(v);
          while (i < n && isSpace(text.charAt(i))) i++;
        }
        if (id) props[id] = (props[id] || []).concat(vals);
      }
    }

    function readTree() {
      i++; // 跳過 (
      var tree = { nodes: [], children: [] };
      for (;;) {
        while (i < n && isSpace(text.charAt(i))) i++;
        if (i >= n) return tree; // 檔案被截斷也盡量讀
        var ch = text.charAt(i);
        if (ch === ';') { i++; tree.nodes.push(readNode()); }
        else if (ch === '(') { tree.children.push(readTree()); }
        else if (ch === ')') { i++; return tree; }
        else i++;
      }
    }

    return readTree();
  }

  function mainLine(tree) {
    var nodes = [];
    for (var t = tree; t; t = t.children[0]) {
      for (var k = 0; k < t.nodes.length; k++) nodes.push(t.nodes[k]);
    }
    return nodes;
  }

  function first(vals) { return vals && vals.length ? String(vals[0]).trim() : ''; }

  function pointOf(v, size) {
    if (!v || v.length < 2) return -1;
    var x = v.charCodeAt(0) - 97, y = v.charCodeAt(1) - 97;
    if (x < 0 || y < 0 || x >= size || y >= size) return -1;
    return y * size + x;
  }

  /* AB/AW/AE 的點列表，支援 "aa:cc" 這種矩形寫法 */
  function pointList(vals, size) {
    var out = [];
    if (!vals) return out;
    for (var k = 0; k < vals.length; k++) {
      var v = String(vals[k]).trim().toLowerCase();
      if (v.length === 5 && v.charAt(2) === ':') {
        var x1 = v.charCodeAt(0) - 97, y1 = v.charCodeAt(1) - 97;
        var x2 = v.charCodeAt(3) - 97, y2 = v.charCodeAt(4) - 97;
        for (var y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
          for (var x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
            if (x >= 0 && y >= 0 && x < size && y < size) out.push(y * size + x);
          }
        }
      } else {
        var p = pointOf(v, size);
        if (p >= 0) out.push(p);
      }
    }
    return out;
  }

  function normalizeKomi(raw, handicap) {
    var k = parseFloat(raw);
    if (isNaN(k)) return handicap > 0 ? 0.5 : 7.5;
    if (Math.abs(k) >= 100) k = k / 100;          // 野狐寫法：375、650
    if (Math.abs(k - 3.75) < 0.001) return 7.5;   // 中國規則 3¾ 子 = 7.5 目
    if (Math.abs(k - 2.75) < 0.001) return 5.5;
    return k;
  }

  /* 把主線轉成對局紀錄（record） */
  function toRecord(tree) {
    var nodes = mainLine(tree);
    if (!nodes.length) throw new Error('棋譜是空的');
    var root = nodes[0];

    var size = parseInt(first(root.SZ), 10);
    if (isNaN(size)) size = 19;
    if (size < 2 || size > 19) throw new Error('不支援 ' + size + ' 路棋盤');

    var handicap = parseInt(first(root.HA), 10) || 0;
    var record = {
      size: size,
      komi: normalizeKomi(first(root.KM), handicap),
      handicap: handicap,
      info: {
        pb: first(root.PB), pw: first(root.PW),
        br: first(root.BR), wr: first(root.WR),
        re: first(root.RE), dt: first(root.DT),
        ev: first(root.EV) || first(root.GN)
      },
      setup: { b: [], w: [] },
      first: 0,
      moves: []
    };

    var setup = new Uint8Array(size * size);
    var seenMove = false;

    for (var k = 0; k < nodes.length; k++) {
      var nd = nodes[k];
      var ab = pointList(nd.AB, size), aw = pointList(nd.AW, size), ae = pointList(nd.AE, size);
      if (ab.length || aw.length || ae.length) {
        if (!seenMove) {
          var q;
          for (q = 0; q < ae.length; q++) setup[ae[q]] = 0;
          for (q = 0; q < ab.length; q++) setup[ab[q]] = BLACK;
          for (q = 0; q < aw.length; q++) setup[aw[q]] = WHITE;
        } else {
          record.moves.push({ edit: true, ab: ab, aw: aw, ae: ae });
        }
      }
      if (nd.PL && !seenMove) {
        var pl = first(nd.PL).toUpperCase();
        if (pl === 'B' || pl === '1') record.first = BLACK;
        else if (pl === 'W' || pl === '2') record.first = WHITE;
      }
      var keys = ['B', 'W'];
      for (var c = 0; c < 2; c++) {
        var vals = nd[keys[c]];
        if (!vals) continue;
        for (var m = 0; m < vals.length; m++) {
          record.moves.push({
            c: c === 0 ? BLACK : WHITE,
            p: pointOf(String(vals[m]).trim().toLowerCase(), size)
          });
          seenMove = true;
        }
      }
    }

    for (var s = 0; s < setup.length; s++) {
      if (setup[s] === BLACK) record.setup.b.push(s);
      else if (setup[s] === WHITE) record.setup.w.push(s);
    }
    return record;
  }

  function load(text) { return toRecord(parse(text)); }

  function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/\]/g, '\\]'); }

  function coord(size, idx) {
    var x = idx % size, y = (idx - x) / size;
    return String.fromCharCode(97 + x) + String.fromCharCode(97 + y);
  }

  function listProp(name, pts, size) {
    if (!pts || !pts.length) return '';
    var s = name;
    for (var k = 0; k < pts.length; k++) s += '[' + coord(size, pts[k]) + ']';
    return s;
  }

  function toSGF(record) {
    var size = record.size, info = record.info || {};
    var s = '(;GM[1]FF[4]CA[UTF-8]AP[GoClassroom]SZ[' + size + ']KM[' + record.komi + ']';
    if (record.handicap > 0) s += 'HA[' + record.handicap + ']';
    var map = [['PB', info.pb], ['BR', info.br], ['PW', info.pw], ['WR', info.wr],
               ['EV', info.ev], ['DT', info.dt], ['RE', info.re]];
    for (var k = 0; k < map.length; k++) {
      if (map[k][1]) s += map[k][0] + '[' + esc(map[k][1]) + ']';
    }
    s += listProp('AB', record.setup.b, size) + listProp('AW', record.setup.w, size);
    if (record.first) s += 'PL[' + (record.first === BLACK ? 'B' : 'W') + ']';
    for (var i = 0; i < record.moves.length; i++) {
      var m = record.moves[i];
      if (m.edit) {
        s += '\n;' + listProp('AE', m.ae, size) + listProp('AB', m.ab, size) + listProp('AW', m.aw, size);
      } else {
        if (i % 10 === 0) s += '\n';
        s += ';' + (m.c === BLACK ? 'B' : 'W') + '[' + (m.p < 0 ? '' : coord(size, m.p)) + ']';
      }
    }
    return s + ')\n';
  }

  Go.SGF = {
    decode: decode,
    parse: parse,
    mainLine: mainLine,
    toRecord: toRecord,
    load: load,
    toSGF: toSGF
  };
})(window);
