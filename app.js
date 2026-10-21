// eBay Mail (ThinkPad 版)。画面の中身 (startClient) は Replies_WebApp.gs.js の _repliesClient_ をそのまま移した物。
// 変えたのは 3 点だけ: ① 通信 (google.script.run → GSR) ② 起動 (端末の控えで先に描く → 取り直して差し替える = applyData)
// (段階 3 で AI・翻訳・Block・5% Offer・台帳も今のページと同じ動きに戻した)
var TOKEN = '';   // 使わない (本物のトークンは apiCall が X-Mail-Token で送る。元のコードの引数の形を保つためだけに残す)
var LS_STATE = 'mailapp.state.v1', LS_TOKEN = 'mailapp.token';

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 控えが残らないだけ。画面は出す */ } }

var MAIL_TOKEN = (function () {
  var t = '';
  try { t = new URLSearchParams(location.search).get('t') || ''; } catch (e) { }
  if (t) { lsSet(LS_TOKEN, t); return t; }
  return lsGet(LS_TOKEN) || '';
})();

// 配布版 (2026-10-21 ユーザー指示): ListingTool 拡張に同梱した画面 (chrome-extensions/ListingTool/mail/) は、この app.js のコピーを
// window.MAIL_BACKEND='gas' と mail-gas.js (window.MailGas) を先に読み込んで動かす。GAS_MODE の時だけ、通信を MailGas へ渡す・
// ZBook 専用の部品 (通知のベル・自動返信の欄) を出さない (Chat / Order / Summary / Status は GAS 版ができた = 第 1〜3 段、商品の画面・Re:translation・Supplier・商品の検索窓・AI 対応の絞り込みは第 4 段 a = 2026-10-21)。
// ZBook の mail_app (window.MAIL_BACKEND が無い) では GAS_MODE は常に false = 従来どおり。
var GAS_MODE = (window.MAIL_BACKEND === 'gas') && !!window.MailGas;

function apiCall(method, path, body, onHeaders) {
  if (GAS_MODE) return window.MailGas.call(method, path, body, onHeaders);
  var opt = { method: method, headers: { 'X-Mail-Token': MAIL_TOKEN } };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  return fetch(path, opt).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) { var er = new Error((j && j.message) || ('HTTP ' + r.status)); er.status = r.status; throw er; }
      if (onHeaders) onHeaders(r.headers);
      return j;
    });
  });
}

// google.script.run と同じ形 (withSuccessHandler / withFailureHandler / 関数名(引数...)) の小さな包み
var GSR_ROUTES = {
  repliesTemplates: function () { return ['GET', '/api/templates']; },
  repliesMarkDone: function (a) { return ['POST', '/api/done', { mid: a[0] }]; },
  repliesSend: function (a) { return ['POST', '/api/send', { mid: a[0], body: a[1], images: a[3] || [] }]; },
  repliesAiOptions: function (a) { return ['POST', '/api/ai-options', { mid: a[0], memo: a[1] }]; },
  repliesAiDraft: function (a) { return ['POST', '/api/ai-draft', { mid: a[0], memo: a[1], option: a[2], extra: a[3] }]; },
  repliesAiRewrite: function (a) { return ['POST', '/api/ai-rewrite', { mid: a[0], ja: a[1], option: a[2] }]; },
  repliesRetranslate: function (a) { return ['POST', '/api/retranslate', { mid: a[0] }]; },
  repliesTranslate: function (a) { return ['POST', '/api/translate', { mid: a[0], ja: a[1] }]; },
  repliesLedgerRecord: function (a) { return ['POST', '/api/ledger', { mid: a[0], body: a[1], ja: a[2] }]; },
  repliesOfferUrl: function (a) { return ['POST', '/api/offer-url', { mid: a[0], itemId: a[1], buyer: a[2] }]; }
};
function GSR() {
  var ok = function () { }, ng = null;
  var h = new Proxy({}, {
    get: function (_, name) {
      if (name === 'withSuccessHandler') return function (f) { ok = f; return h; };
      if (name === 'withFailureHandler') return function (f) { ng = f; return h; };
      return function () {
        var args = Array.prototype.slice.call(arguments), route = GSR_ROUTES[name];
        if (!route) { setTimeout(function () { if (ng) ng(new Error('未対応の呼び出し: ' + String(name))); }, 0); return; }
        var r = route(args);
        apiCall(r[0], r[1], r[2]).then(function (j) { ok(j); }, function (e) { if (ng) ng(e); });
      };
    }
  });
  return h;
}

function hhmm(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return '-';
  var j = new Date(d.getTime() + 9 * 3600000), p = function (n) { return (n < 10 ? '0' : '') + n; };
  return p(j.getUTCHours()) + ':' + p(j.getUTCMinutes());
}
function setStatus(txt, ng) { var s = document.getElementById('mailStatus'); if (s) { s.textContent = ng ? txt : ''; s.hidden = !ng; } }   // 2026-10-14: 出すのは失敗の時だけ

// 起動: 端末の控え (localStorage) があれば先にそれで描く → サーバーの控え → Drive から取り直し、の順に差し替える
function boot() {
  var client = null;
  function got(data, label) {
    lsSet(LS_STATE, JSON.stringify({ at: Date.now(), data: data }));
    shownStamp = { updated: data.updated || '', queueUpdated: data.queueUpdated || '' };
    if (client) client.apply(data); else client = startClient(data);
    window.mailClient = client;   // 動作確認用 (画面からは使わない)
    setMailN((data.threads || []).filter(function (v) { return v.unread; }).length);
    setStatus(label + ' ' + hhmm(data.updated));
  }
  var c = null;
  try { c = JSON.parse(lsGet(LS_STATE) || 'null'); } catch (e) { }
  if (c && c.data && c.data.threads) { client = window.mailClient = startClient(c.data); setStatus('控え ' + hhmm(c.data.updated) + ' / 取り直し中…'); }
  else setStatus('読み込み中…');
  var fresh = false;
  mailRefresh = function () {
    if (!client) return;
    apiCall('GET', '/api/state').then(function (d) { got(d, '控え'); }).catch(function () { /* 次の 30 秒でまた見る */ });
  };
  apiCall('GET', '/api/state').then(function (d) {
    got(d, '控え'); setStatus('控え ' + hhmm(d.updated) + ' / 取り直し中…');
    return apiCall('GET', '/api/state?fresh=1', null, function (h) { fresh = h.get('X-Mail-Fresh') === '1'; });
  }).then(function (d) {
    got(d, fresh ? '最新' : '控え (Drive を読めませんでした)');
  }).catch(function (e) {
    setStatus('取り直せません: ' + (e && e.message ? e.message : e) + (client ? ' (控えを表示中)' : ''), true);
  });
}
document.addEventListener('DOMContentLoaded', boot);

if (!GAS_MODE && 'serviceWorker' in navigator) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () { /* 殻を覚えられないだけ。ページは動く */ }); });
}

// 画面の自動更新。見えている間だけ 30 秒ごとに /api/stamp を見て、表示中のデータと違えば boot の取り直し (mailRefresh) を呼ぶ。
// 会話を開いている間・送信や AI の処理中は見送り (refreshWanted)、一覧に戻った時に 1 回だけ更新する (showList → mailRefreshIfWanted)
var mailRefresh = null, refreshWanted = false, shownStamp = null;
function mailRefreshNow() {
  if (!mailRefresh || !window.mailClient) return;
  if (!window.mailClient.idle()) { refreshWanted = true; return; }
  refreshWanted = false;
  mailRefresh();
}
function mailRefreshIfWanted() { if (refreshWanted) mailRefreshNow(); }
function stampCheck() {
  if (document.visibilityState !== 'visible' || !shownStamp) return;
  apiCall('GET', '/api/stamp').then(function (s) {
    if (s.updated !== shownStamp.updated || s.queueUpdated !== shownStamp.queueUpdated) mailRefreshNow();
  }).catch(function () { /* 見られなかっただけ。次の 30 秒でまた見る */ });
}
setInterval(stampCheck, 30000);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.type === 'refresh') mailRefreshNow(); });
}

// 会話の上に出す注文カード (Seller Hub の注文一覧の並び)。reply_orders.py が付けた order / repeat / history から、行のリストを作る。
// DOM には触れない (行の文字だけ作る)。1 行 = {cls: 'oh' | 'ord', text, right?}。無ければ空のリスト
// ORDER-ROWS-BEGIN
function ordMd(iso) {
  var d = new Date(iso);
  if (!iso || isNaN(d)) return '';
  d = new Date(d.getTime() + 9 * 3600000);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
}
function ordMoney(v, cur) {
  var n = parseFloat(v);
  if (isNaN(n) || n === 0) return '';      // 全額返金のキャンセルは合計が 0 になる。$0.00 は出さない
  var s = n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return cur === 'USD' || !cur ? '$' + s : cur + ' ' + s;
}
function ordHead(o) {
  if (o.stage === 'cancelled') return 'キャンセル済み';
  if (o.stage === 'cancel_requested') return 'キャンセル依頼中';
  var one = function (label, iso) { return label + (ordMd(iso) ? ' ' + ordMd(iso) : ''); };
  if (o.stage === 'delivered') return one('配達済み', o.delivered);
  if (o.stage === 'shipped') return one('発送済み', o.shipped);
  if (o.stage === 'paid') return one('支払い済み', o.paid) + ' (未発送)';
  return '未払い';
}
// opt.repeater: 買い手の名前の行に「リピーター」を付ける / opt.mini: 過去の購入の小さなカード (商品のタイトルと ItemID の行を足す)
function orderRows(o, opt) {
  opt = opt || {};
  var rows = [{ cls: 'oh', text: ordHead(o), right: o.order_id || '' }];
  if (opt.mini) {
    var it = (o.items && o.items[0]) || {}, id = it.item_id || (o.item_ids && o.item_ids[0]) || '';
    var ti = String(it.title || '');
    if (ti.length > 40) ti = ti.slice(0, 40) + '…';
    var tl = [ti, id ? 'ItemID ' + id : ''].filter(Boolean).join(' · ');
    if (tl) rows.push({ cls: 'ord', text: tl });
  }
  var who = [o.buyer_name, o.buyer, opt.repeater ? 'リピーター' : ''].filter(Boolean).join(' · ');
  if (who) rows.push({ cls: 'ord', text: who });
  var trk = [o.carrier, o.tracking].filter(Boolean).join(' ');
  if (o.tracking || o.carrier) {
    var tp = ['追跡 ' + trk];
    if (o.stage === 'shipped') {
      var a = ordMd(o.est_min), b = ordMd(o.est_max);
      if (a || b) tp.push('配達予定 ' + (a && b && a !== b ? a + '〜' + b : a || b));
    }
    rows.push({ cls: 'ord', text: tp.join(' · ') });
  }
  var ct = [o.country, o.postal_code].filter(Boolean).join(' ');
  if (ct) rows.push({ cls: 'ord', text: ct });
  var nm = [];
  if (o.quantity) nm.push('数量 ' + o.quantity);
  if (ordMoney(o.item_price, o.item_price_currency || o.currency)) nm.push('売れた価格 ' + ordMoney(o.item_price, o.item_price_currency || o.currency));
  if (ordMoney(o.total, o.currency)) nm.push('合計 ' + ordMoney(o.total, o.currency));
  if (ordMd(o.created)) nm.push('売れた日 ' + ordMd(o.created));
  if (ordMd(o.paid)) nm.push('支払い日 ' + ordMd(o.paid));
  if (nm.length) rows.push({ cls: 'ord', text: nm.join(' · ') });
  return rows;
}
// 会話 t の注文カード: {main: 行のリスト か null, past: [行のリスト, ...]}。order も history も無ければ main = null・past = []
function orderGroups(t) {
  var main = t.order ? orderRows(t.order, { repeater: !!(t.repeat && t.repeat.count >= 2) }) : null;
  var past = (t.history || []).map(function (h) { return orderRows(h, { mini: true }); });
  return { main: main, past: past };
}
// ORDER-ROWS-END

function startClient(DATA) {
  var T = DATA.threads, filter = 'all', cur = null, tplCache = null, aiMemo = '', boxOpened = false, lastOpt = null, en = '', enLang = '', jaSnap = '', busyF = false, sentF = false, atts = [], pend = 0, kw = '';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function jst(iso) { var d = new Date(iso); return isNaN(d) ? null : new Date(d.getTime() + 9 * 3600000); }
  function dstr(iso) { var d = jst(iso); return d ? (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日' : ''; }
  function tstr(iso) {
    var d = jst(iso);
    if (!d) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }
  function ini(s) { return (s || '?').charAt(0).toUpperCase(); }
  function flat(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function pic(t, cls) {
    if (t.pic) {
      var im = el('img', 'pic');
      im.src = t.pic; im.alt = ''; im.loading = 'lazy';
      im.onerror = function () { im.replaceWith(el('div', 'ini', ini(t.buyer))); };
      return im;
    }
    return el('div', 'ini', ini(t.buyer));
  }
  function counts() {
    var a = 0;
    T.forEach(function (t) { if (t.ai) a++; });
    return { all: T.filter(function (t) { return !t.virt; }).length, ai: a };
  }

  // AI Chat ボタンの文字 (AI が対応している会話が 1 件以上ならその数を後ろに付ける・2026-10-14)
  function aiText() { var n = counts().ai; return 'AI Chat' + (n ? ' ' + n : ''); }

  // 取り直したデータに差し替える。開いている会話・入力中の文・検索語・絞り込みはそのまま (一覧の行だけ作り直す)
  function applyData(nd) {
    var nt = nd.threads.slice();
    if (cur) {   // 開いている会話は今の物を残す (吹き出しや入力欄を作り直さない)。新しい分は閉じて開き直した時に出る
      var k = -1;
      nt.forEach(function (t, i) { if (t.buyer === cur.buyer && t.item_id === cur.item_id) k = i; });
      if (k >= 0) nt[k] = cur; else nt.push(cur);
    }
    DATA = nd; T = nt;
    if ($('bAi')) $('bAi').textContent = aiText();
    if ($('rows')) renderRows();
    if (wantBuyer && !cur) openWanted();
  }

  function renderList() {
    var root = $('listView');
    root.textContent = '';
    var hd = el('div', 'hd');
    hd.appendChild(el('h1', null, 'Management Tools'));   // 2026-10-14: 3 つのタブ共通の題 (旧: メッセージ + 会話の更新時刻)
    root.appendChild(hd);
    root.appendChild(segBar('mail'));
    // 検索 → その下に右寄せの丸いボタンの列 (AI Chat・通知のベル・更新)
    var sr = el('div', 'sr'), si = el('input');
    si.type = 'search'; si.placeholder = 'Chat を検索'; si.value = kw;
    si.oninput = function () { kw = si.value; renderRows(); };
    sr.appendChild(si); root.appendChild(sr);
    var bar = el('div', 'bar'), lm = el('span', 'lm'), bAi = el('button', 'aibtn' + (filter === 'ai' ? ' on' : '')), rf = uRefreshBtn(function () { location.reload(); });
    lm.id = 'lm';
    bAi.id = 'bAi'; bAi.type = 'button'; bAi.textContent = aiText();
    bAi.onclick = function () { filter = filter === 'ai' ? 'all' : 'ai'; renderList(); };   // AI が対応中の会話だけ ⇄ すべて
    bar.appendChild(lm); bar.appendChild(bAi); bar.appendChild(rf);   // 配布版でも出す (第 4 段 a): 自動返信は第 4 段 b なので、今は AI 対応の会話が無い = 空の一覧になるだけ
    root.appendChild(bar);
    pushButton(bar, rf);                                                             // 配布版 (GAS_MODE) のベルは Bark の入切 (PushUi の中)
    var rows = el('div'); rows.id = 'rows'; root.appendChild(rows);
    renderRows();
  }

  // 絞り込み後の会話 (AI対応の切替 + 検索語。名前・商品名・ItemID・本文・訳を見る)
  function shown() {
    var k = kw.toLowerCase().replace(/^\s+|\s+$/g, '');
    return T.filter(function (t) {
      if (t.virt) return false;   // Status から開いた空の会話は一覧に出さない
      if (filter === 'ai' && !t.ai) return false;
      if (!k) return true;
      var hay = [t.buyer, t.title, t.item_id].concat(t.msgs.map(function (m) { return (m.text || '') + ' ' + (m.ja || ''); })).join(' ').toLowerCase();
      return hay.indexOf(k) >= 0;
    });
  }

  // 新着の通知のボタン (メールの通知)。作りは PushUi.bell (販売データのタブのベルと共通)
  function pushButton(bar, before) {
    PushUi.bell('mail', bar, before, function (t) { if ($('lm')) $('lm').textContent = t; });
  }

  // 一覧の商品名の行の右に出す買い手の状態: 購入者 = 緑の $ / 発送済み = 灰色の車・配達完了 = 緑の車 / ポジティブフィードバックのお礼を送った人 = 緑の鉛筆。
  //   $ と車は、注文が無い・未払い・キャンセルなら出さない
  function statusIcons(t) {
    var st = t.order && t.order.stage, bought = st === 'paid' || st === 'shipped' || st === 'delivered';
    if (!bought && !t.fb) return null;
    var box = el('span', 'sti');
    if (bought) {
      var d = el('span', 'g'); d.title = '購入者';
      d.innerHTML = STI_DOLLAR;
      box.appendChild(d);
    }
    if (bought && st !== 'paid') {
      var c = el('span', st === 'delivered' ? 'g' : 'x'); c.title = st === 'delivered' ? '配達完了' : '発送済み (配達前)';
      c.innerHTML = STI_TRUCK;
      box.appendChild(c);
    }
    if (t.fb) {
      var f = el('span', 'g'); f.title = 'ポジティブフィードバック (お礼送信済み)';
      f.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/></svg>';
      box.appendChild(f);
    }
    return box;
  }

  function renderRows() {
    var box = $('rows'), list = shown();
    box.textContent = '';
    list.forEach(function (t) {
      var i = T.indexOf(t), o = t.order || {};
      var dt = el('div', 'dt'), sti = statusIcons(t);   // 1 行目の右: 買い手の状態の印 + 日付 (+ AI対応)
      if (sti) dt.appendChild(sti);
      var sb = shipBadge('', o.ship_service);
      if (sb) dt.appendChild(sb);
      dt.appendChild(el('span', null, dstr(t.last_at)));
      if (t.confirm) dt.appendChild(el('span', 'shb aig', 'AI'));       // 確認待ちの返信案あり (配送バッジと同じ小ささ)
      else if (t.ai) dt.appendChild(el('span', 'aib', 'AI対応'));
      var last = t.msgs[t.msgs.length - 1];
      var row = uRow({
        cls: (t.open ? 'open' : '') + (cur === t ? ' sel' : ''), thumb: pic(t), dot: !!t.unread, price: t.price || '', name: buyerLink(t.buyer),
        nameExtra: t.repeat && t.repeat.count >= 2 ? el('span', 'rb', 'RepeatBuyer') : null, right: dt,
        title: t.title || ('ItemID ' + t.item_id), ids: t.order ? uIds(o.order_id, o, true) : null,
        detail: (last.who === 'me' ? '↩ ' : '') + flat(last.text), onclick: function () { openThread(i, true); }
      });
      row.setAttribute('data-i', String(i));
      box.appendChild(row);
    });
    if (!list.length) box.appendChild(el('div', 'none', '該当する会話はありません'));
  }

  function bubble(t, m) {
    var mine = m.who === 'me';
    var row = el('div', 'm ' + (mine ? 'me' : 'b'));
    if (!mine) row.appendChild(el('div', 'av', ini(t.buyer)));
    var col = el('div', 'col');
    var bub = el('div', 'bub');
    if (m.ja) { bub.appendChild(el('div', 'jt', m.ja)); bub.appendChild(el('div', 'org', m.text)); } else bub.textContent = m.text;
    col.appendChild(bub);
    (m.media || []).forEach(function (u) {      // 添付の写真 (2026-10-14)
      var a = el('a', 'mimg'); a.href = u; a.target = '_blank'; a.rel = 'noopener';
      var im = el('img'); im.src = u; im.loading = 'lazy'; im.alt = '';
      a.appendChild(im); col.appendChild(a);
    });
    col.appendChild(el('div', 'tm', tstr(m.at)));
    row.appendChild(col);
    return row;
  }

  // 確認モードの AI 返信案: 自分側の未送信の吹き出し (点線) + [送る] / [自分で入力]。訳 (draft_ja) が無ければ日本語は出さない
  // CONFIRM-BUBBLE-BEGIN
  function pendingBubble(t) {
    var row = el('div', 'm me pend'), col = el('div', 'col'), bub = el('div', 'bub');
    bub.appendChild(el('div', null, t.draft));
    if (t.draft_ja) bub.appendChild(el('div', 'org', t.draft_ja));
    col.appendChild(bub);
    var bs = el('div', 'pbtn'), go = el('button', 'sd', 'Send'), own = el('button', 'f-bk', 'Typing');
    go.id = 'pSend'; own.id = 'pOwn';
    go.onclick = function () { doConfirmSend(t); };
    own.onclick = function () { $('ta').value = t.draft_ja || ''; showBox(false); fitTa($('ta')); $('ta').focus(); chk(); };
    bs.appendChild(go); bs.appendChild(own); col.appendChild(bs);
    row.appendChild(col);
    return row;
  }
  // CONFIRM-BUBBLE-END
  // [送る]: 確認モードの英文をそのまま今の送信 (Direct と同じ経路・台帳の記録) で送る
  function doConfirmSend(t) {
    var body = String(t.draft || '').trim();
    if (!body || busyF || sentF) return;
    busy(true); out('送信中…', '');
    sendBatches(t.mid, body, function (r) {
      if (cur !== t) return;
      if (r.ok) {
        t.msgs.push({ id: 'local-' + Date.now(), who: 'me', at: new Date().toISOString(), text: body });
        t.open = false; t.confirm = false;
        openThread(T.indexOf(t), false);
        out('送信しました。台帳に記録中…', 'ok');
        GSR().withSuccessHandler(function (lr) {
          if (cur === t) out((lr && lr.ok ? '送信しました。' : '送信しました (') + (lr && lr.message ? lr.message : '台帳の結果が不明です') + (lr && lr.ok ? '' : ')'), lr && lr.ok ? 'ok' : 'ng');
        }).withFailureHandler(function (e) {
          if (cur === t) out('送信しました (台帳に記録できなかった: ' + (e && e.message ? e.message : e) + ')', 'ng');
        }).repliesLedgerRecord(t.mid, body, t.draft_ja || '', TOKEN);
      } else {
        out(r.message, 'ng');
        if (!r.keepLocked) busy(false);
      }
    }, function (e) { out('失敗: ' + e.message, 'ng'); busy(false); });
  }

  function openThread(i, push) {
    if (push) closeDetails('thread');         // 一覧の行・Status から開く時は、右に開いていた Order の詳細・商品画面を閉じる (2026-10-14)
    cur = T[i];
    if (cur && cur.unread) {                 // 開いた = 既読。サーバーに覚える (端末をまたいで共通)。失敗しても会話は開く (次に読み直した時に未読へ戻る)
      cur.unread = false;
      apiCall('POST', '/api/mail-read', { mid: cur.mid }).catch(function () { });
      setMailN(T.filter(function (v) { return v.unread; }).length);
    }
    var t = cur, root = $('threadView');
    root.textContent = ''; root.className = 'thr'; en = ''; enLang = ''; jaSnap = ''; busyF = false; sentF = false; atts = []; pend = 0;
    var top = el('div', 'top'), back = el('button', 'back', '‹');
    back.onclick = function () { if (history.state && history.state.t != null) history.back(); else showList(); };
    // 名前を押すと eBay の本人ページを別タブで開く (eBay のメッセージ画面と同じ)
    var who = el('a', 'who', t.buyer); who.href = 'https://www.ebay.com/usr/' + encodeURIComponent(t.buyer); who.target = '_blank'; who.rel = 'noopener';
    top.appendChild(back); top.appendChild(who);
    if (t.ai) top.appendChild(el('span', 'aib', 'AI対応'));
    var bBl = el('button', 'tblk', 'Block'); top.appendChild(bBl);   // 名前の行の右端 (2026-10-11 に下の段から移した)
    root.appendChild(top);
    var scr = el('div', 'scr');
    // 商品カード (2026-10-14): 左 = 一覧の行と同じ写真 + その下に売価 / 右 = 商品名・ItemID (それぞれコピー付き)。カードを押すと商品画面を開く
    var card = el('div', 'card tcard');
    card.onclick = function () {
      ItemsUi.openFromThread(t, itemHooks);
    };
    var tcol = el('div', 'tcol');
    tcol.appendChild(pic(t));
    tcol.appendChild(el('div', 'tpr' + ((t.price || '').length > 9 ? ' tl' : ''), t.price || ''));
    card.appendChild(tcol);
    var ct = el('div', 'sct');
    ct.appendChild(uCopyField('ct', t.title || ('ItemID ' + t.item_id)));
    // 3 行目 (2026-10-18): 左 = Supplier (仕入先 URL を別タブで開く) / 右詰め = ItemID とコピー
    if (t.item_id) {
      var r3 = el('div', 'trow3');
      var sup = el('button', 'tsup', 'Supplier'); sup.type = 'button';
      sup.onclick = function (e) {
        e.preventDefault(); e.stopPropagation();
        var w = window.open('', '_blank');   // 先に開く (iPhone は通信の後に開くと止められる)
        var ok = function (u) { return /^https?:\/\//i.test(u || '') ? u : ''; };
        apiCall('GET', '/api/item?id=' + encodeURIComponent(t.item_id)).then(function (d) {
          return ok(d && d.item && d.item.src_url) || apiCall('GET', '/api/item-supplier?id=' + encodeURIComponent(t.item_id)).then(function (r) { return ok(r.url); });
        }, function () {
          return apiCall('GET', '/api/item-supplier?id=' + encodeURIComponent(t.item_id)).then(function (r) { return ok(r.url); });
        }).then(function (u) {
          if (u) { if (w) w.location.href = u; else window.open(u, '_blank'); return; }
          if (w) w.close(); sup.textContent = '仕入先なし'; setTimeout(function () { sup.textContent = 'Supplier'; }, 1500);
        }).catch(function () { if (w) w.close(); sup.textContent = '失敗'; setTimeout(function () { sup.textContent = 'Supplier'; }, 1500); });
      };
      r3.appendChild(sup);
      r3.appendChild(uCopyField('id', 'ItemID ' + t.item_id, String(t.item_id)));
      ct.appendChild(r3);
    }
    card.appendChild(ct);
    var fix = el('div', 'tfix');    // 画面の上に固定 (吹き出しの .scr だけがスクロールする・2026-10-14 ユーザー指示)
    fix.appendChild(card);
    root.appendChild(fix);
    var og = orderGroups(t);
    function ocard(rows) {
      var c = el('div', 'card ocard');
      rows.forEach(function (r) {
        if (r.cls === 'oh') { var h = el('div', 'oh'); h.appendChild(el('span', null, r.text)); if (r.right) h.appendChild(el('span', null, r.right)); c.appendChild(h); }
        else c.appendChild(el('div', 'ord', r.text));
      });
      return c;
    }
    if (og.main) scr.appendChild(ocard(og.main));
    if (og.past.length) {
      var pd = el('details'); pd.appendChild(el('summary', null, '過去の購入 ' + og.past.length + ' 件'));
      og.past.forEach(function (rows) { pd.appendChild(ocard(rows)); });
      scr.appendChild(pd);
    }
    var lastDay = '';
    t.msgs.forEach(function (m) {
      var d = dstr(m.at);
      if (d !== lastDay) { scr.appendChild(el('div', 'day', d)); lastDay = d; }
      scr.appendChild(bubble(t, m));
    });
    if (t.open && t.confirm && t.draft) scr.appendChild(pendingBubble(t));   // 確認待ちの AI 返信案 (未送信の吹き出し + 送る / 自分で入力)
    if (t.open && (!GAS_MODE || t.tier)) {  // 配布版は自動返信 (第 4 段 b) が入るまで t.tier が空 = 段・下書き・根拠の欄は出ない
      var info = el('div', 'info');
      var tierName = { auto: '自動返信 (試運転)', draft: '作成返信の確認', full: '完全確認' }[t.tier] || '下書きなし';
      info.appendChild(el('span', 'chip', tierName));
      if (t.intent) info.appendChild(el('span', 'chip', t.intent));
      scr.appendChild(info);
      if (t.stat === '送信中') scr.appendChild(el('div', 'fl', '送信中のまま止まっています (結果不明)。eBay の送信済みを確認し、届いていれば「済みにする」を押してください。'));
      if (t.note) scr.appendChild(el('div', 'info', t.note));
      var det = function (title, body) {
        var d = el('details'); d.appendChild(el('summary', null, title)); d.appendChild(el('div', 'ex', body)); scr.appendChild(d);
      };
      if (t.draft && !t.confirm) det('自動で作った英語の下書き (参考・送信は下の日本語の窓から)', t.draft);
      if (t.basis) det('根拠', t.basis);
      if ((t.examples || []).length) {
        det('似た過去ケース ' + t.examples.length + ' 件', t.examples.map(function (x) {
          return x.date + ' / ' + x.item_title + '\n買い手: ' + x.buyer + '\n返信: ' + x.reply;
        }).join('\n\n----\n'));
      }
    }
    if (t.resp === false) scr.appendChild(el('div', 'fl', 'eBay 側で返信できない通の可能性があります。送信は失敗することがあります。'));
    root.appendChild(scr);

    var cmp = el('div', 'cmp'), inn = el('div', 'in');
    var tools = el('div', 'tools');
    var bAi = el('button', 't-ai', 'AI'), bRt = el('button', 't-rt', 'Re:translation'), bTp = el('button', 't-tp', 'Template'), bTy = el('button', 't-ty', 'Typing'), bOf = el('button', 't-of', '5% Offer');
    // 2026-10-16 ユーザー指示: AI|Re:translation / Template|5% Offer / +(写真添付)|Typing|飛行機 (選んだ画像だけを送る)
    var bAd = el('button', 't-ad', '+'), bSp = el('button', 't-sp'), tyrow = el('div', 'tyrow');
    bAd.id = 'bAd'; bAd.title = '画像を添付 (5 枚ずつ分けて送る)'; bSp.id = 'sp'; bSp.title = '画像だけを送る'; bSp.disabled = true;
    bSp.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 3L3 10.5l7 2.5 2.5 7z"/><path d="M21 3L10 13"/></svg>';
    var fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = 'image/*'; fileIn.multiple = true; fileIn.hidden = true;
    tyrow.appendChild(bAd); tyrow.appendChild(bTy); tyrow.appendChild(bSp);
    tools.appendChild(bAi); tools.appendChild(bRt); tools.appendChild(bTp); tools.appendChild(bOf); tools.appendChild(tyrow);  // AI|Re:translation / Template|5% Offer / +|Typing|飛行機
    var thumbs = el('div', 'thumbs'); thumbs.id = 'thumbs';
    var panel = el('div', 'panel'); panel.id = 'panel'; panel.hidden = true;
    var ta = el('textarea'); ta.id = 'ta'; ta.placeholder = '日本語で書く (AI は要点だけでも・空でも可)'; ta.value = ''; ta.hidden = true; boxOpened = false; lastOpt = null;
    // 2026-10-16 ユーザー指示: Typing の窓から戻れない → 窓の右上に薄い小さな × (押すと閉じる = Cancel と同じ)
    var taw = el('div', 'taw'), tax = el('span', 'tax', '×'); tax.title = '閉じる'; tax.onclick = function () { finCancel(); };
    taw.appendChild(ta); taw.appendChild(tax);
    var warn = el('div', 'msg ng'); warn.id = 'warn';
    var msg = el('div', 'msg'); msg.id = 'msg';
    // Direct (2026-10-16 ユーザー指示): Typing の窓の文を翻訳も AI も通さずそのまま送る (送る経路は今の送信 repliesSend と同じ)
    var btns = el('div', 'btns'), tb = el('button', 'f-rg', 'Generate'), dsd = el('button', 'f-rg', 'Direct');
    tb.id = 'tb'; dsd.id = 'dSd'; btns.appendChild(tb); btns.appendChild(dsd); btns.hidden = true; btns.id = 'btns';
    if (t.open) { var db = el('button', null, 'Done'); db.id = 'db'; db.onclick = doDone; btns.appendChild(db); }
    var fin = el('div', 'fin'); fin.id = 'fin';
    var enLb = el('div', 'lb', '送られる文 (相手の言語)'); enLb.id = 'enLb';
    var enBox = el('div', 'en'); enBox.id = 'en';
    fin.appendChild(enLb); fin.appendChild(enBox); fin.appendChild(el('div', 'lb', '日本語 (削っただけなら Translate・足したなら AI)'));
    var r4 = el('div', 'r4');
    [['fRg', 'AI', doRegen, 'f-rg'], ['fTr', 'Translate', function () { doTranslate(); }, 'f-tr'], ['fBk', 'Back', finBack, 'f-bk'], ['fCx', 'Cancel', finCancel, 'f-cx']].forEach(function (d) {
      var b = el('button', d[3], d[1]); b.id = d[0]; b.onclick = d[2]; r4.appendChild(b);
    });
    var sd = el('button', 'sd', 'SendMail'); sd.id = 'fSd'; sd.onclick = doSend;
    var fo = el('button', 'sd fo', '5% Offer'); fo.id = 'fOf'; fo.onclick = finOffer;
    var r2 = el('div', 'r2'); r2.appendChild(sd); r2.appendChild(fo);
    var finBtns = el('div', 'fin'); finBtns.id = 'finBtns'; finBtns.appendChild(r4); finBtns.appendChild(r2);
    bAd.onclick = function () { fileIn.value = ''; fileIn.click(); };
    fileIn.onchange = function () { addFiles(fileIn.files); };
    bSp.onclick = sendImages;
    inn.appendChild(tools); inn.appendChild(fileIn); inn.appendChild(thumbs); inn.appendChild(panel); inn.appendChild(fin); inn.appendChild(taw); inn.appendChild(warn); inn.appendChild(msg); inn.appendChild(btns); inn.appendChild(finBtns);
    cmp.appendChild(inn); root.appendChild(cmp);
    ta.oninput = function () { fitTa(ta); chk(); }; chk();
    // Typing の窓は要点だけを書く場所 = Generate で AI (方針なし・窓の内容がそのまま依頼) に本文を作らせ、続けて翻訳
    tb.onclick = function () {
      var memo = $('ta').value.trim();
      if (!memo) { out('要点を日本語で書いてください', 'ng'); return; }
      tb.disabled = true; out('返信文を作っています…', '');
      GSR().withSuccessHandler(function (d) {
        tb.disabled = false; lastOpt = null; fitTa($('ta'), d.text); enterFin(); doTranslate();
      }).withFailureHandler(function (e) { tb.disabled = false; fail(e); }).repliesAiDraft(cur.mid, aiMemo, null, memo, TOKEN);
    };
    bRt.id = 'bRt'; bRt.onclick = doRetranslate; bAi.onclick = doAi; bTp.onclick = doTpl; bBl.onclick = doBlock; bOf.onclick = doOffer;
    dsd.onclick = doDirect; bTy.onclick = function () { $('ta').value = ''; showBox(false); $('ta').focus(); };  // Typing は完全に空の窓 (下書きを入れない)

    $('listView').hidden = true;
    // PC の 2 列表示で、開いている会話の行に枠を付ける
    Array.prototype.forEach.call(document.querySelectorAll('#listView .row'), function (r) {
      if (r.getAttribute('data-i') === String(i)) r.classList.add('sel'); else r.classList.remove('sel');
    });
    root.hidden = false;
    scr.scrollTop = scr.scrollHeight;
    if (push) { try { history.pushState({ t: i }, ''); } catch (e) { } }
  }

  var lastMid = null;   // 最後に開いていた会話 (右の端のボタンで戻る・2026-10-15)
  function lastIdx() {
    if (!lastMid) return -1;
    for (var i = 0; i < T.length; i++) if (T[i].mid === lastMid) return i;
    return -1;
  }
  function showList() {
    $('threadView').hidden = true;
    $('listView').hidden = false;
    if (cur) lastMid = cur.mid;
    cur = null;
    renderList();
    mailRefreshIfWanted();
  }

  function chk() {
    var ta = $('ta'), tb = $('tb');
    if (!ta) return;
    var empty = !ta.value.trim(), fm = $('threadView').className.indexOf('fmode') >= 0;
    tb.disabled = busyF || empty;
    if ($('db')) $('db').disabled = busyF;
    if ($('sp')) $('sp').disabled = busyF || !atts.length;
    if ($('dSd')) $('dSd').disabled = busyF || sentF || empty;
    if ($('bRt')) $('bRt').disabled = busyF;
    if ($('fRg')) {
            $('fRg').disabled = busyF || empty; $('fTr').disabled = busyF || empty;
      $('fBk').disabled = busyF || sentF; $('fCx').disabled = busyF;
      $('fSd').disabled = busyF || empty || sentF; $('fOf').disabled = busyF;
      if (sentF) { $('fRg').disabled = true; $('fTr').disabled = true; }
    }
  }
  // 入力窓を出す。初めて開く時、未対応の通なら自動下書き (日本語訳) を初期値に入れる
  function showBox(initial) {
    var ta = $('ta');
    if (!boxOpened) {
      boxOpened = true;
      if (initial !== false && cur && cur.open && !ta.value) ta.value = cur.draft_ja || '';
    }
    ta.hidden = false; $('btns').hidden = false;
    fitTa(ta);
    chk();
  }
  function fitTa(ta, v) { if (v != null) ta.value = v; ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight + 2, Math.round(window.innerHeight * 0.45)) + 'px'; }
  function out(txt, cls) { var m = $('msg'); m.textContent = txt; m.className = 'msg ' + cls; }
  function busy(v) { busyF = v; chk(); }
  function fail(e) { out('失敗: ' + (e && e.message ? e.message : e), 'ng'); busy(false); }
  function showEn() { $('en').textContent = en || '(翻訳中…)'; $('enLb').textContent = '送られる文 (' + (enLang || '相手の言語') + ')'; }
  function enterFin() {
    var ta = $('ta');
    showBox(false); en = ''; enLang = ''; jaSnap = '';
    $('threadView').className = 'thr fmode'; showEn(); fitTa(ta); out('', ''); chk();
  }
  function finBack() { $('threadView').className = 'thr'; out('', ''); chk(); }
  function finCancel() {
    if (sentF) { sentF = false; openThread(T.indexOf(cur), false); return; }  // 送信後は会話を開き直して送った文を出す
    var ta = $('ta');
    $('threadView').className = 'thr'; closePanel(); ta.value = ''; ta.hidden = true; $('btns').hidden = true; boxOpened = false;
    en = ''; enLang = ''; jaSnap = ''; out('', ''); chk(); fitTa(ta);
  }
  function closePanel() { var p = $('panel'); p.hidden = true; p.textContent = ''; }

  // ---- AI: 方針の選択肢 (選ぶだけ) → 指示の追加 → 依頼で日本語の返信文
  function doAi() {
    var p = $('panel'), t = cur;
    aiMemo = $('ta').value;
    p.hidden = false; p.textContent = '';
    p.appendChild(el('div', 'ph', 'AI が方針を考えています…'));
    GSR().withSuccessHandler(function (r) {
      var sel = null, cards = [];
      p.textContent = '';
      p.appendChild(el('div', 'ph', '方針を 1 つ選べます (もう一度押すと解除)'));
      r.options.forEach(function (o) {
        var b = el('button', 'opt');
        b.appendChild(el('b', null, o.label));
        b.appendChild(el('span', null, o.detail));
        b.onclick = function () {
          sel = (sel === o) ? null : o;
          cards.forEach(function (c) { c.b.className = 'opt' + (c.o === sel ? ' sel' : ''); });
          upd();
        };
        cards.push({ b: b, o: o });
        p.appendChild(b);
      });
      var two = el('div', 'two'), bAdd = el('button', null, 'Add'), bGo = el('button', 'go', 'Generate');
      two.appendChild(bAdd); two.appendChild(bGo); p.appendChild(two);
      var ex = el('textarea', 'exin'); ex.placeholder = sel ? '選んだ方針への追加の指示 (日本語)' : '指示を日本語で (方針なしの時は、この内容がそのまま依頼になります)'; ex.hidden = true;
      p.appendChild(ex);
      var x = el('button', 'opt cancel', 'Cancel'); x.onclick = closePanel; p.appendChild(x);
      function upd() {
        ex.placeholder = sel ? '選んだ方針への追加の指示 (日本語)' : '指示を日本語で (方針なしの時は、この内容がそのまま依頼になります)';
        bGo.disabled = !sel && !ex.value.trim();
      }
      ex.oninput = upd;
      bAdd.onclick = function () { ex.hidden = !ex.hidden; if (!ex.hidden) ex.focus(); };
      bGo.onclick = function () {
        var extra = ex.value.trim();
        if (!sel && !extra) { out('方針を選ぶか、指示を書いてください', 'ng'); return; }
        bGo.disabled = true; bAdd.disabled = true; out('返信文を作っています…', '');
        GSR().withSuccessHandler(function (d) {
          lastOpt = sel;
          lastOpt = sel; showBox(false); fitTa($('ta'), d.text); enterFin(); doTranslate();
        }).withFailureHandler(function (e) { bAdd.disabled = false; upd(); fail(e); }).repliesAiDraft(t.mid, aiMemo, sel, extra, TOKEN);
      };
      upd();
    }).withFailureHandler(function (e) { closePanel(); fail(e); }).repliesAiOptions(t.mid, aiMemo, TOKEN);
  }

  // ---- 再生成: 窓の今の日本語文 (追記・修正込み) を書き直し、続けて翻訳
  function doRegen() {
    var t = cur, ja = $('ta').value;
    busy(true); out('書き直しています…', '');
    GSR().withSuccessHandler(function (d) {
      fitTa($('ta'), d.text); doTranslate();
    }).withFailureHandler(fail).repliesAiRewrite(t.mid, ja, lastOpt, TOKEN);
  }

  // ---- Template
  function showTpl(items) {
    var p = $('panel');
    p.hidden = false; p.textContent = '';
    p.appendChild(el('div', 'ph', 'テンプレを選ぶと日本語の窓に入ります (シート「Mail」の下の返信テンプレで足し引きできます)'));
    // 種類ごとに色を変える。色はシート (Mail の A・B 列の条件付き書式) と同じ並び = 種類が出てくる順に 8 色を繰り返す
    var TPL_COLORS = ['#FDE2E2', '#FFF2CC', '#D9EAD3', '#D0E0F5', '#F9D5B8', '#E1D5F0', '#E0E0E0', '#D5F0EE'];
    var lastKind = null, kindNo = -1;
    items.forEach(function (it) {
      if (it.kind !== lastKind) { p.appendChild(el('div', 'kind', it.kind || 'その他')); lastKind = it.kind; kindNo++; }
      var b = el('button', 'opt tpl'); b.appendChild(el('b', null, it.name));
      b.style.background = TPL_COLORS[kindNo % TPL_COLORS.length];
      if (it.memo) b.appendChild(el('span', null, it.memo));   // 詳細 (Mail の I 列・地域｜特徴) を小さい字で。選ぶ前に中身が分かるように
      b.onclick = function () {
        lastOpt = null; showBox(false); fitTa($('ta'), it.body); enterFin();
        // D 列に英語の定型があれば AI を呼ばずにそのまま使う (2026-10-11)。日本語を直すと SendMail の前に訳し直す (doSend)
        if (it.en) { en = it.en; enLang = 'en'; jaSnap = $('ta').value; showEn(); chk(); out('定型の英語です (日本語を直した時・英語以外の相手には Translate)', ''); }
        else doTranslate();
      };
      p.appendChild(b);
    });
    var x = el('button', 'opt cancel', 'Cancel'); x.onclick = closePanel; p.appendChild(x);
  }
  function doTpl() {
    if (tplCache) { showTpl(tplCache); return; }
    var p = $('panel');
    p.hidden = false; p.textContent = ''; p.appendChild(el('div', 'ph', 'テンプレを読んでいます…'));
    GSR().withSuccessHandler(function (r) {
      // 種類はシートに出てくる順に並べる (行を入れ替えればページの順も変わる・2026-10-11)。同じ種類の中もシートの順
      var ord = {};
      r.items.forEach(function (it) { if (!(it.kind in ord)) ord[it.kind] = Object.keys(ord).length; });
      tplCache = r.items.slice().sort(function (a, b) { return ord[a.kind] - ord[b.kind]; });
      showTpl(tplCache);
    }).withFailureHandler(function (e) { closePanel(); fail(e); }).repliesTemplates(TOKEN);
  }

  // ---- Block (eBay API に買い手ブロックの操作が無いので eBay の画面へ)
  function doBlock() {
    var p = $('panel'), t = cur;
    p.hidden = false; p.textContent = '';
    p.appendChild(el('div', 'ph', 'eBay の API には買い手をブロックする操作が無いため、eBay の「買い手のブロック」画面で登録します。「, ' + t.buyer + '」(頭にカンマ付き) をコピーして画面を開きます。一覧の最後に貼り付けて Submit。'));
    var go = el('button', 'opt'); go.appendChild(el('b', null, 'Copy ID & Open'));
    go.onclick = function () {
      var cp = copyText(', ' + t.buyer);  // 一覧の末尾に貼るだけで区切りになるよう頭にカンマ
      window.open('https://www.ebay.com/bmgt/BuyerBlock', '_blank');
      closePanel(); out(cp ? 'ブロック画面を開きました (ID: ' + t.buyer + ')' : 'ブロック画面を開きましたが、ID をコピーできませんでした。手で入力してください: , ' + t.buyer, cp ? 'ok' : 'ng');
    };
    var x = el('button', 'opt cancel', 'Cancel'); x.onclick = closePanel;
    p.appendChild(go); p.appendChild(x);
  }

  // ---- 5% Offer (API では特定の 1 人にオファーを送れないので、金額をコピーして eBay のメッセージ画面へ。会話を開いて Send offer で貼る)
  function doOffer() {
    var p = $('panel'), t = cur;
    p.hidden = false; p.textContent = '';
    var m = String(t.price || '').match(/^(\D*?)\s*([\d,]+(?:\.\d+)?)$/);
    if (!m) { p.appendChild(el('div', 'ph', '出品価格が取れていないため 5% 引きを計算できません (価格: ' + (t.price || '空') + ')')); var x0 = el('button', 'opt cancel', 'Cancel'); x0.onclick = closePanel; p.appendChild(x0); return; }
    var c = offerCalc(t), off = c.off, cur$ = c.cur;
    p.appendChild(el('div', 'ph', 'API では特定の 1 人にオファーを送れないため、eBay のメッセージ画面で送ります。5% 引きの金額をコピーして ' + t.buyer + ' の会話を開きます。「Send offer」→ 金額に貼り付けて送信。'));
    p.appendChild(el('div', 'ph', '出品価格 ' + t.price + ' → 5% 引き ' + cur$ + (cur$.length > 1 ? ' ' : '') + off));
    var go = el('button', 'opt'); go.appendChild(el('b', null, 'Copy price & Open'));
    go.onclick = function () { closePanel(); offerOpen(t, off); };
    var x = el('button', 'opt cancel', 'Cancel'); x.onclick = closePanel;
    p.appendChild(go); p.appendChild(x);
  }

  function offerCalc(t) {
    var m = String(t.price || '').match(/^(\D*?)\s*([\d,]+(?:\.\d+)?)$/);
    if (!m) return null;
    return { off: (Math.round(parseFloat(m[2].replace(/,/g, '')) * 0.95 * 100) / 100).toFixed(2), cur: m[1] || '' };
  }
  function offerOpen(t, off) {
    var cp = copyText(off);
    var w = window.open('about:blank', '_blank');  // 非同期の後だとポップアップ扱いで止まるので先に開く
    out('会話の URL を取っています…', '');
    GSR().withSuccessHandler(function (r) {
      if (r && r.ok) {
        if (w) w.location.href = r.url;
        out(cp ? 'オファー金額 ' + off + ' をコピーして ' + t.buyer + ' の会話を開きました。Send offer で貼ってください'
          : t.buyer + ' の会話を開きましたが、金額をコピーできませんでした。Send offer に手で入れてください: ' + off, cp ? 'ok' : 'ng');
        return;
      }
      if (w) w.location.href = 'https://mesg.ebay.com/mesgweb/ViewMessages/0';
      out('会話を直接開けなかったのでメッセージ画面を開きました (' + ((r && r.message) || '') + ')。' + t.buyer + ' の会話を選んでください', 'ng');
    }).withFailureHandler(function (e) {
      if (w) w.location.href = 'https://mesg.ebay.com/mesgweb/ViewMessages/0';
      out('会話を直接開けなかったのでメッセージ画面を開きました (' + (e && e.message ? e.message : e) + ')', 'ng');
    }).repliesOfferUrl(t.mid, t.item_id, t.buyer, TOKEN);
  }
  // 商品画面の Offer: 入力した額をコピーして eBay の会話を開き、戻ってきたら送れるように「オファーを送りました」の文を用意する (送信は SendMail を押した時だけ)
  function itemOffer(t, amt, curName) {
    var price = (curName ? curName + ' ' : '') + Number(amt).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    lastOpt = null; showBox(false);
    fitTa($('ta'), 'お客様へ\n\nお問い合わせありがとうございます。\n\n' + price + ' でオファーをお送りしました。eBay でご確認のうえ、有効期限内にお手続きいただければ幸いです。\n\nよろしくお願いいたします。\n\n敬具\nSimpleLifeDesignLab');
    enterFin();
    en = 'Dear Valued Customer,\n\nThank you for your inquiry.\n\nWe have sent you an offer of ' + price + '. Please check it on eBay and complete your purchase before the offer expires.\n\nThank you very much.\n\nBest regards,\nSimpleLifeDesignLab';
    enLang = 'en'; jaSnap = $('ta').value; showEn(); chk();
    offerOpen(t, Number(amt).toFixed(2));
  }
  var itemHooks = { offer: itemOffer };
  // 最終画面の 5% Offer: パネルを出さずに金額コピー+会話を開く (SendMail の後にそのまま押す想定)
  function finOffer() {
    var c = offerCalc(cur);
    if (!c) { out('出品価格が取れていないため 5% 引きを計算できません (価格: ' + (cur.price || '空') + ')', 'ng'); return; }
    offerOpen(cur, c.off);
  }

  // ---- 画像の添付 (最大 30 枚・送る時に 5 枚ずつ): 長辺 1600px・JPEG 0.85 に縮めて base64 で持つ
  function renderThumbs() {
    var box = $('thumbs');
    if (!box) return;
    box.textContent = '';
    atts.forEach(function (a, k) {
      var w = el('div', 'th'), im = el('img'), x = el('button', null, '×');
      im.src = a.url; im.alt = '';
      x.title = '外す';
      x.onclick = function () { atts.splice(k, 1); renderThumbs(); out('', ''); };
      w.appendChild(im); w.appendChild(x); box.appendChild(w);
    });
    chk();
  }
  function shrink(file, cb) {
    var fr = new FileReader();
    fr.onerror = function () { cb(null); };
    fr.onload = function () {
      var im = new Image();
      im.onerror = function () { cb(null); };
      im.onload = function () {
        var w = im.naturalWidth, h = im.naturalHeight, k = Math.min(1, 1600 / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
        var g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);  // 透過 PNG を黒くしない
        g.drawImage(im, 0, 0, c.width, c.height);
        var u = c.toDataURL('image/jpeg', 0.85);
        cb({ url: u, data: u.split(',')[1], mime: 'image/jpeg' });
      };
      im.src = fr.result;
    };
    fr.readAsDataURL(file);
  }
  function addFiles(files) {
    var tk = cur, room = 30 - atts.length - pend, list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    if (room <= 0) { out('画像は 30 枚までです', 'ng'); return; }
    var over = list.length > room;
    list.slice(0, room).forEach(function (f) {
      pend++;
      shrink(f, function (r) {
        pend--;
        if (cur !== tk) return;  // 読み込み中に別の会話へ移った
        if (r) atts.push(r); else out('画像を読めませんでした: ' + f.name, 'ng');
        renderThumbs();
      });
    });
    if (over) out('画像は 30 枚までです (超えた分は追加していません)', 'ng'); else out('', '');
  }
  // eBay のメッセージは 1 通 5 枚まで → 5 枚ずつ続けて送る (2026-10-17 ユーザー指示)。本文は 1 通目に付け、2 通目からは画像だけ
  //   (本文はサーバーが「[Attachment] N photos」を入れる)。途中で止まったら送れた分を添付から外す = もう一度押せば残りだけ送る
  function sendBatches(mid, body, ok, ng) {
    var all = atts.slice(), done = 0;
    function trim() { if (done > 0) { atts = all.slice(done); renderThumbs(); } }
    function next() {
      var part = all.slice(done, done + 5);
      GSR().withSuccessHandler(function (r) {
        if (!r.ok) {
          if (done > 0) r = Object.assign({}, r, { message: (body ? '本文と ' : '') + done + ' 枚は送信済み。残り ' + (all.length - done) + ' 枚で止まりました: ' + r.message });
          trim(); ok(r); return;
        }
        done += part.length;
        if (done < all.length) { out('画像を送信中… (' + done + ' / ' + all.length + ' 枚)', ''); next(); return; }
        ok(r);
      }).withFailureHandler(function (e) { trim(); ng(e); })
        .repliesSend(mid, done ? '' : body, TOKEN, part.map(function (a) { return { mime: a.mime, data: a.data }; }));
    }
    next();
  }
  // 飛行機 = 選んだ画像だけを送る。eBay API は本文 (Body) が必須なので、サーバーが「[Attachment] N photos / Sent: 日時 JST」を本文に入れる
  function sendImages() {
    if (!atts.length || busyF) return;
    var t = cur;
    busy(true); out('画像を送信中…', '');
    sendBatches(t.mid, '', function (r) {
      if (r.ok) { atts = []; renderThumbs(); out('画像を送信しました', 'ok'); busy(false); return; }
      out(r.message, 'ng');
      if (!r.keepLocked) busy(false);
    }, fail);
  }

  // ---- 翻訳 (窓の日本語をそのまま相手の言語へ) → 英語を表示 → 送る
  function doTranslate(note) {
    var t = cur, ja = $('ta').value;
    busy(true); out('訳しています…', ''); $('en').textContent = '(翻訳中…)';
    GSR().withSuccessHandler(function (r) {
      if (!r.ok) { out(r.message, 'ng'); showEn(); busy(false); return; }
      en = r.text; enLang = r.lang || ''; jaSnap = ja; showEn(); busy(false);
      if (r.note) out((note ? note + ' / ' : '') + r.note, 'ng'); else out(note || '', note ? 'ok' : '');
    }).withFailureHandler(function (e) { showEn(); fail(e); }).repliesTranslate(t.mid, ja, TOKEN);
  }
  function doSend() {
    var t = cur, body = en;
    if (!$('ta').value.trim()) return;
    if (!body.trim() || jaSnap !== $('ta').value) { doTranslate('英語を更新しました。確認して SendMail を押してください'); return; }
    busy(true); out('送信中…', '');
    sendBatches(t.mid, body, function (r) {
      if (r.ok) {
        t.msgs.push({ id: 'local-' + Date.now(), who: 'me', at: new Date().toISOString(), text: body.trim() });
        t.open = false; sentF = true; atts = []; renderThumbs(); busy(false);
        out('送信しました。台帳に記録中… 続けて 5% Offer を押せます (戻るは Cancel)', 'ok');
        GSR().withSuccessHandler(function (lr) {
          out((lr && lr.ok ? '送信しました。' : '送信しました (') + (lr && lr.message ? lr.message : '台帳の結果が不明です') + (lr && lr.ok ? '' : ')'), lr && lr.ok ? 'ok' : 'ng');
        }).withFailureHandler(function (e) {
          out('送信しました (台帳に記録できなかった: ' + (e && e.message ? e.message : e) + ')', 'ng');
        }).repliesLedgerRecord(t.mid, body, jaSnap, TOKEN);
      } else {
        out(r.message, 'ng');
        if (!r.keepLocked) busy(false);
      }
    }, function (e) { out('失敗: ' + e.message, 'ng'); busy(false); });
  }
  // Direct Send Chat: 貼った英語を翻訳せずそのまま送る (確認画面なし)。送る経路・台帳の記録・送信後に会話を開き直す動きは doSend と同じ
  function doDirect() {
    var t = cur, body = $('ta').value.trim();
    if (!body || busyF || sentF) return;
    busy(true); out('送信中…', '');
    sendBatches(t.mid, body, function (r) {
      if (cur !== t) return;
      if (r.ok) {
        t.msgs.push({ id: 'local-' + Date.now(), who: 'me', at: new Date().toISOString(), text: body });
        t.open = false;
        openThread(T.indexOf(t), false);      // 会話を開き直して送った文を出す (入力欄は新しくなり、busy・sentF・添付も戻る)
        out('送信しました。台帳に記録中…', 'ok');
        GSR().withSuccessHandler(function (lr) {
          if (cur === t) out((lr && lr.ok ? '送信しました。' : '送信しました (') + (lr && lr.message ? lr.message : '台帳の結果が不明です') + (lr && lr.ok ? '' : ')'), lr && lr.ok ? 'ok' : 'ng');
        }).withFailureHandler(function (e) {
          if (cur === t) out('送信しました (台帳に記録できなかった: ' + (e && e.message ? e.message : e) + ')', 'ng');
        }).repliesLedgerRecord(t.mid, body, '', TOKEN);
      } else {
        out(r.message, 'ng');
        if (!r.keepLocked) busy(false);
      }
    }, function (e) { out('失敗: ' + e.message, 'ng'); busy(false); });
  }
  // Re:translation (2026-10-16 ユーザー指示): 開いている会話の訳だけを Sonnet で訳し直し、今の画面の吹き出しに反映する
  function doRetranslate() {
    var t = cur;
    if (busyF) return;
    busy(true); out('訳し直しています… (数十秒かかることがあります)', '');
    GSR().withSuccessHandler(function (r) {
      busy(false);                                // 押せないままにしない (別の会話へ移っていても戻す)
      (t.msgs || []).forEach(function (m) { if (r.ok && r.ja && r.ja[m.id]) m.ja = r.ja[m.id]; });
      if (cur !== t) return;
      if (!r.ok) { out(r.message, 'ng'); return; }
      openThread(T.indexOf(t), false);           // 開き直して新しい日本語を出す (入力欄は新しくなる)
      out(r.message, 'ok');
    }).withFailureHandler(fail).repliesRetranslate(t.mid, TOKEN);
  }
  function doDone() {
    var t = cur;
    if (!confirm('返信せず「済み」にします (自分で eBay から返した時用)。よろしいですか?')) return;
    busy(true);
    GSR().withSuccessHandler(function (r) {
      out(r.message, r.ok ? 'ok' : 'ng');
      if (r.ok) { t.open = false; setTimeout(function () { openThread(T.indexOf(t), false); }, 600); } else busy(false);
    }).withFailureHandler(fail).repliesMarkDone(t.mid, TOKEN);
  }

  window.addEventListener('popstate', function () { if (cur) showList(); });
  renderList();
  // トラブルタブから会話を開く (mid で探して既存の openThread を呼ぶ)
  function openMid(mid) {
    var k = -1;
    T.forEach(function (t, i) { if (k < 0 && mid && String(t.mid) === String(mid)) k = i; });
    if (k < 0) return false;
    openThread(k, true);
    return true;
  }
  // Thank you / 配送完了の通知から来た時: その買い手の会話を開く (2026-10-14)。送った文の取込が終わる前なら、
  // 一覧の読み直しで出てきた時に開く (2 分待って出なければやめる = Chat の一覧のまま)
  var wantBuyer = '';
  function openWanted() {
    var k = -1;
    T.forEach(function (t, i) { if (k < 0 && t.buyer === wantBuyer) k = i; });
    if (k < 0) return;
    wantBuyer = '';
    openThread(k, true);
  }
  function openBuyer(b) {
    wantBuyer = b || '';
    if (!wantBuyer) return;
    setTimeout(function () { wantBuyer = ''; }, 120000);
    openWanted();
  }
  // Status の詳細から: mid → 無ければ 買い手 + ItemID → 無ければ同じ買い手の会話 (自分から送っただけの会話 "to:" も含む) を探す (2026-10-14)
  function findFor(q) {
    var k = -1, b = String(q.buyer || '').toLowerCase();
    T.forEach(function (t, i) { if (k < 0 && q.mid && String(t.mid) === String(q.mid)) k = i; });
    T.forEach(function (t, i) { if (k < 0 && b && String(t.buyer).toLowerCase() === b && q.item_id && String(t.item_id) === String(q.item_id)) k = i; });
    T.forEach(function (t, i) { if (k < 0 && b && String(t.buyer).toLowerCase() === b) k = i; });
    return k;
  }
  // 会話を開いて、text があれば Direct の窓 (英語をそのまま送る窓) に入れる。送信は押さない
  // 会話がまだ無い買い手は、Status の行の注文から「空の会話」(自分から送るだけの "to:" の会話と同じ形) を作って開く。
  // 送るのはサーバーの "to:" の経路 (注文の控えに買い手と ItemID が実在する時だけ通る)。次の取り込みで普通の会話として一覧に出る
  function canVirt(q) { return !!(q.buyer && /^\d{9,}$/.test(String(q.item_id || ''))); }
  function virtThread(q) {
    return { mid: 'to:' + String(q.buyer).toLowerCase() + '|' + q.item_id, buyer: q.buyer, item_id: String(q.item_id), title: q.title || '', pic: q.pic || '',
      price: q.price || '', last_at: new Date().toISOString(), open: false, unread: false, msgs: [], order: q.order || null, virt: true };
  }
  function openDraft(q, text) {
    var k = findFor(q);
    if (k < 0) {
      if (!canVirt(q)) return false;
      T.push(virtThread(q)); k = T.length - 1;
    }
    openThread(k, true);
    if (text) {
      var ta = $('ta');
      if (ta) { ta.value = text; showBox(false); chk(); ta.focus(); }
    }
    return true;
  }
  function closeThread() { if (cur) showList(); }   // 上のタブを押した時に開いている会話を閉じる (会話の「戻る」と同じ showList)
  return { canReturn: function () { return !cur && lastIdx() >= 0; }, returnLast: function () { var i = lastIdx(); if (i >= 0) openThread(i, true); }, apply: applyData, idle: function () { return !cur && !busyF; }, openMid: openMid, openBuyer: openBuyer, closeThread: closeThread, hasThread: function (q) { return findFor(q) >= 0 || canVirt(q); }, openDraft: openDraft };
}

// ================================================================== 通知のベル (メール / 販売データ・2026-10-13)
// ブラウザの購読は端末に 1 つ。サーバーが端末ごとに「メールの通知」「販売データの通知」「Thank you 送信の通知」「配送完了の通知」の入切を持つ (/api/push-kind)。
// 販売データのタブには 3 つ並ぶ (ベル = 販売データ・ハート = Thank you 送信・箱 = 配送完了)。
// 入 = 塗りつぶしのベル・切 = 線だけのベル。押すと切り替わり、結果を say に 1 行出す。両方切になったらサーバーが購読を消し、ここでブラウザの購読も外す。
var PushUi = (function () {
  var KIND_NAME = { mail: 'メールの通知', sales: '販売データの通知', thanks: 'Thank you 送信の通知', ship: '配送完了の通知', late: '未配達の通知' };
  var BELL = '<path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4z"@/><path d="M10 21h4"/>';
  var KIND_ICON = { mail: BELL, sales: BELL, late: BELL, thanks: '<path d="M12 20s-7-4.4-7-9.5A4 4 0 0 1 12 8a4 4 0 0 1 7 2.5C19 15.6 12 20 12 20z"@/>',
    ship: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"@/><path d="M4 8l8 4 8-4M12 12v8"/>' };   // @ = 入の時に塗る場所
  var S = { sub: null, kinds: { mail: false, sales: false, thanks: false, ship: false, late: false }, loaded: null }, draws = [];
  function supported() { return GAS_MODE || 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function msg(e) { return e && e.message ? e.message : String(e); }
  function redraw() { draws = draws.filter(function (d) { return d.btn.isConnected; }); draws.forEach(function (d) { d.draw(); }); }
  function load() {
    if (S.loaded) return S.loaded;                    // 同じ約束を返す (ベルを呼んだ順に並ぶ)
    if (GAS_MODE) return S.loaded = apiCall('GET', '/api/bark-kinds').then(function (r) { S.sub = true; S.kinds = r.kinds; });   // 配布版: ブラウザの購読は無い。GAS の Bark の種類ごとの入切 (mail / sales)
    return S.loaded = navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      S.sub = sub;
      return sub ? apiCall('POST', '/api/push-state', { endpoint: sub.endpoint }).then(function (r) { S.kinds = r.kinds; }) : null;
    });
  }
  function keyBytes(k) {
    var raw = atob(k.replace(/-/g, '+').replace(/_/g, '/')), key = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) key[i] = raw.charCodeAt(i);
    return key;
  }
  function turnOn(kind) {
    if (GAS_MODE) return apiCall('POST', '/api/bark-kind', { kind: kind, on: true }).then(function (r) { S.kinds = r.kinds; });
    var made = null;
    return Notification.requestPermission().then(function (p) {
      if (p !== 'granted') throw new Error('通知が許可されませんでした');
      if (S.sub) return S.sub;
      return apiCall('GET', '/api/push-key').then(function (k) {
        return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(k.key) }); });
      }).then(function (s) { made = s; return s; });
    }).then(function (sub) {
      return apiCall('POST', '/api/push-kind', { subscription: sub.toJSON(), kind: kind, on: true }).then(function (r) { S.sub = sub; S.kinds = r.kinds; });
    }).catch(function (e) {
      if (made) made.unsubscribe().catch(function () { });   // サーバーに登録できなかった購読は残さない (残すと有効に見えて通知が来ない)
      throw e;
    });
  }
  function turnOff(kind) {
    if (GAS_MODE) return apiCall('POST', '/api/bark-kind', { kind: kind, on: false }).then(function (r) { S.kinds = r.kinds; });
    var sub = S.sub;
    return apiCall('POST', '/api/push-kind', { subscription: sub.toJSON(), kind: kind, on: false }).then(function (r) {
      S.kinds = r.kinds;
      if (r.dropped) { S.sub = null; return sub.unsubscribe(); }
    });
  }
  function bell(kind, bar, before, say) {
    if (!supported()) return;
    load().then(function () {
      if (!bar.isConnected || bar.querySelector('.bPush[data-kind="' + kind + '"]')) return;
      var b = document.createElement('button'), name = KIND_NAME[kind];
      b.className = 'bPush';
      b.setAttribute('data-kind', kind);
      function on() { return !!(S.sub && S.kinds[kind]); }
      function draw() {
        b.title = name + (on() ? 'を止める' : 'を有効にする');
        b.innerHTML = '<svg viewBox="0 0 24 24">' + KIND_ICON[kind].replace('@', on() ? ' fill="currentColor"' : '') + '</svg>';
      }
      b.onclick = function () {
        var was = on();
        b.disabled = true;
        (was ? turnOff(kind) : turnOn(kind)).then(function () {
          say(name + (was ? 'を止めました' : 'を有効にしました'));
        }, function (e) {
          say(name + (was ? 'を止められません: ' : 'を有効にできません: ') + msg(e));
        }).then(function () { b.disabled = false; redraw(); });
      };
      draws.push({ btn: b, draw: draw });
      draw();
      bar.insertBefore(b, before || null);
    }).catch(function () { /* 通知に対応していないだけ。ボタンを出さない */ });
  }
  return { bell: bell };
})();

// ================================================================== 商品タブ (利益計算表の検索 + オファー計算・2026-10-11)
// メールの画面 (startClient) とは独立。データは /api/items 系 (読むだけ。シートへは何も書かない)。
// タブの下にいつも置く検索窓 (ItemsUi.attach・メール / 販売データ / ステータスのどれを開いていても出る) と、会話の商品カードの「商品」ボタン (ItemsUi.openFromThread) から使う。
// コピー: 押した瞬間にその場で済ませる (execCommand)。navigator.clipboard は結果が後から返るので、
// 直後に別の画面を開くと iPhone のホーム画面アプリではコピーされないまま切り替わる (2026-10-12)。戻り値 = コピーできたか
function copyText(s) {
  var ok = false, ta = document.createElement('textarea');
  ta.value = s; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  document.body.appendChild(ta);
  try { ta.focus(); ta.select(); ta.setSelectionRange(0, s.length); ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  if (!ok && navigator.clipboard) { try { navigator.clipboard.writeText(s); } catch (e) { } }   // こちらは成否が分からないので ok は false のまま (画面に額を出して手で打てるようにする)
  return ok;
}

// 買い手の名前: 押すと eBay の本人ページを別タブで開く (会話の画面の名前と同じリンク)。行を開く動きには伝えない。名前が空・'-' ならただの文字
function buyerLink(name) {
  var n = String(name || '').trim();
  if (!n || n === '-') { var sp = document.createElement('span'); sp.textContent = n || '-'; return sp; }
  var a = document.createElement('a');
  a.className = 'blk'; a.textContent = n; a.target = '_blank'; a.rel = 'noopener';
  a.href = 'https://www.ebay.com/usr/' + encodeURIComponent(n);
  a.onclick = function (e) { e.stopPropagation(); };
  return a;
}

// 買い手の状態の印 (メールの一覧とステータスのタブで共用)
var STI_DOLLAR = '<svg viewBox="0 0 24 24"><path d="M12 3v18M16.5 7.5c-.8-1.3-2.4-2-4.5-2-2.6 0-4.3 1.2-4.3 3.1 0 4.4 9 2 9 6.6 0 2-1.9 3.3-4.7 3.3-2.3 0-4.1-.8-5-2.3"/></svg>';
var STI_TRUCK = '<svg viewBox="0 0 24 24"><path d="M2 6h11v10H2zM13 9h4l4 4v3h-8z"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg>';

// ---- 3 つのタブ共通の一覧の行と部品 (2026-10-14)。形は旧ステータスの行: 左 = 写真 (右上に未読の緑の点) とその下の売価 / 右 = 1 行目 買い手 + 右寄せの小さい字・2 行目 商品名・3 行目 OrderID + 追跡・4 行目 (売価と同じ高さ)
function uel(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
// eBay を別の画面で開くリンク (行を押した時の動きには伝えない)
function uLink(node, url) {
  var a = uel('a', 'tlk');
  a.href = url; a.target = '_blank'; a.rel = 'noopener';
  a.onclick = function (e) { e.stopPropagation(); };
  a.appendChild(node);
  return a;
}
function uOrderUrl(id) { return id ? 'https://www.ebay.com/sh/ord/details?orderid=' + encodeURIComponent(id) : ''; }
// Order の 4 行目 (Status で 4 行目が空の行にも出す・2026-10-14): 利益 (太字) / (確定なら見積りとの差額) / トラック + 送料。ラベルは付けない。
// 発送して集計シートの P に追跡番号が入ると送料は集計の T (確定送料)、利益は集計の Y (最終損益) になるので、その時は利益・トラック・送料を緑にする
function uNums(it) {
  var w = uel('span', 'unum');
  function add(cls, txt, html) {
    if (!txt) return;
    if (w.firstChild) w.appendChild(document.createTextNode(' '));
    var s = uel('span', cls, html ? null : txt);
    if (html) s.innerHTML = html + uYen(it.out_ship);
    w.appendChild(s);
  }
  add('upf' + (it.profit < 0 ? ' ng' : it.tracked ? ' ok' : ''), uYen(it.profit));   // 利益は太字。マイナスは赤
  if (it.tracked && it.profit != null && it.profit_est != null) {                   // 確定した利益と見積り (販売 Q) の差額。+ は緑、- は赤
    var d = Math.round(it.profit - it.profit_est);
    add('udf' + (d < 0 ? ' ng' : ' ok'), '(' + (d < 0 ? '-' : '+') + uYen(Math.abs(d)) + ')');
  }
  add('ush' + (it.tracked ? ' ok' : ''), uYen(it.out_ship), STI_TRUCK);
  return w.firstChild ? w : null;
}
// キャンセル・返品・一部返金の行の 4 行目 (2026-10-20 ユーザー指示): 配送の印と同じ大きさの印 + 実際の損益 (集計の Y = 仕入れ・返金込み・+/-)。
//   Cancel = 黒 (数字は出さない) / Return = 赤 / Partial = 濃い青。損益は集計に載った注文 (tracked) だけ
var TROUBLE_BADGE = { cancel: ['Cancel', 'cxl'], 'return': ['Return', 'ret'], partial: ['Partial', 'prt'] };
function uTrouble(it) {
  var t = TROUBLE_BADGE[it.trouble], w = uel('span', 'unum');
  w.appendChild(uel('span', 'shb ' + t[1], t[0]));
  if (it.trouble !== 'cancel' && it.tracked && it.profit != null) {
    w.appendChild(document.createTextNode(' '));
    w.appendChild(uel('span', 'upf ' + (it.profit < 0 ? 'ng' : 'ok'), (it.profit < 0 ? '' : '+') + uYen(it.profit)));
  }
  return w;
}
// Order の 3 行目の OrderID の後ろ: 仕入先 / 仕入額 / 仕入れ時送料 (ラベルなし・2026-10-14)
function uSupply(it, ids) {
  [it.shop || '', uYen(it.cost), uYen(it.ship)].forEach(function (t) { if (t) ids.appendChild(uel('span', null, t)); });
}
function uYen(n) { return n == null || isNaN(n) ? '' : (n < 0 ? '-' : '') + '¥' + Math.round(Math.abs(n)).toLocaleString('ja-JP'); }
// 3 行目: OrderID (linked = eBay を開く) + キャリア 追跡番号 (文字のまま) + コピー。o = 追跡の入った注文 (無ければ {})。何も無くても高さは残す (4 行目を売価と揃えるため)
// numOnly = コピーは追跡番号だけ (Status の一覧・2026-10-15)
function uIds(oid, o, linked, numOnly) {
  var l3 = uel('div', 'tids');
  if (oid) l3.appendChild(linked ? uLink(uel('span', null, oid), uOrderUrl(oid)) : uel('span', null, oid));
  if (o && o.tracking) {
    var trk = [o.carrier, o.tracking].filter(Boolean).join(' '), tks = uel('span', 'ttk', trk);
    l3.appendChild(tks);
    var cp = uel('button', 'tcp');
    cp.type = 'button'; cp.title = numOnly ? '追跡番号をコピー' : 'キャリアと追跡番号をコピー';
    cp.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
    cp.onclick = function (e) {
      e.stopPropagation();
      var ok = copyText(numOnly ? o.tracking : trk);                // 「DHL 0000000」の形でコピー (numOnly は番号だけ)。押した場所に結果を 1.5 秒出す
      cp.classList.add(ok ? 'ok' : 'ng'); tks.classList.add(ok ? 'ok' : 'ng');
      tks.textContent = ok ? 'コピーしました' : 'コピーできませんでした';
      setTimeout(function () { cp.classList.remove('ok', 'ng'); tks.classList.remove('ok', 'ng'); tks.textContent = trk; }, 1500);
    };
    l3.appendChild(cp);
  }
  return l3;
}
// 商品名・ItemID の横のコピー (2026-10-14): 文字 + コピーのアイコン。押すとその文字をコピーし、押した場所に 1.5 秒「コピーしました」を出す (Status の追跡番号と同じ)。行・カードの動きには伝えない
// Status の詳細の「追跡を調べる」のボタン (2026-10-15): [名前, 番号 → 開く URL, 番号がある時はアプリの中に経過を出すか (OC)]。DHL・FedEx・UPS は 2026-10-15 に実際の番号で開くのを確認
var TRACK_SITES = [
  ['FedEx', function (n) { return n ? 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(n) : 'https://www.fedex.com/ja-jp/tracking.html'; }],
  ['DHL', function (n) { return 'https://www.dhl.com/jp-ja/home/tracking.html' + (n ? '?submit=1&tracking-id=' + encodeURIComponent(n) : ''); }],
  ['UPS', function (n) { return 'https://www.ups.com/track?loc=ja_JP' + (n ? '&tracknum=' + encodeURIComponent(n) : '') + '&requester=ST/'; }],
  ['OC', function () { return 'https://www.orangeconnex.jp/tracking'; }, true]
];

function uCopyField(cls, text, val) {
  var w = uel('div', 'cprow'), tx = uel('div', cls, text), cp = uel('button', 'tcp');
  cp.type = 'button'; cp.title = 'コピー';
  cp.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
  cp.onclick = function (e) {
    e.preventDefault(); e.stopPropagation();
    var ok = copyText(val == null ? text : val);
    cp.classList.add(ok ? 'ok' : 'ng'); tx.classList.add(ok ? 'ok' : 'ng');
    tx.textContent = ok ? 'コピーしました' : 'コピーできませんでした';
    setTimeout(function () { cp.classList.remove('ok', 'ng'); tx.classList.remove('ok', 'ng'); tx.textContent = text; }, 1500);
  };
  w.appendChild(tx); w.appendChild(cp);
  return w;
}
// DUE-BEGIN
// 発送期日 (Order の一覧 4 行目の右端): iso = eBay の HandleByTime。日本時間の日付で「発送期日 10月21日 (+7)」。(+N) = 今日から期日までの残り日数・3 日以下 (0・負を含む) は red
function ordDue(iso, now) {
  var t = Date.parse(iso || '');
  if (isNaN(t)) return null;
  var JST = 9 * 3600000, DAY = 86400000;
  var d = new Date(t + JST), today = Math.floor(((now == null ? Date.now() : now) + JST) / DAY), due = Math.floor((t + JST) / DAY);
  var n = due - today;
  return { text: '発送期日 ' + (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日 (' + (n > 0 ? '+' : '') + n + ')', red: n <= 3 };
}
// DUE-END
// o: {cls, thumb, dot, price, name (node), nameExtra (node・買い手の右に置く小さい印), right (1 行目の右 = .dt の node), title (node か文字), ids (3 行目の node), detail (4 行目の文字), onclick}
// 買い手が選んだ配送の小さな印 (2026-10-19 ユーザー指示: Order と Chat の一覧の 1 行目・日付の前)。
//   Expedited = 緑 / Economy = オレンジに黒の文字 / Other = 水色 (2026-10-19 ユーザー指示で色を変更・Other も出す)
function shipBadge(cls, raw) {
  var c = cls || (raw ? (/expedited/i.test(raw) ? 'Expedited' : (/economy/i.test(raw) ? 'Economy' : 'Other')) : '');
  if (!c) return null;
  var b = uel('span', 'shb ' + (c === 'Expedited' ? 'exp' : (c === 'Economy' ? 'eco' : 'oth')), c);
  b.title = '買い手が選んだ配送: ' + (raw || c);
  return b;
}
function uRow(o) {
  var row = uel('div', 'row urow' + (o.cls ? ' ' + o.cls : '')), lc = uel('div', 'tcol'), pw = uel('div', 'pw');
  pw.appendChild(o.thumb);
  if (o.dot) pw.appendChild(uel('span', 'udot'));
  lc.appendChild(pw);
  lc.appendChild(uel('div', 'tpr' + ((o.price || '').length > 9 ? ' tl' : ''), o.price || ''));   // AUD 1,063.33 のように長い売価は小さくして 56px に収める
  row.appendChild(lc);
  var rt = uel('div', 'rt'), l1 = uel('div', 'l1'), nmb = uel('div', 'nm'), l2 = uel('div', 'l2');
  nmb.appendChild(o.name); l1.appendChild(nmb);
  if (o.nameExtra) l1.appendChild(o.nameExtra);
  l1.appendChild(o.right);
  rt.appendChild(l1);
  if (o.title && o.title.nodeType) l2.appendChild(o.title); else l2.textContent = o.title || '';
  rt.appendChild(l2);
  rt.appendChild(o.ids || uel('div', 'tids'));
  var l4 = uel('div', 'tdt');
  if (o.due) {                                            // Order の一覧だけ: 4 行目の右端に発送期日
    l4.classList.add('hasdue');
    var dl = uel('span', 'udl');
    if (o.detail && o.detail.nodeType) dl.appendChild(o.detail); else dl.textContent = o.detail || '';
    l4.appendChild(dl);
    l4.appendChild(uel('span', 'udue' + (o.due.red ? ' ng' : ''), o.due.text));
  } else if (o.detail && o.detail.nodeType) l4.appendChild(o.detail); else l4.textContent = o.detail || '';
  rt.appendChild(l4);
  row.appendChild(rt);
  row._pw = pw;
  if (o.onclick) row.onclick = o.onclick;
  return row;
}
// 丸い更新ボタン (3 つのタブのボタンの列の一番右・2026-10-14)
function uRefreshBtn(fn) {
  var b = uel('button');
  b.type = 'button'; b.title = '更新'; b.setAttribute('aria-label', '更新');
  b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>';
  b.onclick = fn;
  return b;
}

// ListingTool の横パネルの中に iframe として入っている時 (?embed=panel)。2026-10-15 ユーザー指示:
// ・タブの 2 行目の右端に Listing を出す (スマホ・普通のブラウザは今までどおり空)
// ・パネルの上の枠とタブを同期するため、親 (拡張機能のページ) と postMessage で話す
// 親の origin は location.ancestorOrigins (Chrome) から取る。chrome-extension:// 以外・取れない時は送らない・受けない (* は使わない)
var EMBED = false, PARENT_ORIGIN = '';
try {
  EMBED = new URLSearchParams(location.search).get('embed') === 'panel' && window.parent !== window;
  if (EMBED) {
    PARENT_ORIGIN = (location.ancestorOrigins && location.ancestorOrigins.length) ? location.ancestorOrigins[0] : '';
    if (!PARENT_ORIGIN) { try { PARENT_ORIGIN = new URL(document.referrer).origin; } catch (e) { } }
    if (!/^chrome-extension:\/\//.test(PARENT_ORIGIN)) PARENT_ORIGIN = '';
    document.body.classList.add('embed');
    if (new URLSearchParams(location.search).get('ai') === '1') document.body.classList.add('embed-ai');
  }
} catch (e) { EMBED = false; }
function toPanel(msg) {
  if (!EMBED || !PARENT_ORIGIN) return;
  try { window.parent.postMessage(msg, PARENT_ORIGIN); } catch (e) { /* 親が居ない。画面は動く */ }
}
if (EMBED) {
  window.addEventListener('message', function (e) {   // 親が上のタブを押した → 再読み込みなしで切り替える
    if (e.source !== window.parent || e.origin !== PARENT_ORIGIN || !e.data) return;
    if (e.data.type === 'mt-ai') document.body.classList.toggle('embed-ai', !!e.data.on);   // 2 行目を出すか (親の Settings の Claude キーの有無)
    if (e.data.type === 'mt-tab' &&['mail', 'sales', 'troubles', 'summary'].indexOf(e.data.tab) >= 0 && e.data.tab !== curTab) showTab(e.data.tab);   // Listing から同じタブへ戻った時は開き直さない (会話を閉じない・2026-10-20)
  });
  document.addEventListener('DOMContentLoaded', function () {
    toPanel({ type: 'mt-ready' });                     // 親はこれが来るまでを「つながらない」の判定に使う
    toPanel({ type: 'mt-status-count', n: troubleN });
  });
}

// いま開いているタブ。segBar と showTab が読み書きする
var curTab = 'mail';
// タブの文字の横の数とアイコンの数字 (2026-10-14)。メール = 未読の会話の数 (まだ開いていない会話。開くと減る)。販売データ = 開いていない間に届いた知らせの数 (タブを開くと消える)。
// アイコンの数字は、画面を開いている間は未読の数だけ (閉じている間に届いた知らせは通知が足す = sw.js)
var mailN = 0, salesN = 0;
var SEG_NAME = { mail: 'Chat', sales: 'Order', troubles: 'Status', summary: 'Summary' };   // タブの文字 (2026-10-14 に メール / 販売データ / ステータス から替えた)
function segLabel(seg, n) {
  Array.prototype.forEach.call(document.querySelectorAll('.sg[data-seg="' + seg + '"]'), function (b) { b.textContent = SEG_NAME[seg] + (n ? ' ' + n : ''); });
}
function setMailN(n) {
  mailN = n;
  segLabel('mail', n);
  if (navigator.setAppBadge) (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(function () { /* 数字を付けられない端末。画面は動く */ });
}
function setSalesN(n) { salesN = n; segLabel('sales', n); }
function noticesSeen() {
  if (document.visibilityState !== 'visible') return;
  apiCall('POST', '/api/notices-seen', {}).then(function (d) {
    if (d && d.n) setSalesN(curTab === 'sales' ? 0 : salesN + d.n);
    if (window.mailClient) setMailN(mailN);          // 会話をまだ読めていない間は数字に触らない
  }).catch(function () { /* 次に画面を出した時にまた聞く */ });
}
document.addEventListener('visibilitychange', noticesSeen);
document.addEventListener('DOMContentLoaded', noticesSeen);

// 右 (スマホは全面) に開いている詳細を閉じる。keep = 今から開く画面の種類 ('thread' / 'sale' / 'item')。各画面の「戻る」と同じ関数を使う (2026-10-14)
function closeDetails(keep) {
  if (keep !== 'sale') SalesUi.closeDetail();
  if (keep !== 'item') ItemsUi.closeDetail();
  if (keep !== 'status') TroublesUi.closeDetail();
  if (keep !== 'thread' && window.mailClient) window.mailClient.closeThread();
}
function showTab(name) {
  closeDetails();
  curTab = name;
  var soon = GAS_MODE && name !== 'mail' && name !== 'sales' && name !== 'summary' && name !== 'troubles';   // 配布版は 4 つのタブとも GAS 版がある (第 3 段で Status を足した)
  if (name === 'sales' && !soon) setSalesN(0);
  SalesUi.show(name === 'sales' && !soon);
  TroublesUi.show(name === 'troubles' && !soon);
  SummaryUi.show(name === 'summary' && !soon);
  document.body.classList.toggle('tab-soon', soon);
  if (soon) gasSoon(name);
  ItemsUi.place(name);
}
// 配布版の「準備中」の画面。タブの 2 行 (segBar) は付けて、Chat へ戻れるようにする
function gasSoon(name) {
  var v = document.getElementById('soonView');
  if (!v) { v = document.createElement('div'); v.id = 'soonView'; document.body.insertBefore(v, document.getElementById('listView')); }
  v.textContent = '';
  v.appendChild(segBar(name));
  v.appendChild(uel('div', 'none', '配布版は準備中です'));
}

// タブの切替と、その下の商品の検索窓の置き場 (検索窓は 1 つだけ作って、開いているタブの下へ移す)
// 2026-10-15 ユーザー指示: 2 行にする。1 行目 = Chat / Order / Status・2 行目 = 左に Summary・真ん中は空・右はパネルの中でだけ Listing (押せない空の枠は 3 列の形を保つ)
function segBar(active) {
  // 2026-10-15 ユーザー指示「先頭 2 行のタブは固定」: タブの 2 行を .segs にまとめ、画面 (root) の直下に置く (sticky は親の中でしか止まらないため fragment で返す)
  var wrap = document.createDocumentFragment(), tabs = document.createElement('div'), host = document.createElement('div');
  tabs.className = 'segs';
  host.className = 'ishost';
  function segRow(list, cls) {
    var bar = document.createElement('div');
    bar.className = 'seg' + (cls ? ' ' + cls : '');
    list.forEach(function (d) {
      var b = document.createElement('button');
      if (d && d[0] === 'overview') {            // 2026-10-16: パネルの中でだけ出る OverView。押すと親 (拡張機能) が全画面のアプリを別ウィンドウで開く
        b.className = 'sg'; b.textContent = d[1]; b.setAttribute('data-seg', 'overview');
        b.onclick = function () { toPanel({ type: 'mt-overview', tab: curTab }); };
        bar.appendChild(b);
        return;
      }
      // パネルの中でだけ出る Listing / Settings / AI。押すと親 (拡張機能) が出品画面・設定画面へ切り替える / Claude の小窓を開く
      if (d && (d[0] === 'listing' || d[0] === 'settings' || d[0] === 'ai')) {
        b.className = 'sg'; b.textContent = d[1]; b.setAttribute('data-seg', d[0]);
        b.onclick = function () { toPanel({ type: 'mt-' + d[0] }); };
        bar.appendChild(b);
        return;
      }
      if (!d) {                                  // 空の枠: 3 列の形だけ保つ (文字なし・押せない)
        b.className = 'sg blank'; b.disabled = true; b.tabIndex = -1; b.setAttribute('aria-hidden', 'true'); b.textContent = ' ';
        bar.appendChild(b);
        return;
      }
      b.className = 'sg' + (active === d[0] ? ' on' : '');
      var cnt = d[0] === 'troubles' ? troubleN : d[0] === 'mail' ? mailN : d[0] === 'sales' ? salesN : 0;
      b.textContent = SEG_NAME[d[0]] + (cnt ? ' ' + cnt : '');
      b.setAttribute('data-seg', d[0]);
      b.onclick = function () { showTab(d[0]); };
      bar.appendChild(b);
    });
    return bar;
  }
  // 2026-10-16 ユーザー指示: 4 列。1 行目 = Chat / Order / Status / Summary・2 行目 = Listing / 空 / 空 / OverView
  // 2 行目はパネルの中でだけ出す (スマホと OverView で開いた PC の画面は 1 行目だけ)
  // 2026-10-21 ユーザー指示: パネルの中は拡張機能の上のタブと同じ 5 列。1 行目 = Listing / Order / Status / Summary / Settings・
  //   2 行目 = Chat / 空 / 空 / AI / OverView (2 行目は Settings に Claude キーがある時だけ = body.embed-ai)
  if (EMBED) {
    tabs.appendChild(segRow([['listing', 'Listing'], ['sales', 'Order'], ['troubles', 'Status'], ['summary', 'Summary'], ['settings', 'Settings']]));
    tabs.appendChild(segRow([['mail', 'Chat'], null, null, ['ai', 'AI'], ['overview', 'OverView']], 'seg2'));
  } else {
    tabs.appendChild(segRow([['mail', 'Chat'], ['sales', 'Order'], ['troubles', 'Status'], ['summary', 'Summary']]));
  }
  wrap.appendChild(tabs);
  if (active !== 'mail' && active !== 'summary') {   // Chat のタブには商品の検索窓を置かない (2026-10-14・Chat は自分の検索窓を持つ)。Summary も置かない (2026-10-15)
    wrap.appendChild(host);
    if (active === curTab) ItemsUi.attach(host);
  }
  return wrap;
}

var ItemsUi = (function () {
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var kw = '', timer = null, seqS = 0, seqC = 0, node = null, selRow = null, readNote = '', from = null;   // from = 会話から開いた時の {t, hooks}

  function yen(n) { return n == null ? '-' : (n < 0 ? '-' : '') + '¥' + Math.round(Math.abs(n)).toLocaleString('ja-JP'); }
  function usd(n) { return n == null ? '-' : (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2); }
  function pc(x, d) { return x == null ? '-' : (x * 100).toFixed(d == null ? 1 : d) + '%'; }
  function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? u : ''; }   // javascript: などは出さない
  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '-';
    var j = new Date(d.getTime() + 9 * 3600000), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (j.getUTCMonth() + 1) + '月' + j.getUTCDate() + '日 ' + p(j.getUTCHours()) + ':' + p(j.getUTCMinutes());
  }
  function msgOf(e) { return e && e.message ? e.message : String(e); }

  // ---- 検索窓 (タブの下にいつも置く。1 つだけ作り、開いているタブの下へ移す。語・候補はタブを替えても残る)
  function build() {
    if (node) return node;
    node = el('div', 'isearch');
    var sr = el('div', 'sr'), si = el('input');
    si.id = 'itemQ'; si.type = 'search'; si.placeholder = '商品名 または ItemID'; si.value = kw; si.autocomplete = 'off';
    si.oninput = function () { kw = si.value; clearTimeout(timer); timer = setTimeout(search, 200); };
    sr.appendChild(si); node.appendChild(sr);
    var st = el('div', 'istat'); st.id = 'itemStat'; node.appendChild(st);
    var up = el('div', 'istat'); up.id = 'itemUpd'; node.appendChild(up);
    var rows = el('div'); rows.id = 'itemRows'; node.appendChild(rows);
    if (kw.trim()) search();
    return node;
  }
  function attach(host) { host.appendChild(build()); }
  function place(name) {
    var root = $({ mail: 'listView', sales: 'salesView', troubles: 'troublesView' }[name]), h = root && root.querySelector('.ishost');
    if (h) attach(h);
  }

  function stat(txt, ng) { var s = $('itemStat'); if (s) { s.textContent = txt; s.className = 'istat' + (ng ? ' ng' : ''); } }
  // 応答に付いてくる「いつ読んだか」と読み直しの失敗理由
  function readLine(r) {
    readNote = (r && r.read_at ? '利益計算表を読んだ時刻 ' + when(r.read_at) : '') + (r && r.error ? ' / ' + r.error : '');
    var u = $('itemUpd'); if (u) { u.textContent = readNote; u.style.color = r && r.error ? '#b42318' : ''; }
    return readNote;
  }

  function candRow(c, pick, pics) {
    var row = el('div', 'row irow' + (c.row === selRow ? ' sel' : ''));
    if (pics) { var im = el('img', 'cth'); im.alt = ''; im.setAttribute('data-id', String(c.item_id || '')); row.appendChild(im); }
    var rt = el('div', 'rt'), l1 = el('div', 'l1');
    l1.appendChild(el('div', 'nm', c.title || ('ItemID ' + c.item_id)));
    l1.appendChild(el('div', 'dt', c.price == null ? '' : usd(c.price)));
    rt.appendChild(l1);
    rt.appendChild(el('div', 'l2', 'ItemID ' + c.item_id + ' ・' + (c.stock || '-') + ' ・' + (c.status || '-')));
    rt.appendChild(el('div', 'l3', c.profit || ''));
    row.appendChild(rt);
    row.onclick = function () { selRow = c.row; pick(c); Array.prototype.forEach.call(document.querySelectorAll('#itemRows .row'), function (r) { r.classList.remove('sel'); }); row.classList.add('sel'); };
    return row;
  }
  // pick: 行を選んだ時の動き (省略 = その行を開く)。pics: サムネを並べる (会話から開いた時の候補)
  function fillCands(host, list, more, pick, pics) {
    host.textContent = '';
    list.forEach(function (c) { host.appendChild(candRow(c, pick || function (x) { openBy('row=' + x.row); }, pics)); });
    if (more) host.appendChild(el('div', 'none', '50 件を超えました。語を足して絞ってください'));
    if (!pics || !list.length) return;
    apiCall('POST', '/api/item-pics', { ids: list.slice(0, 12).map(function (c) { return String(c.item_id || ''); }).filter(Boolean) }).then(function (r) {
      Array.prototype.forEach.call(host.querySelectorAll('img.cth'), function (im) { var u = safeUrl(r.pics && r.pics[im.getAttribute('data-id')]); if (u) im.src = u; });
    }).catch(function () { });   // サムネが取れなくても候補は商品名で選べるので、ここは黙って進める
  }
  // 会話から開いた時に候補を選んだ: その行で売価とオファー額を拾い直してから開く
  function pickCand(c) {
    if (!(from && from.t && from.t.mid)) { openBy('row=' + c.row); return; }
    var scr = shell('商品');
    scr.appendChild(el('div', 'none', '会話から売価とオファー額を拾っています…'));
    apiCall('POST', '/api/item-offer-guess', { mid: from.t.mid, row: c.row }).then(function (g) {
      openBy('row=' + c.row, null, g && g.ok ? g : null);
    }, function () { openBy('row=' + c.row); });
  }

  function search() {
    var q = kw.trim(), my = ++seqS, rows = $('itemRows');
    if (!rows) return;
    if (!q) { rows.textContent = ''; stat(''); readLine(null); return; }
    stat('検索中…');
    apiCall('GET', '/api/items?q=' + encodeURIComponent(q)).then(function (r) {
      if (my !== seqS) return;
      readLine(r);
      fillCands(rows, r.items, r.more);
      stat(r.items.length ? r.items.length + ' 件' + (r.more ? ' 以上' : '') : '該当する商品はありません');
    }).catch(function (e) { if (my === seqS) { rows.textContent = ''; stat('失敗: ' + msgOf(e), true); } });
  }

  // ---- 詳細 (右の列 / スマホは全画面)
  function shell(title) {
    var root = $('itemView');
    root.textContent = '';
    var top = el('div', 'top'), back = el('button', 'back', '‹');
    back.onclick = closeDetail;
    top.appendChild(back); top.appendChild(el('span', 'who', title));
    root.appendChild(top);
    var scr = el('div', 'scr');
    root.appendChild(scr);
    root.hidden = false;
    return scr;
  }
  function closeDetail() { var v = $('itemView'); if (v) { v.hidden = true; v.textContent = ''; } seqC++; from = null; }

  // qs: 'id=<ItemID>' か 'row=<行>'。fbTitle: ItemID で見つからない時に商品名で探す (会話から開いた時)
  function openBy(qs, fbTitle, guess) {
    var scr = shell('商品');
    scr.appendChild(el('div', 'none', '読み込み中…'));
    apiCall('GET', '/api/item?' + qs).then(function (d) {
      readLine(d); renderDetail(d, guess);
    }, function (e) {
      if (e.status === 404 && fbTitle) { byTitle(fbTitle); return; }
      scr.textContent = '';
      scr.appendChild(el('div', 'fl', e.status === 404 ? 'この ItemID は利益計算表にありません' : '失敗: ' + msgOf(e)));
    });
  }
  function byTitle(title) {
    var scr = shell('商品'), words = String(title).split(/\s+/).filter(Boolean);
    scr.appendChild(el('div', 'none', '商品名で探しています…'));
    function ask(q) { return apiCall('GET', '/api/items?q=' + encodeURIComponent(q)); }
    ask(words.join(' ')).then(function (r) {
      return (r.items.length || words.length <= 4) ? r : ask(words.slice(0, 4).join(' '));   // 長い題名は先頭 4 語まで緩める
    }).then(function (r) {
      readLine(r);
      scr.textContent = '';
      scr.appendChild(el('div', 'info', 'ItemID では見つからなかったので商品名で探しました'));
      var host = el('div');
      scr.appendChild(host);
      if (r.items.length) fillCands(host, r.items, r.more, from ? pickCand : null, !!from); else host.appendChild(el('div', 'none', '商品名でも見つかりませんでした'));
    }).catch(function (e) { scr.textContent = ''; scr.appendChild(el('div', 'fl', '失敗: ' + msgOf(e))); });
  }

  function kv(scr, k, v, href) {
    var r = el('div', 'kv');
    r.appendChild(el('span', 'k', k));
    var s = el('span', 'v');
    if (href) { var a = el('a', null, v); a.href = href; a.target = '_blank'; a.rel = 'noopener'; s.appendChild(a); } else s.textContent = v == null || v === '' ? '-' : v;
    r.appendChild(s); scr.appendChild(r);
  }

  function renderDetail(d, guess) {
    var it = d.item, scr = shell('Listing Management');
    selRow = it.row;
    // 上 = 利益計算表の商品 (サムネ付き)。会話から開いた時は、すぐ下に問い合わせが来た出品を並べて、同じ商品かを目で確かめられるようにする
    // href があればカード全体がリンク (押すと別タブで開く)
    function pcard(label, picUrl, title, sub, note, ng, href) {
      var c = el(href ? 'a' : 'div', 'pcard'), im = el('img', 'pth'), tx = el('div', 'ptx');
      if (href) { c.href = href; c.target = '_blank'; c.rel = 'noopener'; }
      im.alt = ''; if (safeUrl(picUrl)) im.src = picUrl;
      tx.appendChild(el('div', 'plb', label));
      tx.appendChild(el('div', 'ptt', title || '(商品名なし)'));
      if (sub) tx.appendChild(el('div', 'psb', sub));
      if (note) tx.appendChild(el('div', 'pnt' + (ng ? ' ng' : ''), note));
      c.appendChild(im); c.appendChild(tx); scr.appendChild(c);
      return im;
    }
    var th0 = from && from.t;
    // 上のカード = 問い合わせが来た国の eBay の出品 (会話が無い時は US の出品) / 下のカード = 仕入先 (2026-10-12 ユーザー指示)
    var lid = (th0 && th0.item_id) || it.item_id;
    var topIm = pcard('Listing Item', '', it.title, 'ItemID ' + (it.item_id || '-') + ' ・' + usd(it.price) + ' ・' + it.row + ' 行目',
      null, false, lid ? 'https://www.ebay.com/itm/' + encodeURIComponent(lid) : '');
    if (it.item_id) {
      apiCall('POST', '/api/item-pics', { ids: [String(it.item_id)] }).then(function (r) {
        var u = safeUrl(r.pics && r.pics[String(it.item_id)]); if (u) topIm.src = u;
      }).catch(function () { });   // サムネが取れなくても画面は使えるので、ここは黙って進める
    }
    if (th0) {
      var same = th0.item_id && String(th0.item_id) === String(it.item_id);
      var supIm = pcard('Supplier', th0.pic, th0.title, 'ItemID ' + (th0.item_id || '-') + (th0.price ? ' ・' + th0.price : ''),
        same ? 'ItemID が同じです' : 'ItemID は別です (他国の出品なら正常)。写真と商品名で同じ商品か確かめてください', !same, safeUrl(it.src_url));
      if (!safeUrl(it.src_url) && it.item_id) {   // 売れた商品は利益計算表の I が空 → 販売シートの I の仕入先へ飛ばす (2026-10-14)
        apiCall('GET', '/api/item-supplier?id=' + encodeURIComponent(it.item_id)).then(function (r) {
          var u = safeUrl(r.url), old = supIm.parentNode;
          if (!u || !old) return;
          var a = el('a', old.className); a.href = u; a.target = '_blank'; a.rel = 'noopener';
          while (old.firstChild) a.appendChild(old.firstChild);
          old.parentNode.replaceChild(a, old);
        }).catch(function () { });   // 引けなくてもカードは今のまま (押しても飛ばないだけ)
      }
    }
    // 商品検索窓 (2026-10-14): 自動の一致で違う商品が当たった時に、利益計算表から探して選び直す。/api/items と候補の選択 (pickCand) は商品タブの検索と同じ
    var qBox = el('div', 'sr isr'), qIn = el('input'), qStat = el('div', 'istat isst'), qRows = el('div'), qSeq = 0, qT = null;
    qIn.type = 'search'; qIn.placeholder = '商品を探す (商品名 または ItemID)'; qIn.autocomplete = 'off';
    qBox.appendChild(qIn);
    qIn.oninput = function () {
      clearTimeout(qT);
      qT = setTimeout(function () {
        var q = qIn.value.trim(), my = ++qSeq;
        if (!q) { qRows.textContent = ''; qStat.textContent = ''; return; }
        qStat.className = 'istat isst'; qStat.textContent = '検索中…';
        apiCall('GET', '/api/items?q=' + encodeURIComponent(q)).then(function (r) {
          if (my !== qSeq) return;
          fillCands(qRows, r.items, r.more, pickCand, true);
          qStat.textContent = r.items.length ? r.items.length + ' 件' + (r.more ? ' 以上' : '') : '該当する商品はありません';
        }).catch(function (e) { if (my === qSeq) { qRows.textContent = ''; qStat.className = 'istat isst ng'; qStat.textContent = '失敗: ' + msgOf(e); } });
      }, 250);
    };
    scr.appendChild(qBox); scr.appendChild(qStat); scr.appendChild(qRows);
    if (d.dups && d.dups.length) scr.appendChild(el('div', 'info', '同じ ItemID の行が他にもあります: ' + d.dups.map(function (n) { return n + ' 行'; }).join(', ') + ' (これは ' + it.row + ' 行)'));
    // 編集ボタン (eBay へ反映 / Send Title / 出品を取り下げる) の共通の状態: 処理中は全部押せない・取り下げたら全部押せない
    var ed = {
      busy: false, ended: false, btns: [],
      refresh: function () { ed.btns.forEach(function (b) { b.disabled = ed.ended || ed.busy || (b.canPress ? !b.canPress() : false); }); },
      setBusy: function (v) { ed.busy = v; ed.refresh(); }
    };
    var cb = calcBox(it, guess, ed);
    scr.appendChild(cb.box);
    if (it.item_id) scr.appendChild(titleBox(it, ed));
    var src = safeUrl(it.src_url), th = from && from.t;
    // 5% Offer (eBay へ反映の右・2026-10-14): 上の BUYER 希望価格をコピーして eBay の会話へ戻りオファーの文を用意する。会話から開いた時だけ押せる
    var of = el('button', 'irp irg', '5% Offer');
    if (th && from.hooks && from.hooks.offer) {
      of.onclick = function () {
        var p = cb.offerPrice();
        if (!p) { cb.say('BUYER 希望価格 (または差額%) を入れてください'); return; }
        var t0 = th, h = from.hooks;
        closeDetail();
        h.offer(t0, p.amt, p.cur);
      };
    } else of.disabled = true;
    cb.rpw.appendChild(of);
    // シートの値と「最低の値段」は畳んでおく (開けば今までどおり見られる)
    var more = el('details', 'imore');
    more.appendChild(el('summary', null, '最低の値段・シートの値'));
    more.appendChild(cb.extra);
    kv(more, 'ItemID', it.item_id);
    kv(more, '仕入先 URL', it.src_url, src);
    kv(more, '仕入先の種別', it.src_kind);
    kv(more, '仕入価格', yen(it.cost));
    kv(more, '着払', yen(it.cod));
    kv(more, '仕入合計', yen(it.cost_total));
    kv(more, 'Sale 前の表示価格 (AE)', usd(it.price_before_sale));
    kv(more, 'Sale の段 (N)', it.sale_tier);
    kv(more, '還付込 (AA)', it.refund_profit);
    kv(more, '目標利益%', it.target != null ? pc(it.target, 1) : (it.target_yen != null ? yen(it.target_yen) + ' (円で指定)' : '-'));
    kv(more, 'DDP / DDU', it.term);
    kv(more, '配送会社', it.carrier);
    kv(more, '寸法・重量', it.dims.map(function (x) { return x == null ? '-' : x; }).join(' × ') + ' cm / ' + (it.weight == null ? '-' : it.weight) + ' kg');
    kv(more, '在庫状況', it.stock);
    kv(more, 'Status', it.status);
    kv(more, '出品日', it.listed);
    kv(more, 'シートの行', it.row + ' 行目');
    scr.appendChild(more);
    var ft = el('div', 'ifoot');
    ft.appendChild(el('span', null, 'データを読んだ時刻 ' + when(d.read_at) + (d.error ? ' / ' + d.error : '')));
    var rf = uRefreshBtn(null);   // 文字なしの更新アイコン (一覧の更新ボタンと同じ見た目)
    rf.className = 'irf'; rf.title = '読み直す'; rf.setAttribute('aria-label', '読み直す');
    rf.onclick = function () {
      rf.disabled = true;
      apiCall('POST', '/api/items-refresh', {}).then(function (r) {
        readLine(r);
        openBy('row=' + it.row);
        if ($('itemQ') && kw.trim()) search();
      }).catch(function (e) { rf.disabled = false; ft.appendChild(el('div', 'msg ng', '失敗: ' + msgOf(e))); });
    };
    ft.appendChild(rf);
    if (d.error) ft.firstChild.style.color = '#b42318';
    scr.appendChild(ft);
    if (it.item_id) scr.appendChild(endBox(it, ed));
  }

  // ---- 出品の編集 (GAS 経由で eBay・利益計算表を書く。1 回 5〜30 秒)。結果は GAS が返した message / warnings をそのまま出す
  function editCall(ed, path, body, note, onOk) {
    ed.setBusy(true);
    note.className = 'inote'; note.textContent = '送っています… (5〜30 秒かかります)';
    return apiCall('POST', path, body).then(function (r) {
      ed.setBusy(false);
      var parts = [r.message || (r.ok ? '完了しました' : '失敗しました')];
      (r.warnings || []).forEach(function (w) { parts.push('注意: ' + w); });
      note.className = 'inote' + (r.ok ? '' : ' ng');
      note.textContent = parts.join(' / ');
      if (r.ok && onOk) onOk(r);
    }, function (e) {
      ed.setBusy(false);
      note.className = 'inote ng';
      note.textContent = '失敗: ' + msgOf(e) + ' (反映されたか確認できていません。商品を読み直して確かめてください)';
    });
  }

  // タイトル: 開いた時は利益計算表のタイトル。変えていない時・空・80 字超は送れない
  function titleBox(it, ed) {
    var box = el('div', 'calc'), base = String(it.title || '').trim();
    var ta = el('textarea'), cnt = el('div', 'inote'), note = el('div', 'inote'), btn = el('button', 'irp', 'Send Title');
    box.appendChild(el('div', 'ch', 'Title'));
    ta.value = String(it.title || ''); ta.autocomplete = 'off';
    box.appendChild(ta); box.appendChild(cnt); box.appendChild(btn); box.appendChild(note);
    btn.canPress = function () { var v = ta.value.trim(); return v !== '' && v.length <= 80 && v !== base && /^\d{12}$/.test(String(it.item_id || '')); };
    ed.btns.push(btn);
    function upd() {
      var n = ta.value.trim().length;
      cnt.textContent = n + '/80';
      cnt.className = 'inote' + (n > 80 || n === 0 ? ' ng' : '');
      ed.refresh();
    }
    ta.oninput = function () { if (/[\r\n]/.test(ta.value)) ta.value = ta.value.replace(/[\r\n]+/g, ' '); upd(); };   // タイトルに改行は使えない
    btn.onclick = function () {
      if (!btn.canPress()) return;
      var v = ta.value.trim();
      editCall(ed, '/api/item-title', { item_id: String(it.item_id), title: v }, note, function () { base = v; upd(); });
    };
    upd();
    return box;
  }

  // 出品を取り下げる (End Listing)。一番下に離して置く。成功したらこの商品の編集ボタンは全部押せなくなる
  function endBox(it, ed) {
    var box = el('div', 'iend'), btn = el('button', 'opt cancel', 'End Listing'), note = el('div', 'inote');
    btn.canPress = function () { return /^\d{12}$/.test(String(it.item_id || '')); };
    ed.btns.push(btn);
    btn.onclick = function () {
      if (!window.confirm('この出品を取り下げます (End Listing)。元に戻せません。よろしいですか?')) return;
      editCall(ed, '/api/item-end', { item_id: String(it.item_id) }, note, function () { ed.ended = true; ed.refresh(); });
    };
    box.appendChild(btn); box.appendChild(note);
    return box;
  }

  // ---- 商品のカード (販売処理のメールと同じ「左に項目・右に値」の並び)。計算はサーバー (items.py・利益計算表の式の写し)
  // 差額% = 1 − BUYER 希望価格 ÷ 問い合わせ国の売価。その % を US の今の売価 V に当てて利益を出す。
  // 問い合わせ国の売価が空なら US の売価と同じとして扱う (= US のオファーは希望価格を USD で打つだけ)。差額% は直接打ってもよい。
  function calcBox(it, g, ed) {
    var box = el('div', 'calc'), extra = el('div', 'cex'), dirty = false;
    // 仕入れ値・送料の欄: 押したら空にして、すぐ打てるようにする。何も打たずに離れたら元の値に戻す (2026-10-18 ユーザー指示)
    function blankOnFocus(i) {
      i.addEventListener('focus', function () { i.dataset.was = i.value; i.value = ''; });
      i.addEventListener('blur', function () { if (i.value.trim() === '' && i.dataset.was) { i.value = i.dataset.was; i.dispatchEvent(new Event('input')); } });
    }
    function inp(ph, cls) { var i = el('input', cls); i.type = 'text'; i.inputMode = 'decimal'; i.placeholder = ph || ''; i.autocomplete = 'off'; return i; }
    function row(label, node, big) {
      var r = el('div', 'srow');
      r.appendChild(el('span', 'sk', label));
      node.classList.add('sv'); if (big) node.classList.add('big');
      r.appendChild(node); box.appendChild(r);
      return node;
    }
    function wrap(pre, i, post) { var w = el('span'); if (pre) w.appendChild(pre); w.appendChild(i); if (post) w.appendChild(el('span', 'cur', post)); return w; }
    var m = /^\s*(-?¥[\d,]+)\s*\(([^)]+)\)/.exec(it.profit || '');   // Z 列は「¥32,823 (15%)」の文字列
    row('US 売価', el('span', null, usd(it.price)), true);
    var usP = row('US 利益', el('span', null, m ? m[1] : (it.profit || '-')));
    var usR = row('US 利益%', el('span', null, m ? m[2] : '-'));
    box.appendChild(el('div', 'sline'));
    // 仕入れ値 (J)・送料 (K): 打ち直すとその値で自動で計算し直す。左の更新ボタンを押すと、確認のうえシートの J / K を書き換える (2026-10-14)
    //   sheetCost / sheetShip = 読んだ時のシートの値 (計算に送る基準) / writ = 今シートにあると画面が思っている値 (書き換えの old)。送料 K の空欄は 0
    var sheetCost = it.cost, sheetShip = it.cod == null ? 0 : it.cod, writ = { cost: it.cost, ship: sheetShip }, costI = inp(''), shipI = inp('');
    costI.value = it.cost == null ? '' : String(it.cost);
    shipI.value = it.cod == null ? '' : String(it.cod);
    blankOnFocus(costI); blankOnFocus(shipI);
    function updBtn(kind, inputEl, name) {
      var b = el('button', 'iupd');
      b.type = 'button'; b.title = name + 'をシートに書き込む'; b.setAttribute('aria-label', name + 'をシートに書き込む');
      b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>';
      b.canPress = function () {
        var v = num(inputEl.value);
        return !!it.calc_ok && /^\d{9,13}$/.test(String(it.item_id || '')) && v !== null && (kind === 'cost' ? v > 0 : v >= 0) && v !== writ[kind];
      };
      ed.btns.push(b);
      b.onclick = function () {
        clearTimeout(t2);
        var v = num(inputEl.value);
        if (!b.canPress()) return;
        if (!window.confirm('スプレッドシートの' + name + 'を ' + yen(writ[kind]) + ' → ' + yen(v) + ' に書き換えます')) return;
        var was = writ[kind];
        ed.setBusy(true); wr.className = 'inote'; wr.textContent = 'シートを書き換えています…';
        apiCall('POST', kind === 'cost' ? '/api/item-cost' : '/api/item-ship', { item_id: String(it.item_id), old: was, new: v }).then(function (r) {
          ed.setBusy(false);
          if (!r.ok) { wr.className = 'inote ng'; wr.textContent = 'シートを書き換えられませんでした: ' + r.message; recalc(); return; }
          wr.className = 'inote'; wr.textContent = 'シートの' + name + 'を ' + yen(was) + ' → ' + yen(v) + ' に書き換えました (' + r.row + ' 行目。US の売価はシートの再計算後に変わります)';
          writ[kind] = v; ed.refresh(); recalc();
        }).catch(function (e) { ed.setBusy(false); wr.className = 'inote ng'; wr.textContent = 'シートを書き換えられませんでした: ' + msgOf(e); recalc(); });
      };
      return b;
    }
    function updRow(label, b, inputEl) {
      var w = el('span'); w.appendChild(b); w.appendChild(el('span', 'cur', '¥')); w.appendChild(inputEl);
      row(label, w);
    }
    var costB = updBtn('cost', costI, '仕入価格'), shipB = updBtn('ship', shipI, '送料');
    updRow('仕入れ値', costB, costI);
    updRow('送料', shipB, shipI);
    // 仕入先の今の値段 (在庫監視が AN 列に書いた値)。シートの仕入価格と違う時だけ出す。押すと仕入れ値の欄に入る (シートは仕入れ値の更新ボタンを押すまで変えない)
    if (it.src_price != null && it.src_price > 0 && it.src_price !== it.cost) {
      var sc = el('button', 'schip', '仕入先の今の値段 ' + yen(it.src_price) + ' を入れる');
      sc.onclick = function () { costI.value = String(it.src_price); costI.dispatchEvent(new Event('input')); };
      box.appendChild(sc);
    }
    var curL = el('span', 'cur', ''), lpI = inp(it.price == null ? '' : String(it.price)), ofI = inp('手入力できます'), dcI = inp('');
    row('問い合わせ国の売価', wrap(curL, lpI));
    row('BUYER 希望価格', wrap(null, ofI));
    row('差額%', wrap(null, dcI, '%'));
    box.appendChild(el('div', 'sline'));
    var out = row('BUYER 希望での利益', el('span', null, '-'), true);
    var pushBtn = el('button', 'irp', 'eBay へ反映');   // BUYER 希望価格 (US 額) を W (販売価格・手動) に書き、G に ItemID を貼り直したのと同じ処理で eBay へ送る (GAS の reset)
    var rpw = el('div', 'rpw');
    rpw.appendChild(pushBtn);
    box.appendChild(rpw);
    var pushUsd = null;   // 最後の計算が出した、BUYER 希望価格に当たる US の額 (r.price_usd)。計算できない・希望価格が空なら null
    pushBtn.canPress = function () { return !!it.calc_ok && /^\d{12}$/.test(String(it.item_id || '')) && pushUsd !== null && pushUsd > 0; };
    ed.btns.push(pushBtn);
    var notes = el('div'), wr = el('div', 'inote'), msg = el('div', 'inote');
    box.appendChild(notes); box.appendChild(wr); box.appendChild(msg);
    // 畳んである側: 利益率 ○% を残せる最低の値段・利益ゼロの値段
    var mr = el('div', 'crow'), rin = inp('', 'rin');
    rin.value = it.target ? String(Math.round(it.target * 1000) / 10) : '';
    mr.appendChild(el('span', 'cl', '利益率')); mr.appendChild(rin); mr.appendChild(el('span', 'cl', '% を残せる最低の値段'));
    extra.appendChild(mr);
    var minv = el('div', 'cval'), zerov = el('div', 'cval');
    extra.appendChild(minv);
    extra.appendChild(el('div', 'cl2', '利益ゼロの値段'));
    extra.appendChild(zerov);
    if (!it.calc_ok) { msg.className = 'inote ng'; msg.textContent = '計算できません: ' + it.calc_error; [costI, shipI, costB, shipB, lpI, ofI, dcI, rin, pushBtn].forEach(function (x) { x.disabled = true; }); return { box: box, extra: extra, rpw: rpw, offerPrice: function () { return null; }, say: function () { } }; }

    function num(x) { var v = parseFloat(String(x).replace(/,/g, '').replace('%', '')); return isNaN(v) ? null : v; }
    function dpct(d) { return d == null ? '-' : (d * 100).toFixed(1) + '%'; }
    function ptText(p) {   // US の額 + V からの割引率 (+ 問い合わせ国の売価が入っていれば現地の額)
      if (p.usd == null) return null;
      return usd(p.usd) + ' (割引率 ' + dpct(p.discount) + ')' + (p.local != null && lpI.value.trim() !== '' ? '  /  現地 ' + (Math.round(p.local * 100) / 100).toLocaleString('ja-JP') : '');
    }
    function fail(t) { pushUsd = null; ed.refresh(); out.textContent = '-'; out.classList.remove('neg'); msg.className = 'inote ng'; msg.textContent = t; }
    function recalc() {
      var my = ++seqC, rtxt = rin.value.trim(), rv = rtxt === '' ? null : num(rtxt) / 100;
      if (rtxt !== '' && rv === null) { fail('利益率は数字で入れてください'); return Promise.resolve(); }
      var lp = lpI.value.trim().replace(/,/g, '');
      var body = { row: it.row, mode: 'other', rate: rv, list_price: lp === '' ? it.price : lp, offer: ofI.value.trim().replace(/,/g, '') };
      var cv = num(costI.value);
      if (costI.value.trim() !== '' && (cv === null || cv <= 0)) { fail('仕入れ値は 0 より大きい数字で入れてください'); return Promise.resolve(); }
      if (cv !== null && cv !== sheetCost) body.cost = cv;   // 読んだ時のシートの値と違う時だけ送る
      var sv = num(shipI.value);
      if (shipI.value.trim() !== '' && (sv === null || sv < 0)) { fail('送料は 0 以上の数字で入れてください'); return Promise.resolve(); }
      if (sv !== null && sv !== sheetShip) body.ship = sv;
      if (dirty && dcI.value.trim() !== '') { var dv = num(dcI.value); if (dv === null) { fail('差額% は数字で入れてください'); return Promise.resolve(); } body.discount = dv / 100; }
      return apiCall('POST', '/api/item-calc', body).then(function (r) {
        if (my !== seqC) return;
        minv.textContent = ''; zerov.textContent = '';
        pushUsd = (r.ok && r.calc && r.price_usd > 0) ? r.price_usd : null;
        ed.refresh();
        if (!r.ok) { fail(r.message); return; }
        msg.className = 'inote';
        if (r.us) { usP.textContent = yen(r.us.profit); usR.textContent = pc(r.us.rate, 0); }   // 打ち直した仕入れ値での US の利益
        else { usP.textContent = m ? m[1] : (it.profit || '-'); usR.textContent = m ? m[2] : '-'; }
        if (r.calc) {
          var c = r.calc;
          out.textContent = yen(c.profit) + ' (' + pc(c.rate) + ')';
          out.classList.toggle('neg', c.profit < 0);
          msg.textContent = 'US の売価 ' + usd(it.price) + ' に差額 ' + dpct(r.discount) + ' を当てた額 ' + usd(r.price_usd) + ' で計算' + (c.below_duty_floor ? ' / この額は関税・通関の最低額より小さいため、売上は 0 として計算しています' : '');
          if (c.below_duty_floor) msg.className = 'inote ng';
        } else { out.textContent = '-'; out.classList.remove('neg'); msg.textContent = ''; }
        if (r.min_price) minv.textContent = ptText(r.min_price) || 'この利益率には届きません';
        else minv.textContent = rtxt === '' ? '(利益率を入れてください)' : '';
        zerov.textContent = ptText(r.zero_price) || '-';
      }).catch(function (e) { if (my === seqC) fail('失敗: ' + msgOf(e)); });
    }
    var t2 = null;
    function later() { clearTimeout(t2); t2 = setTimeout(recalc, 250); }
    rin.oninput = later;
    costI.oninput = function () { later(); ed.refresh(); };
    shipI.oninput = function () { later(); ed.refresh(); };
    [lpI, ofI].forEach(function (x) {   // 売価か希望価格を打つと差額% に計算結果を出す (差額% を直接打ち直せば、そちらが優先)
      x.oninput = function () {
        dirty = false;
        var l = lpI.value.trim() === '' ? it.price : num(lpI.value), o = num(ofI.value);
        dcI.value = (l && o && l > 0) ? String(Math.round((1 - o / l) * 1000) / 10) : '';
        later();
      };
    });
    dcI.oninput = function () {   // 差額% を直接打ったら、その % を当てた額を BUYER 希望価格の欄にも出す (Offer でコピーする額)
      dirty = true;
      var l = lpI.value.trim() === '' ? it.price : num(lpI.value), dv = num(dcI.value);
      if (l && dv !== null && dv < 100) ofI.value = (l * (1 - dv / 100)).toFixed(2);
      later();
    };
    pushBtn.onclick = function () {   // BUYER 希望価格の US 額を W (販売価格・手動) に書いて eBay へ送る。W は Sale の対象外 (仕入れ値は左の更新ボタンで書く)
      clearTimeout(t2);
      if (ofI.value.trim() === '') { wr.className = 'inote ng'; wr.textContent = 'BUYER 希望価格 (または差額%) を入れてください'; return; }
      recalc().then(function () {   // 打ちかけの値で最後に計算し直した US 額を使う (自前で換算しない)
        if (pushUsd === null) { wr.className = 'inote ng'; wr.textContent = 'BUYER 希望価格の US の額を計算できません (上の赤い文を確認してください)'; return; }
        var usdAmt = Math.round(pushUsd * 100) / 100;
        if (!window.confirm('W に $' + usdAmt.toFixed(2) + ' を書いて eBay へ送ります。よろしいですか?')) return;
        editCall(ed, '/api/item-price-push', { item_id: String(it.item_id), price: usdAmt }, wr, function () { recalc(); });
      });
    };
    ed.refresh();
    if (g) fillGuess();
    recalc();
    return {
      box: box, extra: extra, rpw: rpw,
      say: function (t) { msg.className = 'inote ng'; msg.textContent = t; },
      // Offer でコピーする額 (BUYER 希望価格の欄) と通貨。問い合わせ国の売価が空なら US の額 (USD)
      offerPrice: function () {
        var o = num(ofI.value);
        return o && o > 0 ? { amt: o, cur: curL.textContent || (lpI.value.trim() === '' ? 'USD' : '') } : null;
      }
    };

    // 会話から開いた時: 「問い合わせ国の売価・BUYER 希望価格」を自動で入れる (手で直せる・直すと再計算)。拾えなかった項目は空のまま理由を出す
    function fillGuess() {
      var gl = g.list_price, go = g.offer, ns = [];
      if (gl) { lpI.value = String(gl.amount); curL.textContent = gl.currency; }
      else if (g.list_error) ns.push('その国の売価を取れませんでした: ' + g.list_error);
      if (go && go.found) {
        if (gl && go.currency === gl.currency) {
          ofI.value = String(go.amount);
          if (g.discount != null) dcI.value = String(Math.round(g.discount * 1000) / 10);
        } else ns.push(g.note || ('通貨が違うので計算できません (希望価格 ' + go.currency + ' ' + go.amount + ')'));
        if (go.quote) notes.appendChild(el('div', 'iquote', 'AI が拾った原文: ' + go.quote + ' → ' + go.currency + ' ' + go.amount));
      } else if (go) ns.push(go.reason || '希望価格を拾えませんでした (手で入れられます)');
      if (g.note && !(go && go.found)) ns.push(g.note);
      ns.forEach(function (n) { notes.appendChild(el('div', 'inote' + (/取れ|違う|できません|見当たり/.test(n) ? ' ng' : ''), n)); });
    }
  }

  window.addEventListener('popstate', closeDetail);   // 会話から開いた商品画面は、戻る操作で会話と一緒に閉じる
  return {
    attach: attach,
    place: place,
    closeDetail: closeDetail,
    openFromThread: function (t, hooks) {
      from = null;
      function plain() { if (t.item_id) openBy('id=' + encodeURIComponent(t.item_id), t.title); else if (t.title) byTitle(t.title); }
      if (!t.mid) { plain(); return; }
      var scr = shell('商品');
      from = { t: t, hooks: hooks || null };
      scr.appendChild(el('div', 'none', '会話から売価とオファー額を拾っています…'));
      apiCall('POST', '/api/item-offer-guess', { mid: t.mid }).then(function (g) {
        if (!g.ok) { plain(); return; }
        if (g.row) { openBy('row=' + g.row, null, g); return; }
        scr.textContent = '';
        scr.appendChild(el('div', 'info', (g.note || '候補があります') + (g.matched_by === 'title' ? ' (商品名で探しました)' : '')));
        var host = el('div'); scr.appendChild(host);
        if (g.candidates.length) fillCands(host, g.candidates, false, pickCand, true);
      }, function () { plain(); });   // 拾えない時 (AI・通信の失敗など) は今までどおり ItemID → 商品名で開く
    }
  };
})();

// ================================================================== ステータスのタブ (旧トラブル: キャンセル・返品・未着の問い合わせ・ケース + 未配達の注意・2026-10-12)
// データは /api/troubles (読むだけ。eBay へ何かを送る操作は無い)。会話がある行は押すとメールのタブでその会話を開く。
// 2026-10-13: 行をメールの一覧と同じ形に (写真・買い手・商品名)。写真・商品名・OrderID・追跡番号は押すと eBay を開く。その下に今の状態 ($ 売価・車)。
var troubleN = 0;   // タブの文字の横に出す数 (開いている物 + 未配達の注意)。segBar が読む
function setTroubleN(n) {
  troubleN = n;
  segLabel('troubles', n);
  toPanel({ type: 'mt-status-count', n: n });   // パネルの上のタブの Status の数 (2026-10-15)
}

// TROUBLE-DUE-BEGIN (期限の印・2026-10-14。DOM に触れない関数だけ。test_trouble_due.js が取り出して流す)
// 期限 (ISO) が今日から何日先か。日本時間 (JST) の日付で数える (0 = 今日まで・負 = 超過)。読めなければ null
function dueDays(iso, nowMs) {
  var t = iso ? new Date(iso).getTime() : NaN;
  if (isNaN(t)) return null;
  var day = function (ms) { return Math.floor((ms + 9 * 3600000) / 86400000); };
  return day(t) - day(nowMs);
}
// 残り 1 日以内 (今日まで・超過を含む) = 赤 / 3 日以内 = オレンジ / それより先 = グレー
function dueMark(days) {
  if (days == null) return null;
  var text = days < 0 ? (-days) + '日超過' : days === 0 ? '今日まで' : '残り' + days + '日';
  return { text: text, tone: days <= 1 ? 'r' : days <= 3 ? 'o' : 'g' };
}
// 期限が近い順 (期限が空・読めない行は後ろ)。同じ期限は元の並びのまま。元の配列は変えない
function sortByDue(rows) {
  return rows.map(function (r, i) { return { r: r, i: i, t: r.due ? new Date(r.due).getTime() : NaN }; }).sort(function (a, b) {
    var an = isNaN(a.t), bn = isNaN(b.t);
    return an && bn ? a.i - b.i : an ? 1 : bn ? -1 : a.t - b.t || a.i - b.i;
  }).map(function (x) { return x.r; });
}
// 詳細画面の純粋な部品 (2026-10-14)。状況ボタン / 「N日前」/ 候補 API に渡す中身
var TRBL_SITUATIONS = [['delay', '配達遅れ'], ['duty', '関税未払いで止まっている'], ['address', '住所・保管期限'], ['other', 'その他(メモ)']];
function agoText(days) { return days == null ? '' : days < 0 ? (-days) + '日前' : days === 0 ? '今日' : ''; }
function trblPayload(it, sit, memo, nowMs) {
  var o = it.order || {}, d = o.est_max ? dueDays(o.est_max, nowMs) : null;
  return { situation: sit, memo: memo || '', kind: it.kind || '', buyer: it.buyer || '', item_id: it.item_id || '', title: it.title || '',
    order_id: it.order_id || o.order_id || '', country: o.country || '', carrier: o.carrier || '', tracking: o.tracking || '',
    shipped: o.shipped || '', est_min: o.est_min || '', est_max: o.est_max || '', overdue_days: d != null && d < 0 ? -d : 0 };
}
// TROUBLE-DUE-END
var TroublesUi = (function () {
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var SECTIONS = [['unpaid', '入金待ち'], ['late', '未配達の注意'], ['cancels', 'キャンセル'], ['returns', '返品'], ['inquiries', '未着の問い合わせ'], ['cases', 'ケース']];
  var built = false, seq = 0;

  function jst(iso) { var d = new Date(iso); return !iso || isNaN(d) ? null : new Date(d.getTime() + 9 * 3600000); }
  function md(iso) { var d = jst(iso); return d ? (d.getUTCMonth() + 1) + '/' + d.getUTCDate() : ''; }
  function money(v, cur) {
    var n = parseFloat(v);
    if (isNaN(n) || n === 0) return '';
    var s = n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return cur === 'USD' || !cur ? '$' + s : cur + ' ' + s;
  }
  function itemUrl(it) { return /^\d{9,}$/.test(String(it.item_id || '')) ? 'https://www.ebay.com/itm/' + it.item_id : ''; }
  function thumb(it) {
    if (it.pic) {
      var im = el('img', 'pic');
      im.src = it.pic; im.alt = ''; im.loading = 'lazy';
      im.onerror = function () { im.replaceWith(el('div', 'ini', (it.buyer || '?').charAt(0).toUpperCase())); };
      return im;
    }
    return el('div', 'ini', (it.buyer || '?').charAt(0).toUpperCase());
  }
  function chip(cls, svg, text) {
    var c = el('span', 'stc'), box = el('span', 'sti'), i = el('span', cls);
    i.innerHTML = svg; box.appendChild(i); c.appendChild(box);
    c.appendChild(el('span', null, text));
    return c;
  }
  // 1 行目の右: 配送の状態 (車は配達前が灰色・配達完了が緑)。注文が無い行は起きた日だけ
  function shipState(it) {
    var o = it.order || {}, st = o.stage;
    if (st === 'delivered') return chip('g', STI_TRUCK, '配達完了' + (md(o.delivered) ? ' ' + md(o.delivered) : ''));
    if (st === 'shipped') return chip('x', STI_TRUCK, '発送済み' + (md(o.est_max) ? ' 配達予定 ' + md(o.est_max) : ''));
    if (st === 'paid') return el('span', 'stc', '未発送');
    if (st === 'unpaid') return el('span', 'stc', '入金待ち');
    if (st === 'cancelled') return el('span', 'stc', 'キャンセル済み');
    if (st === 'cancel_requested') return el('span', 'stc', 'キャンセル依頼中');
    return el('span', 'stc', md(it.date));
  }
  // 写真の下の売価 (支払い済みの注文だけ)
  function priceOf(it) {
    var o = it.order || {}, st = o.stage;
    if (st !== 'paid' && st !== 'shipped' && st !== 'delivered') return '';
    return money(o.item_price, o.item_price_currency || o.currency) || money(o.total, o.currency);
  }
  // 4 行目: キャンセル・返品などの中身を 1 行で (未配達の注意は 1 行目に出ているので空)
  function detail(it) {
    if (it.kind === 'late') return '';
    var p = [md(it.date), it.reason || it.state, money(it.amount, it.currency)].filter(Boolean);
    if (it.due && md(it.due)) p.push('期限 ' + md(it.due));
    return p.join(' · ');
  }
  function openConv(mid) {
    showTab('mail');
    if (window.mailClient) window.mailClient.openMid(mid);
  }
  // 4 行目が空の行に出す Order の数字 (2026-10-14)。販売データは load の時に 1 回読む (サーバーの控えなので軽い)。注文番号で探し、無ければ ItemID
  var salesBy = {};
  function salesNums(it, oid) {
    var s = (oid && salesBy['o' + oid]) || (it.item_id && salesBy['i' + it.item_id]);
    return s ? uNums(s) : '';
  }
  function rowOf(it) {
    var o = it.order || {};
    var iu = itemUrl(it), oid = it.order_id || o.order_id || '';
    var dt = el('div', 'dt'); dt.appendChild(shipState(it));
    var dm = it.closed ? null : dueMark(dueDays(it.due, Date.now()));   // 開いている物だけ期限の印 (閉じた物は付けない)
    if (dm) dt.appendChild(el('span', 'due ' + dm.tone, dm.text));
    var ti = el('span', null, it.title || (it.item_id ? 'ItemID ' + it.item_id : '-'));
    return uRow({     // 行のどこを押しても詳細画面が開く (写真・商品名・OrderID・買い手のリンクは詳細の中へ移した・2026-10-14)
      thumb: thumb(it), price: priceOf(it), name: el('span', null, it.buyer || '-'), right: dt,
      title: ti, ids: uIds(oid, o, false, true), detail: detail(it) || salesNums(it, oid), onclick: function () { openDetail(it); }
    });
  }

  // ---- 詳細画面 (2026-10-14): Order の詳細と同じ作り。状況ボタン → AI の英文の候補 → 選ぶと Chat の入力欄に入る (送信はしない)
  var KIND_NAME = { unpaid: '入金待ち', late: '未配達', cancels: 'キャンセル', returns: '返品', inquiries: '未着の問い合わせ', cases: 'ケース' };
  function closeDetail() {
    var v = $('statusView');
    if (v) { v.hidden = true; v.textContent = ''; }
  }
  function openDetail(it) {
    closeDetails('status');
    var root = $('statusView'), o = it.order || {}, now = Date.now(), iu = itemUrl(it), oid = it.order_id || o.order_id || '';
    root.textContent = '';
    var top = el('div', 'top'), back = el('button', 'back', '‹'), who = el('span', 'who', 'Status');
    back.onclick = closeDetail;
    top.appendChild(back); top.appendChild(who);
    top.appendChild(el('span', 'sdsold tr', KIND_NAME[it.kind] || ''));
    root.appendChild(top);
    var scr = el('div', 'scr sdx');
    root.appendChild(scr);
    // 商品カード (写真・商品名 = eBay の商品ページ)
    var cards = el('div', 'sds'), c = el(iu ? 'a' : 'div', 'pcard' + (iu ? '' : ' off')), im = el('img', 'pth'), tx = el('div', 'ptx');
    if (iu) { c.href = iu; c.target = '_blank'; c.rel = 'noopener'; }
    im.alt = ''; if (/^https?:\/\//i.test(it.pic || '')) im.src = it.pic;
    tx.appendChild(el('div', 'plb', 'Listing Item'));
    tx.appendChild(el('div', 'ptt', it.title || (it.item_id ? 'ItemID ' + it.item_id : '-')));
    var pr = priceOf(it) || money(it.amount, it.currency);
    if (pr) tx.appendChild(el('div', 'psb', pr));
    c.appendChild(im); c.appendChild(tx); cards.appendChild(c); scr.appendChild(cards);
    // 期限の印 (開いている物だけ)
    var dm = it.closed ? null : dueMark(dueDays(o.est_max || it.due, now));
    if (dm) { var dw = el('div', 'sds'); dw.appendChild(el('div', 'due sdd ' + dm.tone, '▶ ' + dm.text)); scr.appendChild(dw); }
    // Order details
    var ow = el('div', 'sds'), oc = el('div', 'sdc');
    ow.appendChild(el('div', 'sdl', 'Order details')); ow.appendChild(oc); scr.appendChild(ow);
    function kv(k, v) {
      if (v == null || v === '') return;
      var r = el('div', 'sdr');
      r.appendChild(el('span', 'sdk', k));
      if (v.nodeType) { if (!v.classList.contains('cprow')) v.classList.add('sdv'); r.appendChild(v); } else r.appendChild(el('span', 'sdv', v));
      oc.appendChild(r);
    }
    var ol = null;
    if (oid) { ol = el('a', null, oid); ol.href = uOrderUrl(oid); ol.target = '_blank'; ol.rel = 'noopener'; }
    kv('Order ID', ol);
    var bl = null;
    if (it.buyer) { bl = el('a', null, it.buyer); bl.href = '#'; bl.onclick = function (e) { e.preventDefault(); if (openChat('') === false) cn.textContent = '買い手 ID か ItemID が無いので Chat を開けません'; }; }
    kv('Buyer', bl);
    var trk = [o.carrier, o.tracking].filter(Boolean).join(' ');
    kv('追跡', trk ? uCopyField('sdv', trk, o.tracking) : '');   // コピーは追跡番号だけ (キャリアの窓にそのまま貼れるように・2026-10-15)
    // SpeedPAK (OC の番号) は CPaSS の DHL / FedEx の番号も出す (CSV Cpass の B → G・H)
    if (/^E[A-Z]\d/.test(o.tracking || '')) {
      var lm = el('div', 'sdr');
      oc.appendChild(lm);
      apiCall('GET', '/api/cpass-track?oc=' + encodeURIComponent(o.tracking)).then(function (r) {
        if (!r.tracking) { lm.remove(); return; }
        lm.appendChild(el('span', 'sdk', (r.carrier || 'CPaSS') + ' 追跡'));
        lm.appendChild(uCopyField('sdv', r.tracking));
        trkFill(r.carrier, r.tracking);
      }).catch(function () { lm.remove(); });
    }
    if (it.kind === 'late' || o.shipped) {
      var sd = dueDays(o.shipped || it.date, now);
      kv('発送', md(o.shipped || it.date) + (agoText(sd) ? ' (' + agoText(sd) + ')' : ''));
      kv('到着予定', md(o.est_min) && md(o.est_max) ? md(o.est_min) + '〜' + md(o.est_max) : md(o.est_max));
    } else {
      kv('起きた日', md(it.date));
      kv('理由', it.reason || it.state);
      kv('金額', money(it.amount, it.currency));
      kv('期限', it.due ? md(it.due) : '');
    }
    // キャリアの追跡: 4 社のボタン (販売シート E5〜E8 の 4 社)。この注文の番号が分かる社 (SpeedPAK は CPaSS の DHL / FedEx の番号も) は番号入りで開く (青)。
    // 分からない社は追跡ページの入口 (灰)。OC は URL で番号を渡せないので、経過をアプリの中に出す (/api/oc-track)・2026-10-15 窓から替えた
    var tw = el('div', 'sds'), tg = el('div', 'tkg'), tb = {}, ocBox = el('div', 'ocl');
    tw.appendChild(el('div', 'sdl', '追跡を調べる'));
    TRACK_SITES.forEach(function (d) {
      var b = el('a', 'sbt gy', d[0]);
      b.target = '_blank'; b.rel = 'noopener'; b.href = d[1]('');
      tb[d[0]] = b; tg.appendChild(b);
    });
    tw.appendChild(tg); tw.appendChild(ocBox); scr.appendChild(tw);
    trkFill(o.carrier, o.tracking);
    function trkFill(carrier, num) {
      if (!num) return;
      var c = String(carrier || '').toLowerCase();
      var name = /speedpak/.test(c) || /^E[A-Z]\d/.test(num) ? 'OC' : c.indexOf('fedex') >= 0 ? 'FedEx' : c.indexOf('dhl') >= 0 ? 'DHL' : c.indexOf('ups') >= 0 ? 'UPS' : '';
      var b = tb[name], d = TRACK_SITES.filter(function (x) { return x[0] === name; })[0];
      if (!b) return;
      b.href = d[1](num); b.className = 'sbt bl';
      if (d[2]) b.onclick = function (e) { e.preventDefault(); ocShow(num); };
    }
    function ocShow(num) {
      ocBox.textContent = ''; ocBox.appendChild(el('div', 'none', 'OC の追跡を取っています…'));
      apiCall('GET', '/api/oc-track?n=' + encodeURIComponent(num)).then(function (r) {
        ocBox.textContent = '';
        var w = r.waybill;
        if (!w) { ocBox.appendChild(el('div', 'fl', 'OC にこの番号の記録がありません')); return; }
        if (w.status) ocBox.appendChild(el('div', 'ocs', w.status));
        (w.traces || []).forEach(function (t) {
          var d = t.ts ? new Date(t.ts) : null, row = el('div', 'ocr');
          row.appendChild(el('div', 'oct', d ? (d.getMonth() + 1) + '/' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) : ''));
          row.appendChild(el('div', 'ocd', t.desc + (t.place ? ' (' + t.place + ')' : '')));
          ocBox.appendChild(row);
        });
      }).catch(function (e) {
        ocBox.textContent = ''; ocBox.appendChild(el('div', 'fl', '失敗: ' + (e && e.message ? e.message : e)));
      });
    }
    // 状況を選ぶ → 候補
    var sw = el('div', 'sds'), sg = el('div', 'sdg'), memo = el('textarea', 'sdq sdm'), go = el('button', 'sbt bl', '候補を作る'), cand = el('div', 'sdcd'), sel = '', mySeq = 0, btns = {};
    sw.appendChild(el('div', 'sdl', '状況を選ぶ'));
    memo.placeholder = '状況のメモ (日本語でよい)'; memo.hidden = true; memo.rows = 3; go.hidden = true; go.type = 'button';
    function ask() {
      var my = ++mySeq, text = memo.value.trim();
      if (sel === 'other' && !text) { cand.textContent = ''; cand.appendChild(el('div', 'fl', 'メモを書いてください')); return; }
      cand.textContent = ''; cand.appendChild(el('div', 'none', '候補を作っています…'));
      go.disabled = true;
      apiCall('POST', '/api/trouble-draft', trblPayload(it, sel, text, Date.now())).then(function (r) {
        if (my !== mySeq) return;
        cand.textContent = '';
        (r.options || []).forEach(function (op) { cand.appendChild(candCard(op)); });
      }).catch(function (e) {
        if (my !== mySeq) return;
        cand.textContent = ''; cand.appendChild(el('div', 'fl', '失敗: ' + (e && e.message ? e.message : e)));
      }).then(function () { go.disabled = false; });
    }
    TRBL_SITUATIONS.forEach(function (d) {
      var b = el('button', 'sbt gy', d[1]); b.type = 'button'; btns[d[0]] = b;
      b.onclick = function () {
        sel = d[0]; ++mySeq;
        Object.keys(btns).forEach(function (k) { btns[k].className = 'sbt ' + (k === sel ? 'bl' : 'gy'); });
        var other = sel === 'other';
        memo.hidden = !other; go.hidden = !other;
        if (other) { cand.textContent = ''; memo.focus(); } else ask();
      };
      sg.appendChild(b);
    });
    go.onclick = ask;
    sw.appendChild(sg); sw.appendChild(memo); sw.appendChild(go); sw.appendChild(cand); scr.appendChild(sw);
    // 候補 1 本 (英文 + 日本語訳)。「これを使う」で Chat の入力欄へ (会話が無い買い手は空の会話を作って開く)
    function candCard(op) {
      var w = el('div', 'sdcard'), use = el('button', 'sbt bl', 'これを使う'), note = el('div', 'inote');
      w.appendChild(el('div', 'sden', op.en));
      if (op.ja) w.appendChild(el('div', 'sdja', op.ja));
      use.type = 'button';
      use.onclick = function () {
        if (openChat(op.en) === false) note.textContent = '買い手 ID か ItemID が無いので Chat を開けません';
      };
      w.appendChild(use); w.appendChild(note);
      return w;
    }
    var cw = el('div', 'sds'), cb = el('button', 'sbt bw', 'Chat で書く'), cn = el('div', 'inote');
    cb.type = 'button';
    cb.onclick = function () { if (openChat('') === false) cn.textContent = '買い手 ID か ItemID が無いので Chat を開けません'; };
    cw.appendChild(cb); cw.appendChild(cn); scr.appendChild(cw);
    // 一番下に Archive (2026-10-16 ユーザー指示): 押すと「閉じた物」へ移す。アプリが覚えるだけで eBay へは何も送らない
    if (!it.closed && it.id) {
      var aw = el('div', 'sds'), ab = el('button', 'sbt bw', 'Archive'), an = el('div', 'inote');
      ab.type = 'button';
      ab.onclick = function () {
        ab.disabled = true;
        apiCall('POST', '/api/trouble-archive', { kind: it.kind, id: it.id }).then(function () { closeDetail(); load(false); })
          .catch(function (e) { ab.disabled = false; an.textContent = '失敗: ' + (e && e.message ? e.message : e); });
      };
      aw.appendChild(ab); aw.appendChild(an); scr.appendChild(aw);
    }
    // Chat を開く (text があれば Direct の窓に入れる・送信はしない)。買い手 ID か ItemID が無ければ何も動かさず false
    function openChat(text) {
      var c = window.mailClient, q = { mid: it.mid, buyer: it.buyer, item_id: it.item_id, title: it.title, pic: it.pic, price: priceOf(it), order: it.order };
      if (!c || !c.hasThread(q)) return false;
      showTab('mail');
      return c.openDraft(q, text);
    }
    root.hidden = false;
  }

  function build() {
    if (built) return;
    built = true;
    var root = $('troublesView');
    root.textContent = '';
    var hd = el('div', 'hd');
    hd.appendChild(el('h1', null, 'Management Tools'));   // 2026-10-14: 3 つのタブ共通の題
    root.appendChild(hd);
    root.appendChild(segBar('troubles'));
    var bar = el('div', 'bar'), lm = el('span', 'lm'), rf = uRefreshBtn(function () { sel = null; pickOpen = false; load(true); });   // 更新 = 今月に戻る   // 旧「最後に取った時刻 … [更新]」の行の替わり (動きは同じ)
    rf.id = 'trRf';
    lm.id = 'trLm';
    bar.appendChild(lm);
    bar.appendChild(rf);
    if (!GAS_MODE) PushUi.bell('late', bar, rf, function (t) { var x = $('trLm'); if (x) x.textContent = t; });   // 未配達の注意の通知 (2026-10-14)。配布版には通知が無い
    root.appendChild(bar);
    var rows = el('div'); rows.id = 'trRows'; root.appendChild(rows);
  }

  function stat(txt, ng) {   // 2026-10-14: 読んだ時刻の行は廃止。失敗の時だけ一覧の先頭に赤い 1 行を出す
    var host = $('trRows'), old = $('trStat');
    if (old) old.remove();
    if (!ng || !host) return;
    var s = el('div', 'fl', txt); s.id = 'trStat';
    host.insertBefore(s, host.firstChild);
  }

  function render(r) {
    var host = $('trRows'), total = 0, any = false;
    if (!host) return;
    host.textContent = '';
    SECTIONS.forEach(function (d) {
      var open = d[0] === 'late' || d[0] === 'unpaid' ? (r[d[0]] || []) : ((r.open || {})[d[0]] || []);
      var closed = (r.closed || {})[d[0]] || [];   // 未配達の閉じた物 = Archive した物だけ
      total += open.length;
      if (!open.length && !closed.length) return;
      any = true;
      host.appendChild(el('div', 'thd', d[1] + (open.length ? ' ' + open.length : '')));
      sortByDue(open).forEach(function (it) { host.appendChild(rowOf(it)); });
      if (closed.length) {
        var det = el('details', 'tcl');
        det.appendChild(el('summary', null, '閉じた物 (30 日) ' + closed.length + ' 件'));
        closed.forEach(function (it) { det.appendChild(rowOf(it)); });
        host.appendChild(det);
      }
    });
    if (!any) host.appendChild(el('div', 'none', '表示する物はありません'));
    setTroubleN(total);
  }

  function load(fresh) {
    var my = ++seq, rf = $('trRf');
    if (rf) rf.disabled = true;
    stat('取得中…');
    var sp = apiCall('GET', '/api/sales' + (GAS_MODE ? '?cached=1' : '')).then(function (s) {   // 配布版は Order の一覧を新しく取りに行かない (Gmail と GetOrders が重い)。開いたことのある分の控えだけ
      salesBy = {};
      (s.items || []).forEach(function (x) { if (x.order_id) salesBy['o' + x.order_id] = x; if (x.item_id && !salesBy['i' + x.item_id]) salesBy['i' + x.item_id] = x; });
    }).catch(function () { /* 読めなければ 4 行目は空のまま (Status の中身は出す) */ });
    Promise.all([apiCall('GET', '/api/troubles' + (fresh ? '?fresh=1' : '')), sp]).then(function (rs) {
      var r = rs[0];
      if (my !== seq) return;
      render(r);
      stat(r.error || '', !!r.error);
    }).catch(function (e) {
      if (my === seq) stat('失敗: ' + (e && e.message ? e.message : e), true);
    }).then(function () { if (my === seq) { var b = $('trRf'); if (b) b.disabled = false; } });
  }

  function show(on) {
    document.body.classList.toggle('tab-troubles', !!on);
    if (on) { build(); load(false); }
  }

  // 起動時: タブの数だけ先に出す (サーバーは 10 分以内なら eBay を呼ばず控えを返す)
  document.addEventListener('DOMContentLoaded', function () {
    apiCall('GET', '/api/troubles' + (GAS_MODE ? '?badge=1' : '')).then(function (r) {   // 配布版は件数だけ (控えを返す・eBay は呼ばない)。Status を開く・更新ボタンで取りに行く
      setTroubleN(SECTIONS.reduce(function (n, d) { return n + (d[0] === 'late' || d[0] === 'unpaid' ? (r[d[0]] || []) : ((r.open || {})[d[0]] || [])).length; }, 0));
    }).catch(function () { /* 数が出ないだけ。タブを開けば取り直す */ });
  });
  return { show: show, closeDetail: closeDetail };
})();

// ================================================================== 販売データのタブ (販売シートの売れた注文を新しい順に・2026-10-13)
// データは /api/sales (読むだけ。シートにも eBay にも何も書かない)。1 件を押すとその注文の画面 (会話の画面と同じ頭・カード・ボタン。Spreadsheet のボタンは置かない)。
// 金額・買い手・売れた日は販売処理完了メールから (販売シートに無い)。メールが見つからない行は空欄 (買い手と売れた日は注文の控えで補えれば出る)。
// 未読: まだ開いていない行はサムネの右上に緑の点 (2026-10-14 に「Sold」の文字から替えた)。開くと /api/sales-read でサーバーに覚える (メールの済みと同じ = 端末をまたいで共通)。
// サムネ: 一覧に写真が無い行の ItemID だけ /api/item-pics (GetItem) で取る。取れた物はサーバーが覚え、取れなかった物は 6 時間は呼び直さない。
var SalesUi = (function () {
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var built = false, seq = 0;

  function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? u : ''; }   // javascript: などは出さない
  function md(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    return m ? (+m[2]) + '月' + (+m[3]) + '日' : '';
  }
  function ini(it) { return ((it.buyer || it.title || '?').charAt(0) || '?').toUpperCase(); }
  function thumb(it) {
    if (safeUrl(it.pic)) {
      var im = el('img', 'pic');
      im.src = it.pic; im.alt = ''; im.loading = 'lazy';
      im.onerror = function () { im.replaceWith(el('div', 'ini', ini(it))); };
      return im;
    }
    return el('div', 'ini', ini(it));
  }

  // 一覧の 1 行 (3 つのタブ共通の uRow・2026-10-14): 写真 (未読は右上に緑の点) + 売価 / 買い手 + 売れた日 / 商品名 / OrderID / 予定利益 送料 仕入先 仕入額 仕入れ時送料 (ラベル無し・値が無い物は出さない)
  function rowOf(it) {
    var dt = el('div', 'dt'), sb = it.trouble ? null : shipBadge(it.ship_class);   // キャンセル・返品・一部返金の行は配送の印を出さない (2026-10-20)
    if (sb) dt.appendChild(sb);
    dt.appendChild(el('span', null, md(it.sold_ymd)));
    if (it.bundle) dt.appendChild(el('span', 'aib', '同梱'));
    if (it.pending) dt.appendChild(el('span', 'aib', 'Request'));   // 手動対応 (利益計算表と結び付いていない注文・2026-10-15)
    var ids = el('div', 'tids');
    if (it.order_id) ids.appendChild(el('span', null, it.order_id));
    uSupply(it, ids);
    var nums = it.trouble ? uTrouble(it) : uNums(it);
    var row = uRow({ thumb: thumb(it), dot: !!it.unread, price: it.amount || '', name: buyerLink(it.buyer || '(買い手不明)'), right: dt, title: it.title || ('ItemID ' + it.item_id), ids: ids, detail: nums, due: ordDue(it.handle_by) });
    row._it = it;
    row.onclick = function () { markRead(it, row); closeDetails('sale'); openDetail(it); };
    return row;
  }
  function markRead(it, row) {
    if (!it.unread) return;
    it.unread = false;
    var b = row._pw.querySelector('.udot');
    if (b) b.remove();
    apiCall('POST', '/api/sales-read', { key: it.key }).catch(function (e) {
      var x = $('saleLm'); if (x) x.textContent = '既読を保存できませんでした: ' + (e && e.message ? e.message : e);
    });
  }
  // 写真の無い行の ItemID だけ取りに行く (12 件ずつ・順に)。取れたら一覧のサムネを差し替える
  function fillPics(items, my) {
    var ids = [];
    items.forEach(function (it) { if (!it.pic && /^\d{9,13}$/.test(it.item_id) && ids.indexOf(it.item_id) < 0) ids.push(it.item_id); });
    (function next() {
      if (!ids.length || my !== seq) return;
      apiCall('POST', '/api/item-pics', { ids: ids.splice(0, 12) }).then(function (r) {
        items.forEach(function (it) { var u = safeUrl(r.pics && r.pics[it.item_id]); if (u && !it.pic) it.pic = u; });
        Array.prototype.forEach.call(document.querySelectorAll('#saleRows .row'), function (row) {
          if (row._it && row._it.pic && row._pw.firstChild.tagName !== 'IMG') row._pw.replaceChild(thumb(row._it), row._pw.firstChild);
        });
      }).catch(function () { /* 写真が取れなくても一覧は頭文字の丸で使える。次に開いた時にまた試す */ }).then(next);
    })();
  }

  // ---- 詳細 (頭に買い手の名前・大きい写真と金額・ORDER と仕入れの一覧・ボタン)
  function closeDetail() {
    var v = $('saleView');
    if (v) { v.hidden = true; v.textContent = ''; }
    ItemsUi.place(curTab);                 // 詳細の一番下へ移していた検索窓を、開いているタブの下へ戻す
  }
  // 探すサイト。URL は本体SS の仕入先検索 (Tool_Fixed.gs.js の SUPPLIER_SEARCH_SITES・2026-09-07 にブラウザで確認済み) と同じ物。
  // Yahoo!フリマ と 楽天 は検索語がパスに入る。変える時は両方を一緒に直す
  var FIND_SITES = [
    { name: 'メルカリ', pre: 'https://jp.mercari.com/search?keyword=', post: '&status=on_sale&sort=price&order=asc' },   // 販売中だけ・安い順 (research_search.py と同じ絞り込み)
    { name: 'ヤフオク', pre: 'https://auctions.yahoo.co.jp/search/search?p=', post: '' },
    { name: 'ラクマ', pre: 'https://fril.jp/s?query=', post: '' },
    { name: 'Yahoo!フリマ', pre: 'https://paypayfleamarket.yahoo.co.jp/search/', post: '' },
    { name: 'ハードオフ', pre: 'https://netmall.hardoff.co.jp/search/?q=', post: '' },
    { name: '楽天', pre: 'https://search.rakuten.co.jp/search/mall/', post: '/' },
    { name: 'Yahoo!ショッピング', pre: 'https://shopping.yahoo.co.jp/search?p=', post: '' }
  ];
  // 商品名から型番らしい語 (英字と数字の両方を含む 3 文字以上)。items.py の model_tokens と同じ決まり
  function modelTokens(title) {
    var out = [], seen = {};
    (String(title || '').match(/[A-Za-z0-9][A-Za-z0-9\-\/]*[A-Za-z0-9]/g) || []).forEach(function (w) {
      if (w.length >= 3 && /[A-Za-z]/.test(w) && /\d/.test(w) && !seen[w.toLowerCase()]) { seen[w.toLowerCase()] = 1; out.push(w); }
    });
    return out;
  }
  function btn(label, href, cls) {
    var u = safeUrl(href), b = el(u ? 'a' : 'span', 'sbt ' + cls + (u ? '' : ' off'), label);
    if (u) { b.href = u; b.target = '_blank'; b.rel = 'noopener'; }
    return b;
  }
  function openDetail(it) {
    var root = $('saleView');
    root.textContent = '';
    var top = el('div', 'top'), back = el('button', 'back', '‹');
    back.onclick = closeDetail;
    var who = buyerLink(it.buyer || '(買い手不明)');
    who.classList.add('who');
    top.appendChild(back); top.appendChild(who);
    if (it.bundle) top.appendChild(el('span', 'aib', '同梱'));
    top.appendChild(it.pending ? el('span', 'sdsold tr', 'REQUEST') : el('span', 'sdsold', 'SOLD'));
    root.appendChild(top);
    // 2026-10-15 ユーザー指示: 一覧の行と同じ形 (写真 + 売価 / 買い手 / 商品名 コピー / OrderID ItemID コピー / Spreadsheet N 行目)。画面の上に固定 (下の .scr だけがスクロール)
    var title = it.title || ('ItemID ' + it.item_id);
    var hids = el('div', 'tids'), pic = thumb(it);
    if (it.order_id) hids.appendChild(el('span', null, it.order_id));
    if (it.item_id) hids.appendChild(uCopyField('sid', 'ItemID ' + it.item_id, String(it.item_id)));
    if (safeUrl(it.my_listing)) {                                       // 写真を押すと eBay の出品 (旧 Listing Item のカードと同じ行き先)
      var pa = el('a', 'tlk'); pa.href = it.my_listing; pa.target = '_blank'; pa.rel = 'noopener';
      pa.appendChild(pic); pic = pa;
    }
    var hdt = el('div', 'dt'); hdt.appendChild(el('span', null, md(it.sold_ymd)));
    var hdr = el('div', 'sfix');
    hdr.appendChild(uRow({ thumb: pic, price: it.amount || '', name: buyerLink(it.buyer || '(買い手不明)'), right: hdt, title: uCopyField('stt', title), ids: hids, detail: it.row ? 'Spreadsheet ' + it.row + ' 行目' : '' }));
    root.appendChild(hdr);
    var scr = el('div', 'scr sdx');
    root.appendChild(scr);
    if (it.bundle) {   // 同梱の注文
      var pg = it.piggyback, ban = el('div', 'sbn');
      ban.appendChild(el('div', null, '[同梱発送注文]' + (pg ? ' ' + pg.seq + ' 件目 / 全 ' + pg.total + ' 件' : '')));
      if (it.order_id) ban.appendChild(el('div', 'sbs', 'OrderID: ' + it.order_id));
      if (pg && pg.siblings && pg.siblings.length) {
        ban.appendChild(el('div', 'sbs', '既処理商品 (' + pg.siblings.length + ' 件):'));
        pg.siblings.forEach(function (x) { ban.appendChild(el('div', 'sbs', '・' + x.substring(0, 80))); });
      }
      scr.appendChild(ban);
    }
    // 2026-10-14 ユーザー指示 (控えは .backups/mail-app-order-detail-2026-10-14): Listing Management と同じサムネつきカード。Listing Item は 2026-10-15 に上の固定の行へ移した
    var cards = el('div', 'sds');
    function card(label, href, rows, off) {
      var c = el(href ? 'a' : 'div', 'pcard' + (off ? ' off' : '')), im = el('img', 'pth'), tx = el('div', 'ptx');
      if (href) { c.href = href; c.target = '_blank'; c.rel = 'noopener'; }
      im.alt = ''; if (safeUrl(it.pic)) im.src = it.pic;
      tx.appendChild(el('div', 'plb', label));
      rows.forEach(function (n) { tx.appendChild(n); });
      c.appendChild(im); c.appendChild(tx); cards.appendChild(c);
    }
    function costText() {
      return '仕入れ値 ' + (it.cost == null ? '-' : yen2(it.cost)) + ' ・ 送料 ' + (it.ship == null ? '-' : yen2(it.ship));
    }
    var supSub = el('div', 'psb', costText());
    card('Supplier', safeUrl(it.supplier_url), [el('div', 'ptt', it.shop || '(仕入先なし)'), supSub], !safeUrl(it.supplier_url));
    scr.appendChild(cards);
    function sec(label) {
      var w = el('div', 'sds');
      w.appendChild(el('div', 'sdl', label));
      var c = el('div', 'sdc'); w.appendChild(c); scr.appendChild(w);
      return c;
    }
    function kv(c, k, v) {                                              // 値が無い行は出さない
      if (v == null || v === '') return;
      var r = el('div', 'sdr');
      r.appendChild(el('span', 'sdk', k));
      if (v.nodeType) { v.classList.add('sdv'); r.appendChild(v); } else r.appendChild(el('span', 'sdv', v));
      c.appendChild(r);
    }
    var oc = sec('Order details');
    kv(oc, '買い手', it.buyer ? buyerLink(it.buyer) : '');
    var oid = '';
    if (it.order_id) {                                                  // 押すと eBay の注文の詳細 (ステータスのタブと同じ行き先)
      oid = el('a', null, it.order_id);
      oid.href = 'https://www.ebay.com/sh/ord/details?orderid=' + encodeURIComponent(it.order_id); oid.target = '_blank'; oid.rel = 'noopener';
    }
    kv(oc, 'Order ID', oid);
    kv(oc, '売れた日', it.date_sold || md(it.sold_ymd));
    kv(oc, '配送', it.ship_class);                                    // 買い手が選んだ配送 (Expedited / Economy / Other・2026-10-19)
    kv(oc, '記録した時刻', it.recorded_at);
    if (!it.has_mail) scr.appendChild(el('div', 'info sdn', '販売処理完了メールが見つからないため、金額などが空の項目があります'));
    // 仕入れ: Listing Management と同じ編集の行 (左のアイコンボタン + ¥ + 入力欄)。押すと販売シートの J (仕入価格)・K (着払送料) だけを /api/sales-cost で書く。空の欄は触らない
    var sw = el('div', 'sds'), box = el('div', 'calc'), msg = el('div', 'inote'), busy = false, E = {};
    sw.appendChild(el('div', 'sdl', '仕入れ'));
    var canEdit = !!it.row && /^\d{9,13}$/.test(String(it.item_id || ''));
    function numOk(kind, s) {
      s = String(s).trim().replace(/,/g, '');
      if (!/^\d+(\.\d+)?$/.test(s)) return null;
      var v = +s;
      return kind === 'cost' ? (v > 0 ? v : null) : v;
    }
    function say(t, ng) { msg.className = 'inote' + (ng ? ' ng' : ''); msg.textContent = t; }
    function refreshBtns() { ['cost', 'ship'].forEach(function (k) { E[k].b.disabled = !E[k].b.canPress(); }); }
    function editRow(kind, label, name) {
      var inp = el('input'), b = el('button', 'iupd'), r = el('div', 'srow'), w = el('span', 'sv');
      inp.type = 'text'; inp.inputMode = 'decimal'; inp.autocomplete = 'off';
      inp.value = it[kind] == null ? '' : String(it[kind]);
      b.type = 'button'; b.title = name + 'をシートに書き込む'; b.setAttribute('aria-label', name + 'をシートに書き込む');
      b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>';
      b.canPress = function () { var v = numOk(kind, inp.value); return canEdit && !busy && v !== null && v !== it[kind]; };
      b.onclick = function () { send(kind); };
      inp.oninput = refreshBtns;
      inp.addEventListener('focus', function () { inp.dataset.was = inp.value; inp.value = ''; refreshBtns(); });   // 押したら空にしてすぐ打てるようにする (2026-10-18 ユーザー指示)
      inp.addEventListener('blur', function () { if (inp.value.trim() === '' && inp.dataset.was) { inp.value = inp.dataset.was; refreshBtns(); } });   // 何も打たずに離れたら元の値に戻す
      r.appendChild(el('span', 'sk', label));
      w.appendChild(b); w.appendChild(el('span', 'cur', '¥')); w.appendChild(inp);
      r.appendChild(w); box.appendChild(r);
      E[kind] = { b: b, inp: inp };
    }
    function listRowRefresh() {   // 一覧の行の値も更新する
      Array.prototype.some.call(document.querySelectorAll('#saleRows .row'), function (row) {
        if (row._it === it) { row.replaceWith(rowOf(it)); return true; }
        return false;
      });
    }
    function send(kind) {
      if (!E[kind].b.canPress()) return;
      busy = true; refreshBtns(); say('書き込み中…');
      apiCall('POST', '/api/sales-cost', { row: it.row, item_id: String(it.item_id), old_cost: it.cost, old_ship: it.ship, cost: kind === 'cost' ? E.cost.inp.value : '', ship: kind === 'ship' ? E.ship.inp.value : '' }).then(function (r) {
        busy = false;
        if (r && !r.ok && 'now_cost' in r) {     // シートの値が先に変わっていた (自動更新など)。画面の値をシートの今の値に直して赤で知らせる
          it.cost = r.now_cost; it.ship = r.now_ship;
          E.cost.inp.value = it.cost == null ? '' : String(it.cost); E.ship.inp.value = it.ship == null ? '' : String(it.ship);
          supSub.textContent = costText(); listRowRefresh();
        }
        if (!r || !r.ok) { say((r && r.message) || '書き込めませんでした', true); refreshBtns(); return; }
        var parts = [];
        if (r.new_cost != null) { parts.push('仕入れ値 ' + yen2(r.old_cost) + ' → ' + yen2(r.new_cost)); it.cost = r.new_cost; E.cost.inp.value = String(r.new_cost); }
        if (r.new_ship != null) { parts.push('送料 ' + yen2(r.old_ship) + ' → ' + yen2(r.new_ship)); it.ship = r.new_ship; E.ship.inp.value = String(r.new_ship); }
        supSub.textContent = costText(); listRowRefresh();
        say('反映しました: ' + parts.join(' / '));
        refreshBtns();
      }).catch(function (e) { busy = false; say((e && e.message) || '書き込めませんでした', true); refreshBtns(); });
    }
    editRow('cost', '仕入れ値', '仕入れ値');
    editRow('ship', '送料', '送料');
    box.appendChild(msg); sw.appendChild(box); scr.appendChild(sw);
    refreshBtns();
    // Supplier / Hapitas / Moppy は白黒の丸ボタン (押した時の動きは元のまま)
    var bw = el('div', 'sds'), b0 = el('div', 'sbb'), sup = btn('Supplier', it.supplier_url, 'bw'), b1 = el('div', 'sbb');
    if (it.shop) sup.appendChild(el('span', 'sbshop', it.shop));
    b0.appendChild(sup); bw.appendChild(b0);
    b1.appendChild(btn('Hapitas', 'https://hapitas.jp/', 'bw')); b1.appendChild(btn('Moppy', 'https://ssl.pc.moppy.jp/', 'bw'));
    bw.appendChild(b1);
    scr.appendChild(bw);
    // 他のサイトで探す (2026-10-14 ユーザー指示): 商品名から拾った型番を入れておき (直せる)、押すとそのサイトの検索結果を開く
    var fw = el('div', 'sds'), fq = el('input', 'sdq'), fg = el('div', 'sdg');
    fw.appendChild(el('div', 'sdl', '他のサイトで探す'));
    fq.type = 'text'; fq.placeholder = '型番・商品名'; fq.autocomplete = 'off'; fq.setAttribute('aria-label', '探す言葉');
    fq.value = modelTokens(title)[0] || '';
    fw.appendChild(fq);
    var links = FIND_SITES.map(function (st) {
      var a = el('a', 'sbt gy', st.name);
      a.target = '_blank'; a.rel = 'noopener'; a._st = st;
      a.onclick = function (e) { if (!fq.value.trim()) { e.preventDefault(); fq.focus(); } };
      fg.appendChild(a);
      return a;
    });
    function setLinks() {
      var q = encodeURIComponent(fq.value.trim());
      links.forEach(function (a) { a.href = a._st.pre + q + a._st.post; });
    }
    fq.oninput = setLinks; setLinks();
    fw.appendChild(fg);
    scr.appendChild(fw);
    if (it.pending) matchSec(it, scr, title);
    {
      var foot = el('div', 'sdf'), host = el('div', 'ishost sdhost');     // 一番下に商品の検索窓 (タブの下の窓と同じ物を移す)
      foot.appendChild(host); scr.appendChild(foot);
      ItemsUi.attach(host);
    }
    root.hidden = false;
  }

  // ---- 一致候補 (手動対応・2026-10-15): 利益計算表から探して選ぶ = 販売シートの G に ItemID を書く (メールの「アプリで一致候補を選ぶ」と同じ)。
  // カードは Listing Item / Supplier と同じ形。候補に無い時は ItemID を直接入れる
  function matchSec(it, scr, title) {
    var w = el('div', 'sds'), q = el('input', 'sdq'), msg = el('div', 'inote'), list = el('div', 'mcl'), my = 0, tm = null, busy = false;
    w.appendChild(el('div', 'sdl', '一致候補'));
    q.type = 'text'; q.placeholder = '利益計算表を探す'; q.autocomplete = 'off'; q.setAttribute('aria-label', '利益計算表を探す言葉');
    q.value = String(title || '').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');   // GAS の手動マッチと同じ = 商品名の先頭 2 語
    w.appendChild(q); w.appendChild(msg); w.appendChild(list);
    var dr = el('div', 'mdr'), di = el('input', 'sdq'), db = el('button', 'sbt bl', '書く');
    di.type = 'text'; di.inputMode = 'numeric'; di.placeholder = '候補に無い時は ItemID (12 桁)'; di.autocomplete = 'off';
    db.type = 'button'; db.onclick = function () { pick(di.value.replace(/\s+/g, ''), ''); };
    dr.appendChild(di); dr.appendChild(db); w.appendChild(dr);
    scr.appendChild(w);
    function say(t, ng) { msg.className = 'inote' + (ng ? ' ng' : ''); msg.textContent = t; }
    if (it.picked) say('ItemID ' + it.picked + ' を販売シートに書きました。5 分以内に販売処理が進みます');
    function mark() {                        // 書いた ItemID の候補の Select だけ色を変える
      Array.prototype.forEach.call(list.querySelectorAll('.msel'), function (b) { b.classList.toggle('on', b._iid === it.picked); });
    }
    function pick(iid, name) {
      if (busy) return;
      if (!/^\d{12}$/.test(iid)) { say('ItemID は 12 桁の数字です', true); return; }
      if (!window.confirm((name ? name + '\n' : '') + 'ItemID ' + iid + ' で販売処理します')) return;
      busy = true; say('書き込み中…');
      apiCall('POST', '/api/sales-match', { row: it.row, order_id: it.order_id, item_id: iid }).then(function (r) {
        busy = false;
        if (!r || !r.ok) { say((r && r.message) || '書き込めませんでした', true); return; }
        it.picked = iid; mark();
        say('ItemID ' + iid + ' を販売シートに書きました。5 分以内に販売処理が進みます');
      }).catch(function (e) { busy = false; say((e && e.message) || '書き込めませんでした', true); });
    }
    function card(x) {                       // 2026-10-15 ユーザー指示: 一覧の行と同じ形 (コピーのボタンは無し)。1 行目 US + ItemID / 2 行目 商品名 / 3 行目 空き / 4 行目 利益計算表 N 行目 + 右端に Select
      var im = el('img', 'pic'), b = el('button', 'msel', 'Select');
      im.alt = '';
      var c = uRow({ cls: 'mrow', thumb: im, price: x.price == null ? '' : '$' + Number(x.price).toFixed(2), name: el('span', null, 'US ' + x.item_id), right: el('span'), title: x.title });   // 1 行目 = US の出品の ItemID (GE などで売れた出品と照合する・2026-10-15 ユーザー指示。仕入先は出さない)
      var l4 = c.querySelector('.tdt');
      l4.classList.add('hasdue');
      l4.appendChild(el('span', 'udl', '利益計算表 ' + x.row + ' 行目'));
      b.type = 'button'; b._iid = x.item_id; b.onclick = function () { pick(x.item_id, x.title); };
      l4.appendChild(b);
      c._iid = x.item_id; c._im = im;
      return c;
    }
    function pics(cards, me) {               // サムネは一覧と同じ /api/item-pics (12 件ずつ)
      var ids = cards.map(function (c) { return c._iid; });
      (function next() {
        if (!ids.length || me !== my) return;
        apiCall('POST', '/api/item-pics', { ids: ids.splice(0, 12) }).then(function (r) {
          cards.forEach(function (c) { var u = safeUrl(r.pics && r.pics[c._iid]); if (u && !c._im.src) c._im.src = u; });
        }).catch(function () { /* 写真が無くても候補は選べる */ }).then(next);
      })();
    }
    function load() {
      var s = q.value.trim(), me = ++my;
      list.textContent = '';
      if (!s) return;
      list.appendChild(el('div', 'none', '探しています…'));
      apiCall('GET', '/api/sales-cands?q=' + encodeURIComponent(s)).then(function (r) {
        if (me !== my) return;
        list.textContent = '';
        var cs = (r.items || []).map(card);
        if (!cs.length) list.appendChild(el('div', 'none', '候補がありません。言葉を減らすか ItemID を直接入れてください'));
        cs.forEach(function (c) { list.appendChild(c); });
        mark();
        pics(cs, me);
      }).catch(function (e) {
        if (me !== my) return;
        list.textContent = ''; list.appendChild(el('div', 'fl', '失敗: ' + (e && e.message ? e.message : e)));
      });
    }
    q.oninput = function () { clearTimeout(tm); tm = setTimeout(load, 400); };
    load();
  }

  // ---- 仕入れ値・送料の書き込みは詳細の「仕入れ」の行 (openDetail の中)。別画面 openCost は 2026-10-14 に削除
  function yen2(n) { return n == null ? '-' : '¥' + Math.round(n).toLocaleString('ja-JP'); }

  // ---- 一覧
  function build() {
    if (built) return;
    built = true;
    var root = $('salesView');
    root.textContent = '';
    var hd = el('div', 'hd');
    hd.appendChild(el('h1', null, 'Management Tools'));   // 2026-10-14: 3 つのタブ共通の題 (旧: 販売データ + 読んだ時刻)
    root.appendChild(hd);
    root.appendChild(segBar('sales'));
    var bar = el('div', 'bar'), lm = el('span', 'lm'), rf = uRefreshBtn(function () { load(); });   // 更新は一番右 (ベルは更新の左に差し込む)
    lm.id = 'saleLm';
    bar.appendChild(lm);
    bar.appendChild(rf);
    root.appendChild(bar);
    (GAS_MODE ? ['sales'] : ['sales', 'thanks', 'ship']).forEach(function (k) {   // 配布版の Bark は売れた知らせ (sales) だけ
      PushUi.bell(k, bar, rf, function (t) { var x = $('saleLm'); if (x) x.textContent = t; });
    });
    var rows = el('div'); rows.id = 'saleRows'; root.appendChild(rows);
  }

  function load() {
    var my = ++seq, rows = $('saleRows');
    if (rows && !rows.firstChild) rows.appendChild(el('div', 'none', '読み込み中…'));
    apiCall('GET', '/api/sales').then(function (r) {
      if (my !== seq || !rows) return;
      rows.textContent = '';
      var err = [r.error, r.mail_error].filter(Boolean).join(' / ');
      if (err) rows.appendChild(el('div', 'fl', err));
      (r.items || []).forEach(function (it) { rows.appendChild(rowOf(it)); });
      if (!(r.items || []).length) rows.appendChild(el('div', 'none', '売れた注文はまだありません'));
      if (wantOrder) {                    // 手動対応の通知から来た時は、その注文の詳細を開く (2026-10-15)
        var w = wantOrder; wantOrder = '';
        (r.items || []).some(function (it) { if (it.order_id === w) { closeDetails('sale'); openDetail(it); return true; } return false; });
      }
      fillPics(r.items || [], my);
    }).catch(function (e) {
      if (my !== seq || !rows) return;
      rows.textContent = '';
      rows.appendChild(el('div', 'fl', '失敗: ' + (e && e.message ? e.message : e)));
    });
  }

  var wantOrder = '';
  function show(on) {
    document.body.classList.toggle('tab-sales', !!on);
    if (on) { build(); closeDetail(); load(); }
  }
  return { show: show, closeDetail: closeDetail, want: function (o) { wantOrder = o || ''; } };
})();

// ================================================================== Summary のタブ (2026-10-15 ユーザー指示)
// 集計シートの月利ダッシュボード (MonthlyReport.gs.js の _renderMonthlyDashboard_) と同じ中身を、このアプリの見た目で出す。
// データは /api/summary (読むだけ)。グラフは SVG と CSS の棒だけ (外部ライブラリなし)。更新ボタン = ?fresh=1 で読み直す。
var SummaryUi = (function () {
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var built = false, seq = 0;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var GREEN = '#1a8f3c';

  // 数字の書き方は GAS の _fmtJpy_ / _fmtUsd_ / _fmtPct_ と同じ
  function yen(n) { n = Number(n) || 0; return (n < 0 ? '-' : '') + '¥' + Math.round(Math.abs(n)).toLocaleString('en-US'); }
  function usd(n) { n = Number(n) || 0; return (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct(n) { return (Number(n) || 0).toFixed(2) + '%'; }
  function num(n) { return String(Number(n) || 0); }

  function sv(tag, attrs, text) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }

  // 12 か月の棒グラフ。今月だけ緑・他は灰色。今月より先と 0 の月は薄い細い棒。avg を渡すと破線 (平均)
  function barChart(vals, cur, fmt, avg, last) {
    last = last || cur;   // cur = 緑にする月 (選んだ月)・last = 実際の今月 (これより先は薄い棒)
    var W = 360, H = 150, top = 22, bot = 18, px = 4, bw = (W - px * 2) / 12, bar = bw * 0.62, base = H - bot, hh = base - top;
    var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', role: 'img' });
    svg.setAttribute('class', 'smch');
    var max = 1;
    vals.forEach(function (v) { if (v > max) max = v; });
    if (avg > max) max = avg;
    svg.appendChild(sv('line', { x1: px, x2: W - px, y1: base, y2: base, stroke: '#e0e0e0', 'stroke-width': 1 }));
    vals.forEach(function (v, i) {
      var x = px + i * bw + (bw - bar) / 2, on = i + 1 === cur, h = v > 0 ? Math.max(2, v / max * hh) : 0;
      if (v > 0 && i + 1 <= last) {
        svg.appendChild(sv('rect', { x: x, y: base - h, width: bar, height: h, rx: 2, fill: on ? GREEN : '#b9b9b9' }));
      } else {
        svg.appendChild(sv('rect', { x: x, y: base - 2, width: bar, height: 2, rx: 1, fill: v < 0 ? '#e53238' : '#e6e6e6' }));   // 売りが無い月・先の月
      }   // 2026-10-16 ユーザー指示: 図の字も補足と同じ 12px (文字の 5 段)
      svg.appendChild(sv('text', { x: x + bar / 2, y: H - 4, 'text-anchor': 'middle', 'font-size': 12, fill: on ? '#111' : '#707070', 'font-weight': on ? 700 : 400 }, String(i + 1)));
      if (on && v > 0) {
        svg.appendChild(sv('text', { x: Math.min(W - 30, Math.max(30, x + bar / 2)), y: base - h - 5, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: '#111' }, fmt(v)));
      }
    });
    if (avg > 0) {
      var ay = base - avg / max * hh;
      svg.appendChild(sv('line', { x1: px, x2: W - px, y1: ay, y2: ay, stroke: '#707070', 'stroke-width': 1, 'stroke-dasharray': '4 3' }));
    }
    return svg;
  }

  // 国別の横棒 (内訳の文字 "US 132 UK 27 ..." → 国 + 棒 + 件数)
  function countryBars(pairs) {
    var box = el('div', 'smcb'), max = 1;
    pairs.forEach(function (p) { if (p[1] > max) max = p[1]; });
    if (!pairs.length) { box.appendChild(el('div', 'smnote', 'まだありません')); return box; }
    pairs.forEach(function (p) {
      var r = el('div', 'smcr'), tr = el('div', 'smtr'), fl = el('div', 'smfl');
      fl.style.width = Math.max(2, p[1] / max * 100) + '%';
      tr.appendChild(fl);
      r.appendChild(el('span', 'smcc', p[0]));
      r.appendChild(tr);
      r.appendChild(el('span', 'smcn', String(p[1])));
      box.appendChild(r);
    });
    return box;
  }

  function card(lab, val, sub, green) {
    var c = el('div', 'smcard');
    c.appendChild(el('div', 'smlb', lab));
    c.appendChild(el('div', 'smv' + (green ? ' g' : ''), val));
    c.appendChild(el('div', 'smsb', sub));
    return c;
  }
  function panel(title, sub, body) {
    var p = el('div', 'smpanel');
    p.appendChild(el('div', 'smpt', title));
    if (sub) p.appendChild(el('div', 'smpsub', sub));
    p.appendChild(body);
    return p;
  }

  // ---- 月選択・詳細・先月比 (2026-10-19 ユーザー指示)。sel = 選んだ月 (null = 今月)・更新ボタンで今月に戻る
  var sel = null, data = null;

  // 先月比の 1 行。先月が 0 の月は比べられないので「—」。kind: 'yen' | 'usd' | 'n' | 'pt'
  // 集計でマイナスの項目 (手数料・広告費・返金など・2026-10-20 ユーザー指示) は大きさ (絶対値) で比べる = 費用が増えたら +・赤 / 減ったら -・緑
  function isCost(curV, prevV) { return curV < 0 || prevV < 0; }
  function diffText(curV, prevV, kind) {
    var f = kind === 'yen' ? yen : kind === 'usd' ? usd : kind === 'pt' ? function (n) { return n.toFixed(2) + 'pt'; } : function (n) { return n.toFixed(2); };
    if (!prevV) return '先月比 —';
    if (isCost(curV, prevV)) { curV = Math.abs(curV); prevV = Math.abs(prevV); }
    var dv = curV - prevV, sign = dv > 0 ? '+' : dv < 0 ? '-' : '';
    var t = '先月比 ' + sign + f(Math.abs(dv));
    if (kind !== 'pt') t += ' (' + (dv >= 0 ? '+' : '-') + Math.abs(dv / prevV * 100).toFixed(1) + '%)';
    return t;
  }
  function diffEl(curV, prevV, kind) {
    var e = el('div', 'smdf', diffText(curV, prevV, kind));
    var up = isCost(curV, prevV) ? Math.abs(curV) - Math.abs(prevV) > 0 : curV - prevV < 0;   // 赤 = 悪くなった
    if (prevV && up) e.className += ' neg';
    return e;
  }
  function card2(labEl, val, sub, green, df) {
    var c = el('div', 'smcard');
    c.appendChild(labEl);
    c.appendChild(el('div', 'smv' + (green ? ' g' : ''), val));
    c.appendChild(el('div', 'smsb', sub));
    if (df) c.appendChild(df);
    return c;
  }

  // 販売 ($) の内訳の横積み棒 (手数料・広告費・返金・手元 = 100%)。灰色の濃淡 + 緑
  function stackBar(segs) {
    var box = el('div', 'smstk');
    segs.forEach(function (sg) {
      if (sg.pct <= 0) return;
      var x = el('div', 'smseg'); x.style.width = sg.pct + '%'; x.style.background = sg.color;
      box.appendChild(x);
    });
    return box;
  }
  function legendRow(color, name, val, pctStr, df) {
    var r = el('div', 'smlg'), dot = el('span', 'smdot'), top = el('div', 'smlgt');
    dot.style.background = color;
    top.appendChild(dot); top.appendChild(el('span', 'smlgn', name)); top.appendChild(el('span', 'smlgv', val)); top.appendChild(el('span', 'smlgp', pctStr));
    r.appendChild(top);
    if (df) r.appendChild(df);
    return r;
  }
  function detRow(k, v, df) {
    var r = el('div', 'smdr'), t = el('div', 'smdt');
    t.appendChild(el('span', 'smdk', k)); t.appendChild(el('span', 'smdv', v));
    r.appendChild(t);
    if (df) r.appendChild(df);
    return r;
  }
  function sect(t) { return el('div', 'smcsub', t); }

  function render(d) {
    var host = $('smBody');
    if (!host) return;
    host.textContent = '';
    data = d;
    var yt = d.yearTotal, last = d.currentMonth, ms = d.months, ab = Math.abs;
    var cur = sel || last, tm = ms[cur - 1];
    var pm = cur > 1 ? ms[cur - 2] : {};
    var P = function (k) { return pm[k] || 0; };
    // 見出しの右に西暦のプルダウン (2026-10-20 ユーザー指示)。年はサーバーの years (無ければ今年だけ)。過去の年のデータが入ったら増える
    var hd = el('div', 'smhd smhdy'), ys = el('select', 'smyr');
    hd.appendChild(el('span', null, 'MONTHLY · ' + d.cutoff + ' まで'));
    (d.years && d.years.length ? d.years : [d.year]).forEach(function (y) { var o = el('option', null, y + ' ▾'); o.value = y; o.selected = String(y) === String(d.year); ys.appendChild(o); });
    ys.disabled = ys.options.length < 2;
    hd.appendChild(ys);
    host.appendChild(hd);
    var pk = el('div', 'smmo');   // 月のボタンは出しっぱなし (2026-10-20 ユーザー指示・カードの「今月 ▾」は廃止)
    for (var i = 1; i <= 12; i++) (function (m) {
      var b = el('button', 'smmb' + (m === cur ? ' on' : ''), m + '月'); b.type = 'button';
      b.disabled = m > last;
      b.onclick = function () { sel = m === last ? null : m; render(data); };
      pk.appendChild(b);
    })(i);
    host.appendChild(pk);
    var g = el('div', 'smcards');
    g.appendChild(card2(el('div', 'smlb', '月利'), yen(tm.finalY), usd(tm.finalUsd) + ' USD', true, diffEl(tm.finalY, P('finalY'), 'yen')));
    g.appendChild(card2(el('div', 'smlb', '販売'), usd(tm.salesUsd), num(tm.count) + ' 件 · 平均 ' + usd(tm.avgUsd), false, diffEl(tm.salesUsd, P('salesUsd'), 'usd')));
    g.appendChild(card2(el('div', 'smlb', '利益率'), pct(tm.ratePct), '利益 ' + yen(tm.profitJpy), false, diffEl(tm.ratePct, P('ratePct'), 'pt')));
    g.appendChild(card(d.year + ' 累計', yen(yt.finalJpy), usd(yt.salesUsd) + ' · ' + num(yt.count) + ' 件', true));
    host.appendChild(g);
    host.appendChild(panel('月利の推移 (¥)', d.avgMonthly > 0 ? '破線 = 月利のある月の平均 ' + yen(d.avgMonthly) : '',
      barChart(ms.map(function (m) { return m.finalY; }), cur, yen, d.avgMonthly, last)));
    host.appendChild(panel('販売 ($) 月別', '', barChart(ms.map(function (m) { return m.salesUsd; }), cur, usd, 0, last)));
    host.appendChild(panel('件数 月別', '', barChart(ms.map(function (m) { return m.count; }), cur, num, 0, last)));
    var cb = el('div');
    cb.appendChild(el('div', 'smcsub', d.year + ' 累計'));
    cb.appendChild(countryBars(yt.breakdown));
    cb.appendChild(el('div', 'smcsub', cur + '月'));
    cb.appendChild(countryBars(tm.breakdown));
    host.appendChild(panel('国別 (件数)', '', cb));

    // 手数料の構成: 販売 ($) を 100% として、手数料・広告費・返金・手元 (最終 $) に分ける
    var sale = tm.salesUsd;
    var sp = function (v) { return sale > 0 ? ab(v) / sale * 100 : 0; };
    var fe = el('div');
    if (sale > 0) {
      fe.appendChild(stackBar([{ pct: sp(tm.feesUsd), color: '#555' }, { pct: sp(tm.adUsd), color: '#8c8c8c' }, { pct: sp(tm.refundUsd), color: '#c8c8c8' }, { pct: Math.max(0, tm.finalUsd) / sale * 100, color: GREEN }]));
      fe.appendChild(legendRow('#555', 'eBay 手数料 (税込)', usd(tm.feesUsd), sp(tm.feesUsd).toFixed(1) + '%', diffEl(tm.feesUsd, P('feesUsd'), 'usd')));
      fe.appendChild(legendRow('#8c8c8c', '広告費', usd(tm.adUsd), sp(tm.adUsd).toFixed(1) + '%', diffEl(tm.adUsd, P('adUsd'), 'usd')));
      fe.appendChild(legendRow('#c8c8c8', '返金', usd(tm.refundUsd), sp(tm.refundUsd).toFixed(1) + '%', diffEl(tm.refundUsd, P('refundUsd'), 'usd')));
      fe.appendChild(legendRow(GREEN, '手元 (最終 $)', usd(tm.finalUsd), (tm.finalUsd / sale * 100).toFixed(1) + '%', diffEl(tm.finalUsd, P('finalUsd'), 'usd')));
    } else fe.appendChild(el('div', 'smnote', 'まだ販売がありません'));
    host.appendChild(panel(cur + '月 販売 ($) の内訳', '% は販売 ($) に対する割合', fe));

    // 詳細 (集計シートの列。名前は 3 行目の見出しのまま)
    var D = el('div');
    D.appendChild(sect('ドル'));
    D.appendChild(detRow('販売 ($)', usd(tm.salesUsd), diffEl(tm.salesUsd, P('salesUsd'), 'usd')));
    D.appendChild(detRow('Total Fees (includes Tax)', usd(tm.feesUsd), diffEl(tm.feesUsd, P('feesUsd'), 'usd')));
    D.appendChild(detRow('広告費(PL)', usd(tm.adUsd), diffEl(tm.adUsd, P('adUsd'), 'usd')));
    D.appendChild(detRow('返金', usd(tm.refundUsd), diffEl(tm.refundUsd, P('refundUsd'), 'usd')));
    D.appendChild(detRow('最終 ($)', usd(tm.finalUsd), diffEl(tm.finalUsd, P('finalUsd'), 'usd')));
    D.appendChild(detRow('手数料 (V 列)', usd(tm.feeTotalUsd), diffEl(tm.feeTotalUsd, P('feeTotalUsd'), 'usd')));
    D.appendChild(sect('為替・入金'));
    D.appendChild(detRow('販売月$ (平均レート)', '¥' + (tm.rateJpy || 0).toFixed(2), diffEl(tm.rateJpy, P('rateJpy'), 'n')));
    D.appendChild(detRow('販売月¥換算', yen(tm.salesJpy), diffEl(tm.salesJpy, P('salesJpy'), 'yen')));
    D.appendChild(detRow('ペイオニア入金額', yen(tm.payoneerJpy), diffEl(tm.payoneerJpy, P('payoneerJpy'), 'yen')));
    D.appendChild(sect('円 (% は 販売月¥換算 に対する割合)'));
    var base = tm.salesJpy, yp = function (v) { return base > 0 ? ' (' + (ab(v) / base * 100).toFixed(1) + '%)' : ''; };
    D.appendChild(detRow('仕入れ金額合計' + yp(tm.purchaseJpy), yen(tm.purchaseJpy), diffEl(tm.purchaseJpy, P('purchaseJpy'), 'yen')));
    D.appendChild(detRow('送料 (AC 列)' + yp(tm.shipCostJpy), yen(tm.shipCostJpy), diffEl(tm.shipCostJpy, P('shipCostJpy'), 'yen')));
    D.appendChild(detRow('現金支出' + yp(tm.cashOutJpy), yen(tm.cashOutJpy), diffEl(tm.cashOutJpy, P('cashOutJpy'), 'yen')));
    D.appendChild(detRow('eBay固定費(¥)' + yp(tm.fixedJpy), yen(tm.fixedJpy), diffEl(tm.fixedJpy, P('fixedJpy'), 'yen')));
    D.appendChild(detRow('手数料消費税還付', yen(tm.feeTaxRefundJpy), diffEl(tm.feeTaxRefundJpy, P('feeTaxRefundJpy'), 'yen')));
    D.appendChild(detRow('消費税還付', yen(tm.taxRefundJpy), diffEl(tm.taxRefundJpy, P('taxRefundJpy'), 'yen')));
    D.appendChild(sect('1 件あたり'));
    D.appendChild(detRow('平均単価 ($)', usd(tm.avgUsd), diffEl(tm.avgUsd, P('avgUsd'), 'usd')));
    D.appendChild(detRow('利益 (R 列)', yen(tm.profitJpy), diffEl(tm.profitJpy, P('profitJpy'), 'yen')));
    D.appendChild(detRow('送料 (S 列)', yen(tm.shipJpy), diffEl(tm.shipJpy, P('shipJpy'), 'yen')));
    D.appendChild(detRow('単価利益率', pct(tm.ratePct), diffEl(tm.ratePct, P('ratePct'), 'pt')));
    D.appendChild(sect('最終損益'));
    D.appendChild(detRow('最終損益 (Y 列)', yen(tm.finalY), diffEl(tm.finalY, P('finalY'), 'yen')));
    D.appendChild(detRow('最終損益 (Z 列・別計算)', yen(tm.finalZ), diffEl(tm.finalZ, P('finalZ'), 'yen')));
    host.appendChild(panel(cur + '月の詳細', cur > 1 ? '先月 = ' + (cur - 1) + '月' : '先月比なし', D));
  }

  function build() {
    if (built) return;
    built = true;
    var root = $('summaryView');
    root.textContent = '';
    var hd = el('div', 'hd');
    hd.appendChild(el('h1', null, 'Management Tools'));
    root.appendChild(hd);
    root.appendChild(segBar('summary'));
    var bar = el('div', 'bar'), lm = el('span', 'lm'), rf = uRefreshBtn(function () { sel = null; load(true); });   // 更新 = 今月に戻る
    lm.id = 'smLm'; rf.id = 'smRf';
    bar.appendChild(lm); bar.appendChild(rf);
    root.appendChild(bar);
    var body = el('div', 'smbody'); body.id = 'smBody';
    root.appendChild(body);
  }

  function load(fresh) {
    var my = ++seq, body = $('smBody'), rf = $('smRf'), lm = $('smLm');
    if (!body) return;
    if (rf) rf.disabled = true;
    if (!body.firstChild) body.appendChild(el('div', 'none', '読み込み中…'));
    apiCall('GET', '/api/summary' + (fresh ? '?fresh=1' : '')).then(function (d) {
      if (my !== seq) return;
      render(d);
      if (lm) lm.textContent = d.updated + ' 時点';
    }).catch(function (e) {
      if (my !== seq) return;
      body.textContent = '';
      body.appendChild(el('div', 'fl', '失敗: ' + (e && e.message ? e.message : e)));   // 読めなかった理由はそのまま出す
      if (lm) lm.textContent = '';
    }).then(function () { if (my === seq && rf) rf.disabled = false; });
  }

  function show(on) {
    document.body.classList.toggle('tab-summary', !!on);
    if (on) { build(); load(false); }
  }
  return { show: show };
})();

// 通知を押して来た時: 売れた = Order の一覧・買い手のメール = Chat の一覧・Thank you / 配送完了 = その買い手の会話 (2026-10-14)
// (開いたままの画面には service worker が知らせ、閉じていれば ?tab=…&buyer=… で開く)
function openFromNote(tab, buyer, order) {
  if (tab === 'sales') { SalesUi.want(order); showTab('sales'); }
  if (tab === 'troubles') showTab('troubles');
  if (tab === 'summary') showTab('summary');
  if (tab !== 'mail') return;
  showTab('mail');
  if (!buyer) return;
  var n = 0;
  (function go() {                      // 閉じていた画面を開いた時は、会話の一覧ができるまで待つ (最長 30 秒)
    if (window.mailClient) window.mailClient.openBuyer(buyer);
    else if (++n < 60) setTimeout(go, 500);
  })();
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', function (e) { if (e.data) openFromNote(e.data.tab, e.data.buyer, e.data.order); });
}
document.addEventListener('DOMContentLoaded', function () {
  var q = null;
  try { q = new URLSearchParams(location.search); } catch (e) { }
  if (q) openFromNote(q.get('tab') || '', q.get('buyer') || '', q.get('order') || '');
});

// 右へスワイプ = 戻る (2026-10-14 ユーザー指示: 戻るボタンを押すのが面倒)。指を置いた画面の ‹ を押したのと同じ動き。‹ はそのまま残す。
// 縦のスクロール・入力欄の中・横に流れる所では動かさない。Safari の左端スワイプ (ブラウザの戻る) とは重ねない
(function () {
  var sx = 0, sy = 0, st = 0, from = null;
  var standalone = (window.navigator.standalone === true) || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  document.addEventListener('touchstart', function (e) {
    from = null;
    if (e.touches.length !== 1) return;
    var p = e.touches[0];
    if (!standalone && p.clientX < 24) return;
    if (e.target.closest && e.target.closest('textarea, input, select, [contenteditable="true"]')) return;
    sx = p.clientX; sy = p.clientY; st = Date.now(); from = e.target;
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (!from) return;
    var p = e.changedTouches[0], dx = p.clientX - sx, dy = Math.abs(p.clientY - sy), n = from;
    from = null;
    if (dx < 70 || dy > dx * 0.5 || Date.now() - st > 700) return;
    for (; n && n !== document; n = n.parentElement) {        // 指を置いた画面 (一番内側) の ‹ を押す
      if (n.scrollWidth > n.clientWidth + 4 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return;   // 横に流れる所は横スクロールに任せる
      var b = n.querySelector(':scope > .top > .back');
      if (b && b.offsetParent) { b.click(); return; }
    }
  }, { passive: true });
})();

// パネルの中 (PC) の左右の端のボタン (2026-10-15 ユーザー指示)。薄く縦いっぱい。スマホ・普通のブラウザには出さない
// 左 = 一番内側の画面の ‹ を押したのと同じ (右スワイプと同じ動き)・右 = 最後に開いていた会話へ戻る (一覧にいる時だけ)
if (EMBED) {
  (function () {
    function mk(id, cls, glyph, label) {
      var b = document.createElement('button');
      b.id = id; b.type = 'button'; b.className = 'edge ' + cls; b.textContent = glyph; b.hidden = true; b.setAttribute('aria-label', label);
      document.body.appendChild(b);
      return b;
    }
    var L = mk('edgeL', 'el', '‹', '戻る'), R = mk('edgeR', 'er', '›', '最後に開いていた会話へ');
    function visibleBack() {
      var all = document.querySelectorAll('.top > .back'), hit = null;
      Array.prototype.forEach.call(all, function (b) { if (b.offsetParent) hit = b; });   // DOM の後ろにある画面ほど内側 (商品画面は会話の後)
      return hit;
    }
    function lv() { var v = document.getElementById('listView'); return !!(v && !v.hidden && v.offsetParent); }
    function refresh() {
      if (document.visibilityState !== 'visible') return;
      L.hidden = !visibleBack();
      R.hidden = !(curTab === 'mail' && lv() && window.mailClient && window.mailClient.canReturn());
    }
    L.onclick = function () { var b = visibleBack(); if (b) b.click(); setTimeout(refresh, 50); };
    R.onclick = function () { if (window.mailClient) window.mailClient.returnLast(); setTimeout(refresh, 50); };
    setInterval(refresh, 400);   // 画面の出し入れは各画面が持っているので、見える状態を 0.4 秒ごとに読むだけ
  })();
}
