import 'package:flutter/material.dart';

import 'state.dart';
import 'pages/home_page.dart';

class WebShellApp extends StatelessWidget {
  const WebShellApp({super.key, required this.state});

  final ShellState state;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: state,
      builder: (BuildContext context, Widget? _) {
        final Color seed = Color(state.branding.themeColor);
        return MaterialApp(
          title: state.branding.appName,
          debugShowCheckedModeBanner: false,
          theme: ThemeData(
            colorScheme: ColorScheme.fromSeed(seedColor: seed),
            useMaterial3: true,
          ),
          darkTheme: ThemeData(
            colorScheme: ColorScheme.fromSeed(
              seedColor: seed,
              brightness: Brightness.dark,
            ),
            useMaterial3: true,
          ),
          home: HomePage(state: state),
        );
      },
    );
  }
}
