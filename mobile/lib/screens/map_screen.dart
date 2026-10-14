import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';

import '../api.dart';
import '../session.dart';
import '../theme.dart';
import 'report_screen.dart';

// Zone aurifère de test pour la démo (secteur de Hiré).
const _demoCenter = LatLng(5.75, -5.31);

class MapScreen extends StatefulWidget {
  const MapScreen({super.key, required this.session});
  final Session session;

  @override
  State<MapScreen> createState() => _MapScreenState();
}

class _MapScreenState extends State<MapScreen> {
  final _controller = MapController();
  LatLng _center = _demoCenter;
  LatLng? _me;
  bool _showReports = true, _showProtected = true, _showRivers = true, _showZones = true;
  List<Polygon> _polygons = [];
  List<Polyline> _rivers = [];
  List<dynamic> _cells = [];
  List<dynamic> _zones = [];
  String? _error;
  bool _loading = true;
  double _zoom = 11;

  @override
  void initState() {
    super.initState();
    _locate();
    _load();
  }

  Future<void> _locate() async {
    try {
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) return;
      final p = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 8)),
      );
      if (!mounted) return;
      setState(() {
        _me = LatLng(p.latitude, p.longitude);
        _center = _me!;
      });
      _controller.move(_center, 12);
    } catch (_) {/* position indisponible : on garde la zone de démonstration */}
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final api = widget.session.api;
    try {
      final results = await Future.wait([api.layers(), api.publicCells(), api.publicZones()]);
      final layers = results[0] as Map<String, dynamic>;
      final polys = <Polygon>[];
      final lines = <Polyline>[];
      for (final f in (layers['features'] as List)) {
        final kind = f['properties']['kind'];
        final g = f['geometry'];
        if (kind == 'protected' && g['type'] == 'Polygon') {
          final ring = (g['coordinates'][0] as List).map((c) => LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble())).toList();
          polys.add(Polygon(points: ring, color: kGreenMid.withAlpha(60), borderColor: kGreenMid, borderStrokeWidth: 1.5));
        } else if (kind == 'river' && g['type'] == 'LineString') {
          final pts = (g['coordinates'] as List).map((c) => LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble())).toList();
          lines.add(Polyline(points: pts, color: const Color(0xFF2B6CB0), strokeWidth: 3));
        }
      }
      if (!mounted) return;
      setState(() {
        _polygons = polys;
        _rivers = lines;
        _cells = results[1] as List;
        _zones = results[2] as List;
        _error = null;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.network ? 'Serveur injoignable (${widget.session.baseUrl}). Mode hors-ligne : vous pouvez tout de même signaler.' : e.message;
        _loading = false;
      });
    }
  }

  Future<void> _openArea(LatLng p) async {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (_) => FutureBuilder<Map<String, dynamic>>(
        future: widget.session.api.area(p.latitude, p.longitude),
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return const SizedBox(height: 160, child: Center(child: CircularProgressIndicator()));
          }
          if (snap.hasError) {
            return Padding(padding: const EdgeInsets.all(24), child: Text('Impossible de charger la fiche : ${snap.error}'));
          }
          final a = snap.data!;
          final level = a['aiAlertLevel'] as String;
          final cats = (a['categories'] as Map).entries.map((e) => '${categoryLabels[e.key] ?? e.key} : ${e.value}').join('\n');
          return Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(a['status'] as String, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              Row(children: [
                const Icon(Icons.report_outlined, size: 18),
                const SizedBox(width: 6),
                Text('${a['recentReports']} signalement(s) sur 30 jours'),
              ]),
              if (cats.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text(cats)),
              const SizedBox(height: 10),
              Row(children: [
                const Text('Niveau d\'alerte IA : '),
                Chip(
                  label: Text(level == 'aucune' ? 'aucune' : level, style: const TextStyle(color: Colors.white)),
                  backgroundColor: level == 'aucune' ? Colors.grey : levelColor(level),
                ),
              ]),
              if (a['summary'] != null) Text(a['summary'] as String),
              const SizedBox(height: 8),
              Text('Position approximative (±${a['approxRadiusM']} m) : la position exacte n\'est jamais publique.',
                  style: Theme.of(context).textTheme.bodySmall),
            ]),
          );
        },
      ),
    );
  }

  Future<void> _report() async {
    final sent = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => ReportScreen(session: widget.session, fallback: _me ?? _center)),
    );
    if (sent == true) _load();
  }

  /// Regroupe les cellules publiques voisines selon le niveau de zoom (évite l'empilement de pastilles).
  List<Map<String, dynamic>> _bucketCells() {
    final size = _zoom >= 13 ? 0.0 : (_zoom >= 12 ? 0.01 : (_zoom >= 10 ? 0.03 : 0.1));
    if (size == 0) return _cells.map((c) => Map<String, dynamic>.from(c as Map)).toList();
    final buckets = <String, Map<String, dynamic>>{};
    for (final raw in _cells) {
      final c = raw as Map;
      final lat = (c['lat'] as num).toDouble(), lng = (c['lng'] as num).toDouble();
      final key = '${(lat / size).floor()}:${(lng / size).floor()}';
      final n = c['count'] as int;
      final b = buckets.putIfAbsent(key, () => {'lat': 0.0, 'lng': 0.0, 'count': 0, 'confirmed': false});
      b['lat'] = (b['lat'] as double) + lat * n;
      b['lng'] = (b['lng'] as double) + lng * n;
      b['count'] = (b['count'] as int) + n;
      if (c['confirmed'] == true) b['confirmed'] = true;
    }
    return buckets.values.map((b) {
      final n = b['count'] as int;
      return {'lat': (b['lat'] as double) / n, 'lng': (b['lng'] as double) / n, 'count': n, 'confirmed': b['confirmed']};
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final cellMarkers = _showReports
        ? _bucketCells().map<Marker>((c) {
            final confirmed = c['confirmed'] == true;
            final count = c['count'] as int;
            return Marker(
              point: LatLng((c['lat'] as num).toDouble(), (c['lng'] as num).toDouble()),
              width: 44,
              height: 44,
              child: GestureDetector(
                onTap: () => _openArea(LatLng((c['lat'] as num).toDouble(), (c['lng'] as num).toDouble())),
                child: Container(
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: (confirmed ? kHigh : kGold).withAlpha(220),
                    border: Border.all(color: Colors.white, width: 2),
                  ),
                  alignment: Alignment.center,
                  child: Text('$count', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
                ),
              ),
            );
          }).toList()
        : <Marker>[];

    return Scaffold(
      appBar: AppBar(
        title: const Text('GoldWatch CI'),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), tooltip: 'Actualiser', onPressed: _load),
          IconButton(icon: const Icon(Icons.settings), tooltip: 'Serveur', onPressed: _settings),
        ],
      ),
      body: Stack(children: [
        FlutterMap(
          mapController: _controller,
          options: MapOptions(
            initialCenter: _center,
            initialZoom: 11,
            onTap: (_, p) => _openArea(p),
            onPositionChanged: (camera, _) {
              if (camera.zoom.floor() != _zoom.floor()) setState(() => _zoom = camera.zoom);
            },
          ),
          children: [
            TileLayer(
              urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
              userAgentPackageName: 'ci.goldwatch.goldwatch_ci',
            ),
            if (_showProtected) PolygonLayer(polygons: _polygons),
            if (_showRivers) PolylineLayer(polylines: _rivers),
            if (_showZones)
              CircleLayer(
                circles: _zones
                    .map((z) => CircleMarker(
                          point: LatLng((z['lat'] as num).toDouble(), (z['lng'] as num).toDouble()),
                          radius: (z['radiusM'] as num).toDouble(),
                          useRadiusInMeter: true,
                          color: levelColor(z['level'] as String).withAlpha(70),
                          borderColor: levelColor(z['level'] as String),
                          borderStrokeWidth: 2,
                        ))
                    .toList(),
              ),
            MarkerLayer(markers: cellMarkers),
            if (_me != null)
              MarkerLayer(markers: [
                Marker(point: _me!, width: 22, height: 22, child: const Icon(Icons.my_location, color: Color(0xFF1565C0))),
              ]),
          ],
        ),
        Positioned(
          top: 8,
          left: 8,
          right: 8,
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(children: [
              _chip('Signalements', _showReports, (v) => setState(() => _showReports = v)),
              _chip('Zones protégées', _showProtected, (v) => setState(() => _showProtected = v)),
              _chip('Cours d\'eau', _showRivers, (v) => setState(() => _showRivers = v)),
              _chip('Zones à risque (IA)', _showZones, (v) => setState(() => _showZones = v)),
            ]),
          ),
        ),
        if (_loading) const Positioned(top: 56, left: 0, right: 0, child: LinearProgressIndicator()),
        if (_error != null)
          Positioned(
            left: 12,
            right: 12,
            bottom: 90,
            child: Material(
              color: Colors.amber.shade100,
              borderRadius: BorderRadius.circular(8),
              child: Padding(padding: const EdgeInsets.all(10), child: Text(_error!)),
            ),
          ),
      ]),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _report,
        icon: const Icon(Icons.add_location_alt),
        label: const Text('Signaler'),
      ),
    );
  }

  Widget _chip(String label, bool value, ValueChanged<bool> onChanged) => Padding(
        padding: const EdgeInsets.only(right: 6),
        child: FilterChip(
          label: Text(label),
          selected: value,
          onSelected: onChanged,
          backgroundColor: Colors.white,
          selectedColor: Colors.green.shade100,
        ),
      );

  Future<void> _settings() async {
    final ctrl = TextEditingController(text: widget.session.baseUrl);
    String? result;
    bool? ok;
    ok = await showDialog<bool>(
      context: context,
      builder: (_) => StatefulBuilder(
        builder: (context, setSt) => AlertDialog(
          title: const Text('Serveur GoldWatch'),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            TextField(
              controller: ctrl,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: const InputDecoration(
                labelText: 'Adresse du serveur',
                hintText: 'http://192.168.1.82:3000',
              ),
            ),
            const SizedBox(height: 8),
            const Text('Téléphone et PC doivent être sur le même Wi-Fi. Émulateur : http://10.0.2.2:3000',
                style: TextStyle(fontSize: 12)),
            if (result != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(result!)),
          ]),
          actions: [
            TextButton(
              onPressed: () async {
                final url = normalizeBaseUrl(ctrl.text);
                setSt(() => result = 'Test de $url …');
                try {
                  await Api(url).health();
                  setSt(() => result = '✓ Serveur joignable ($url)');
                } on ApiException catch (e) {
                  setSt(() => result = '✗ ${e.message}');
                }
              },
              child: const Text('Tester'),
            ),
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Annuler')),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Enregistrer')),
          ],
        ),
      ),
    );
    if (ok == true) {
      await widget.session.setBaseUrl(ctrl.text);
      await widget.session.ensureWallet().catchError((_) {});
      _load();
    }
  }
}
