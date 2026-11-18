import 'dart:async';
import 'dart:convert';

import 'package:flutter_vless/flutter_vless.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';

typedef EmitFn = void Function(String event, Object? data);

/// Owns the VPN session, persistence (state + traffic totals), server list
/// fetching and ping tests. The HTML UI talks to this class through the bridge.
class VpnManager {
  VpnManager({required this.emit});

  final EmitFn emit;

  late final FlutterVless _vless;
  late final SharedPreferences _prefs;
  final Completer<void> _ready = Completer<void>();
  Object? _initError;

  // disconnected | connecting | connected | restoring (shown as connecting)
  String _state = 'disconnected';
  Map<String, dynamic>? _server; // {name, icon, config}

  int _upSpeed = 0, _downSpeed = 0, _duration = 0;
  int _totalUp = 0, _totalDown = 0; // persisted totals (all sessions)
  int _lastUp = 0, _lastDown = 0; // last seen per-session counters

  Timer? _connectTimer;
  Timer? _restoreTimer;
  DateTime _lastSave = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _ignoreConnectedUntil = DateTime.fromMillisecondsSinceEpoch(0);

  // ---------------------------------------------------------------- init
  Future<void> init() async {
    try {
      _prefs = await SharedPreferences.getInstance();
      _totalUp = _prefs.getInt('totalUp') ?? 0;
      _totalDown = _prefs.getInt('totalDown') ?? 0;
      final raw = _prefs.getString('selected');
      if (raw != null) {
        _server = Map<String, dynamic>.from(jsonDecode(raw) as Map);
      }
      final want = _prefs.getBool('wantConnected') ?? false;
      if (want) {
        _lastUp = _prefs.getInt('lastUp') ?? 0;
        _lastDown = _prefs.getInt('lastDown') ?? 0;
        _state = 'restoring';
      }

      _vless = FlutterVless(onStatusChanged: _onStatus);
      await _vless.initializeVless(
        providerBundleIdentifier: 'ir.virasub.vless_vpn',
        groupIdentifier: 'group.ir.virasub.vless_vpn',
        notificationIconResourceType: 'mipmap',
        notificationIconResourceName: 'ic_launcher',
      );

      if (_state == 'restoring') {
        // If the background service is still alive, CONNECTED events arrive
        // within a second or two. If nothing arrives, it was stopped.
        _restoreTimer = Timer(const Duration(seconds: 5), () {
          if (_state == 'restoring') {
            _lastUp = 0;
            _lastDown = 0;
            _setState('disconnected');
          }
        });
      }
    } catch (e) {
      _initError = e;
    } finally {
      if (!_ready.isCompleted) _ready.complete();
    }
  }

  Future<Map<String, dynamic>> snapshot() async {
    await _ready.future;
    return {
      'status': _statusMap(),
      'servers': _cachedServers(),
      'selected': _server,
      'error': _initError?.toString(),
    };
  }

  void republish() {
    if (_ready.isCompleted && _initError == null) _pushStatus();
  }

  // ------------------------------------------------------------- servers
  List<dynamic> _cachedServers() {
    final raw = _prefs.getString('servers');
    if (raw == null) return [];
    try {
      return jsonDecode(raw) as List<dynamic>;
    } catch (_) {
      return [];
    }
  }

  /// [url] is passed from JavaScript.
  Future<List<dynamic>> fetchServers(String url) async {
    await _ready.future;
    final res = await http.get(Uri.parse(url), headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13) ViraVPN/1.0',
    }).timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) {
      throw Exception('HTTP ${res.statusCode}');
    }
    final list = _normalize(jsonDecode(utf8.decode(res.bodyBytes)));
    if (list.isEmpty) throw Exception('empty_list');
    await _prefs.setString('servers', jsonEncode(list));
    return list;
  }

  List<Map<String, dynamic>> _normalize(dynamic data) {
    if (data is Map) {
      for (final v in data.values) {
        if (v is List) {
          data = v;
          break;
        }
      }
    }
    if (data is! List) return [];
    final out = <Map<String, dynamic>>[];
    for (final item in data) {
      if (item is! Map) continue;
      final config = (item['config'] ?? '').toString().trim();
      if (config.isEmpty) continue;
      final name =
          (item['loction'] ?? item['location'] ?? item['name'] ?? 'Server')
              .toString();
      out.add({
        'name': name,
        'icon': (item['icon'] ?? '').toString(),
        'config': config,
      });
    }
    return out;
  }

  Future<void> select(Map<String, dynamic> server) async {
    await _ready.future;
    _server = _pickServer(server);
    await _prefs.setString('selected', jsonEncode(_server));
    _pushStatus();
  }

  Map<String, dynamic> _pickServer(Map<String, dynamic> s) => {
        'name': (s['name'] ?? 'VPN').toString(),
        'icon': (s['icon'] ?? '').toString(),
        'config': (s['config'] ?? '').toString(),
      };

  // ---------------------------------------------------------------- ping
  /// Returns delay in ms, or -1 when the server is unreachable.
  Future<int> ping(String config) async {
    await _ready.future;
    if (_initError != null) return -1;
    try {
      final full = FlutterVless.parse(config).getFullConfiguration();
      final ms = await _vless
          .getServerDelay(config: full)
          .timeout(const Duration(seconds: 12));
      return ms;
    } catch (_) {
      return -1;
    }
  }

  // ------------------------------------------------------ connect / stop
  Future<void> connect(Map<String, dynamic> server) async {
    await _ready.future;
    if (_initError != null) throw Exception('init_failed: $_initError');

    _server = _pickServer(server);
    await _prefs.setString('selected', jsonEncode(_server));

    final config = _server!['config'] as String;
    final name = _server!['name'] as String;

    _cancelTimers();
    if (_state == 'connected' || _state == 'connecting') {
      try {
        await _vless.stopVless();
      } catch (_) {}
      await Future<void>.delayed(const Duration(milliseconds: 700));
    }

    _lastUp = 0;
    _lastDown = 0;
    _upSpeed = 0;
    _downSpeed = 0;
    _duration = 0;
    _setState('connecting');

    try {
      await _requestNotificationPermission();
      final parsed = FlutterVless.parse(config);
      final granted = await _vless.requestPermission();
      if (!granted) throw Exception('permission_denied');
      await _vless.startVless(
        remark: name,
        config: parsed.getFullConfiguration(),
        notificationDisconnectButtonName: 'قطع اتصال',
      );
      _connectTimer = Timer(const Duration(seconds: 20), () {
        if (_state == 'connecting') _failConnect('timeout');
      });
    } catch (e) {
      _cancelTimers();
      _setState('disconnected');
      rethrow;
    }
  }

  Future<void> disconnect() async {
    await _ready.future;
    _cancelTimers();
    try {
      await _vless.stopVless();
    } catch (_) {}
    _lastUp = 0;
    _lastDown = 0;
    _upSpeed = 0;
    _downSpeed = 0;
    _duration = 0;
    _ignoreConnectedUntil = DateTime.now().add(const Duration(seconds: 2));
    _setState('disconnected');
  }

  Future<void> resetTraffic() async {
    await _ready.future;
    _totalUp = 0;
    _totalDown = 0;
    await _save();
    _pushStatus();
  }

  Future<void> _requestNotificationPermission() async {
    try {
      final st = await Permission.notification.status;
      if (!st.isGranted) await Permission.notification.request();
    } catch (_) {}
  }

  void _failConnect(String reason) {
    _cancelTimers();
    _vless.stopVless().catchError((_) {});
    _setState('disconnected');
    emit('error', {'message': reason});
  }

  // -------------------------------------------------------------- status
  void _onStatus(VlessStatus s) {
    final st = s.state.toUpperCase();
    _duration = s.duration;

    switch (st) {
      case 'CONNECTED':
        if (_state == 'disconnected' &&
            DateTime.now().isBefore(_ignoreConnectedUntil)) {
          return; // stale event right after a manual disconnect
        }
        _cancelTimers();
        _accumulate(s);
        _upSpeed = s.uploadSpeed;
        _downSpeed = s.downloadSpeed;
        if (_state != 'connected') {
          _setState('connected');
        } else {
          _pushStatus();
          _saveThrottled();
        }
        break;
      case 'DISCONNECTED':
        // While connecting/restoring a stale DISCONNECTED may be reported;
        // those cases are resolved by their timers.
        if (_state == 'connected') {
          _lastUp = 0;
          _lastDown = 0;
          _upSpeed = 0;
          _downSpeed = 0;
          _duration = 0;
          _setState('disconnected');
        }
        break;
      default:
        if (st.contains('ERROR') && _state == 'connecting') {
          _failConnect('error');
        }
    }
  }

  /// Adds only the growth of the per-session counters to the persisted totals,
  /// so totals survive app restarts (and keep growing while the UI is closed).
  void _accumulate(VlessStatus s) {
    final up = s.upload, down = s.download;
    _totalUp += up >= _lastUp ? up - _lastUp : up;
    _totalDown += down >= _lastDown ? down - _lastDown : down;
    _lastUp = up;
    _lastDown = down;
  }

  void _setState(String s) {
    _state = s;
    unawaited(_save());
    _pushStatus();
  }

  Map<String, dynamic> _statusMap() => {
        'state': _state == 'restoring' ? 'connecting' : _state,
        'upSpeed': _upSpeed,
        'downSpeed': _downSpeed,
        'totalUp': _totalUp,
        'totalDown': _totalDown,
        'duration': _duration,
        'server': _server,
      };

  void _pushStatus() => emit('status', _statusMap());

  void _cancelTimers() {
    _connectTimer?.cancel();
    _restoreTimer?.cancel();
    _connectTimer = null;
    _restoreTimer = null;
  }

  // --------------------------------------------------------- persistence
  void _saveThrottled() {
    if (DateTime.now().difference(_lastSave) > const Duration(seconds: 3)) {
      unawaited(_save());
    }
  }

  Future<void> _save() async {
    if (!_ready.isCompleted || _initError != null) return;
    _lastSave = DateTime.now();
    await _prefs.setInt('totalUp', _totalUp);
    await _prefs.setInt('totalDown', _totalDown);
    await _prefs.setInt('lastUp', _lastUp);
    await _prefs.setInt('lastDown', _lastDown);
    await _prefs.setBool('wantConnected', _state != 'disconnected');
  }

  Future<void> flush() => _save();
}
