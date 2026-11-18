import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'vpn_manager.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.light,
    systemNavigationBarColor: Color(0xFF000000),
    systemNavigationBarIconBrightness: Brightness.light,
  ));
  runApp(const VpnApp());
}

class VpnApp extends StatelessWidget {
  const VpnApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Vira VPN',
      theme: ThemeData.dark(useMaterial3: true),
      home: const WebShell(),
    );
  }
}

class WebShell extends StatefulWidget {
  const WebShell({super.key});

  @override
  State<WebShell> createState() => _WebShellState();
}

class _WebShellState extends State<WebShell> with WidgetsBindingObserver {
  late final WebViewController _web;
  late final VpnManager _vpn;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);

    _vpn = VpnManager(emit: _emit);
    _web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF000000))
      ..addJavaScriptChannel('FlutterBridge',
          onMessageReceived: (m) => _dispatch(m.message))
      ..loadFlutterAsset('assets/www/index.html');

    _vpn.init();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _vpn.republish();
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      _vpn.flush();
    }
  }

  // ------------------------------------------------------------- bridge
  // JS escapes: U+2028/2029 are valid JSON but not valid JS string chars.
  String _js(Object? v) => jsonEncode(v)
      .replaceAll('\u2028', r'\u2028')
      .replaceAll('\u2029', r'\u2029');

  void _run(String code) {
    _web.runJavaScript(code).catchError((_) {});
  }

  void _emit(String event, Object? data) {
    _run('window.Bridge&&Bridge._emit(${_js(event)},${_js(data)})');
  }

  void _reply(int id, bool ok, Object? data) {
    _run('window.Bridge&&Bridge._resolve($id,$ok,${_js(data)})');
  }

  Future<void> _dispatch(String raw) async {
    int id = 0;
    try {
      final msg = jsonDecode(raw) as Map<String, dynamic>;
      id = (msg['id'] as num).toInt();
      final action = msg['action'] as String;
      final p = msg['payload'] is Map
          ? Map<String, dynamic>.from(msg['payload'] as Map)
          : <String, dynamic>{};
      _reply(id, true, await _handle(action, p));
    } catch (e) {
      _reply(id, false, e.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<Object?> _handle(String action, Map<String, dynamic> p) async {
    switch (action) {
      case 'init':
        return _vpn.snapshot();
      case 'fetchServers':
        return _vpn.fetchServers(p['url'] as String);
      case 'select':
        await _vpn.select(p);
        return true;
      case 'connect':
        await _vpn.connect(p);
        return true;
      case 'disconnect':
        await _vpn.disconnect();
        return true;
      case 'ping':
        return _vpn.ping(p['config'] as String);
      case 'resetTraffic':
        await _vpn.resetTraffic();
        return true;
      case 'exit':
        if (p['disconnect'] == true) await _vpn.disconnect();
        await _vpn.flush();
        await SystemNavigator.pop();
        return true;
      default:
        throw Exception('unknown_action: $action');
    }
  }

  // ---------------------------------------------------------------- back
  Future<void> _handleBack() async {
    var handled = false;
    try {
      final r = await _web
          .runJavaScriptReturningResult('(window.App && App.back()) ? 1 : 0');
      handled = r.toString().replaceAll('"', '').trim() == '1';
    } catch (_) {}
    // Not handled by the web UI => we are on the main page => leave the app.
    // (The VPN service keeps running in the background.)
    if (!handled) await SystemNavigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _handleBack();
      },
      child: Scaffold(
        backgroundColor: Colors.black,
        body: SafeArea(child: WebViewWidget(controller: _web)),
      ),
    );
  }
}
