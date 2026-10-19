import 'package:flutter/material.dart';

import 'src/pages/home_page.dart';
import 'src/pages/setup_page.dart';
import 'src/store.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = AppStore();
  await store.init();
  runApp(CfwApp(store: store));
}

class CfwApp extends StatelessWidget {
  final AppStore store;

  const CfwApp({super.key, required this.store});

  // 与网页端同一套琥珀配色，装到两台设备上看起来是一个产品
  static const _seed = Color(0xFFD4A02A);

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: store,
      builder: (context, _) => MaterialApp(
        title: 'CF-Workers-TXT',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          useMaterial3: true,
          colorScheme: ColorScheme.fromSeed(seedColor: _seed),
        ),
        darkTheme: ThemeData(
          useMaterial3: true,
          colorScheme: ColorScheme.fromSeed(seedColor: _seed, brightness: Brightness.dark),
        ),
        home: !store.ready
            ? const Scaffold(body: Center(child: CircularProgressIndicator()))
            : (store.hasSite
                ? HomePage(store: store, key: ValueKey(store.activeId))
                : SetupPage(store: store, firstRun: true)),
      ),
    );
  }
}
