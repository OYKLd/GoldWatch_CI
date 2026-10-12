import 'package:flutter/material.dart';

import '../session.dart';
import '../theme.dart';

/// Vue Alertes : zones à risque détectées par l'IA, triées par urgence (positions publiques floutées).
class AlertsScreen extends StatefulWidget {
  const AlertsScreen({super.key, required this.session});
  final Session session;

  @override
  State<AlertsScreen> createState() => _AlertsScreenState();
}

class _AlertsScreenState extends State<AlertsScreen> {
  late Future<List<dynamic>> _future = widget.session.api.publicZones();

  Future<void> _refresh() async {
    setState(() => _future = widget.session.api.publicZones());
    await _future.catchError((_) => <dynamic>[]);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Zones à risque'), actions: [
        IconButton(icon: const Icon(Icons.refresh), onPressed: _refresh),
      ]),
      body: FutureBuilder<List<dynamic>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
          if (snap.hasError) {
            return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text('Alertes indisponibles : ${snap.error}')));
          }
          final zones = List<dynamic>.from(snap.data!)..sort((a, b) => (b['score'] as int).compareTo(a['score'] as int));
          if (zones.isEmpty) {
            return const Center(child: Text('Aucune zone à risque corroborée pour le moment.'));
          }
          return RefreshIndicator(
            onRefresh: _refresh,
            child: ListView.separated(
              padding: const EdgeInsets.all(12),
              itemCount: zones.length + 1,
              separatorBuilder: (_, _) => const SizedBox(height: 8),
              itemBuilder: (context, i) {
                if (i == 0) {
                  return const Text(
                    'Zones détectées par recoupement de signalements concordants. Les positions affichées sont approximatives ; '
                    'les positions exactes sont réservées aux autorités.',
                    style: TextStyle(fontSize: 12),
                  );
                }
                final z = zones[i - 1];
                final c = levelColor(z['level'] as String);
                return Card(
                  shape: RoundedRectangleBorder(
                    side: BorderSide(color: c, width: 1.5),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Expanded(child: Text(z['name'] as String, style: Theme.of(context).textTheme.titleMedium)),
                        Chip(
                          label: Text('Priorité ${z['level']}', style: const TextStyle(color: Colors.white)),
                          backgroundColor: c,
                        ),
                      ]),
                      Text(z['summary'] as String),
                      const SizedBox(height: 6),
                      Text('Score ${z['score']}/100 · ${z['reportCount']} signalements', style: Theme.of(context).textTheme.bodySmall),
                    ]),
                  ),
                );
              },
            ),
          );
        },
      ),
    );
  }
}
