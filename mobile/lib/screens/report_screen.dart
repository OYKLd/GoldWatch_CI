import 'dart:io' show File;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:image_picker/image_picker.dart';
import 'package:latlong2/latlong.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../api.dart';
import '../session.dart';
import '../theme.dart';

class ReportScreen extends StatefulWidget {
  const ReportScreen({super.key, required this.session, required this.fallback});
  final Session session;
  final LatLng fallback;

  @override
  State<ReportScreen> createState() => _ReportScreenState();
}

class _ReportScreenState extends State<ReportScreen> {
  String _category = 'orpaillage';
  final _desc = TextEditingController();
  Uint8List? _photoBytes;
  String? _photoPath;
  String? _audioPath;
  final _recorder = AudioRecorder();
  bool _recording = false;
  bool _sending = false;
  double? _lat, _lng, _accuracy;
  bool _gps = false;

  @override
  void initState() {
    super.initState();
    _lat = widget.fallback.latitude;
    _lng = widget.fallback.longitude;
    _locate();
  }

  @override
  void dispose() {
    _desc.dispose();
    _recorder.dispose();
    super.dispose();
  }

  Future<void> _locate() async {
    try {
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) return;
      final p = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 10)),
      );
      if (!mounted) return;
      setState(() {
        _lat = p.latitude;
        _lng = p.longitude;
        _accuracy = p.accuracy;
        _gps = true;
      });
    } catch (_) {/* position de la carte conservée */}
  }

  Future<void> _takePhoto() async {
    try {
      final x = await ImagePicker().pickImage(source: ImageSource.camera, maxWidth: 1600, imageQuality: 80);
      if (x == null) return;
      final bytes = await x.readAsBytes();
      setState(() {
        _photoBytes = bytes;
        _photoPath = kIsWeb ? null : x.path;
      });
    } catch (_) {
      _snack('Appareil photo indisponible');
    }
  }

  Future<void> _toggleRecord() async {
    if (kIsWeb) return;
    try {
      if (_recording) {
        final path = await _recorder.stop();
        setState(() {
          _recording = false;
          _audioPath = path;
        });
        return;
      }
      if (!await _recorder.hasPermission()) {
        _snack('Autorisation du micro refusée');
        return;
      }
      final dir = await getTemporaryDirectory();
      final path = '${dir.path}/note_${DateTime.now().millisecondsSinceEpoch}.m4a';
      await _recorder.start(const RecordConfig(), path: path);
      setState(() => _recording = true);
    } catch (_) {
      _snack('Enregistrement audio indisponible');
    }
  }

  void _snack(String m) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));

  Future<void> _send() async {
    if (_lat == null || _lng == null) return;
    setState(() => _sending = true);
    final s = widget.session;
    MediaUpload? photo;
    MediaUpload? audio;
    if (_photoBytes != null) photo = MediaUpload(_photoBytes!, 'photo.jpg');
    if (_audioPath != null && !kIsWeb) audio = MediaUpload(await File(_audioPath!).readAsBytes(), 'note.m4a');
    try {
      await s.ensureWallet();
      final r = await s.api.submitReport(
        category: _category,
        description: _desc.text.trim(),
        lat: _lat!,
        lng: _lng!,
        accuracyM: _accuracy,
        photo: photo,
        audio: audio,
      );
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (_) => AlertDialog(
          title: const Text('Signalement envoyé'),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Catégorie : ${r['categoryLabel']}'),
            Text('Statut : ${r['statusLabel']}'),
            const SizedBox(height: 8),
            Text(r['message'] as String),
            const SizedBox(height: 8),
            const Text('Aucun point n\'est attribué à l\'envoi : les points arrivent si le signalement est corroboré puis confirmé.'),
          ]),
          actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('OK'))],
        ),
      );
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (e.network) {
        await s.enqueue({
          'category': _category,
          'description': _desc.text.trim(),
          'lat': _lat,
          'lng': _lng,
          'accuracyM': _accuracy,
          'photoPath': _photoPath,
          'audioPath': _audioPath,
        });
        if (mounted) {
          _snack('Hors-ligne : signalement enregistré, il sera envoyé dès le retour du réseau.');
          Navigator.of(context).pop(false);
        }
      } else {
        _snack(e.message);
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Nouveau signalement')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Card(
          color: Colors.amber.shade50,
          child: const Padding(
            padding: EdgeInsets.all(12),
            child: Text('Votre sécurité d\'abord : ne vous approchez jamais d\'un site d\'orpaillage. '
                'Photographiez de loin, depuis un endroit sûr. Aucune récompense n\'est liée à la proximité.'),
          ),
        ),
        const SizedBox(height: 12),
        Text('Que voyez-vous ?', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final e in categoryLabels.entries)
            ChoiceChip(
              avatar: Icon(categoryIcons[e.key], size: 18),
              label: Text(e.value),
              selected: _category == e.key,
              onSelected: (_) => setState(() => _category = e.key),
            ),
        ]),
        const SizedBox(height: 16),
        TextField(
          controller: _desc,
          maxLines: 3,
          maxLength: 500,
          decoration: const InputDecoration(
            border: OutlineInputBorder(),
            labelText: 'Description (facultatif)',
            hintText: 'Eau jaune, machines, arbres abattus…',
          ),
        ),
        const SizedBox(height: 8),
        Row(children: [
          Expanded(
            child: OutlinedButton.icon(
              onPressed: _takePhoto,
              icon: const Icon(Icons.photo_camera),
              label: Text(_photoBytes == null ? 'Photo' : 'Photo ajoutée'),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: OutlinedButton.icon(
              onPressed: kIsWeb ? null : _toggleRecord,
              icon: Icon(_recording ? Icons.stop_circle : Icons.mic, color: _recording ? kHigh : null),
              label: Text(_recording ? 'Arrêter' : (_audioPath == null ? 'Note vocale' : 'Note ajoutée')),
            ),
          ),
        ]),
        if (_photoBytes != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: ClipRRect(borderRadius: BorderRadius.circular(8), child: Image.memory(_photoBytes!, height: 160, fit: BoxFit.cover)),
          ),
        const SizedBox(height: 12),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(_gps ? Icons.gps_fixed : Icons.gps_not_fixed),
          title: Text(_gps ? 'Position GPS détectée' : 'Position de la carte (GPS indisponible)'),
          subtitle: const Text('Publiée de façon approximative (≈ 500 m à 1 km). La position exacte n\'est transmise qu\'aux autorités.'),
        ),
        const Text('Les métadonnées de la photo (GPS, modèle de téléphone) sont supprimées. Attention : votre voix reste reconnaissable '
            'dans une note vocale ; elle n\'est jamais publique mais transmise aux autorités.',
            style: TextStyle(fontSize: 12)),
        const SizedBox(height: 16),
        FilledButton.icon(
          onPressed: _sending ? null : _send,
          icon: _sending ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.send),
          label: const Text('Envoyer anonymement'),
        ),
      ]),
    );
  }
}
