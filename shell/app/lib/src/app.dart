import 'package:flutter/material.dart';

import 'state.dart';
import 'theme.dart';
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
          theme: AppTheme.light(seed),
          darkTheme: AppTheme.dark(seed),
          home: HomePage(state: state),
        );
      },
    );
  }
}
