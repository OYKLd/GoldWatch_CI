import 'package:flutter/material.dart';

import 'screens/alerts_screen.dart';
import 'screens/map_screen.dart';
import 'screens/points_screen.dart';
import 'session.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final session = Session();
  await session.init();
  runApp(GoldWatchApp(session: session));
}

class GoldWatchApp extends StatelessWidget {
  const GoldWatchApp({super.key, required this.session});
  final Session session;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'GoldWatch CI',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      home: HomeShell(session: session),
    );
  }
}

class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.session});
  final Session session;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0; // la carte est le point d'entrée

  @override
  void initState() {
    super.initState();
    // Portefeuille pseudonyme + renvoi des signalements mis en attente hors-ligne.
    widget.session.ensureWallet().then((_) => widget.session.flushPending()).catchError((_) => 0);
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.session;
    final pages = [
      MapScreen(session: s),
      AlertsScreen(session: s),
      PointsScreen(session: s),
    ];
    return Scaffold(
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.map_outlined), selectedIcon: Icon(Icons.map), label: 'Carte'),
          NavigationDestination(icon: Icon(Icons.warning_amber_outlined), selectedIcon: Icon(Icons.warning_amber), label: 'Alertes'),
          NavigationDestination(icon: Icon(Icons.stars_outlined), selectedIcon: Icon(Icons.stars), label: 'Mes points'),
        ],
      ),
    );
  }
}
