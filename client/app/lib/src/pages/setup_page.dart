import 'package:cfwtxt_core/cfwtxt_core.dart';
import 'package:flutter/material.dart';

import '../store.dart';
import '../util.dart';

/// 站点编辑页返回的草稿。**密码只在内存里过一手**，从不进配置文件。
class SiteDraft {
  final String id;
  final ServerConfig config;
  final String label;
  final String password;

  SiteDraft({required this.id, required this.config, required this.label, this.password = ''});
}

/// 站点管理 + 首启向导。
///
/// 这个页面承载了整个客户端最关键的一条需求：**站点地址可以随时改**。
/// 用户换域名 / 换 Workers 项目时，只需要在这里改地址，密码与本地缓存都留着。
class SetupPage extends StatelessWidget {
  final AppStore store;
  final bool firstRun;

  const SetupPage({super.key, required this.store, this.firstRun = false});

  Future<void> _add(BuildContext context) async {
    final d = await Navigator.of(context).push<SiteDraft>(
      MaterialPageRoute(builder: (_) => const SiteEditPage()),
    );
    if (d == null) return;
    try {
      await store.addSite(
        rawUrl: d.config.displayName,
        label: d.label,
        password: d.password.isEmpty ? null : d.password,
      );
    } on Object catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(humanError(e))));
      }
    }
  }

  Future<void> _edit(BuildContext context, SiteProfile site) async {
    final d = await Navigator.of(context).push<SiteDraft>(
      MaterialPageRoute(builder: (_) => SiteEditPage(existing: site)),
    );
    if (d == null) return;
    await store.updateSite(
      SiteProfile(id: d.id, label: d.label, config: d.config),
      password: d.password.isEmpty ? null : d.password,
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sites = store.sites;

    return Scaffold(
      appBar: AppBar(
        title: Text(firstRun ? '连接到你的网盘' : '设置'),
        automaticallyImplyLeading: !firstRun,
      ),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          if (firstRun)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('站点地址在哪？', style: theme.textTheme.titleMedium),
                      const SizedBox(height: 8),
                      Text(
                        '就是你平时在浏览器里打开的管理页面地址，形如\n'
                        'https://你的域名/ADMIN_UUID\n\n'
                        '整条粘进来即可 —— 客户端会自己把域名和 ADMIN_UUID 拆开。'
                        '以后域名换了，回来改这一格就行，密码和本地文件都不用重来。',
                        style: theme.textTheme.bodyMedium,
                      ),
                    ],
                  ),
                ),
              ),
            ),

          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
            child: Text('站点', style: theme.textTheme.labelLarge),
          ),
          if (sites.isEmpty)
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('还没有添加站点，点下面的按钮加一个。'),
            ),
          for (final s in sites)
            RadioListTile<String>(
              value: s.id,
              groupValue: store.activeId,
              onChanged: (v) async {
                if (v != null) await store.useSite(v);
              },
              title: Text(s.label.isEmpty ? s.config.displayName : s.label),
              subtitle: Text(
                '${s.config.displayName}${s.config.hasPassword ? ' · 需要密码' : ''}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              secondary: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IconButton(
                    tooltip: '编辑',
                    icon: const Icon(Icons.edit_outlined),
                    onPressed: () => _edit(context, s),
                  ),
                  IconButton(
                    tooltip: '删除',
                    icon: const Icon(Icons.delete_outline),
                    onPressed: () async {
                      final ok = await showDialog<bool>(
                        context: context,
                        builder: (c) => AlertDialog(
                          title: const Text('删除这个站点？'),
                          content: const Text('只删除本机保存的地址与密码，服务器上的文件一个都不会动。'),
                          actions: [
                            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('取消')),
                            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('删除')),
                          ],
                        ),
                      );
                      if (ok == true) await store.removeSite(s.id);
                    },
                  ),
                ],
              ),
            ),

          ListTile(
            leading: const Icon(Icons.add),
            title: const Text('添加站点'),
            onTap: () => _add(context),
          ),

          const Divider(height: 32),

          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
            child: Text('阅读与编辑偏好', style: theme.textTheme.labelLarge),
          ),
          SwitchListTile(
            title: const Text('自动换行'),
            subtitle: const Text('编辑器里默认开启；关掉适合看宽表格 / 长代码行'),
            value: store.autoWrap,
            onChanged: store.setAutoWrap,
          ),
          ListTile(
            title: const Text('字号'),
            subtitle: Slider(
              min: 10,
              max: 22,
              divisions: 12,
              value: store.fontSize,
              label: store.fontSize.toStringAsFixed(0),
              onChanged: store.setFontSize,
            ),
          ),

          const Divider(height: 32),
          ListTile(
            leading: const Icon(Icons.lock_outline),
            title: const Text('清除登录状态'),
            subtitle: const Text('下次打开需要重新输入管理员密码'),
            onTap: store.activeId == null
                ? null
                : () async {
                    await store.clearCookie(store.activeId!);
                    await store.reload();
                    if (context.mounted) {
                      ScaffoldMessenger.of(context)
                          .showSnackBar(const SnackBar(content: Text('已清除登录状态')));
                    }
                  },
          ),
        ],
      ),
    );
  }
}

/// 添加 / 编辑一个站点。**地址是唯一必填项**，其余都能后补。
class SiteEditPage extends StatefulWidget {
  final SiteProfile? existing;

  const SiteEditPage({super.key, this.existing});

  @override
  State<SiteEditPage> createState() => _SiteEditPageState();
}

class _SiteEditPageState extends State<SiteEditPage> {
  final _url = TextEditingController();
  final _label = TextEditingController();
  final _password = TextEditingController();

  String _msg = '';
  bool _busy = false;
  bool _showPw = false;

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    if (e != null) {
      _url.text = e.config.displayName;
      _label.text = e.label;
    }
  }

  @override
  void dispose() {
    _url.dispose();
    _label.dispose();
    _password.dispose();
    super.dispose();
  }

  ServerConfig? get _parsed =>
      ServerConfig.tryParse(_url.text, hasPassword: _password.text.isNotEmpty);

  Future<void> _test() async {
    final cfg = _parsed;
    if (cfg == null || !cfg.isValid) {
      setState(() => _msg = '❌ 地址还不完整，请把整条管理入口粘进来（或补上 ADMIN_UUID）');
      return;
    }
    setState(() {
      _busy = true;
      _msg = '正在连接…';
    });
    try {
      final c = CfwClient(
        config: cfg,
        password: _password.text.isEmpty ? null : _password.text,
      );
      final listing = await c.probe();
      if (!mounted) return;
      setState(() {
        _msg = '✅ 连接成功：根目录 ${listing.folders.length} 个文件夹 / ${listing.files.length} 个文件';
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _msg = e.needPw ? '❌ 需要管理员密码（密码填错或没填）' : '❌ ${e.message}';
      });
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _msg = '❌ ${humanError(e)}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _save() {
    final cfg = _parsed;
    if (cfg == null || !cfg.isValid) {
      setState(() => _msg = '❌ 地址还不完整');
      return;
    }
    final e = widget.existing;
    Navigator.pop(
      context,
      SiteDraft(
        id: e?.id ?? '',
        config: cfg,
        label: _label.text.trim().isEmpty
            ? cfg.baseUrl.replaceFirst(RegExp(r'^https?://'), '')
            : _label.text.trim(),
        password: _password.text,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final cfg = _parsed;

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.existing == null ? '添加站点' : '编辑站点'),
        actions: [
          TextButton(onPressed: _busy ? null : _save, child: const Text('保存')),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _url,
            autofocus: widget.existing == null,
            keyboardType: TextInputType.url,
            autocorrect: false,
            decoration: const InputDecoration(
              labelText: '站点地址',
              hintText: 'https://xxx.workers.dev/你的ADMIN_UUID',
              helperText: '整条粘进来即可；也可以只填域名，客户端会提示补 ADMIN_UUID',
              border: OutlineInputBorder(),
            ),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 8),

          // 解析预览：让用户当场看到"我理解的地址对不对"，
          // 而不是点了连接才发现拼错 —— 地址是这台客户端唯一的坐标，值得多花这一行
          if (cfg != null)
            Card(
              color: Theme.of(context).colorScheme.surfaceContainerHighest,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('域名：${cfg.baseUrl}', style: const TextStyle(fontSize: 12)),
                    Text(
                      '管理入口：${cfg.adminUuid.isEmpty ? '（还没填 ADMIN_UUID）' : '/${cfg.adminUuid}'}',
                      style: TextStyle(
                        fontSize: 12,
                        color: cfg.adminUuid.isEmpty
                            ? Theme.of(context).colorScheme.error
                            : null,
                      ),
                    ),
                  ],
                ),
              ),
            ),

          const SizedBox(height: 12),
          TextField(
            controller: _label,
            decoration: const InputDecoration(
              labelText: '名称（可选）',
              hintText: '我的文本盘',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _password,
            obscureText: !_showPw,
            decoration: InputDecoration(
              labelText: '管理员密码（站点设了 PASSWORD 才需要）',
              border: const OutlineInputBorder(),
              suffixIcon: IconButton(
                icon: Icon(_showPw ? Icons.visibility_off : Icons.visibility),
                onPressed: () => setState(() => _showPw = !_showPw),
              ),
            ),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 6),
          Text(
            '密码只存在系统安全存储里（Android Keystore / Windows 凭据管理器），'
            '不会写进配置文件，也不会随导出/备份泄漏。',
            style: Theme.of(context).textTheme.bodySmall,
          ),

          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: _busy ? null : _test,
            icon: _busy
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.wifi_tethering),
            label: const Text('测试连接'),
          ),
          if (_msg.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(_msg),
          ],
        ],
      ),
    );
  }
}
