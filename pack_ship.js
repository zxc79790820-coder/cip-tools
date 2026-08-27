/* ============================================================
 * 包裝出件登錄 — ERP 頁面注入腳本（書籤小工具原始碼）
 * 西北影像 生產管理工具 / 作者：李安峻
 *
 * 用途：在 ERP 施工單頁（constructionQueryReadyShip.do）上叫出一個小面板，
 *       自動抓出客戶／訂單／施工人員／施工時間／施工地點／施工地址，
 *       現場只需輸入「件數」並按 Enter，資料即寫入 Google Sheet。
 *
 * 為什麼是書籤小工具而不是獨立網頁：
 *   腳本跑在使用者已登入的 ERP 頁面「本身」，同網域直接讀 DOM，
 *   不需要伺服器、不需要處理 ERP 登入、也沒有 CORS 問題。
 *
 * 連續掃描：面板內建「掃下一張」輸入框，掃描槍掃進去後用同源 fetch
 *   把下一張的頁面抓回來在記憶體裡解析，**不換頁**，所以整個班次
 *   只需要點一次書籤。
 *
 * 建置：python3 ~/Scripts/pack_ship_build.py  → 產生書籤網址與安裝頁
 * ============================================================ */

(function () {
  'use strict';

  var PANEL_ID = 'cipps-panel';
  var LS = {
    cfg:      'cipps:config',      // {endpoint, secret}
    operator: 'cipps:operator',    // 上次登錄人
    queue:    'cipps:queue'        // 送出失敗的待重送佇列
  };

  /* 已經開著就只把焦點移回去，不要疊第二個面板 */
  var exist = document.getElementById(PANEL_ID);
  if (exist) { var f = exist.querySelector('#cipps-qty'); if (f) f.focus(); return; }

  /* ── 欄位定義：以「標籤文字」為主鍵，比 CSS 選擇器耐改版 ── */
  var FIELDS = [
    { key: 'customer', label: '客戶',     aliases: ['客戶', '客戶名稱', '客戶簡稱'] },
    { key: 'orders',   label: '訂單',     aliases: ['訂單', '訂單號', '訂單編號', '單號'] },
    { key: 'worker',   label: '施工人員', aliases: ['施工人員', '人員', '施工者'] },
    { key: 'workTime', label: '施工時間', aliases: ['施工時間', '施工日期'] },
    { key: 'site',     label: '施工地點', aliases: ['施工地點', '地點'] },
    { key: 'addr',     label: '施工地址', aliases: ['施工地址', '地址'] },
    { key: 'note',     label: '施工備註', aliases: ['施工備註', '備註'] }
  ];

  /* 所有標籤合起來，供「捕捉到下一個標籤為止」用；
   * 長的排前面，避免「地址」比「施工地址」先命中 */
  var ALL_ALIASES = [];
  FIELDS.forEach(function (f) {
    f.aliases.forEach(function (a) { if (ALL_ALIASES.indexOf(a) < 0) ALL_ALIASES.push(a); });
  });
  ALL_ALIASES.sort(function (a, b) { return b.length - a.length; });

  var state = { id: '', url: '', values: {}, methods: {}, busy: false };
  var ac = null;

  /* ── 共用小工具 ─────────────────────────────────────── */
  function clean(v) {
    return String(v == null ? '' : v)
      .replace(/ /g, ' ')
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }

  /* 提示音（沿用工具箱 Tool F 的音效慣例：ok 短嗶／warn 雙嗶／err 長嗡） */
  function beep(kind) {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      var seq = kind === 'ok' ? [[880, 0.07]]
              : kind === 'warn' ? [[560, 0.09], [0, 0.04], [560, 0.09]]
              : [[200, 0.28]];
      var t = ac.currentTime;
      seq.forEach(function (p) {
        var fr = p[0], d = p[1];
        if (fr) {
          var o = ac.createOscillator(), g = ac.createGain();
          o.type = kind === 'err' ? 'square' : 'sine';
          o.frequency.value = fr;
          g.gain.setValueAtTime(0.18, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + d);
          o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + d);
        }
        t += d;
      });
    } catch (e) {}
  }

  function lsGet(k, dflt) {
    try { var v = localStorage.getItem(k); return v == null ? dflt : JSON.parse(v); }
    catch (e) { return dflt; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  /* ── 從網址取施工單 ID ──────────────────────────────── */
  function idFromUrl(u) {
    var m = String(u || '').match(/constructionQuery\.id=([0-9a-fA-F-]{8,})/);
    return m ? m[1] : '';
  }

  /* ── 擷取欄位：三段式，前一段沒抓到才往下試 ───────────
   * 1) 標籤格：找出文字剛好等於標籤的葉節點，取右邊那格
   * 2) 表單值：標籤後面的 input/textarea/select（ERP 常用唯讀輸入框呈現）
   * 3) 純文字：整頁 innerText 逐行比對「標籤：值」
   * 三段都失敗就留空，交給人在面板上手動補（欄位是可編輯的）
   */
  function extract(doc) {
    var values = {}, methods = {};

    var leaves = [];
    var all = doc.querySelectorAll('td,th,label,span,div,dt,b,strong,p,li');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.querySelector && el.querySelector('td,th,label,span,div,dt,b,strong,p,li')) continue;
      leaves.push(el);
    }

    function labelMatch(txt, aliases) {
      var t = clean(txt).replace(/[:：]\s*$/, '');
      for (var j = 0; j < aliases.length; j++) if (t === aliases[j]) return true;
      return false;
    }

    /* 1) 標籤格 → 右邊那格 */
    function byCell(fd) {
      for (var i = 0; i < leaves.length; i++) {
        if (!labelMatch(leaves[i].textContent, fd.aliases)) continue;
        var node = leaves[i];
        var cell = node.closest ? node.closest('td,th') : null;
        var cand = [];
        if (cell && cell.nextElementSibling) cand.push(cell.nextElementSibling);
        if (node.nextElementSibling) cand.push(node.nextElementSibling);
        if (node.parentElement) cand.push(node.parentElement);
        for (var k = 0; k < cand.length; k++) {
          var v = valueOf(cand[k], fd);
          if (v) return v;
        }
      }
      return '';
    }

    /* 取一個容器的值：優先表單元素，其次純文字 */
    function valueOf(el, fd) {
      if (!el) return '';
      var inp = el.matches && el.matches('input,textarea,select') ? el
              : (el.querySelector ? el.querySelector('input,textarea,select') : null);
      if (inp) {
        var iv = clean(inp.value != null ? inp.value : inp.getAttribute('value'));
        if (iv) return iv;
      }
      var tv = clean(el.textContent);
      /* 父層 fallback 會連標籤一起吃進來，切掉「標籤：」前綴 */
      for (var j = 0; j < fd.aliases.length; j++) {
        var re = new RegExp('^' + fd.aliases[j] + '\\s*[:：]\\s*');
        if (re.test(tv)) { tv = tv.replace(re, ''); break; }
      }
      for (var m = 0; m < fd.aliases.length; m++) if (tv === fd.aliases[m]) return '';
      return tv;
    }

    /* 3) 純文字逐行
     * 不能用 innerText：DOMParser 產生的離線文件上 innerText 不會把 <br> 與區塊
     * 元素當成換行，整頁會黏成一行，抓出來的值會把下一個欄位一起吃進去（已實測踩到）。
     * 所以自己把 <br> 與區塊元素換成換行後再取 textContent。
     */
    var lines = null;
    function docLines() {
      var root = (doc.body || doc.documentElement);
      var c = root.cloneNode(true);
      Array.prototype.forEach.call(c.querySelectorAll('script,style'), function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
      Array.prototype.forEach.call(c.querySelectorAll('br'), function (n) {
        if (n.parentNode) n.parentNode.replaceChild(doc.createTextNode('\n'), n);
      });
      Array.prototype.forEach.call(
        c.querySelectorAll('p,div,tr,td,th,li,h1,h2,h3,h4,h5,h6,section,article,label,dt,dd,option'),
        function (n) { n.appendChild(doc.createTextNode('\n')); }
      );
      return String(c.textContent || '')
        .replace(/ /g, ' ').normalize('NFKC')
        .replace(/[ \t]+/g, ' ')
        .split('\n')
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s; });
    }

    /* 捕捉到「下一個已知標籤」為止，避免同一行有多個欄位時吃過頭 */
    var STOP = '(?=\\s*(?:' + ALL_ALIASES.join('|') + ')\\s*[:：]|$)';

    function byText(fd) {
      if (lines === null) lines = docLines();
      /* 先嚴格（標籤前必須是行首或空白），全部落空才放寬 */
      var boundaries = ['(?:^|\\s)', ''];
      for (var b = 0; b < boundaries.length; b++) {
        for (var i = 0; i < lines.length; i++) {
          for (var j = 0; j < fd.aliases.length; j++) {
            var re = new RegExp(boundaries[b] + fd.aliases[j] + '\\s*[:：]\\s*(.+?)' + STOP);
            var m = lines[i].match(re);
            if (m && clean(m[1])) return clean(m[1]);
          }
        }
      }
      return '';
    }

    FIELDS.forEach(function (fd) {
      var v = byCell(fd);
      var how = v ? '標籤格' : '';
      if (!v) { v = byText(fd); how = v ? '純文字' : '未命中'; }
      /* 訂單欄常見尾巴逗號（貼紙上就是「20260819038,」），順手清掉 */
      if (fd.key === 'orders') v = v.replace(/[,，、\s]+$/, '');
      values[fd.key] = v;
      methods[fd.key] = how;
    });

    return { values: values, methods: methods };
  }

  /* ── 抓下一張：同源 fetch，不換頁 ─────────────────────── */
  function loadFromUrl(url) {
    setStatus('讀取中…', 'busy');
    state.busy = true;
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var got = extract(doc);
        var hit = Object.keys(got.values).filter(function (k) { return got.values[k]; }).length;

        /* 頁面若是 frameset 包裝，往下再抓一層 */
        if (hit === 0) {
          var fr = doc.querySelector('frame[src],iframe[src]');
          if (fr) {
            var sub = new URL(fr.getAttribute('src'), url).href;
            return fetch(sub, { credentials: 'same-origin' })
              .then(function (r2) { return r2.text(); })
              .then(function (h2) {
                return extract(new DOMParser().parseFromString(h2, 'text/html'));
              });
          }
        }
        return got;
      })
      .then(function (got) {
        state.id = idFromUrl(url);
        state.url = url;
        state.values = got.values;
        state.methods = got.methods;
        fillForm();
        var hit = Object.keys(got.values).filter(function (k) { return got.values[k]; }).length;
        if (hit === 0) { beep('err'); setStatus('這頁抓不到任何欄位，請按「診斷」把結果貼給管理者', 'err'); }
        else if (hit < 4) { beep('warn'); setStatus('只抓到 ' + hit + ' 個欄位，請確認後再送出', 'warn'); }
        else { setStatus('已帶出資料，請輸入件數', 'ok'); }
        var q = $('cipps-qty'); if (q) { q.value = ''; q.focus(); }
      })
      .catch(function (err) {
        beep('err');
        setStatus('讀取失敗：' + err.message, 'err');
      })
      .then(function () { state.busy = false; });
  }

  /* ── 送出 ────────────────────────────────────────────── */
  function post(payload) {
    var cfg = lsGet(LS.cfg, null);
    return fetch(cfg.endpoint, {
      method: 'POST',
      /* 故意用 text/plain：讓瀏覽器視為 simple request，避開 Apps Script 不支援的 preflight */
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }

  function submit(overwrite) {
    var cfg = lsGet(LS.cfg, null);
    if (!cfg || !cfg.endpoint || !cfg.secret) { openSettings(); return; }
    if (state.busy) return;

    var qty = parseInt($('cipps-qty').value, 10);
    if (!(qty > 0)) { beep('err'); setStatus('件數必須是大於 0 的整數', 'err'); $('cipps-qty').focus(); return; }
    if (!state.id) { beep('err'); setStatus('沒有施工單ID，請先掃一張貼紙', 'err'); return; }

    var operator = clean($('cipps-operator').value);
    if (!operator) { beep('err'); setStatus('請填登錄人', 'err'); $('cipps-operator').focus(); return; }
    lsSet(LS.operator, operator);

    var data = { id: state.id, qty: qty, operator: operator, url: state.url, note: clean($('cipps-note').value) };
    FIELDS.forEach(function (fd) {
      if (fd.key === 'note') return;
      data[fd.key] = clean($('cipps-f-' + fd.key).value);
    });
    if ($('cipps-f-note')) data.note = clean($('cipps-f-note').value) || data.note;

    var payload = { secret: cfg.secret, action: 'submit', overwrite: !!overwrite, data: data };

    state.busy = true;
    setStatus('送出中…', 'busy');
    post(payload).then(function (res) {
      state.busy = false;
      if (!res || !res.ok) { throw new Error((res && res.error) || '未知錯誤'); }

      if (res.dup) {
        beep('warn');
        var e = res.existing || {};
        setStatus('這張已經登錄過（' + (e.ts || '') + '　' + (e.operator || '') + '　' + (e.qty || '') + ' 件）', 'warn');
        $('cipps-dup').style.display = 'block';
        return;
      }

      beep('ok');
      $('cipps-dup').style.display = 'none';
      setStatus((res.updated ? '已更新 ✓' : '已登錄 ✓') + '　請掃下一張', 'ok');
      resetForNext();
    }).catch(function (err) {
      state.busy = false;
      beep('err');
      enqueue(payload);
      setStatus('送出失敗，已存進待重送佇列：' + err.message, 'err');
      renderQueue();
    });
  }

  /* ── 失敗佇列：絕不靜默失敗 ──────────────────────────── */
  function enqueue(payload) {
    var q = lsGet(LS.queue, []);
    q.push({ at: new Date().toISOString(), payload: payload });
    lsSet(LS.queue, q);
  }

  function flushQueue() {
    var q = lsGet(LS.queue, []);
    if (!q.length) { setStatus('沒有待重送的資料', 'ok'); return; }
    var cfg = lsGet(LS.cfg, null);
    if (!cfg) { openSettings(); return; }

    setStatus('重送中…（' + q.length + ' 筆）', 'busy');
    var rest = [], done = 0;
    var chain = Promise.resolve();
    q.forEach(function (item) {
      chain = chain.then(function () {
        return post(item.payload).then(function (res) {
          if (res && res.ok) done++; else rest.push(item);
        }).catch(function () { rest.push(item); });
      });
    });
    chain.then(function () {
      lsSet(LS.queue, rest);
      renderQueue();
      if (rest.length) { beep('warn'); setStatus('重送完成：成功 ' + done + '，仍失敗 ' + rest.length, 'warn'); }
      else { beep('ok'); setStatus('待重送資料已全部送出（' + done + ' 筆）', 'ok'); }
    });
  }

  function renderQueue() {
    var q = lsGet(LS.queue, []);
    var el = $('cipps-queue');
    if (!el) return;
    if (!q.length) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = '⚠ 有 <b>' + q.length + '</b> 筆尚未送出　' +
      '<button type="button" id="cipps-flush" class="cipps-btn cipps-btn-sm">立即重送</button>';
    $('cipps-flush').onclick = flushQueue;
  }

  /* ── 介面 ────────────────────────────────────────────── */
  function css() {
    return '#cipps-panel{position:fixed;right:16px;bottom:16px;width:380px;max-height:88vh;overflow:auto;' +
      'background:#fff;border:2px solid #F5A623;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.28);' +
      'z-index:2147483647;font:13px/1.5 "Microsoft JhengHei","PingFang TC",sans-serif;color:#3D3D3D}' +
      '#cipps-panel *{box-sizing:border-box;font-family:inherit}' +
      '.cipps-hd{background:#3D3D3D;color:#fff;padding:8px 12px;display:flex;align-items:center;gap:8px;' +
      'border-radius:6px 6px 0 0;cursor:move}' +
      '.cipps-hd b{flex:1;font-size:14px}' +
      '.cipps-hd button{background:none;border:1px solid #777;color:#ddd;border-radius:4px;cursor:pointer;' +
      'padding:2px 8px;font-size:12px}' +
      '.cipps-bd{padding:10px 12px}' +
      '.cipps-row{display:flex;align-items:center;gap:6px;margin-bottom:5px}' +
      '.cipps-row label{width:64px;flex:none;color:#666;font-size:12px}' +
      '.cipps-row input,.cipps-row textarea{flex:1;border:1px solid #ccc;border-radius:4px;padding:4px 6px;font-size:13px;width:100%}' +
      '.cipps-qty input{font-size:26px;font-weight:bold;text-align:center;border:2px solid #F5A623;padding:4px}' +
      '.cipps-scan input{border:2px dashed #999;background:#fafafa}' +
      '.cipps-btn{background:#F5A623;color:#fff;border:none;border-radius:5px;padding:8px 14px;' +
      'font-size:14px;font-weight:bold;cursor:pointer}' +
      '.cipps-btn-sm{padding:3px 8px;font-size:12px}' +
      '.cipps-btn-gh{background:#888}' +
      '.cipps-st{margin-top:8px;padding:7px 9px;border-radius:5px;font-size:13px;font-weight:bold;min-height:32px}' +
      '.cipps-st.ok{background:#e6f6e6;color:#1a7f1a;border:1px solid #9cd39c}' +
      '.cipps-st.warn{background:#fff6e0;color:#8a6100;border:1px solid #e8c877}' +
      '.cipps-st.err{background:#fdeaea;color:#a11;border:1px solid #e0a0a0}' +
      '.cipps-st.busy{background:#eef2f7;color:#456;border:1px solid #bcc8d6}' +
      '#cipps-queue{margin-top:6px;padding:6px 8px;background:#fdeaea;border:1px solid #e0a0a0;' +
      'border-radius:5px;color:#a11;font-size:12px}' +
      '#cipps-dup{margin-top:6px;display:none}' +
      '.cipps-mini{font-size:11px;color:#999;margin-top:6px}' +
      '#cipps-diag{width:100%;height:180px;font-family:monospace;font-size:11px;margin-top:6px;display:none}';
  }

  function fieldRows() {
    return FIELDS.map(function (fd) {
      return '<div class="cipps-row"><label>' + fd.label + '</label>' +
        '<input id="cipps-f-' + fd.key + '" type="text" value=""></div>';
    }).join('');
  }

  function build() {
    var st = document.createElement('style');
    st.textContent = css();
    document.head.appendChild(st);

    var p = document.createElement('div');
    p.id = PANEL_ID;
    p.innerHTML =
      '<div class="cipps-hd" id="cipps-hd"><b>📦 包裝出件登錄</b>' +
      '<button type="button" id="cipps-set">設定</button>' +
      '<button type="button" id="cipps-diagbtn">診斷</button>' +
      '<button type="button" id="cipps-close">✕</button></div>' +
      '<div class="cipps-bd">' +
        '<div class="cipps-row cipps-scan"><label>掃下一張</label>' +
        '<input id="cipps-scan" type="text" placeholder="游標放這裡，用掃描槍掃貼紙 QR"></div>' +
        '<hr style="border:none;border-top:1px solid #eee;margin:8px 0">' +
        fieldRows() +
        '<div class="cipps-row cipps-qty"><label>件數</label>' +
        '<input id="cipps-qty" type="number" min="1" step="1" placeholder="0"></div>' +
        '<div class="cipps-row"><label>登錄人</label><input id="cipps-operator" type="text"></div>' +
        '<div class="cipps-row"><label>備註</label><input id="cipps-note" type="text"></div>' +
        '<button type="button" class="cipps-btn" id="cipps-submit" style="width:100%;margin-top:6px">送出（Enter）</button>' +
        '<div id="cipps-dup"><button type="button" class="cipps-btn cipps-btn-gh" id="cipps-ow" style="width:100%">這張要覆蓋原本的登錄</button></div>' +
        '<div class="cipps-st busy" id="cipps-status">請用掃描槍掃一張貼紙</div>' +
        '<div id="cipps-queue" style="display:none"></div>' +
        '<textarea id="cipps-diag" readonly></textarea>' +
        '<div class="cipps-mini">Enter 送出／Esc 關閉。抓錯的欄位可直接在上面改再送。</div>' +
      '</div>';
    document.body.appendChild(p);
    return p;
  }

  function setStatus(msg, kind) {
    var el = $('cipps-status');
    if (!el) return;
    el.className = 'cipps-st ' + (kind || 'busy');
    el.textContent = msg;
  }

  function fillForm() {
    FIELDS.forEach(function (fd) {
      var el = $('cipps-f-' + fd.key);
      if (el) el.value = state.values[fd.key] || '';
    });
  }

  function resetForNext() {
    $('cipps-qty').value = '';
    $('cipps-note').value = '';
    var s = $('cipps-scan');
    s.value = '';
    s.focus();
  }

  function openSettings() {
    var cfg = lsGet(LS.cfg, { endpoint: '', secret: '' });
    var ep = prompt('Google Apps Script 網頁應用程式網址（/exec 結尾）：', cfg.endpoint || '');
    if (ep === null) return;
    var sc = prompt('共享密鑰（要與 Apps Script 內的 SECRET 一字不差）：', cfg.secret || '');
    if (sc === null) return;
    lsSet(LS.cfg, { endpoint: clean(ep), secret: sc });
    setStatus('設定已儲存（只存在這台電腦的這個瀏覽器）', 'ok');
  }

  function showDiag() {
    var ta = $('cipps-diag');
    ta.style.display = ta.style.display === 'block' ? 'none' : 'block';
    if (ta.style.display !== 'block') return;
    var out = ['網址：' + (state.url || location.href), '施工單ID：' + (state.id || '(無)'), ''];
    FIELDS.forEach(function (fd) {
      out.push(fd.label + '　[' + (state.methods[fd.key] || '-') + ']　' + (state.values[fd.key] || '(空)'));
    });
    out.push('', '── 頁面純文字前 2000 字（抓不到欄位時請整段複製給管理者）──');
    var body = document.body;
    out.push(clean0(body.innerText || body.textContent || '').slice(0, 2000));
    ta.value = out.join('\n');
    ta.select();
    function clean0(s) { return String(s).replace(/ /g, ' ').normalize('NFKC'); }
  }

  function drag(panel, handle) {
    var ox = 0, oy = 0, on = false;
    handle.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      on = true;
      var r = panel.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!on) return;
      panel.style.left = (e.clientX - ox) + 'px';
      panel.style.top = (e.clientY - oy) + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', function () { on = false; });
  }

  /* ── 啟動 ────────────────────────────────────────────── */
  var panel = build();
  drag(panel, $('cipps-hd'));

  $('cipps-close').onclick = function () { panel.remove(); };
  $('cipps-set').onclick = openSettings;
  $('cipps-diagbtn').onclick = showDiag;
  $('cipps-submit').onclick = function () { submit(false); };
  $('cipps-ow').onclick = function () { $('cipps-dup').style.display = 'none'; submit(true); };
  $('cipps-operator').value = lsGet(LS.operator, '') || '';

  /* 掃描槍當鍵盤用：掃完會送 Enter；若沒設定送 Enter，用 160ms idle 判讀（同 Tool F 慣例） */
  var scanTimer = null;
  var scanEl = $('cipps-scan');
  function tryScan() {
    var v = clean(scanEl.value);
    if (!v) return;
    var id = idFromUrl(v);
    if (!id) { beep('err'); setStatus('這不是施工單貼紙的 QR（找不到 constructionQuery.id）', 'err'); scanEl.select(); return; }
    scanEl.value = '';
    loadFromUrl(v);
  }
  scanEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(scanTimer); tryScan(); }
  });
  scanEl.addEventListener('input', function () {
    clearTimeout(scanTimer);
    if (scanEl.value.length >= 40) scanTimer = setTimeout(tryScan, 160);
  });

  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { panel.remove(); return; }
    if (e.key === 'Enter' && (e.target.id === 'cipps-qty' || e.target.id === 'cipps-note')) {
      e.preventDefault(); submit(false);
    }
  });

  /* 開面板時，若目前這頁本身就是施工單頁，直接抓現成的 DOM，省一次 fetch */
  var here = idFromUrl(location.href);
  if (here) {
    var got = extract(document);
    state.id = here; state.url = location.href;
    state.values = got.values; state.methods = got.methods;
    fillForm();
    var hit = Object.keys(got.values).filter(function (k) { return got.values[k]; }).length;
    if (hit === 0) { beep('err'); setStatus('這頁抓不到任何欄位，請按「診斷」把結果貼給管理者', 'err'); }
    else { setStatus('已帶出資料，請輸入件數', 'ok'); }
    $('cipps-qty').focus();
  } else {
    scanEl.focus();
  }

  renderQueue();
  if (!lsGet(LS.cfg, null)) openSettings();
})();
