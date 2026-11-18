'use strict';

/* ======================================================================
 *  Vira VPN – UI logic
 *  The API address lives here (JS) and is passed to Flutter via the bridge.
 * ==================================================================== */
var API_URL = 'https://virasub.ir/npv/';

var $ = function (sel) { return document.querySelector(sel); };

var S = {
  servers: [],
  selected: null,           // {name, icon, config}
  pings: {},                // config -> ms | -1 | 'loading'
  pinging: false,
  lastPingAt: 0,
  loadingServers: false,
  status: { state: 'disconnected', upSpeed: 0, downSpeed: 0, totalUp: 0, totalDown: 0, duration: 0 },
  page: 'home',
  modal: false,
};

/* ------------------------------------------------------------ helpers */
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function fmtSpeed(b) {
  b = Math.max(0, Math.floor(b || 0));
  if (b < 1024) return [String(b), 'B/s'];
  if (b < 1048576) return [(b / 1024).toFixed(1), 'KB/s'];
  return [(b / 1048576).toFixed(2), 'MB/s'];
}

function fmtBytes(b) {
  b = Math.max(0, b || 0);
  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = 0;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return [i === 0 ? String(Math.floor(b)) : b.toFixed(i >= 3 ? 2 : 1), units[i]];
}

function fmtTime(sec) {
  sec = Math.max(0, sec | 0);
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h, m, s].map(function (n) { return String(n).padStart(2, '0'); }).join(':');
}

function setStat(id, pair) {
  $(id).innerHTML = pair[0] + '<em>' + pair[1] + '</em>';
}

var toastTimer;
function toast(msg) {
  var t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3200);
}

function errText(e) {
  var m = (e && e.message) ? e.message : String(e);
  if (m.indexOf('permission_denied') >= 0) return 'اجازه‌ی VPN داده نشد';
  if (m.indexOf('timeout') >= 0) return 'زمان اتصال تمام شد؛ سرور دیگری را امتحان کنید';
  if (m.indexOf('empty_list') >= 0) return 'لیست سرورها خالی است';
  if (m.indexOf('init_failed') >= 0) return 'راه‌اندازی هسته‌ی VPN ناموفق بود';
  return 'خطا: ' + m;
}

function flagHtml(icon) {
  return icon ? '<img src="' + esc(icon) + '" alt="" loading="lazy">' : '<span class="globe">🌐</span>';
}

// broken flag images fall back to a globe (error events don't bubble => capture)
document.addEventListener('error', function (e) {
  var el = e.target;
  if (el && el.tagName === 'IMG') {
    var span = document.createElement('span');
    span.className = 'globe';
    span.textContent = '🌐';
    el.replaceWith(span);
  }
}, true);

/* ------------------------------------------------------------ rendering */
function pingInfo(config) {
  var v = S.pings[config];
  if (v === undefined) return { text: '—', cls: '' };
  if (v === 'loading') return { text: '…', cls: 'loading' };
  if (v <= 0 || v >= 10000) return { text: 'ناموفق', cls: 'bad' };
  return { text: v + ' ms', cls: v < 300 ? 'good' : (v < 700 ? 'mid' : 'bad') };
}

function renderStatus() {
  var st = S.status;
  document.body.dataset.state = st.state;
  $('#connect-btn').dataset.state = st.state;
  $('#status-text').textContent = { disconnected: 'قطع شده', connecting: 'در حال اتصال…', connected: 'متصل شد' }[st.state] || '';
  $('#timer').textContent = st.state === 'connected' ? fmtTime(st.duration) : '00:00:00';
  setStat('#speed-down', fmtSpeed(st.state === 'connected' ? st.downSpeed : 0));
  setStat('#speed-up', fmtSpeed(st.state === 'connected' ? st.upSpeed : 0));
  setStat('#total-down', fmtBytes(st.totalDown));
  setStat('#total-up', fmtBytes(st.totalUp));
}

function renderSelected() {
  var s = S.selected;
  $('#sel-name').textContent = s ? s.name : 'انتخاب سرور';
  $('#sel-flag').innerHTML = flagHtml(s && s.icon);
  var p = $('#sel-ping');
  if (s) {
    var info = pingInfo(s.config);
    p.textContent = info.text === '—' ? '' : info.text;
    p.className = 'ping ' + info.cls;
  } else {
    p.textContent = '';
    p.className = 'ping';
  }
}

function renderServers() {
  var list = $('#server-list');
  $('#srv-count').textContent = S.servers.length ? S.servers.length + ' سرور' : '';
  $('#btn-ping-all').disabled = S.pinging || !S.servers.length;
  $('#btn-ping-all').textContent = S.pinging ? 'در حال تست…' : 'تست پینگ همه';
  $('#btn-refresh svg').classList.toggle('spin', S.loadingServers);

  if (!S.servers.length) {
    list.innerHTML = '<div class="empty">' + (S.loadingServers
      ? 'در حال دریافت لیست سرورها…'
      : 'لیست سرورها خالی است.<br>با دکمه‌ی بروزرسانی بالا دوباره تلاش کنید.') + '</div>';
    return;
  }

  list.innerHTML = S.servers.map(function (s, i) {
    var sel = S.selected && S.selected.config === s.config;
    var p = pingInfo(s.config);
    return '<button class="srv' + (sel ? ' sel' : '') + '" data-i="' + i + '">' +
      '<span class="flag">' + flagHtml(s.icon) + '</span>' +
      '<span class="nm">' + esc(s.name) + '</span>' +
      '<span class="ping ' + p.cls + '">' + p.text + '</span>' +
      '<span class="chk">✓</span></button>';
  }).join('');
}

function renderAll() { renderStatus(); renderSelected(); renderServers(); }

/* ------------------------------------------------------------ routing */
function go(page) {
  if (S.page === page) return;
  S.page = page;
  document.querySelectorAll('.page').forEach(function (p) {
    p.classList.toggle('active', p.id === 'page-' + page);
  });
  if (page === 'servers') {
    renderServers();
    if (S.servers.length && Date.now() - S.lastPingAt > 60000) pingAll();
  }
}

/* Called by Flutter on the system back button.
 * Returns true when the web UI consumed it; false => Flutter exits the app. */
window.App = {
  back: function () {
    if (S.modal) { closeModal(); return true; }
    if (S.page !== 'home') { go('home'); return true; }
    return false;
  },
};

/* ------------------------------------------------------------ modal */
function openModal(html) {
  $('#sheet').innerHTML = html;
  $('#modal').classList.remove('hidden');
  S.modal = true;
}
function closeModal() {
  $('#modal').classList.add('hidden');
  S.modal = false;
}

function askExit() {
  var active = S.status.state !== 'disconnected';
  openModal(
    '<h2>خروج از برنامه</h2>' +
    '<p>' + (active
      ? 'VPN در پس‌زمینه فعال است. می‌توانید فقط برنامه را ببندید و اتصال را نگه دارید، یا اتصال را هم قطع کنید.'
      : 'برنامه بسته می‌شود.') + '</p>' +
    '<button class="primary" data-x="keep">' + (active ? 'خروج (اتصال فعال می‌ماند)' : 'خروج') + '</button>' +
    (active ? '<button class="danger" data-x="stop">قطع اتصال و خروج</button>' : '') +
    '<button data-x="cancel">انصراف</button>'
  );
}

/* ------------------------------------------------------------ actions */
async function toggleConnection() {
  var st = S.status.state;
  if (st === 'connected' || st === 'connecting') {
    try { await Bridge.call('disconnect'); } catch (e) { toast(errText(e)); }
    return;
  }
  if (!S.selected) {
    toast('ابتدا یک سرور انتخاب کنید');
    go('servers');
    return;
  }
  S.status.state = 'connecting';
  renderStatus();
  try {
    await Bridge.call('connect', S.selected);
  } catch (e) {
    toast(errText(e));
  }
}

async function chooseServer(i) {
  var s = S.servers[i];
  if (!s) return;
  S.selected = { name: s.name, icon: s.icon, config: s.config };
  renderSelected();
  renderServers();
  try {
    if (S.status.state === 'connected' || S.status.state === 'connecting') {
      S.status.state = 'connecting';
      renderStatus();
      go('home');
      await Bridge.call('connect', S.selected);   // Flutter restarts with the new server
    } else {
      await Bridge.call('select', S.selected);
      go('home');
    }
  } catch (e) {
    toast(errText(e));
  }
}

async function loadServers() {
  if (S.loadingServers) return;
  S.loadingServers = true;
  renderServers();
  try {
    // the address is passed from JS to Flutter, Flutter performs the request
    var list = await Bridge.call('fetchServers', { url: API_URL }, 40000);
    S.servers = list;
    if (!S.selected && list.length) {
      S.selected = { name: list[0].name, icon: list[0].icon, config: list[0].config };
      Bridge.call('select', S.selected).catch(function () {});
    }
  } catch (e) {
    toast(S.servers.length ? 'بروزرسانی لیست ناموفق بود؛ لیست ذخیره‌شده نمایش داده می‌شود' : 'دریافت لیست سرورها ناموفق بود');
  }
  S.loadingServers = false;
  renderAll();
}

async function pingAll() {
  if (S.pinging || !S.servers.length) return;
  S.pinging = true;
  var configs = S.servers.map(function (s) { return s.config; });
  configs.forEach(function (c) { S.pings[c] = 'loading'; });
  renderServers();
  renderSelected();

  var next = 0;
  async function worker() {
    while (next < configs.length) {
      var c = configs[next++];
      try {
        var ms = await Bridge.call('ping', { config: c }, 25000);
        S.pings[c] = (ms > 0 && ms < 10000) ? ms : -1;
      } catch (e) {
        S.pings[c] = -1;
      }
      renderServers();
      renderSelected();
    }
  }
  await Promise.all([worker(), worker(), worker()]);   // 3 tests in parallel
  S.pinging = false;
  S.lastPingAt = Date.now();
  renderServers();
}

/* ------------------------------------------------------------ events */
Bridge.on('status', function (s) {
  Object.assign(S.status, s);
  if (s.server && !S.selected) S.selected = s.server;
  renderStatus();
  renderSelected();
});

Bridge.on('error', function (e) { toast(errText(new Error(e && e.message))); });

$('#connect-btn').addEventListener('click', toggleConnection);
$('#server-card').addEventListener('click', function () { go('servers'); });
$('#btn-servers').addEventListener('click', function () { go('servers'); });
$('#btn-back').addEventListener('click', function () { go('home'); });
$('#btn-refresh').addEventListener('click', loadServers);
$('#btn-ping-all').addEventListener('click', pingAll);
$('#btn-exit').addEventListener('click', askExit);
$('#reset-traffic').addEventListener('click', function () {
  Bridge.call('resetTraffic').catch(function (e) { toast(errText(e)); });
});

$('#server-list').addEventListener('click', function (e) {
  var btn = e.target.closest('.srv');
  if (btn) chooseServer(+btn.dataset.i);
});

$('#modal').addEventListener('click', function (e) {
  if (e.target.id === 'modal') { closeModal(); return; }
  var b = e.target.closest('button[data-x]');
  if (!b) return;
  var x = b.dataset.x;
  closeModal();
  if (x === 'keep') Bridge.call('exit', { disconnect: false }).catch(function () {});
  if (x === 'stop') Bridge.call('exit', { disconnect: true }).catch(function () {});
});

/* ------------------------------------------------------------ boot */
(async function boot() {
  renderAll();
  try {
    var snap = await Bridge.call('init', {}, 15000);
    S.servers = snap.servers || [];
    S.selected = snap.selected || null;
    Object.assign(S.status, snap.status || {});
    if (snap.error) toast(errText(new Error('init_failed')));
  } catch (e) {
    toast(errText(e));
  }
  renderAll();
  loadServers();
})();
