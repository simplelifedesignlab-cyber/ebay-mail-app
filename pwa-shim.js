// iPhone の PWA (GitHub Pages・ebay-mail-app) の GAS 用の差分 (2026-10-21 第 5 段)。app.js / mail-gas.js より先に読まれる。
// 画面 = ZBook の app.js / app.css をそのまま・通信の継ぎ目 = 拡張と同じ mail-gas.js (fetch POST text/plain で GAS の Web App を呼ぶ)。このファイルが足すのは次の 4 つだけ。
//   ① 設定: GAS の Web App URL・トークン (出品パネルの Settings と同じ物)・Claude キー・Bark キー。URL とトークンは localStorage (try/catch) に覚える
//      Claude / Bark キーは端末に残さず、action 'keys' で GAS (MAIL_CLAUDE_KEY / MAIL_BARK_KEY) へ送るだけ (パネルの Settings と同じ)
//   ② chrome.storage.local の代わり (mail-gas.js が既読・訳の控えに使う) = localStorage。URL とトークンが入るまで get の返事を待たせる = 通信は始まらない
//   ③ Claude は GAS 経由 (window.MAIL_AI_VIA_GAS)。ブラウザから Anthropic を直接呼ばない
//   ④ Service Worker (sw.js・画面の殻だけ覚える)。Web Push は無い (通知は Bark)
// 設定画面の開き方: 初回は自動。あとは画面の左上の角を 3 秒のうちに 5 回たたく (ホーム画面のアプリには URL 欄が無いため)・または URL に ?settings=1。
// トークン・キーを画面・URL・ログに出さない。localStorage が使えない時はメモリに持つ (開き直すと聞き直し)。
(function () {
  'use strict';
  var PFX = 'mailgas.', mem = {};
  function lget(k) { try { var v = localStorage.getItem(PFX + k); if (v !== null) return v; } catch (e) { /* 使えない時はメモリ */ } return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; }
  function lset(k, v) { mem[k] = v; try { localStorage.setItem(PFX + k, v); } catch (e) { /* 控えが残らないだけ */ } }
  function ldel(k) { delete mem[k]; try { localStorage.removeItem(PFX + k); } catch (e) { /* 同上 */ } }

  var cfg = { url: String(lget('url') || ''), token: String(lget('token') || '') }, waiters = [];
  function haveCfg() { return !!(cfg.url && cfg.token); }
  function ready() { var w = waiters; waiters = []; w.forEach(function (fn) { try { fn(); } catch (e) { /* 次へ */ } }); }
  function validUrl(u) { return /^https:\/\/script\.google\.com\/(?:a\/macros\/[^\/]+|macros)\/s\/[\w-]+\/exec$/.test(u); }
  // 貼り付けの揺れを吸収 (2026-10-21: 「違う」と出た)。/dev や ?以降・空白を落として …/exec に揃える。Bark は api.day.app/ のアドレス丸ごとでもキーだけ取り出す
  function normUrl(u) { var m = String(u || '').replace(/\s+/g, '').match(/^(https:\/\/script\.google\.com\/(?:a\/macros\/[^\/]+|macros)\/s\/[\w-]+)/); return m ? m[1] + '/exec' : String(u || '').trim(); }
  function normBark(b) { var s = String(b || '').replace(/\s+/g, ''); var m = s.match(/api\.day\.app\/([A-Za-z0-9_-]+)/); return m ? m[1] : s.replace(/^\/+|\/+$/g, ''); }

  var overlay = null;
  function closeOverlay() { if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); overlay = null; }
  function openSettings(note, bad) {
    if (overlay) return;
    var first = !haveCfg();
    var d = overlay = document.createElement('div');
    d.className = 'mgov';
    var ATTR = ' type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"';
    d.innerHTML = '<div class="box"><h1>eBay Mail GAS 設定</h1><p id="mgMsg"' + (bad ? ' class="bad"' : '') + '></p>' +
      '<label>Web App の URL (https://script.google.com/macros/s/…/exec)</label><input id="mgUrl"' + ATTR + ' inputmode="url">' +
      '<label>Web App のトークン (出品パネルの Settings のトークン)</label><input id="mgTok"' + ATTR + '>' +
      '<hr><p>キーは GAS の中にだけ保存され、保存後は画面に出ません。空欄は変えません。</p>' +
      '<label>Bark キー (通知)</label><input id="mgBark"' + ATTR + '>' +
      '<button id="mgBarkDel" class="sub" type="button">Bark キーを消す</button>' +
      '<label>Claude キー (AI 案・翻訳。sk-ant- から始まる)</label><input id="mgClaude"' + ATTR + '>' +
      '<button id="mgClaudeDel" class="sub" type="button">Claude キーを消す</button>' +
      '<button id="mgSave" type="button">保存</button>' + (first ? '' : '<button id="mgClose" class="sub" type="button">閉じる</button>') + '</div>';
    document.body.appendChild(d);
    var $ = function (id) { return document.getElementById(id); };
    function msg(t, isBad) { var m = $('mgMsg'); m.textContent = t; m.className = isBad ? 'bad' : ''; }
    msg(note || (first ? 'URL とトークンを入れてください。この端末に覚えるので、次からは聞きません。' : 'URL とトークンは今の値のままなら触らないでください (欄は空です)。'), bad);
    if (!first) { $('mgUrl').placeholder = '(設定済み)'; $('mgTok').placeholder = '(設定済み)'; }
    else { $('mgUrl').value = cfg.url; }

    function sendKeys(o) {
      var url = ($('mgUrl').value.trim() || cfg.url), tok = ($('mgTok').value.trim() || cfg.token);
      if (!validUrl(url) || !tok) { msg('先に URL とトークンを入れてください。', true); return Promise.resolve(false); }
      msg('保存しています…');
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(Object.assign({ type: 'mail', t: tok, action: 'keys' }, o)), redirect: 'follow' })
        .then(function (r) { return r.text(); }).then(function (txt) {
          var j; try { j = JSON.parse(txt); } catch (e) { j = null; }
          if (j && j.error === 'invalid token') { msg('トークンが違います。', true); return false; }
          if (!j || j.ok !== true) { msg('保存できませんでした: ' + String((j && j.message) || '返事を読めません (URL を確かめてください)'), true); return false; }
          if (j.owner) { msg('このGASはオーナーで、本番テストの期間外のためキーは保存されません。', true); return false; }
          var sv = j.saved || {};
          msg('キーを保存しました' + (('bark' in sv) ? ' (Bark: ' + (sv.bark ? '設定' : '削除') + ')' : '') + (('claude' in sv) ? ' (Claude: ' + (sv.claude ? '設定' : '削除') + ')' : ''));
          $('mgBark').value = ''; $('mgClaude').value = '';
          return true;
        }, function (e) { msg('GAS に届きませんでした: ' + (e && e.message ? e.message : e), true); return false; });
    }
    function saveCfg() {
      var u = normUrl($('mgUrl').value), t = $('mgTok').value.replace(/\s+/g, '');
      if (u) { if (!validUrl(u)) { msg('URL の形が違います (https://script.google.com/macros/s/…/exec)。', true); return false; } cfg.url = u; lset('url', u); }
      if (t) { cfg.token = t; lset('token', t); }
      if (!haveCfg()) { msg('URL とトークンを入れてください。', true); return false; }
      return true;
    }
    $('mgSave').onclick = function () {
      var b = normBark($('mgBark').value), c = $('mgClaude').value.trim();
      var keys = {};
      if (b) keys.bark = b;
      if (c) keys.claude = c;
      if (!saveCfg()) return;
      if (b || c) { sendKeys(keys).then(function (ok) { if (ok && first) { closeOverlay(); ready(); } else if (ok) closeOverlay(); }); return; }
      closeOverlay(); ready();
      if (!first) { try { location.reload(); } catch (e) { /* 手で開き直す */ } }
    };
    $('mgBarkDel').onclick = function () { saveCfg() && sendKeys({ bark: '' }); };
    $('mgClaudeDel').onclick = function () { saveCfg() && sendKeys({ claude: '' }); };
    if ($('mgClose')) $('mgClose').onclick = closeOverlay;
  }

  function whenBody(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }
  var wantSettings = false;
  try { wantSettings = /(^|[?&])settings=1(&|$)/.test(location.search); } catch (e) { /* 使えない時は開かない */ }
  if (!haveCfg()) whenBody(function () { openSettings(); });
  else if (wantSettings) whenBody(function () { openSettings(); });
  // 左上の角を 5 回 (3 秒以内) = 設定
  var taps = [];
  document.addEventListener('click', function (e) {
    if (e.clientX > 64 || e.clientY > 64) { taps = []; return; }
    var now = Date.now();
    taps = taps.filter(function (t) { return now - t < 3000; }); taps.push(now);
    if (taps.length >= 5) { taps = []; openSettings(); }
  }, true);

  // chrome.storage.local の代わり (mail-gas.js が見る物だけ)。listingCfg は {url, token}・Claude キーは持たない (GAS の action 'ai')
  var store = {
    get: function (keys, cb) {
      var run = function () {
        var o = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
          if (k === 'listingCfg') o.listingCfg = { url: cfg.url, token: cfg.token };
          else if (k !== 'claudeApiKey') { var v = lget('d.' + k); if (v !== null) { try { o[k] = JSON.parse(v); } catch (e) { /* 壊れた控えは無いことにする */ } } }
        });
        cb(o);
      };
      if (haveCfg()) run(); else waiters.push(run);
    },
    set: function (obj, cb) {
      Object.keys(obj || {}).forEach(function (k) { if (k !== 'listingCfg' && k !== 'claudeApiKey') { try { lset('d.' + k, JSON.stringify(obj[k])); } catch (e) { /* 容量超過など。控えが残らないだけ */ } } });
      if (cb) cb();
    }
  };
  window.chrome = { storage: { local: store, onChanged: { addListener: function () { } } } };
  window.MAIL_AI_VIA_GAS = true;
  window.MAIL_PWA_OPEN_SETTINGS = function () { openSettings(); };

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('./sw.js').catch(function () { /* 殻を覚えられないだけ。ページは動く */ }); });
  }
})();
