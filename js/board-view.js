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
    this._hover = -1;

    var self = this;
    svg.addEventListener('click', function (ev) {
      var idx = self.pointAt(ev);
      if (idx >= 0 && self.onPoint) self.onPoint(idx);
    });
    svg.addEventListener('pointermove', function (ev) {
      if (ev.pointerType !== 'mouse') return;
      self._setHover(self.pointAt(ev));
    });
    svg.addEventListener('pointerleave', function () { self._setHover(-1); });
  }

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

    h += '<g data-layer="stones"></g><g data-layer="ghost"></g>';
    this.svg.setAttribute('viewBox', '0 0 ' + total + ' ' + total);
    this.svg.innerHTML = h;
    this.stonesLayer = this.svg.querySelector('[data-layer="stones"]');
    this.ghostLayer = this.svg.querySelector('[data-layer="ghost"]');
  };

  /*
   * 畫棋子。opts: { board, last, numbers, ko, dead, owner }
   *   numbers 有給就顯示手數；ko >= 0 會在劫點畫方框。
   *   dead / owner 是數目用：死子畫成半透明，空點與死子上用小方塊標出是誰的地。
   */
  BoardView.prototype.render = function (opts) {
    var size = this.size, board = opts.board, dead = opts.dead, owner = opts.owner, h = '';
    var idx, p, black;
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
    this.stonesLayer.innerHTML = h;
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
