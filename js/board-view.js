/* 棋盤畫面（SVG）。只負責畫與回報滑鼠／觸控位置，不含規則。 */
(function (global) {
  'use strict';
  var Go = global.Go = global.Go || {};
  var E = Go.Engine, G = Go.Game, BLACK = Go.BLACK;

  var CELL = 100, MARGIN = 105, R = 47;

  function BoardView(svg) {
    this.svg = svg;
    this.size = 0;
    this.onPoint = null;   // function (idx) 點了某個交叉點
    this.onHover = null;   // function (idx) 滑鼠移到某個交叉點（離開為 -1）
    this.onStroke = null;  // function ({ t, pts }) 畫完一筆（畫筆模式）
    this.drawMode = '';    // '' 一般點棋盤；'pen' 畫筆；'arrow' 箭頭
    this._hover = -1;
    this._stroke = null;   // 正在畫的這一筆

    var self = this;
    svg.addEventListener('click', function (ev) {
      if (self.drawMode) return;   // 畫筆模式不落子
      var idx = self.pointAt(ev);
      if (idx >= 0 && self.onPoint) self.onPoint(idx);
    });
    svg.addEventListener('pointerdown', function (ev) {
      if (!self.drawMode || !self.size || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
      ev.preventDefault();
      var p = self.svgPoint(ev);
      self._stroke = { t: self.drawMode, pts: [p.x, p.y], id: ev.pointerId };
      try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
      self._drawLive();
    });
    svg.addEventListener('pointermove', function (ev) {
      var st = self._stroke;
      if (st && ev.pointerId === st.id) {
        var p = self.svgPoint(ev), n = st.pts.length;
        if (st.t === 'arrow') {
          st.pts = [st.pts[0], st.pts[1], p.x, p.y];
        } else if (Math.abs(p.x - st.pts[n - 2]) + Math.abs(p.y - st.pts[n - 1]) >= 8) {
          st.pts.push(p.x, p.y);   // 太近的點略過，線條一樣順，資料小很多
        }
        self._drawLive();
        return;
      }
      if (ev.pointerType !== 'mouse') return;
      self._setHover(self.drawMode ? -1 : self.pointAt(ev));
    });
    function finish(ev) {
      var st = self._stroke;
      if (!st || ev.pointerId !== st.id) return;
      self._stroke = null;
      self.liveLayer.innerHTML = '';
      var pts = st.pts;
      if (pts.length === 2) pts = pts.concat([pts[0] + 1, pts[1]]);   // 只點一下：畫一個點
      var len = Math.abs(pts[pts.length - 2] - pts[0]) + Math.abs(pts[pts.length - 1] - pts[1]);
      if (st.t === 'arrow' && len < 40) return;   // 箭頭太短當成誤觸
      if (self.onStroke) self.onStroke({ t: st.t, pts: pts });
    }
    svg.addEventListener('pointerup', finish);
    svg.addEventListener('pointercancel', function (ev) {
      if (self._stroke && ev.pointerId === self._stroke.id) { self._stroke = null; self.liveLayer.innerHTML = ''; }
    });
    svg.addEventListener('pointerleave', function () { self._setHover(-1); });
  }

  /* 滑鼠／手指位置換成棋盤的 SVG 座標（取整數） */
  BoardView.prototype.svgPoint = function (ev) {
    var ctm = this.svg.getScreenCTM(), pt = this.svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    var p = ctm ? pt.matrixTransform(ctm.inverse()) : pt;
    var max = (this.size - 1) * CELL + MARGIN * 2;
    return { x: Math.round(Math.max(0, Math.min(max, p.x))), y: Math.round(Math.max(0, Math.min(max, p.y))) };
  };

  BoardView.prototype.setDrawMode = function (mode) {
    this.drawMode = mode === 'pen' || mode === 'arrow' ? mode : '';
    this.svg.classList.toggle('drawing', !!this.drawMode);
    if (!this.drawMode && this._stroke) { this._stroke = null; this.liveLayer.innerHTML = ''; }
  };

  /* 一筆畫線的 SVG */
  function strokeSvg(st) {
    var pts = st.pts, i, h = '';
    var attr = ' fill="none" stroke="#e5322d" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"';
    if (!pts || pts.length < 4) return '';
    if (st.t === 'arrow') {
      var x1 = pts[0], y1 = pts[1], x2 = pts[pts.length - 2], y2 = pts[pts.length - 1];
      var a = Math.atan2(y2 - y1, x2 - x1), L = 46, W = 0.45;
      var hx = x2 - Math.cos(a) * L * 0.6, hy = y2 - Math.sin(a) * L * 0.6;
      h += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + hx + '" y2="' + hy + '"' + attr + '/>';
      h += '<polygon points="' + x2 + ',' + y2 + ' ' +
        (x2 - Math.cos(a - W) * L) + ',' + (y2 - Math.sin(a - W) * L) + ' ' +
        (x2 - Math.cos(a + W) * L) + ',' + (y2 - Math.sin(a + W) * L) +
        '" fill="#e5322d" opacity="0.85"/>';
      return h;
    }
    var d = 'M' + pts[0] + ' ' + pts[1];
    for (i = 2; i < pts.length; i += 2) d += 'L' + pts[i] + ' ' + pts[i + 1];
    return '<path d="' + d + '"' + attr + '/>';
  }

  BoardView.prototype._drawLive = function () {
    this.liveLayer.innerHTML = this._stroke ? strokeSvg(this._stroke) : '';
  };

  BoardView.prototype._setHover = function (idx) {
    if (idx === this._hover) return;
    this._hover = idx;
    if (this.onHover) this.onHover(idx);
  };

  BoardView.prototype.xy = function (idx) {
    var col = idx % this.size, row = (idx - col) / this.size;
    return { x: MARGIN + col * CELL, y: MARGIN + row * CELL };
  };

  BoardView.prototype.pointAt = function (ev) {
    var ctm = this.svg.getScreenCTM();
    if (!ctm || !this.size) return -1;
    var pt = this.svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    var p = pt.matrixTransform(ctm.inverse());
    var col = Math.round((p.x - MARGIN) / CELL), row = Math.round((p.y - MARGIN) / CELL);
    if (col < 0 || row < 0 || col >= this.size || row >= this.size) return -1;
    return row * this.size + col;
  };

  /* 建立棋盤底圖（格線、星位、座標）。同樣大小不會重畫。 */
  BoardView.prototype.setSize = function (size) {
    if (size === this.size) return;
    this.size = size;
    var span = (size - 1) * CELL, total = span + MARGIN * 2;
    var h = '';
    h += '<defs>' +
      '<radialGradient id="stoneB" cx="35%" cy="30%" r="70%">' +
      '<stop offset="0" stop-color="#6a6a6a"/><stop offset="0.55" stop-color="#1c1c1c"/><stop offset="1" stop-color="#050505"/>' +
      '</radialGradient>' +
      '<radialGradient id="stoneW" cx="35%" cy="30%" r="75%">' +
      '<stop offset="0" stop-color="#ffffff"/><stop offset="0.7" stop-color="#ece9e2"/><stop offset="1" stop-color="#c9c4b8"/>' +
      '</radialGradient>' +
      '</defs>';
    h += '<rect x="0" y="0" width="' + total + '" height="' + total + '" rx="22" fill="#e6b96a"/>';

    var i, a;
    for (i = 0; i < size; i++) {
      a = MARGIN + i * CELL;
      var w = (i === 0 || i === size - 1) ? 5 : 2.6;
      h += '<line x1="' + MARGIN + '" y1="' + a + '" x2="' + (MARGIN + span) + '" y2="' + a +
        '" stroke="#4a3414" stroke-width="' + w + '" stroke-linecap="square"/>';
      h += '<line x1="' + a + '" y1="' + MARGIN + '" x2="' + a + '" y2="' + (MARGIN + span) +
        '" stroke="#4a3414" stroke-width="' + w + '" stroke-linecap="square"/>';
    }

    var stars = G.starPoints(size);
    for (i = 0; i < stars.length; i++) {
      var s = this.xy(stars[i]);
      h += '<circle cx="' + s.x + '" cy="' + s.y + '" r="11" fill="#4a3414"/>';
    }

    var near = MARGIN - 70, far = MARGIN + span + 70;
    for (i = 0; i < size; i++) {
      a = MARGIN + i * CELL;
      var letter = E.LETTERS.charAt(i), num = size - i;
      h += '<text class="coord" x="' + a + '" y="' + near + '">' + letter + '</text>';
      h += '<text class="coord" x="' + a + '" y="' + far + '">' + letter + '</text>';
      h += '<text class="coord" x="' + near + '" y="' + a + '">' + num + '</text>';
      h += '<text class="coord" x="' + far + '" y="' + a + '">' + num + '</text>';
    }

    h += '<g data-layer="stones"></g><g data-layer="draw" pointer-events="none"></g>' +
      '<g data-layer="live" pointer-events="none"></g><g data-layer="ghost"></g>';
    this.svg.setAttribute('viewBox', '0 0 ' + total + ' ' + total);
    this.svg.innerHTML = h;
    this.stonesLayer = this.svg.querySelector('[data-layer="stones"]');
    this.ghostLayer = this.svg.querySelector('[data-layer="ghost"]');
    this.drawLayer = this.svg.querySelector('[data-layer="draw"]');
    this.liveLayer = this.svg.querySelector('[data-layer="live"]');
  };

  /*
   * 畫棋子。opts: { board, last, numbers, ko, dead, owner, marks }
   *   numbers 有給就顯示手數；ko >= 0 會在劫點畫方框。
   *   marks 是老師擺棋時的標記 [{ p, t }]；draw 是畫筆與箭頭 [{ t, pts }]。
   *   dead / owner 是數目用：死子畫成半透明，空點與死子上用小方塊標出是誰的地。
   */
  BoardView.prototype.render = function (opts) {
    var size = this.size, board = opts.board, dead = opts.dead, owner = opts.owner, h = '';
    var idx, p, black;
    var marked = {};   // 有標記的點：棋子上的手數與「最後一手」記號讓給標記
    if (opts.marks) for (idx = 0; idx < opts.marks.length; idx++) marked[opts.marks[idx].p] = true;
    for (idx = 0; idx < size * size; idx++) {
      var c = board[idx];
      if (!c) continue;
      p = this.xy(idx);
      black = c === BLACK;
      if (dead && dead[idx]) {
        h += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + R + '" fill="url(#' + (black ? 'stoneB' : 'stoneW') +
          ')" opacity="0.38"/>';
        continue;
      }
      h += '<circle cx="' + (p.x + 3) + '" cy="' + (p.y + 5) + '" r="' + R + '" fill="rgba(40,24,0,0.3)"/>';
      h += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + R + '" fill="url(#' + (black ? 'stoneB' : 'stoneW') + ')"' +
        (black ? '' : ' stroke="#9a948a" stroke-width="1.5"') + '/>';

      if (marked[idx]) continue;
      var isLast = idx === opts.last;
      var n = opts.numbers ? opts.numbers[idx] : 0;
      if (n > 0) {
        var fs = n < 10 ? 54 : n < 100 ? 46 : 36;
        var fill = isLast ? (black ? '#ff8a80' : '#d32f2f') : (black ? '#ffffff' : '#111111');
        h += '<text class="num" x="' + p.x + '" y="' + p.y + '" font-size="' + fs + '" fill="' + fill + '">' + n + '</text>';
      } else if (isLast) {
        h += '<circle cx="' + p.x + '" cy="' + p.y + '" r="15" fill="' + (black ? '#ff8a80' : '#d32f2f') + '"/>';
      }
    }
    if (owner) {
      for (idx = 0; idx < size * size; idx++) {
        var o = owner[idx];
        if ((o !== 1 && o !== 2) || (board[idx] && !(dead && dead[idx]))) continue;
        p = this.xy(idx);
        h += '<rect x="' + (p.x - 16) + '" y="' + (p.y - 16) + '" width="32" height="32" rx="4" ' +
          (o === BLACK ? 'fill="#161616"' : 'fill="#ffffff" stroke="#6d675c" stroke-width="2.5"') + '/>';
      }
    }
    if (opts.ko >= 0) {
      var k = this.xy(opts.ko);
      h += '<rect x="' + (k.x - 20) + '" y="' + (k.y - 20) + '" width="40" height="40" fill="none" stroke="#4a3414" stroke-width="6"/>';
    }
    if (opts.marks) {
      for (idx = 0; idx < opts.marks.length; idx++) h += this._mark(opts.marks[idx], board[opts.marks[idx].p]);
    }
    this.stonesLayer.innerHTML = h;
    var d = '';
    if (opts.draw) for (idx = 0; idx < opts.draw.length; idx++) d += strokeSvg(opts.draw[idx]);
    this.drawLayer.innerHTML = d;
  };

  /* 一個標記。t：'tri' 三角形、'sq' 方塊、'cir' 圓圈、'x' 叉，其餘當成文字（A、B、C…） */
  BoardView.prototype._mark = function (mark, stone) {
    var p = this.xy(mark.p), x = p.x, y = p.y, t = mark.t, h = '';
    var color = stone === BLACK ? '#ffffff' : (stone ? '#111111' : '#a01818');
    var line = ' fill="none" stroke="' + color + '" stroke-width="8" stroke-linejoin="round" stroke-linecap="round"';
    if (!stone) {
      // 空點上先蓋一小塊棋盤色，免得標記和格線疊在一起看不清楚
      h += '<circle cx="' + x + '" cy="' + y + '" r="34" fill="#e6b96a"/>';
    }
    if (t === 'tri') {
      h += '<polygon points="' + x + ',' + (y - 29) + ' ' + (x - 27) + ',' + (y + 18) + ' ' + (x + 27) + ',' + (y + 18) + '"' + line + '/>';
    } else if (t === 'sq') {
      h += '<rect x="' + (x - 21) + '" y="' + (y - 21) + '" width="42" height="42"' + line + '/>';
    } else if (t === 'cir') {
      h += '<circle cx="' + x + '" cy="' + y + '" r="23"' + line + '/>';
    } else if (t === 'x') {
      h += '<path d="M' + (x - 20) + ' ' + (y - 20) + 'L' + (x + 20) + ' ' + (y + 20) +
        'M' + (x + 20) + ' ' + (y - 20) + 'L' + (x - 20) + ' ' + (y + 20) + '"' + line + '/>';
    } else {
      var ch = String(t).replace(/[^A-Za-z0-9]/g, '').slice(0, 2);
      h += '<text class="num" x="' + x + '" y="' + y + '" font-size="58" fill="' + color + '">' + ch + '</text>';
    }
    return h;
  };

  /* 預覽棋子。firm = true 代表「等待確認」的落點，畫得比較明顯。idx < 0 則清除。 */
  BoardView.prototype.setGhost = function (idx, color, firm) {
    if (!this.ghostLayer) return;
    if (idx < 0) { this.ghostLayer.innerHTML = ''; return; }
    var p = this.xy(idx), black = color === BLACK;
    var h = '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + R + '" fill="url(#' + (black ? 'stoneB' : 'stoneW') +
      ')" opacity="' + (firm ? 0.8 : 0.5) + '" pointer-events="none"/>';
    if (firm) {
      h += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + (R + 7) + '" fill="none" stroke="#1f6f54" stroke-width="7" pointer-events="none"/>';
    }
    this.ghostLayer.innerHTML = h;
  };

  Go.BoardView = BoardView;
})(window);
