import 'dart:convert';
import 'dart:io' show File;

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';

/// Contexte global : URL du serveur, portefeuille pseudonyme, file d'attente hors-ligne.
class Session extends ChangeNotifier {
  late SharedPreferences _prefs;
  late Api api;
  String? walletId;
  String? recoveryCode;
  bool discreet = false;
  List<Map<String, dynamic>> pending = [];
  Map<String, dynamic>? appConfig;

  Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
    api = Api(_prefs.getString('baseUrl') ?? defaultBaseUrl());
    walletId = _prefs.getString('walletId');
    recoveryCode = _prefs.getString('recoveryCode');
    discreet = _prefs.getBool('discreet') ?? false;
    final raw = _prefs.getString('pending');
    if (raw != null) pending = (jsonDecode(raw) as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
    _applyAuth();
  }

  void _applyAuth() {
    api.walletAuth = (walletId != null && recoveryCode != null) ? 'Wallet $walletId:$recoveryCode' : null;
  }

  String get baseUrl => api.baseUrl;
  Future<void> setBaseUrl(String url) async {
    api.baseUrl = url.trim().replaceAll(RegExp(r'/+$'), '');
    await _prefs.setString('baseUrl', api.baseUrl);
    notifyListeners();
  }

  /// Crée le portefeuille pseudonyme au premier besoin (aucun nom, aucun numéro).
  Future<void>? _creating;
  Future<void> ensureWallet() {
    if (walletId != null) return Future.value();
    // plusieurs écrans l'appellent au démarrage : une seule création à la fois
    return _creating ??= _createWallet().whenComplete(() => _creating = null);
  }

  Future<void> _createWallet() async {
    final w = await api.createWallet();
    walletId = w['walletId'] as String;
    recoveryCode = w['recoveryCode'] as String;
    await _prefs.setString('walletId', walletId!);
    await _prefs.setString('recoveryCode', recoveryCode!);
    _applyAuth();
    notifyListeners();
  }

  Future<void> restoreWallet(String id, String code) async {
    walletId = id.trim();
    recoveryCode = code.trim().toUpperCase();
    _applyAuth();
    await api.wallet(); // lève une exception si le code est invalide
    await _prefs.setString('walletId', walletId!);
    await _prefs.setString('recoveryCode', recoveryCode!);
    notifyListeners();
  }

  Future<void> setDiscreet(bool v) async {
    discreet = v;
    await _prefs.setBool('discreet', v);
    notifyListeners();
    try {
      await api.setDiscreet(v);
    } catch (_) {/* préférence locale suffisante */}
  }

  // ---- file d'attente hors-ligne (connectivité faible en zone rurale) ----
  Future<void> _savePending() async => _prefs.setString('pending', jsonEncode(pending));

  Future<void> enqueue(Map<String, dynamic> report) async {
    pending.add(report);
    await _savePending();
    notifyListeners();
  }

  /// Rejoue les signalements en attente ; retourne le nombre envoyé.
  Future<int> flushPending() async {
    if (pending.isEmpty) return 0;
    await ensureWallet();
    var sent = 0;
    for (final r in List<Map<String, dynamic>>.from(pending)) {
      try {
        MediaUpload? photo;
        MediaUpload? audio;
        if (!kIsWeb && r['photoPath'] != null && await File(r['photoPath'] as String).exists()) {
          photo = MediaUpload(await File(r['photoPath'] as String).readAsBytes(), 'photo.jpg');
        }
        if (!kIsWeb && r['audioPath'] != null && await File(r['audioPath'] as String).exists()) {
          audio = MediaUpload(await File(r['audioPath'] as String).readAsBytes(), 'note.m4a');
        }
        await api.submitReport(
          category: r['category'] as String,
          description: r['description'] as String,
          lat: (r['lat'] as num).toDouble(),
          lng: (r['lng'] as num).toDouble(),
          accuracyM: (r['accuracyM'] as num?)?.toDouble(),
          photo: photo,
          audio: audio,
        );
        pending.remove(r);
        sent++;
      } on ApiException catch (e) {
        if (e.network) break; // toujours hors-ligne : on réessaiera
        pending.remove(r); // refus définitif (doublon, position invalide…) : inutile de réessayer
      }
    }
    await _savePending();
    notifyListeners();
    return sent;
  }
}
