/* ============================================================
   Cコードのステップ実行（旧 index.html のエンジンを、1ページに複数置ける部品に作り直したもの）
   使い方:
     Stepper.mount(document.getElementById("st-addr"), {
       id: "ptr-s1-addr",                    // 達成記録のID（最後の行まで進めると達成）
       title: "変数の番地を見る",
       code: ["#include <stdio.h>", ...],
       frames: ["main"],                     // 最初にあるスタックフレーム
       steps: [ { line: 4, apply: function (m) { M.svar(m, "main", "a", "a", "int", 10); }, note: "..." }, ... ]
     });
   M（下の関数群）でメモリの状態を組み立てる。番地は64ビット環境の見た目（12桁の16進数）。
   ============================================================ */
(function (global) {
  "use strict";

  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function hex(n) { return "0x" + n.toString(16); }

  function highlightC(line) {
    return esc(line).replace(
      /(\/\/.*$)|("(?:[^"\\]|\\.)*")|\b(int|char|double|float|void|struct|typedef|return|if|else|while|for|sizeof|NULL|size_t)\b|\b(malloc|free|printf|strcpy|calloc)\b|\b(\d+(?:\.\d+)?)\b/g,
      function (m, cm, str, kw, fn, num) {
        if (cm) return '<span class="tk-cm">' + cm + "</span>";
        if (str) return '<span class="tk-str">' + str + "</span>";
        if (kw) return '<span class="tk-kw">' + kw + "</span>";
        if (fn) return '<span class="tk-fn">' + fn + "</span>";
        if (num) return '<span class="tk-num">' + num + "</span>";
        return m;
      }
    );
  }

  /* ---------- メモリの状態のモデル ---------- */
  function sizeOfType(type) {
    if (type.indexOf("*") !== -1) return 8;
    if (type === "double") return 8;
    if (type === "char") return 1;
    return 4;
  }
  var M = {
    fresh: function (frameNames) {
      var stackTop = 0x7ffd3a2c0e70, heapNext = 0x55d5a1b02a0;
      var mem = {
        frames: [], heap: [],
        _stack: function (size) { stackTop -= size; stackTop -= stackTop % Math.min(size, 8); return stackTop; },
        _heap: function (size) { var a = heapNext; heapNext += Math.ceil((size + 16) / 16) * 16; return a; }
      };
      (frameNames || ["main"]).forEach(function (n) { mem.frames.push({ id: n, name: n, vars: [] }); });
      return mem;
    },
    svar: function (mem, frameId, id, name, type, value, pointsTo) {
      var f = mem.frames.find(function (x) { return x.id === frameId; });
      var v = { id: id, name: name, type: type, value: value, addr: hex(mem._stack(sizeOfType(type))) };
      if (pointsTo !== undefined) v.pointsTo = pointsTo;
      f.vars.push(v);
    },
    sarray: function (mem, frameId, id, name, type, values) {
      var sz = sizeOfType(type);
      var start = mem._stack(sz * values.length);
      var f = mem.frames.find(function (x) { return x.id === frameId; });
      values.forEach(function (val, i) {
        f.vars.push({ id: id + i, name: name + "[" + i + "]", type: type, value: val, addr: hex(start + i * sz) });
      });
    },
    heap: function (mem, id, label, size, opts) {
      opts = opts || {};
      mem.heap.push({ id: id, label: label, size: size, addr: hex(mem._heap(size)), status: "alive", fields: opts.fields || null, value: opts.value });
    },
    free: function (mem, id) { var h = mem.heap.find(function (x) { return x.id === id; }); if (h) h.status = "freed"; },
    reuse: function (mem, id, label) { var h = mem.heap.find(function (x) { return x.id === id; }); if (h) { h.status = "alive"; if (label) h.label = label; } },
    hval: function (mem, id, value) { var h = mem.heap.find(function (x) { return x.id === id; }); if (h) h.value = value; },
    set: function (mem, frameId, varId, patch) {
      var f = mem.frames.find(function (x) { return x.id === frameId; });
      if (!f) return;
      var v = f.vars.find(function (x) { return x.id === varId; });
      if (v) Object.assign(v, patch);
    },
    field: function (mem, heapId, key, patch) {
      var h = mem.heap.find(function (x) { return x.id === heapId; });
      if (!h || !h.fields) return;
      var fl = h.fields.find(function (x) { return x.key === key; });
      if (fl) Object.assign(fl, patch);
    },
    push: function (mem, id, name) { mem.frames.push({ id: id, name: name || id, vars: [] }); },
    pop: function (mem, id) { mem.frames = mem.frames.filter(function (f) { return f.id !== id; }); },
    nop: function () {}
  };

  function addrOf(mem, id) {
    var h = mem.heap.find(function (x) { return x.id === id; });
    if (h) return h.addr;
    for (var i = 0; i < mem.frames.length; i++) {
      var v = mem.frames[i].vars.find(function (x) { return x.id === id; });
      if (v) return v.addr;
    }
    return null;
  }
  function isFreed(mem, id) {
    var h = mem.heap.find(function (x) { return x.id === id; });
    return h ? h.status === "freed" : false;
  }
  function ptrHtml(mem, o) {
    if (o.pointsTo === "NULL") return '<span class="tag-null">NULL</span>';
    if (o.pointsTo === "WILD") return '<span class="tag-wild">❓ でたらめな値</span>';
    return '<span class="tag-addr">' + (addrOf(mem, o.pointsTo) || "?") + "</span>";
  }
  function hasPtr(o) { return Object.prototype.hasOwnProperty.call(o, "pointsTo"); }

  function renderFrames(mem, uid) {
    if (!mem.frames.length) return '<div class="frame-empty">（スタックは空）</div>';
    return mem.frames.slice().reverse().map(function (f) {
      return '<div class="frame-box"><div class="frame-head">' + esc(f.name) + "() の板</div><div class=\"frame-vars\">" +
        (f.vars.length ? f.vars.map(function (v) {
          return '<div class="mem-box stack-box" id="' + uid + "box-" + v.id + '"><div class="mem-box-row"><span class="mem-box-name">' + esc(v.type) + " <b>" + esc(v.name) + '</b></span><span class="mem-addr">' + v.addr + "</span></div>" +
            '<div class="mem-box-body">' + (hasPtr(v) ? ptrHtml(mem, v) : esc(String(v.value))) + "</div></div>";
        }).join("") : '<div class="frame-empty">（変数なし）</div>') + "</div></div>";
    }).join("");
  }
  function renderHeap(mem, uid) {
    if (!mem.heap.length) return '<div class="frame-empty">（まだ借りていない）</div>';
    return mem.heap.map(function (h) {
      var freed = h.status === "freed";
      var body = h.fields ? h.fields.map(function (f) {
        return '<div class="mem-field-row" id="' + uid + "field-" + h.id + "-" + f.key + '"><span class="mem-field-name">' + esc(f.name) + '</span><span class="mem-field-value">' + (hasPtr(f) ? ptrHtml(mem, f) : esc(String(f.value))) + "</span></div>";
      }).join("") : '<div class="mem-field-row"><span class="mem-field-name">中身</span><span class="mem-field-value">' + esc(String(h.value)) + "</span></div>";
      return '<div class="mem-box heap-box' + (freed ? " is-freed" : "") + '" id="' + uid + "box-" + h.id + '"><div class="mem-box-row"><span class="mem-box-label">' + esc(h.label) + '</span><span class="mem-addr">' + h.addr + "</span></div>" +
        '<div class="mem-box-fields">' + body + "</div>" + (freed ? '<div class="mem-box-badge">🗑 返却済み（使ってはいけない）</div>' : "") + "</div>";
    }).join("");
  }
  function anchors(mem, uid) {
    var list = [];
    mem.frames.forEach(function (f) {
      f.vars.forEach(function (v) {
        if (v.pointsTo && v.pointsTo !== "NULL" && v.pointsTo !== "WILD") list.push({ from: uid + "box-" + v.id, to: v.pointsTo, bad: isFreed(mem, v.pointsTo) });
      });
    });
    mem.heap.forEach(function (h) {
      (h.fields || []).forEach(function (f) {
        if (f.pointsTo && f.pointsTo !== "NULL" && f.pointsTo !== "WILD") list.push({ from: uid + "field-" + h.id + "-" + f.key, to: f.pointsTo, bad: isFreed(mem, f.pointsTo) });
      });
    });
    return list;
  }
  function drawArrows(root, mem, uid) {
    var wrap = root.querySelector(".mem-panel-wrap");
    var svg = root.querySelector(".arrow-svg");
    var wr = wrap.getBoundingClientRect();
    svg.setAttribute("width", wr.width);
    svg.setAttribute("height", wr.height);
    svg.innerHTML = '<defs><marker id="' + uid + 'ah" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d98e3f"/></marker>' +
      '<marker id="' + uid + 'ahng" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#c8433f"/></marker></defs>';
    anchors(mem, uid).forEach(function (a) {
      var fe = document.getElementById(a.from), te = document.getElementById(uid + "box-" + a.to);
      if (!fe || !te) return;
      var fr = fe.getBoundingClientRect(), tr = te.getBoundingClientRect();
      var fx = fr.left + fr.width / 2, fy = fr.top + fr.height / 2, tx = tr.left + tr.width / 2, ty = tr.top + tr.height / 2;
      var d, x1, y1, x2, y2;
      if (Math.abs(ty - fy) > Math.abs(tx - fx)) {
        var below = fy > ty;
        x1 = fx - wr.left; y1 = (below ? fr.top : fr.bottom) - wr.top;
        x2 = tx - wr.left; y2 = (below ? tr.bottom : tr.top) - wr.top;
        var my = (y1 + y2) / 2;
        d = "M" + x1 + "," + y1 + " C" + x1 + "," + my + " " + x2 + "," + my + " " + x2 + "," + y2;
      } else {
        var left = fx < tx;
        x1 = (left ? fr.right : fr.left) - wr.left; y1 = fy - wr.top;
        x2 = (left ? tr.left : tr.right) - wr.left; y2 = ty - wr.top;
        var mx = (x1 + x2) / 2;
        d = "M" + x1 + "," + y1 + " C" + mx + "," + y1 + " " + mx + "," + y2 + " " + x2 + "," + y2;
      }
      var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", d);
      p.setAttribute("class", "arrow-path" + (a.bad ? " dangling" : ""));
      p.setAttribute("marker-end", "url(#" + uid + (a.bad ? "ahng" : "ah") + ")");
      svg.appendChild(p);
    });
  }

  var count = 0;
  function mount(root, cfg) {
    var uid = "st" + (++count) + "-";
    var already = !!(cfg.id && global.QUEST && global.QUEST.isTaskDone(cfg.id));
    root.classList.add("lab");
    if (cfg.id) root.setAttribute("data-task", cfg.id);
    root.innerHTML =
      '<div class="lab-head"><span class="lab-badge">実験</span><span class="lab-title">' + esc(cfg.title || "コードを1行ずつ実行する") + "</span></div>" +
      '<div class="stepper"><div class="code-panel"><div class="code-block"></div></div>' +
      '<div class="mem-panel-wrap"><div class="mem-col"><div class="mem-col-head">📥 スタック（関数ごとの板）</div><div class="mem-col-body frames-body"></div></div>' +
      '<div class="mem-col"><div class="mem-col-head">📤 ヒープ（借りた場所）</div><div class="mem-col-body heap-body"></div></div><svg class="arrow-svg"></svg></div>' +
      '<div class="step-note" aria-live="polite"></div>' +
      '<div class="step-controls"><button type="button" class="btn st-prev">◀ 前へ</button><span class="step-progress"></span><button type="button" class="btn btn-primary st-next">次へ ▶</button></div></div>';
    var idx = -1;
    function memAt() {
      var m = M.fresh(cfg.frames);
      for (var i = 0; i <= idx; i++) cfg.steps[i].apply(m);
      return m;
    }
    function render() {
      var m = memAt();
      var cur = idx >= 0 ? cfg.steps[idx].line : null;
      root.querySelector(".code-block").innerHTML = cfg.code.map(function (t, i) {
        return '<div class="code-line' + (i + 1 === cur ? " active" : "") + '"><span class="ln-no">' + (i + 1) + '</span><span class="ln-text">' + highlightC(t) + "</span></div>";
      }).join("");
      root.querySelector(".frames-body").innerHTML = renderFrames(m, uid);
      root.querySelector(".heap-body").innerHTML = renderHeap(m, uid);
      drawArrows(root, m, uid);
      root.querySelector(".step-note").innerHTML = idx < 0 ? "▶「次へ」を押すと、1行ずつ実行される。" : cfg.steps[idx].note;
      root.querySelector(".step-progress").textContent = (idx + 1) + " / " + cfg.steps.length;
      root.querySelector(".st-prev").disabled = idx < 0;
      root.querySelector(".st-next").disabled = idx >= cfg.steps.length - 1;
      if (idx === cfg.steps.length - 1 && !root.classList.contains("solved")) markDone();
    }
    function markDone() {
      root.classList.add("solved");
      root.querySelector(".lab-badge").textContent = "✓ 達成";
      if (cfg.id && global.QUEST) global.QUEST.taskDone(root, cfg.id);
      else root.setAttribute("data-solved", "true");
    }
    root.querySelector(".st-prev").addEventListener("click", function () { if (idx >= 0) { idx--; render(); } });
    root.querySelector(".st-next").addEventListener("click", function () { if (idx < cfg.steps.length - 1) { idx++; render(); } });
    global.addEventListener("resize", function () { drawArrows(root, memAt(), uid); });
    if (already) markDone();
    render();
  }

  global.M = M;
  global.Stepper = { mount: mount };
})(window);
