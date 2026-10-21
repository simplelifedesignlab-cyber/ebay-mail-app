// 配布版 Chat の通信の継ぎ目 (2026-10-21 ユーザー指示「C で今すぐ作る」)。設計書 docs/design-distribution-chat-2026-10-21.md
//
// ZBook の mail_app では app.js の apiCall が Flask の /api/... を叩く。配布先には ZBook が無いので、拡張に同梱した app.js (コピー) は
// このファイルを先に読み込み (window.MAIL_BACKEND='gas')、apiCall を MailGas.call へ渡す。app.js は同じ path (/api/state など) のまま呼ぶ。
//   ・会話・送信・済み・テンプレ・5% Offer の URL = GAS Web App (Mail_Api.gs.js) へ POST { type:'mail', t: トークン, action, ... }
//   ・AI (方針案・日本語案・書き直し・外国語への訳・買い手の文の日本語訳) = Settings の Claude キーで api.anthropic.com を直接呼ぶ
//   ・未読の印・訳のキャッシュ = 端末 (chrome.storage.local)
//   ・Order / Summary = 第 2 段 (2026-10-21): GAS (Mail_Sales_Api.gs.js) へ summary / sales / sales_read / sales_cost / sales_cands / sales_match / item_pics。未読の印は GAS の控え (ZBook と同じ = 端末をまたいで共通)
//   ・Status = 第 3 段 (2026-10-21): GAS (Mail_Trouble_Api.gs.js) へ troubles / trouble_archive / cpass_track / oc_track。状況ボタンの英文案 (/api/trouble-draft) は Settings の Claude キーで直接つくる
//   ・商品タブ・Re:translation・注文カード・自動返信の確認吹き出し = 第 4 段 (GAS が返す)。通知は Bark (GAS から)
//   ・iPhone の PWA (GitHub Pages・ebay-mail-app。2026-10-21 第 5 段): 同じこのファイルを使う。違いは 1 点だけ
//       root.MAIL_AI_VIA_GAS が真なら Claude は GAS の action 'ai' (MAIL_CLAUDE_KEY) 経由 (iPhone にキーを入れない)
//     拡張の中では未定義 = 今までどおり。
// 設定 (Settings で入れる値は panel.js が chrome.storage.local に保存する): listingCfg.{url,token} / claudeApiKey
// 送信はいつも本物 (GAS へ live:true)。2026-10-21 ユーザー指示「わかりづらい」で試運転の切替は廃止。GAS 側は live:true が無い呼び出しを送らない (安全装置はそのまま)。
// ★キーの値はログ・画面・GAS へ出さない (エラー文は redact を通す)。
(function (root) {
  'use strict';
  root.MAIL_BACKEND = 'gas';

  var CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
  var MODEL_MAIN = 'claude-sonnet-5-5';          // 方針案・日本語案・書き直し・訳 (mail_ai.py の REPLIES_AI_MODEL と同じ)
  var MODEL_TRANS = 'claude-haiku-5-5';          // 買い手の文の日本語訳 (reply_threads.py の TRANS_MODEL と同じ)
  var STATE_TIMEOUT_MS = 175000;                 // GAS の取込は最長 150 秒 + 余裕
  var READ_TIMEOUT_MS = 60000;
  var TRANS_MAX_PER_PASS = 24, TRANS_BATCH = 8, JA_CACHE_MAX = 1500, SEEN_MAX = 3000;
  var PHOTO_ONLY = /Send To Photo\.|\[Attachment\] \d+ photos?\nSent: [^\n]+ JST/;
  var KANA = /[぀-ヿ一-鿿]/g;

  var S = { url: '', token: '', claude: '', loaded: null };
  var state = null, templates = null, templatesAt = 0, itemInfoCache = {};
  var seen = null, ja = null, freshP = null, contBusy = false, transBusy = false;
  var lanes = { long: Promise.resolve(), front: Promise.resolve(), sales: Promise.resolve(), trouble: Promise.resolve() };
  var salesC = null, summaryC = null;               // Order の一覧 (20 秒)・Summary (5 分。更新ボタン = fresh で読み直す)
  var troubleC = null, cpassC = {};                  // Status (20 秒。10 分の間隔は GAS が守る)・OC 追跡番号 → CPaSS の番号 (10 分)

  // ---------------------------------------------------------------- storage / 設定
  function st() { try { return root.chrome && root.chrome.storage && root.chrome.storage.local; } catch (e) { return null; } }
  function sget(keys) {
    return new Promise(function (res) {
      var s = st();
      if (!s) { res({}); return; }
      try { s.get(keys, function (d) { res(d || {}); }); } catch (e) { res({}); }
    });
  }
  function sset(obj) {
    return new Promise(function (res) {
      var s = st();
      if (!s) { res(); return; }
      try { s.set(obj, function () { res(); }); } catch (e) { res(); }
    });
  }
  function applySettings(d) {
    var cfg = d.listingCfg || {};
    S.url = String(cfg.url || ''); S.token = String(cfg.token || '');
    S.claude = String(d.claudeApiKey || '').trim();
  }
  function load() {
    if (S.loaded) return S.loaded;
    S.loaded = sget(['listingCfg', 'claudeApiKey', 'mailSeen', 'mailJa']).then(function (d) {
      applySettings(d);
      seen = d.mailSeen && typeof d.mailSeen === 'object' && d.mailSeen.mids ? d.mailSeen : { init: false, mids: {} };
      ja = d.mailJa && typeof d.mailJa === 'object' ? d.mailJa : {};
    });
    try {
      root.chrome.storage.onChanged.addListener(function (ch, area) {
        if (area !== 'local') return;
        if (ch.listingCfg) { var c = ch.listingCfg.newValue || {}; S.url = String(c.url || ''); S.token = String(c.token || ''); }
        if (ch.claudeApiKey) S.claude = String(ch.claudeApiKey.newValue || '').trim();
      });
    } catch (e) { /* 拡張の外 (テスト) では監視しない */ }
    return S.loaded;
  }
  function persistSeen() {
    var ks = Object.keys(seen.mids);
    if (ks.length > SEEN_MAX) ks.slice(0, ks.length - SEEN_MAX).forEach(function (k) { delete seen.mids[k]; });
    return sset({ mailSeen: seen });
  }
  function persistJa() {
    var ks = Object.keys(ja);
    if (ks.length > JA_CACHE_MAX) ks.slice(0, ks.length - JA_CACHE_MAX).forEach(function (k) { delete ja[k]; });
    return sset({ mailJa: ja });
  }

  // ---------------------------------------------------------------- 小物
  function redact(s) {
    var t = String(s == null ? '' : s).replace(/sk-ant-[A-Za-z0-9_-]+/g, '***');
    if (S.claude) t = t.split(S.claude).join('***');
    if (S.token) t = t.split(S.token).join('***');
    return t;
  }
  function msgOf(e) { return redact(e && e.message ? e.message : e); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
  function isJapanese(text) {
    var t = String(text || '').replace(/\s/g, '');
    return !!t && ((t.match(KANA) || []).length / t.length) >= 0.2;
  }
  function lane(name, fn) {
    if (name === 'par') return fn();                   // 順番待ちしない (iPhone ページの AI 呼び出し。拡張の直接呼び出しと同じく並行で動く)
    var p = lanes[name].then(fn, fn);
    lanes[name] = p.catch(function () { });
    return p;
  }

  // ---------------------------------------------------------------- GAS
  // GAS の Web App へ 1 回 POST。返事は JSON。ok:false は message で Error にする (opts.soft = 呼び元が自分で見る)
  function gas(action, payload, opts) {
    opts = opts || {};
    return load().then(function () {
      if (!S.url || !S.token) throw new Error('Settings に Web App URL とトークンを入れてください');
      var body = JSON.stringify(Object.assign({ type: 'mail', t: S.token, action: action }, payload || {}));
      var ln = opts.lane || 'front';
      return lane(ln, function () { return gasOnce(body, opts); });
    });
  }
  function gasOnce(body, opts) {
    var ac = (!opts.noAbort && typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ac ? setTimeout(function () { ac.abort(); }, opts.timeout || READ_TIMEOUT_MS) : null;
    return fetch(S.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: body, redirect: 'follow', signal: ac ? ac.signal : undefined })
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        if (timer) clearTimeout(timer);
        return parseGas(txt);
      }, function (e) {
        if (timer) clearTimeout(timer);
        var aborted = e && e.name === 'AbortError';
        var er = new Error(aborted ? 'GAS が時間内に返事を返しませんでした' : 'GAS に届きませんでした: ' + msgOf(e));
        er.network = true;
        throw er;
      });
  }
  function parseGas(txt) {
    var j;
    try { j = JSON.parse(txt); } catch (e) { throw new Error('GAS の返事を読めませんでした (URL が違うか、Web App のデプロイが古い可能性があります)'); }
    if (!j || typeof j !== 'object' || !('ok' in j)) throw new Error('この Web App は Chat に対応していません (GAS を最新にして再デプロイしてください)');
    if (j.error === 'invalid token') throw new Error('トークンが違います (Settings のトークンを確かめてください)');
    return j;
  }
  function gasOk(action, payload, opts) {
    return gas(action, payload, opts).then(function (j) {
      if (!j.ok) { var er = new Error(j.message || j.error || '失敗しました'); er.result = j; throw er; }
      return j;
    });
  }

  // ---------------------------------------------------------------- 会話の状態
  function decorate(threads) {
    if (!seen.init) {                                    // 最初の 1 回は今ある会話を全部既読にする (ZBook の mail_seen と同じ)
      threads.forEach(function (v) { if (v.mid) seen.mids[v.mid] = 1; });
      seen.init = true; persistSeen();
    }
    threads.forEach(function (v) {
      var last = v.msgs && v.msgs.length ? v.msgs[v.msgs.length - 1] : null;
      v.unread = !!(v.mid && !seen.mids[v.mid] && !(last && last.who === 'me'));
      (v.msgs || []).forEach(function (m) { if (m.id && ja[m.id]) m.ja = ja[m.id]; });
    });
    return threads;
  }
  function adopt(r) {
    if (!r || !r.ok) throw new Error((r && r.message) || '会話を読めませんでした');
    state = { updated: r.updated || '', queueUpdated: r.queueUpdated || '', threads: decorate(r.threads || []) };
    return r;
  }
  function out() { decorate(state.threads); return clone(state); }   // 未読の印は毎回つけ直す (会話を開くと /api/mail-read で既読にしているため)
  function bump() { if (state) state.queueUpdated = new Date().toISOString(); }

  function getState(fresh, onHeaders) {
    return load().then(function () {
      if (!fresh) {
        if (state) return out();
        return gasOk('state', { fresh: false }).then(function (r) { adopt(r); return out(); });
      }
      if (!freshP) {
        freshP = gasOk('state', { fresh: true }, { lane: 'long', timeout: STATE_TIMEOUT_MS }).then(function (r) {
          adopt(r);
          if (r.partial) continueSync();
          translatePass();
          return r;
        }).then(function (r) { freshP = null; return r; }, function (e) { freshP = null; throw e; });
      }
      return freshP.then(function () {
        if (onHeaders) onHeaders({ get: function (k) { return k === 'X-Mail-Fresh' ? '1' : null; } });
        return out();
      });
    });
  }
  // 取り込みが 1 回で終わらなかった時 (初回の 30 日分など): 続きを裏で取る。1 回ごとに画面へ知らせる
  function continueSync() {
    if (contBusy) return;
    contBusy = true;
    var n = 0;
    (function step() {
      if (++n > 12) { contBusy = false; return; }
      gasOk('state', { fresh: true }, { lane: 'long', timeout: STATE_TIMEOUT_MS }).then(function (r) {
        adopt(r); bump(); translatePass();
        if (typeof root.mailRefreshNow === 'function') root.mailRefreshNow();
        if (r.partial) step(); else contBusy = false;
      }, function () { contBusy = false; });     // 続きが取れなくても今ある分は見られる。次に開いた時にまた続く
    })();
  }

  // ---------------------------------------------------------------- 買い手の文の日本語訳 (Haiku・裏で)
  var TRANS_SYSTEM = 'You translate eBay buyer/seller messages into natural Japanese. Input is a JSON object {id: text}. ' +
    'Return ONLY a JSON object {id: japanese_translation} with exactly the same ids. ' +
    'Keep placeholders such as [EMAIL_1], [NUMBER_1], [URL_1], [BUYER_1] exactly as they are. Translate faithfully, do not add or omit content.';

  // AI に渡す前の伏せ字: メール・長い数字・URL・買い手 ID。{ masked, table } (table で訳のあとに戻す)
  function mask(text, buyer) {
    var table = {}, n = { EMAIL: 0, NUMBER: 0, URL: 0, BUYER: 0 };
    function put(kind, val) { var k = '[' + kind + '_' + (++n[kind]) + ']'; table[k] = val; return k; }
    var s = String(text == null ? '' : text);
    s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, function (v) { return put('EMAIL', v); });
    s = s.replace(/https?:\/\/\S+/g, function (v) { return put('URL', v); });
    s = s.replace(/\+?\d[\d\s().-]{8,}\d/g, function (v) { return put('NUMBER', v); });
    if (buyer) s = s.split(buyer).join(put('BUYER', buyer));
    return { masked: s, table: table };
  }
  function unmask(text, table) {
    var s = String(text || '');
    Object.keys(table).forEach(function (k) { s = s.split(k).join(table[k]); });
    return s;
  }
  // 返信案の材料用 (戻さない・単純な伏せ字)
  function maskPlain(s, buyer) {
    s = String(s == null ? '' : s);
    if (buyer) s = s.split(buyer).join('[BUYER]');
    return s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]').replace(/\+?\d[\d\s().-]{8,}\d/g, '[NUMBER]');
  }

  function hasClaude() { return !!(S.claude || root.MAIL_AI_VIA_GAS); }
  function claude(model, system, user, maxTokens, extra) {
    if (root.MAIL_AI_VIA_GAS) {                        // iPhone の PWA: キーは GAS (MAIL_CLAUDE_KEY)。応答は text だけ
      return gasOk('ai', { model: model, system: system, user: user, max_tokens: maxTokens || 2000, extra: extra || null }, { lane: 'par', noAbort: true }).then(function (j) { return String(j.text || ''); });
    }
    return load().then(function () {
      if (!S.claude) throw new Error('Settings に Claude キーを入れてください');
      return fetch(CLAUDE_URL, {
        method: 'POST',
        headers: { 'x-api-key': S.claude, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify(Object.assign({ model: model, max_tokens: maxTokens || 2000, system: system, messages: [{ role: 'user', content: user }] }, extra || {}))
      }).then(function (r) {
        return r.text().then(function (txt) {
          if (!r.ok) throw new Error('Claude API ' + r.status + ': ' + redact(txt).slice(0, 160));
          var j = JSON.parse(txt);
          return (j.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text || ''; }).join('');
        });
      }, function (e) { throw new Error('Claude API 通信エラー: ' + msgOf(e)); });
    });
  }
  function claudeJson(model, system, user, maxTokens, extra) {
    return claude(model, system, user, maxTokens, extra).then(function (text) {
      var m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('AI の返事に JSON がありません');
      try { return JSON.parse(m[0]); } catch (e) {
        try { return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); } catch (e2) { throw new Error('AI の返事の JSON を読めません'); }
      }
    });
  }

  function translatePass() {
    if (transBusy || !state) return;
    load().then(function () {
      if (!hasClaude()) return;
      var todo = [];
      state.threads.forEach(function (t) {
        (t.msgs || []).slice().reverse().forEach(function (m) {
          if (!m.id || !m.text || Object.prototype.hasOwnProperty.call(ja, m.id)) return;
          if (/^(local|sent)-/.test(String(m.id))) return;
          if (isJapanese(m.text) || PHOTO_ONLY.test(String(m.text).trim())) { ja[m.id] = ''; return; }
          todo.push({ id: m.id, text: m.text, buyer: t.buyer });
        });
      });
      todo = todo.slice(0, TRANS_MAX_PER_PASS);
      if (!todo.length) { persistJa(); return; }
      transBusy = true;
      var chunks = [];
      for (var i = 0; i < todo.length; i += TRANS_BATCH) chunks.push(todo.slice(i, i + TRANS_BATCH));
      return chunks.reduce(function (p, chunk) {
        return p.then(function () {
          var tables = {}, batch = {};
          chunk.forEach(function (x) { var mk = mask(x.text, x.buyer); tables[x.id] = mk.table; batch[x.id] = mk.masked.slice(0, 2500); });
          return claudeJson(MODEL_TRANS, TRANS_SYSTEM, JSON.stringify(batch), 6000).then(function (res) {
            chunk.forEach(function (x) { var v = trim(res[x.id]); if (v) ja[x.id] = unmask(v, tables[x.id]); });
          });
        });
      }, Promise.resolve()).then(function () {
        persistJa();
        if (state) { decorate(state.threads); bump(); }
        if (typeof root.mailRefreshNow === 'function') root.mailRefreshNow();
      });
    }).catch(function () { /* 訳せなかっただけ。原文は読める。次の取込でまた試す */ }).then(function () { transBusy = false; });
  }

  // ---------------------------------------------------------------- AI (mail_ai.py の写し・店固有の文言と Tark は外した汎用版)
  var PREAMBLE = [
    'あなたは日本の中古品などを eBay で海外へ販売するセラーの返信担当です。買い手への返信を店主が日本語で確認し、あとで相手の言語へ訳して送ります。',
    '返信は丁重なビジネス調で、短く、要点だけ。事実 (金額・状態・日付・追跡番号・商品の中身) は会話と商品情報にあるものだけを使い、作らない。',
    '分からない点は断定しない言い方にする。出力は各依頼で指定された形式だけです。'
  ].join('\n');
  function system(task) { return PREAMBLE + '\n\n' + task; }

  function findThread(mid) {
    if (!state) return null;
    var m = String(mid || ''), hit = null;
    state.threads.forEach(function (t) { if (!hit && String(t.mid) === m) hit = t; });
    if (!hit) state.threads.forEach(function (t) { if (!hit && (t.msgs || []).some(function (x) { return String(x.id) === m; })) hit = t; });
    return hit;
  }
  function needThread(mid) {
    var t = findThread(mid);
    if (!t) throw new Error('その会話が見つかりません');
    return t;
  }
  function lastBuyerText(t) {
    var ms = t.msgs || [];
    for (var i = ms.length - 1; i >= 0; i--) if (ms[i].who !== 'me') return ms[i].text;
    return '';
  }
  function itemInfo(itemId) {
    var id = String(itemId || '');
    if (!/^\d+$/.test(id)) return Promise.resolve({});
    var c = itemInfoCache[id];
    if (c && Date.now() - c.at < 10 * 60 * 1000) return Promise.resolve(c.info);
    return gasOk('item_info', { itemId: id }).then(function (r) {
      itemInfoCache[id] = { at: Date.now(), info: r.info || {} };
      return r.info || {};
    }, function () { return {}; });                // 商品情報が取れなくても会話だけで案は作る
  }
  function context(t, memo) {
    return itemInfo(t.item_id).then(function (info) {
      var msgs = (t.msgs || []).slice(-14).map(function (m) {
        return (m.who === 'me' ? '[店主]' : '[買い手]') + ' ' + maskPlain(m.text, t.buyer).slice(0, 1200);
      });
      var obj = { '商品名': info.title || t.title || '', '価格': info.price || t.price || '', '状態': info.condition || '',
        '状態の説明': info.condition_note || '', 'スペック': info.specifics || [] };
      return '【会話 (古い順・最後が買い手の最新の発言)】\n' + msgs.join('\n') + '\n\n【商品情報】\n' + JSON.stringify(obj) +
        '\n\n【店主の要点メモ (日本語・空なら無し)】\n' + maskPlain(memo || '', t.buyer);
    });
  }

  function aiOptions(mid, memo) {
    var t = needThread(mid);
    return context(t, memo).then(function (ctx) {
      var sys = system('【あなたの仕事】会話と商品情報を読み、店主が取りうる返信の「方針」の選択肢を 2〜4 個、日本語で短く出してください。' +
        '店主の要点メモがあればその意図を最優先で反映した選択肢にする。選択肢は実際に起こりうるものだけ。最もありそうなものを先頭に。' +
        '返信しない (対応不要) が妥当ならその選択肢も入れてよい。\n' +
        '出力は JSON だけ: {"options":[{"label":"方針名 (15 字以内)","detail":"何を伝えるかを 1 行"}]}');
      return claudeJson(MODEL_MAIN, sys, ctx, 2500);
    }).then(function (r) {
      var opts = (r.options || []).slice(0, 4).filter(function (o) { return o && typeof o === 'object'; })
        .map(function (o) { return { label: o.label ? String(o.label) : '', detail: o.detail ? String(o.detail) : '' }; })
        .filter(function (o) { return o.label; });
      if (!opts.length) throw new Error('方針の選択肢が返ってきませんでした');
      return { ok: true, options: opts };
    });
  }
  function aiDraft(mid, memo, option, extra) {
    var hasOpt = !!(option && typeof option === 'object' && option.label), ex = trim(extra);
    if (!hasOpt && !ex) return Promise.reject(new Error('方針を選ぶか、指示を書いてください'));
    var t = needThread(mid);
    return context(t, memo).then(function (ctx) {
      var sys = system('【あなたの仕事】店主が選んだ方針と追加の指示をもとに、買い手への返信文を日本語で書いてください (あとで相手の言語へ訳す)。' +
        '選んだ方針があれば土台にし、追加の指示があれば優先して反映する (方針と食い違えば追加の指示を優先)。方針が無く追加の指示だけの時は、その指示の内容そのものが依頼。' +
        '会話の最新の買い手の発言に答える。短く、要点だけ。1 つの質問に 1 つずつ答える。' +
        '分からない点は断定しない言い方にする。指示文そのものは返信文に残さない。出力は JSON だけ: {"reply_ja":"返信文 (日本語)"}');
      var tail = '';
      if (hasOpt) tail += '\n\n【選ばれた方針】' + option.label + ' — ' + (option.detail || '');
      if (ex) tail += '\n\n【追加の指示 (店主・日本語)】\n' + maskPlain(ex, '').slice(0, 1500);
      return claudeJson(MODEL_MAIN, sys, ctx + tail, 3500);
    }).then(function (r) {
      var text = trim(r.reply_ja);
      if (!text) throw new Error('返信文が返ってきませんでした');
      return { ok: true, text: text };
    });
  }
  function aiRewrite(mid, jaText, option) {
    var j = trim(jaText);
    if (!j) return Promise.reject(new Error('窓が空です'));
    var t = needThread(mid);
    return context(t, '').then(function (ctx) {
      var sys = system('【あなたの仕事】店主の窓にある日本語の文を、書き直してください (あとで相手の言語へ訳す)。' +
        '窓の文には、AI が作った文に店主が日本語で追記した指示・修正が含まれることがある。店主の追記・修正を必ず反映する。' +
        '方針は前回選んだものがあればそれを維持する。会話の最新の買い手の発言に答える。短く、要点だけ。分からない点は断定しない言い方にする。' +
        '出力は JSON だけ: {"reply_ja":"書き直した返信文 (日本語・指示文は残さない)"}');
      var opt = (option && typeof option === 'object' && option.label) ? '\n\n【前回選んだ方針】' + option.label + ' — ' + (option.detail || '') : '';
      return claudeJson(MODEL_MAIN, sys, ctx + opt + '\n\n【窓の今の日本語文 (店主の追記・修正を含む)】\n' + maskPlain(j, '').slice(0, 3000), 3500);
    }).then(function (r) {
      var text = trim(r.reply_ja);
      if (!text) throw new Error('返信文が返ってきませんでした');
      return { ok: true, text: text };
    });
  }
  function aiTranslate(mid, jaText) {
    var j = trim(jaText);
    if (!j) return Promise.resolve({ ok: false, message: '本文が空です' });
    var t = findThread(mid);
    if (!t) return Promise.resolve({ ok: false, message: 'その会話が見つかりません' });
    var src = (t.msgs || []).filter(function (m) { return m.who !== 'me'; });
    if (!src.length) src = t.msgs || [];
    var buyerMsgs = src.slice(-4).map(function (m) { return maskPlain(m.text, t.buyer).slice(0, 500); }).join('\n---\n');
    var sys = system([
      'あなたは eBay セラーの返信を、買い手の言語へ訳す翻訳者です。',
      '入力は {"ja": 店主が書いた日本語, "buyer_messages": 買い手の直近の発言}。buyer_messages の言語を判定し (英語圏・不明なら英語)、ja をその言語に訳します。',
      'buyer_messages が日本語の時は、text を「ja を整えた日本語」→ 空行 → 「その英訳」の順に並べる (lang は 日本語+英語)。',
      '丁重なビジネス調。忠実に訳し、意味を足さない・省かない。書き出しの「お客様へ」はその言語の同等表現 (例: Dear customer,)。',
      '結びの「敬具」「よろしくお願いします」等は Best regards, 等。署名・店名は ja に書いてある時だけ残す (足さない)。買い手の名前・ID を足さない。',
      'URL・数字・金額・日付・追跡番号は変えない。段落と改行は ja のとおり。',
      '出力は JSON だけ: {"lang":"言語名を日本語で (例: 英語)","text":"訳文","back_ja":"訳文の検証用日本語訳"}'
    ].join('\n'));
    return claudeJson(MODEL_MAIN, sys, JSON.stringify({ ja: j, buyer_messages: buyerMsgs }), 4500).then(function (r) {
      var text = trim(r.text);
      if (!text) return { ok: false, message: '訳文が返ってきませんでした' };
      return { ok: true, lang: String(r.lang || ''), text: text, back_ja: String(r.back_ja || ''), note: '' };
    });
  }

  // ---------------------------------------------------------------- 送信
  function send(b) {
    return load().then(function () {
      return gas('send', { mid: b.mid, body: b.body, images: b.images || [], live: true }, { lane: 'front', noAbort: true }).then(function (j) {
        return j;
      }, function (e) {
        if (e && e.network) return { ok: false, keepLocked: true, message: '送信結果が不明です (' + msgOf(e) + ')。eBay の送信済みを確認してください。' };
        throw e;
      });
    });
  }

  // ---------------------------------------------------------------- Order / Summary (第 2 段)
  var SALES_TTL_MS = 20 * 1000, SUMMARY_TTL_MS = 5 * 60 * 1000;
  function queryOf(path, name) {
    var m = String(path).match(new RegExp('[?&]' + name + '=([^&]*)'));
    if (!m) return '';
    try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { return m[1]; }
  }
  function summary(fresh) {
    if (!fresh && summaryC && Date.now() - summaryC.at < SUMMARY_TTL_MS) return Promise.resolve(clone(summaryC.data));
    return gasOk('summary', {}, { lane: 'sales' }).then(function (r) { summaryC = { at: Date.now(), data: r }; return clone(r); });
  }
  function salesList() {
    if (salesC && Date.now() - salesC.at < SALES_TTL_MS) return Promise.resolve(clone(salesC.data));
    return gasOk('sales', { fresh: true }, { lane: 'sales', timeout: STATE_TIMEOUT_MS }).then(function (r) { salesC = { at: Date.now(), data: r }; return clone(r); });
  }
  function salesRead(key) {
    return gas('sales_read', { key: key }).then(function (j) {
      if (j.ok && salesC) (salesC.data.items || []).forEach(function (it) { if (it.key === key) it.unread = false; });
      return j;
    });
  }

  // ---------------------------------------------------------------- Status (第 3 段)
  var TROUBLE_TTL_MS = 20 * 1000, CPASS_TTL_MS = 10 * 60 * 1000;
  // GAS は前回から 10 分以内なら eBay を呼ばず控えを返す (?fresh=1 = 更新ボタンは飛ばす)。?badge=1 = タブの件数だけ (控えを返す・eBay は呼ばない)
  function troubles(path) {
    if (/[?&]badge=1/.test(path)) return gas('troubles', { badge: true }, { lane: 'trouble' });
    var fresh = /[?&]fresh=1/.test(path);
    if (!fresh && troubleC && Date.now() - troubleC.at < TROUBLE_TTL_MS) return Promise.resolve(clone(troubleC.data));
    // ok:false でも error と控えを画面が読む (ZBook と同じ・gas で素通し)
    return gas('troubles', { fresh: fresh }, { lane: 'trouble', timeout: STATE_TIMEOUT_MS }).then(function (j) {
      if (j.ok) troubleC = { at: Date.now(), data: j };
      return clone(j);
    });
  }
  function cpassTrack(oc) {
    var c = cpassC[oc];
    if (c && Date.now() - c.at < CPASS_TTL_MS) return Promise.resolve(clone(c.data));
    return gasOk('cpass_track', { oc: oc }).then(function (r) { cpassC[oc] = { at: Date.now(), data: r }; return clone(r); });
  }
  var TROUBLE_SITUATIONS = {
    delay: '配達遅れ: 発送済みなのに到着予定を過ぎた (または過ぎそう)。お詫びと、荷物の状況を確認中であること、買い手側でも追跡で確認できること、届かない場合はまた連絡してほしいことを伝える。',
    duty: '関税未払いで止まっている: 店主は「受取人が関税・輸入税を払うまで配送業者が配達を止めている」状況と判断している。追跡の中身はこちらは持っていないので、止まっていると断定せず、そのような状況のようだと店主が見ている旨で書く。配送業者からの通知 (メール・SMS・不在票) で支払い方法が案内されているはずなので確認・支払いをお願いする、という案内程度に留める。金額・URL・支払い手順の細部は作らない。',
    address: '住所・保管期限: 住所の不備、または配送業者の営業所などでの保管期限が迫っている状況。配送業者からの連絡を確認してもらうこと、住所に誤りがあれば知らせてほしいこと、期限内に受け取ってほしいことを伝える。住所や期限の日付を作らない。',
    other: 'その他: 店主のメモの内容がそのまま依頼。'
  };
  // その買い手の会話 (ItemID も合う物を先に・無ければ同じ買い手の先頭)。無ければ null
  function findBuyerThread(buyer, itemId) {
    var b = trim(buyer).toLowerCase();
    if (!b || !state) return null;
    var mine = state.threads.filter(function (t) { return trim(t.buyer).toLowerCase() === b; });
    var hit = null;
    mine.forEach(function (t) { if (!hit && itemId && trim(t.item_id) === trim(itemId)) hit = t; });
    return hit || mine[0] || null;
  }
  // Status の詳細: 状況ボタンごとの英文の候補 (mail_ai.trouble_drafts の汎用版)。送信はしない (画面が入力欄に入れるだけ)
  function troubleDraft(a) {
    var sit = trim(a.situation);
    if (!TROUBLE_SITUATIONS[sit]) return Promise.reject(new Error('状況が不正です'));
    var memo = trim(a.memo);
    if (sit === 'other' && !memo) return Promise.reject(new Error('メモを書いてください'));
    return load().then(function () { return state ? null : getState(false).catch(function () { return null; }); }).then(function () {
      var t = findBuyerThread(a.buyer, a.item_id);
      var buyer = t ? trim(t.buyer) : trim(a.buyer);
      var facts = {};
      ['kind', 'title', 'order_id', 'country', 'carrier', 'tracking', 'shipped', 'est_min', 'est_max'].forEach(function (k) { var v = trim(a[k]); if (v !== '') facts[k] = v; });
      if (typeof a.overdue_days === 'number' && isFinite(a.overdue_days) && a.overdue_days % 1 === 0) facts.overdue_days = a.overdue_days;
      var msgs = '';
      if (t && t.msgs && t.msgs.length) {
        msgs = t.msgs.slice(-14).map(function (m) { return (m.who === 'me' ? '[店主]' : '[買い手]') + ' ' + maskPlain(m.text, buyer).slice(0, 1200); }).join('\n');
      }
      var sys = system('【あなたの仕事】店主が選んだ「状況」について、買い手へ送る英文のメッセージ案を 2〜3 本、トーンや長さを少し変えて書いてください (各案に日本語訳を付ける)。' +
        '買い手の過去の発言が英語以外なら、その言語で書き、ja はそのまま日本語訳にする。会話が無ければ英語。' +
        '丁重なビジネス調で、書き出しと結びを添える。短く、要点だけ。' +
        '【事実】は渡された注文の情報と店主のメモだけ。ここに無い事実 (追跡の現況・金額・日付・住所・支払い方法の細部・URL) は作らない。分からない点は断定しない言い方にする。' +
        '返信文に指示文そのものは残さない。\n' +
        '出力は JSON だけ: {"options":[{"en":"買い手へ送る文","ja":"その日本語訳"}]}');
      var user = '【状況 (店主が選んだもの)】\n' + TROUBLE_SITUATIONS[sit] +
        '\n\n【店主のメモ (日本語・空なら無し)】\n' + maskPlain(memo, buyer).slice(0, 1500) +
        '\n\n【注文の情報】\n' + JSON.stringify(facts) +
        '\n\n【これまでの会話 (古い順・無ければ無し)】\n' + (msgs || '(会話なし)');
      return claudeJson(MODEL_MAIN, sys, user, 3500);
    }).then(function (r) {
      var opts = (r.options || []).slice(0, 3).filter(function (o) { return o && typeof o === 'object'; })
        .map(function (o) { return { en: trim(o.en), ja: trim(o.ja) }; }).filter(function (o) { return o.en; });
      if (!opts.length) throw new Error('メッセージ案が返ってきませんでした');
      return { ok: true, options: opts };
    });
  }

  // ---------------------------------------------------------------- 商品の画面 (第 4 段 a・2026-10-21): 計算・編集は GAS (Mail_Item_Api.gs.js)。AI でオファー額を拾う所と会話探しだけここ
  var MODEL_OFFER = 'claude-haiku-5-5', MODEL_RETRY = 'claude-sonnet-5-5';
  var OFFER_SYSTEM = [
    'You extract the price a buyer is offering from their latest eBay messages.',
    'Return ONLY a JSON object: {"found": bool, "amount": number|null, "currency": string|null, "quote": string|null}.',
    '- amount: the price the buyer proposes to pay for the item (a number only). If they give an amount and an approximate conversion of it into another currency, ' +
      'return the main amount they ask to pay, not the conversion. If they only say a percentage or no number, found=false.',
    '- currency: ISO 4217 code (AUD, USD, GBP, EUR, CAD ...). If the buyer writes only "$" and the listing currency is given, assume the listing currency; otherwise USD.',
    "- quote: ONE sentence copied verbatim from the buyer's text that states the offer.",
    '- If no price is offered, return {"found": false, "amount": null, "currency": null, "quote": null}.'
  ].join('\n');
  var offers = {};                                 // (買い手の発言, 通貨) → AI の答え。発言が変わるまで使い回す (画面を閉じるまで)

  function buyerLatestRun(msgs) {                  // item_offer.buyer_latest_run: 最新の買い手の発言 (続けて来た分・最大 5 通)
    var i = msgs.length - 1;
    while (i >= 0 && msgs[i].who === 'me') i--;
    var j = i;
    while (j >= 0 && msgs[j].who !== 'me') j--;
    return msgs.slice(j + 1, i + 1).slice(-5);
  }
  function escRe(x) { return String(x).replace(/[.*+?^$|()[\]{}\\]/g, '\\$&'); }
  function amountInText(amount, text) {            // AI が拾った額が原文に数字として出ているか (作り話の防止)
    var t = String(text).replace(/(?<=\d),(?=\d)/g, '');
    var c = {}; c[amount.toFixed(2)] = 1; c[String(+amount.toPrecision(6))] = 1;
    if (amount === Math.floor(amount)) c[String(amount)] = 1;
    return Object.keys(c).some(function (k) { return new RegExp('(?<![\\d.])' + escRe(k) + '(?!\\d)').test(t); });
  }
  function numOf(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
    return isFinite(n) ? n : null;
  }
  function offerOf(t, cur) {                       // OfferGuesser.offer: { found, amount, currency, quote } か { found:false, reason }
    var run = buyerLatestRun(t.msgs || []);
    var text = run.map(function (m) { return maskPlain(m.text, t.buyer).slice(0, 1500); }).join('\n---\n');
    if (!trim(text)) return Promise.resolve({ found: false, reason: '買い手の発言がありません' });
    var user = 'Listing currency: ' + (cur || 'unknown') + "\n\nBuyer's latest message(s):\n" + text;
    var key = text + '\u0000' + (cur || '');
    var got = Object.prototype.hasOwnProperty.call(offers, key) ? Promise.resolve(offers[key])
      : claudeJson(MODEL_OFFER, OFFER_SYSTEM, user, 300, { thinking: { type: 'disabled' } }).then(function (j) {
        if (Object.keys(offers).length >= 500) offers = {};
        offers[key] = j; return j;
      });
    return got.then(function (j) {
      var amt = j && typeof j === 'object' && j.found ? numOf(j.amount) : null;
      var c = j && typeof j === 'object' ? String(j.currency || '').trim().toUpperCase() : '';
      if (!amt || amt <= 0 || !/^[A-Z]{3}$/.test(c)) return { found: false, reason: '買い手の発言に金額が見当たりません' };
      if (!amountInText(amt, text)) return { found: false, reason: 'AI が拾った額 (' + amt + ') が原文に見当たらないため使いません' };
      return { found: true, amount: amt, currency: c, quote: String(j.quote || '') };
    }, function (e) { return { found: false, reason: 'AI で額を拾えませんでした: ' + msgOf(e) }; });
  }
  // /api/item-offer-guess: 行の特定と出品価格は GAS (item_guess)。会話は端末にあるので、買い手のオファー額の拾い出しと割引率はここ。読むだけ
  function itemGuess(b) {
    return load().then(function () {
      var t = findThread(b.mid);
      if (!t) return { ok: false, message: 'その会話が見つかりません' };
      return gas('item_guess', { item_id: t.item_id, item_title: t.item_title || t.title || '', price: t.price || '', row: b.row }).then(function (g) {
        if (!g.ok || g.row === null || g.row === undefined) return g;       // 行が絞れない時は AI を呼ばない (ZBook と同じ)
        var cur = g.list_price && g.list_price.currency;
        return offerOf(t, cur).then(function (of) {
          g.offer = of;
          if (cur && of.found) {
            if (of.currency !== cur) g.note = '通貨が違うので計算できません (出品 ' + cur + ' / オファー ' + of.currency + ')';
            else g.discount = 1 - of.amount / g.list_price.amount;
          }
          return g;
        });
      });
    });
  }
  // /api/retranslate (Re:translation): 開いている会話の買い手・自分の通だけを Sonnet で訳し直して端末の訳に上書きする
  function retranslate(mid) {
    return load().then(function () {
      var t = findThread(mid);
      if (!t) return { ok: false, message: 'その会話が見つかりません' };
      if (!hasClaude()) throw new Error('Settings に Claude キーを入れてください');
      var todo = [];
      (t.msgs || []).forEach(function (m) {
        if (!m.id || !m.text || (m.who !== 'buyer' && m.who !== 'me') || /^(local|sent)-/.test(String(m.id))) return;
        if (isJapanese(m.text) || PHOTO_ONLY.test(String(m.text).trim())) return;
        todo.push({ id: String(m.id), text: m.text, buyer: t.buyer });
      });
      var got = {}, chunks = [];
      for (var i = 0; i < todo.length; i += TRANS_BATCH) chunks.push(todo.slice(i, i + TRANS_BATCH));
      return chunks.reduce(function (p, chunk) {
        return p.then(function () {
          var tables = {}, batch = {};
          chunk.forEach(function (x) { var mk = mask(x.text, x.buyer); tables[x.id] = mk.table; batch[x.id] = mk.masked.slice(0, 2500); });
          return claudeJson(MODEL_RETRY, TRANS_SYSTEM, JSON.stringify(batch), 6000).then(function (res) {
            chunk.forEach(function (x) { var v = trim(res[x.id]); if (v) { got[x.id] = unmask(v, tables[x.id]); ja[x.id] = got[x.id]; } });
          });
        });
      }, Promise.resolve()).then(function () {
        persistJa();
        if (state) { decorate(state.threads); bump(); }
        var n = Object.keys(got).length;
        return { ok: true, ja: got, message: n + ' 通を訳し直しました' };
      });
    });
  }
  // 商品系の GAS 呼び出し。ok:false に status が付く物 (404・400・503) は Error にして .status を渡す (app.js が 404 を見る)
  function itemGet(action, payload) {
    return gas(action, payload).then(function (j) {
      if (!j.ok && j.status) { var er = new Error(j.message || '失敗しました'); er.status = j.status; er.result = j; throw er; }
      return j;
    });
  }
  // 編集 (eBay へ書く) は時間で打ち切らない: 打ち切ると反映されたか分からなくなる。通信が切れた時は「確認できませんでした」を返す (ZBook の unknown と同じ)
  function itemEdit(action, payload) {
    return gas(action, payload, { noAbort: true, lane: 'long' }).then(function (j) { return j; }, function (e) {
      if (e && e.network) return { ok: false, unknown: true, message: 'GAS との通信が途中で切れました。反映されたか確認できませんでした。商品を読み直して確かめてください' };
      throw e;
    });
  }
  var ITEM_EDIT = { '/api/item-edit-get': 'item_edit_get', '/api/item-title': 'item_title', '/api/item-cost-push': 'item_cost_push', '/api/item-price-push': 'item_price_push', '/api/item-end': 'item_end' };

  // ---------------------------------------------------------------- 入口 (app.js の apiCall から)
  function pathOf(path) { var i = path.indexOf('?'); return i < 0 ? path : path.slice(0, i); }
  function unsupported(path) { return Promise.reject(new Error('配布版では未対応です (' + pathOf(path) + ')')); }

  function call(method, path, body, onHeaders) {
    try { return route(method, path, body, onHeaders); } catch (e) { return Promise.reject(e); }   // 同期の失敗も Promise で返す (app.js は .then で受ける)
  }
  function route(method, path, body, onHeaders) {
    var p = pathOf(path), b = body || {};
    if (method === 'GET' && p === '/api/state') return getState(/[?&]fresh=1/.test(path), onHeaders);
    if (method === 'GET' && p === '/api/stamp') return load().then(function () { return { updated: state ? state.updated : '', queueUpdated: state ? state.queueUpdated : '' }; });
    if (method === 'GET' && p === '/api/templates') {
      if (templates && Date.now() - templatesAt < 5 * 60 * 1000) return Promise.resolve(templates);
      return gasOk('templates').then(function (r) { templates = r; templatesAt = Date.now(); return r; });
    }
    if (method === 'GET' && p === '/api/summary') return summary(/[?&]fresh=1/.test(path));
    if (method === 'GET' && p === '/api/sales') {
      if (/[?&]cached=1/.test(path)) return Promise.resolve(salesC ? clone(salesC.data) : { ok: true, items: [] });   // Status の 4 行目の材料: Order を開いたことがある分だけ (新しく取りに行かない)
      return salesList();
    }
    if (method === 'GET' && p === '/api/troubles') return troubles(path);
    if (method === 'GET' && p === '/api/cpass-track') return cpassTrack(queryOf(path, 'oc'));
    if (method === 'GET' && p === '/api/oc-track') return gasOk('oc_track', { n: queryOf(path, 'n') });
    if (method === 'GET' && p === '/api/sales-cands') return gasOk('sales_cands', { q: queryOf(path, 'q') });
    if (method === 'GET' && p === '/api/items') return itemGet('items', { q: queryOf(path, 'q') });
    if (method === 'GET' && p === '/api/item') return itemGet('item', { id: queryOf(path, 'id'), row: queryOf(path, 'row') });
    if (method === 'GET' && p === '/api/item-supplier') return gasOk('item_supplier', { id: queryOf(path, 'id') });
    if (method !== 'POST') return unsupported(path);
    if (p === '/api/done') return gas('done', { mid: b.mid }).then(function (j) { if (j.ok && state) { var t = findThread(b.mid); if (t) t.open = false; bump(); } return j; });
    if (p === '/api/send') return send(b);
    if (p === '/api/ai-options') return aiOptions(b.mid, b.memo);
    if (p === '/api/ai-draft') return aiDraft(b.mid, b.memo, b.option, b.extra);
    if (p === '/api/ai-rewrite') return aiRewrite(b.mid, b.ja, b.option);
    if (p === '/api/translate') return aiTranslate(b.mid, b.ja);
    if (p === '/api/ledger') return Promise.resolve({ ok: true, message: '台帳への記録は配布版では行いません' });
    if (p === '/api/offer-url') return gas('offer_url', { mid: b.mid, itemId: b.itemId, buyer: b.buyer });
    if (p === '/api/mail-read') {
      return load().then(function () {
        if (!b.mid) { var er = new Error('mid がありません'); er.status = 400; throw er; }
        seen.mids[String(b.mid)] = 1; persistSeen();
        return { ok: true };
      });
    }
    if (p === '/api/sales-read') {
      if (!b.key) { var er2 = new Error('key がありません'); er2.status = 400; return Promise.reject(er2); }
      return salesRead(String(b.key));
    }
    if (p === '/api/sales-cost') {            // ok:false でも now_cost / now_ship を画面が読む (gas で素通し)。書いた後・シートが変わっていた後は一覧を取り直す
      return gas('sales_cost', { row: b.row, item_id: b.item_id, old_cost: b.old_cost, old_ship: b.old_ship, cost: b.cost, ship: b.ship }).then(function (j) { salesC = null; return j; });
    }
    if (p === '/api/sales-match') return gas('sales_match', { row: b.row, order_id: b.order_id, item_id: b.item_id }).then(function (j) { salesC = null; return j; });
    if (p === '/api/item-pics') return gasOk('item_pics', { ids: b.ids || [] });
    if (p === '/api/trouble-archive') {
      if (!b.kind || !b.id) { var er3 = new Error('種類か ID がありません'); er3.status = 400; return Promise.reject(er3); }
      return gas('trouble_archive', { kind: b.kind, id: b.id }).then(function (j) { troubleC = null; return j; });
    }
    if (p === '/api/trouble-draft') return troubleDraft(b);
    if (p === '/api/item-offer-guess') return itemGuess(b);
    if (p === '/api/retranslate') return retranslate(b.mid);
    if (p === '/api/item-calc') return itemGet('item_calc', b);
    if (p === '/api/item-cost' || p === '/api/item-ship') return gas(p === '/api/item-cost' ? 'item_cost' : 'item_ship', { item_id: b.item_id, old: b.old, new: b.new });
    if (p === '/api/items-refresh') return Promise.resolve({ ok: true, message: '読み直しました', read_at: new Date().toISOString(), error: null });
    if (Object.prototype.hasOwnProperty.call(ITEM_EDIT, p)) return itemEdit(ITEM_EDIT[p], b);
    if (p === '/api/notices-seen') return Promise.resolve({ ok: true, n: 0 });
    return unsupported(path);
  }

  var api = { call: call, _t: { mask: mask, unmask: unmask, maskPlain: maskPlain, isJapanese: isJapanese, decorate: decorate, adopt: adopt, pathOf: pathOf,
    state: function () { return state; }, reset: function () { state = null; freshP = null; } } };
  root.MailGas = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
