/*
 * JS <-> Flutter bridge.
 *
 *   JS -> Flutter : Bridge.call(action, payload) -> Promise
 *                   (posts {id, action, payload} to the "FlutterBridge" JavaScriptChannel)
 *   Flutter -> JS : Bridge._resolve(id, ok, data)   replies to a call
 *                   Bridge._emit(event, data)       pushes events (e.g. "status", "error")
 *
 * When the page is opened in a normal desktop browser (no FlutterBridge channel)
 * a small mock is installed so the UI can be developed without building the app.
 */
(function () {
  'use strict';

  var pending = {};
  var listeners = {};
  var seq = 0;

  var Bridge = {
    call: function (action, payload, timeoutMs) {
      return new Promise(function (resolve, reject) {
        if (typeof window.FlutterBridge === 'undefined') {
          reject(new Error('Flutter bridge not available'));
          return;
        }
        var id = ++seq;
        var timer = setTimeout(function () {
          delete pending[id];
          reject(new Error('timeout'));
        }, timeoutMs || 60000);
        pending[id] = { resolve: resolve, reject: reject, timer: timer };
        window.FlutterBridge.postMessage(JSON.stringify({ id: id, action: action, payload: payload || {} }));
      });
    },

    on: function (event, fn) {
      (listeners[event] = listeners[event] || []).push(fn);
    },

    _resolve: function (id, ok, data) {
      var p = pending[id];
      if (!p) return;
      clearTimeout(p.timer);
      delete pending[id];
      if (ok) p.resolve(data); else p.reject(new Error(String(data)));
    },

    _emit: function (event, data) {
      (listeners[event] || []).forEach(function (fn) {
        try { fn(data); } catch (e) { console.error(e); }
      });
    },
  };

  window.Bridge = Bridge;

  /* ------------------------------------------------ desktop mock (dev only) */
  if (typeof window.FlutterBridge === 'undefined') {
    var mock = { state: 'disconnected', up: 0, down: 0, tUp: 0, tDown: 0, dur: 0, server: null, timer: null };
    var sample = [
      { name: 'ترکیه', icon: '', config: 'vless://demo-1' },
      { name: 'آلمان', icon: '', config: 'vless://demo-2' },
      { name: 'هلند', icon: '', config: 'vless://demo-3' },
    ];
    var status = function () {
      return { state: mock.state, upSpeed: mock.up, downSpeed: mock.down, totalUp: mock.tUp, totalDown: mock.tDown, duration: mock.dur, server: mock.server };
    };
    var push = function () { setTimeout(function () { Bridge._emit('status', status()); }, 0); };
    var stopTick = function () { clearInterval(mock.timer); mock.up = mock.down = mock.dur = 0; };

    var handlers = {
      init: function () { return { status: status(), servers: [], selected: null }; },
      fetchServers: function () { return sample; },
      select: function (p) { mock.server = p; push(); return true; },
      connect: function (p) {
        mock.server = p; mock.state = 'connecting'; push();
        setTimeout(function () {
          mock.state = 'connected'; push();
          mock.timer = setInterval(function () {
            mock.dur++;
            mock.down = Math.floor(Math.random() * 2500000);
            mock.up = Math.floor(Math.random() * 300000);
            mock.tDown += mock.down; mock.tUp += mock.up;
            push();
          }, 1000);
        }, 1200);
        return true;
      },
      disconnect: function () { stopTick(); mock.state = 'disconnected'; push(); return true; },
      ping: function () { return Math.random() < .15 ? -1 : Math.floor(80 + Math.random() * 900); },
      resetTraffic: function () { mock.tUp = mock.tDown = 0; push(); return true; },
      exit: function () { console.log('[mock] exit'); return true; },
    };

    window.FlutterBridge = {
      postMessage: function (raw) {
        var m = JSON.parse(raw);
        var delay = m.action === 'ping' ? 300 + Math.random() * 900 : 120;
        setTimeout(function () {
          try { Bridge._resolve(m.id, true, handlers[m.action](m.payload)); }
          catch (e) { Bridge._resolve(m.id, false, e.message); }
        }, delay);
      },
    };
    window.__MOCK__ = true;
  }
})();
