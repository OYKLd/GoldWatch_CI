import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

class ApiException implements Exception {
  ApiException(this.message, {this.status, this.code, this.network = false});
  final String message;
  final int? status;
  final String? code;

  /// true si le serveur est injoignable (le signalement peut alors être mis en file d'attente hors-ligne).
  final bool network;
  @override
  String toString() => message;
}

/// Accepte `192.168.1.82:3000`, `http://192.168.1.82:3000/` ou `…/api` : ajoute http:// et retire espaces et `/`.
String normalizeBaseUrl(String raw) {
  var u = raw.trim().replaceAll(RegExp(r'\s+'), '');
  if (u.isEmpty) return defaultBaseUrl();
  if (!RegExp(r'^https?://', caseSensitive: false).hasMatch(u)) u = 'http://$u';
  return u.replaceAll(RegExp(r'/+$'), '').replaceFirst(RegExp(r'/api$'), '');
}

String defaultBaseUrl() {
  const fromEnv = String.fromEnvironment('API_URL');
  if (fromEnv.isNotEmpty) return fromEnv;
  if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) return 'http://10.0.2.2:3000';
  return 'http://localhost:3000';
}

class MediaUpload {
  MediaUpload(this.bytes, this.filename, {this.contentType});
  final Uint8List bytes;
  final String filename;
  final String? contentType;
}

class Api {
  Api(this.baseUrl, {this.walletAuth});
  String baseUrl;

  /// Format `Wallet id:code` — pseudonyme généré localement côté serveur, sans identité réelle.
  String? walletAuth;

  Uri _u(String path, [Map<String, String>? q]) => Uri.parse('$baseUrl/api$path').replace(queryParameters: q);
  Map<String, String> get _headers => {
        'Authorization': ?walletAuth,
        'Accept': 'application/json',
      };

  Future<dynamic> _send(Future<http.Response> Function() call) async {
    http.Response res;
    try {
      res = await call().timeout(const Duration(seconds: 20));
    } on TimeoutException {
      throw ApiException('Le serveur ne répond pas', network: true);
    } catch (e) {
      final detail = e.toString().replaceAll(RegExp(r'\s+'), ' ');
      throw ApiException(
        'Réseau indisponible (${detail.length > 110 ? '${detail.substring(0, 110)}…' : detail})',
        network: true,
      );
    }
    dynamic body;
    try {
      body = res.body.isEmpty ? null : jsonDecode(utf8.decode(res.bodyBytes));
    } catch (_) {
      body = null;
    }
    if (res.statusCode >= 400) {
      throw ApiException(
        (body is Map ? body['error'] : null)?.toString() ?? 'Erreur ${res.statusCode}',
        status: res.statusCode,
        code: body is Map ? body['code']?.toString() : null,
      );
    }
    return body;
  }

  Future<dynamic> _get(String path, [Map<String, String>? q]) => _send(() => http.get(_u(path, q), headers: _headers));
  Future<dynamic> _json(String method, String path, Map<String, dynamic> body) => _send(() async {
        final req = http.Request(method, _u(path))
          ..headers.addAll({..._headers, 'Content-Type': 'application/json'})
          ..body = jsonEncode(body);
        return http.Response.fromStream(await req.send());
      });

  Future<void> health() async => _get('/health');
  Future<Map<String, dynamic>> config() async => Map<String, dynamic>.from(await _get('/config'));
  Future<Map<String, dynamic>> createWallet() async => Map<String, dynamic>.from(await _json('POST', '/wallets', {}));
  Future<Map<String, dynamic>> layers() async => Map<String, dynamic>.from(await _get('/layers'));
  Future<List<dynamic>> publicCells() async => (await _get('/public/reports'))['cells'] as List<dynamic>;
  Future<List<dynamic>> publicZones() async => (await _get('/public/zones'))['zones'] as List<dynamic>;
  Future<Map<String, dynamic>> area(double lat, double lng) async =>
      Map<String, dynamic>.from(await _get('/public/area', {'lat': '$lat', 'lng': '$lng'}));
  Future<Map<String, dynamic>> wallet() async => Map<String, dynamic>.from(await _get('/wallet'));
  Future<Map<String, dynamic>> setDiscreet(bool v) async =>
      Map<String, dynamic>.from(await _json('PATCH', '/wallet/settings', {'discreet': v}));
  Future<Map<String, dynamic>> withdraw(int points, String mode) async =>
      Map<String, dynamic>.from(await _json('POST', '/wallet/withdrawals', {'points': points, 'mode': mode}));

  Future<Map<String, dynamic>> submitReport({
    required String category,
    required String description,
    required double lat,
    required double lng,
    double? accuracyM,
    MediaUpload? photo,
    MediaUpload? audio,
  }) async {
    final body = await _send(() async {
      final req = http.MultipartRequest('POST', _u('/reports'))
        ..headers.addAll(_headers)
        ..fields.addAll({
          'category': category,
          'description': description,
          'lat': '$lat',
          'lng': '$lng',
          if (accuracyM != null) 'accuracyM': accuracyM.toStringAsFixed(0),
        });
      if (photo != null) req.files.add(http.MultipartFile.fromBytes('photo', photo.bytes, filename: photo.filename));
      if (audio != null) req.files.add(http.MultipartFile.fromBytes('audio', audio.bytes, filename: audio.filename));
      return http.Response.fromStream(await req.send());
    });
    return Map<String, dynamic>.from(body);
  }
}
