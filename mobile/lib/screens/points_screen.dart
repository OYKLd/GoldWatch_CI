import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../session.dart';
import '../theme.dart';

/// Onglet « Mes points » : solde, historique, demande de retrait (simulée), mode discret.
class PointsScreen extends StatefulWidget {
  const PointsScreen({super.key, required this.session});
  final Session session;

  @override
  State<PointsScreen> createState() => _PointsScreenState();
}

class _PointsScreenState extends State<PointsScreen> {
  Map<String, dynamic>? _wallet;
  Map<String, dynamic>? _config;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    widget.session.addListener(_onSession);
    _load();
  }

  @override
  void dispose() {
    widget.session.removeListener(_onSession);
    super.dispose();
  }

  void _onSession() {
    if (mounted) setState(() {});
  }

  Future<void> _load() async {
    final s = widget.session;
    setState(() => _loading = true);
    try {
      await s.ensureWallet();
      final r = await Future.wait([s.api.wallet(), s.api.config()]);
      if (!mounted) return;
      setState(() {
        _wallet = r[0];
        _config = r[1];
        _error = null;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  String _mask(Object v) => widget.session.discreet ? '•••' : '$v';

  Future<void> _withdraw() async {
    final w = _wallet!;
    final cfg = _config!['withdrawal'] as Map<String, dynamic>;
    final modes = Map<String, dynamic>.from(cfg['modes'] as Map);
    final minPts = cfg['minPoints'] as int;
    final fcfa = cfg['fcfaPerPoint'] as int;
    String mode = modes.keys.first;
    final ctrl = TextEditingController(text: '${w['points']}');
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => StatefulBuilder(
        builder: (context, setSt) => AlertDialog(
          title: const Text('Demander un retrait'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Minimum $minPts points (${minPts * fcfa} FCFA). Plafond mensuel ${cfg['monthlyCapFcfa']} FCFA.'),
              TextField(
                controller: ctrl,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Points à retirer'),
              ),
              const SizedBox(height: 8),
              Wrap(spacing: 6, runSpacing: 6, children: [
                for (final e in modes.entries)
                  ChoiceChip(
                    label: Text(e.value as String),
                    selected: mode == e.key,
                    onSelected: (_) => setSt(() => mode = e.key),
                  ),
              ]),
              const SizedBox(height: 8),
              const Text(
                'Le mobile money laisse une trace chez l\'opérateur (il connaît l\'identité de son abonné). '
                'Les autres modes limitent cette exposition. Démonstration : aucun paiement réel.',
                style: TextStyle(fontSize: 12),
              ),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Annuler')),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Confirmer')),
          ],
        ),
      ),
    );
    if (ok != true) return;
    try {
      final r = await widget.session.api.withdraw(int.tryParse(ctrl.text) ?? 0, mode);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Retrait de ${r['amountFcfa']} FCFA planifié (délai variable de 3 à 10 jours).'),
      ));
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _restore() async {
    final id = TextEditingController();
    final code = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Récupérer mon portefeuille'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: id, decoration: const InputDecoration(labelText: 'Identifiant (w_…)')),
          TextField(controller: code, decoration: const InputDecoration(labelText: 'Code de récupération')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Annuler')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Récupérer')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await widget.session.restoreWallet(id.text, code.text);
      _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.session;
    return Scaffold(
      appBar: AppBar(title: const Text('Mes points'), actions: [
        IconButton(
          tooltip: 'Mode discret',
          icon: Icon(s.discreet ? Icons.visibility_off : Icons.visibility),
          onPressed: () => s.setDiscreet(!s.discreet),
        ),
        IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
      ]),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null || _wallet == null
              ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error ?? 'Portefeuille indisponible')))
              : _body(context),
    );
  }

  Widget _body(BuildContext context) {
    final w = _wallet!;
    final cfg = _config!;
    final pts = cfg['points'] as Map<String, dynamic>;
    final history = (w['history'] as List);
    final reports = (w['reports'] as List);
    final withdrawals = (w['withdrawals'] as List);
    final canWithdraw = w['canWithdraw'] == true;
    final threshold = w['thresholdPoints'] as int;

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(padding: const EdgeInsets.all(16), children: [
        Card(
          color: kGreen,
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Solde', style: TextStyle(color: Colors.white70)),
              Text('${_mask(w['points'])} points',
                  style: const TextStyle(color: Colors.white, fontSize: 34, fontWeight: FontWeight.bold)),
              Text('≈ ${_mask(w['valueFcfa'])} FCFA', style: const TextStyle(color: Colors.white70)),
              const SizedBox(height: 8),
              Text('Niveau de confiance : ${w['trustLevel']}', style: const TextStyle(color: Colors.white70)),
              const SizedBox(height: 12),
              if (w['blocked'] == true)
                const Text('Portefeuille bloqué (signalements abusifs).', style: TextStyle(color: Colors.amber))
              else
                FilledButton(
                  onPressed: canWithdraw ? _withdraw : null,
                  child: Text(canWithdraw ? 'Retirer' : 'Retrait dès $threshold points'),
                ),
            ]),
          ),
        ),
        const SizedBox(height: 12),
        _section('Comment gagner des points'),
        Text('• Envoi : 0 point (jamais de récompense à l\'envoi)\n'
            '• Signalement corroboré : +${pts['corroborated']}\n'
            '• Confirmé sur le terrain : +${pts['confirmed']}\n'
            '• Premier à signaler un nouveau site : +${pts['firstReporter']}\n'
            '• Photo exploitable et description complète : +${pts['quality']}\n'
            '• Nouveau déclarant : gains réduits de moitié jusqu\'à 3 confirmations\n'
            '• Signalement infondé de bonne foi : aucune sanction ; abus constaté : perte de points'),
        const SizedBox(height: 12),
        _section('Mes signalements'),
        if (reports.isEmpty) const Text('Aucun signalement pour le moment.'),
        for (final r in reports.take(10))
          ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: Icon(categoryIcons[r['category']] ?? Icons.place),
            title: Text(r['categoryLabel'] as String),
            subtitle: Text(statusLabels[r['status']] ?? r['status'] as String),
          ),
        if (_pendingCount > 0) Text('$_pendingCount signalement(s) en attente d\'envoi (hors-ligne).'),
        const SizedBox(height: 12),
        _section('Historique des points'),
        if (history.isEmpty) const Text('Aucune écriture.'),
        for (final h in history.take(15))
          ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            title: Text(reasonLabels[h['reason']] ?? h['reason'] as String),
            subtitle: Text((h['at'] as String).substring(0, 10)),
            trailing: Text(widget.session.discreet ? '•••' : ((h['delta'] as int) > 0 ? '+${h['delta']}' : '${h['delta']}'),
                style: TextStyle(fontWeight: FontWeight.bold, color: (h['delta'] as int) >= 0 ? kGreenMid : kHigh)),
          ),
        if (withdrawals.isNotEmpty) ...[
          const SizedBox(height: 12),
          _section('Retraits'),
          for (final r in withdrawals)
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text('${_mask(r['amountFcfa'])} FCFA — ${r['status']}'),
              subtitle: Text('Échéance ${(r['scheduledFor'] as String).substring(0, 10)}'),
            ),
        ],
        const SizedBox(height: 16),
        _section('Mon identité de portefeuille'),
        const Text('Aucun nom, aucun numéro de téléphone n\'est lié à ce portefeuille. '
            'Conservez ce code : il permet de retrouver vos points sur un autre téléphone.',
            style: TextStyle(fontSize: 12)),
        SelectableText('${widget.session.walletId}\n${widget.session.discreet ? '•••• •••• •••• ••••' : widget.session.recoveryCode}',
            style: const TextStyle(fontFamily: 'monospace')),
        Row(children: [
          TextButton.icon(
            icon: const Icon(Icons.copy, size: 16),
            label: const Text('Copier le code'),
            onPressed: () => Clipboard.setData(ClipboardData(text: widget.session.recoveryCode ?? '')),
          ),
          TextButton(onPressed: _restore, child: const Text('Récupérer un portefeuille')),
        ]),
      ]),
    );
  }

  int get _pendingCount => widget.session.pending.length;

  Widget _section(String t) =>
      Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(t, style: Theme.of(context).textTheme.titleMedium));
}

