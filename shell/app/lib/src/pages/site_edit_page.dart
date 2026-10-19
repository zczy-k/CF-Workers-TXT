import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webshell_core/webshell_core.dart';

import '../state.dart';
import '../widgets/site_avatar.dart';

/// 站点设置：名称、地址、主题色、UA、自定义请求头、Basic Auth、站内导航。
class SiteEditPage extends StatefulWidget {
  const SiteEditPage({super.key, required this.state, required this.siteId});

  final ShellState state;
  final String siteId;

  @override
  State<SiteEditPage> createState() => _SiteEditPageState();
}

class _SiteEditPageState extends State<SiteEditPage> {
  static const List<int> _presetColors = <int>[
    0xFF2962FF,
    0xFF00897B,
    0xFF6A1B9A,
    0xFFC62828,
    0xFFEF6C00,
    0xFF2E7D32,
    0xFF37474F,
    0xFFAD1457,
  ];

  late final SiteProfile _site = widget.state.config.byId(widget.siteId)!;

  late final TextEditingController _name = TextEditingController(text: _site.name);
  late final TextEditingController _url = TextEditingController(text: _site.startUrl);
  late final TextEditingController _ua = TextEditingController(text: _site.userAgent ?? '');
  late final TextEditingController _headers =
      TextEditingController(text: formatHeaderLines(_site.headers));
  late final TextEditingController _user = TextEditingController(text: _site.basicUser ?? '');
  final TextEditingController _password = TextEditingController();

  late bool _stayInSite = _site.stayInSite;
  late bool _allowSelfSignedCert = _site.allowSelfSignedCert;
  late bool _basicAuth = _site.hasBasicAuth;
  late int _themeColor = _site.themeColor;
  bool _hasStoredPassword = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    widget.state.basicPassword(_site.id).then((String? value) {
      if (!mounted) return;
      setState(() => _hasStoredPassword = (value ?? '').isNotEmpty);
    });
  }

  @override
  void dispose() {
    _name.dispose();
    _url.dispose();
    _ua.dispose();
    _headers.dispose();
    _user.dispose();
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('站点设置'),
        actions: <Widget>[
          TextButton(
            onPressed: _busy ? null : _save,
            child: const Text('保存'),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        children: <Widget>[
          Row(
            children: <Widget>[
              SiteAvatar(site: _site, size: 48),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  '图标抓的是网站自己的 favicon / apple-touch-icon。\n抓不到就用站点名字的首字母。',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
              IconButton(
                tooltip: '重新抓取',
                onPressed: _busy ? null : _refreshIcon,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _name,
            decoration: const InputDecoration(
              labelText: '名称',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _url,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(
              labelText: '地址',
              helperText: '改这里就等于换站点；只写域名会自动补 https://',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          _label(context, '主题色'),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: _presetColors.map((int color) {
              final bool selected = color == _themeColor;
              return GestureDetector(
                onTap: () => setState(() => _themeColor = color),
                child: Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: Color(color),
                    shape: BoxShape.circle,
                    border: selected
                        ? Border.all(width: 3, color: Theme.of(context).colorScheme.onSurface)
                        : null,
                  ),
                  child: selected ? const Icon(Icons.check, size: 18, color: Colors.white) : null,
                ),
              );
            }).toList(),
          ),
          const SizedBox(height: 20),
          _label(context, '自定义 User-Agent'),
          TextField(
            controller: _ua,
            decoration: const InputDecoration(
              hintText: '留空 = 用系统 WebView 的默认 UA',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 20),
          _label(context, '自定义请求头'),
          TextField(
            controller: _headers,
            minLines: 3,
            maxLines: 8,
            keyboardType: TextInputType.multiline,
            decoration: const InputDecoration(
              hintText: '每行一个，例如：\nAuthorization: Bearer xxxxx\nX-Requested-With: com.example.app',
              helperText: '页面内部的请求也会带上（注入脚本补），不只是顶层导航',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 20),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _basicAuth,
            onChanged: (bool value) => setState(() => _basicAuth = value),
            title: const Text('使用 Basic 认证'),
            subtitle: const Text('服务器弹账号密码框的站点（浏览器地址栏那种）'),
          ),
          if (_basicAuth) ...<Widget>[
            TextField(
              controller: _user,
              decoration: const InputDecoration(
                labelText: '用户名',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _password,
              obscureText: true,
              decoration: InputDecoration(
                labelText: '密码',
                helperText: _hasStoredPassword ? '已保存过密码，留空表示不修改' : '密码存系统安全存储（Keystore / DPAPI），不写进配置文件',
                border: const OutlineInputBorder(),
              ),
            ),
            if (_hasStoredPassword)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  onPressed: _clearPassword,
                  icon: const Icon(Icons.delete_outline, size: 18),
                  label: const Text('清除已保存的密码'),
                ),
              ),
          ],
          const SizedBox(height: 8),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _stayInSite,
            onChanged: (bool value) => setState(() => _stayInSite = value),
            title: const Text('只在本站内导航'),
            subtitle: const Text('打开后，跳到别的域名的链接会交给系统浏览器，不会把用户带跑'),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _allowSelfSignedCert,
            onChanged: (bool value) => setState(() => _allowSelfSignedCert = value),
            title: const Text('信任自签证书'),
            subtitle: const Text('内网 / 自建站点的 HTTPS 证书不受系统信任时打开；只对这一个站点生效'),
          ),
          const Divider(height: 32),
          TextField(
            controller: TextEditingController(text: _site.id),
            readOnly: true,
            decoration: const InputDecoration(
              labelText: '站点 ID（内部标识，不可改）',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 24),
          OutlinedButton.icon(
            onPressed: _busy ? null : _delete,
            icon: const Icon(Icons.delete_outline),
            label: const Text('删除这个站点'),
            style: OutlinedButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error),
          ),
        ],
      ),
    );
  }

  Widget _label(BuildContext context, String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text(text, style: Theme.of(context).textTheme.labelLarge),
    );
  }

  Future<void> _refreshIcon() async {
    setState(() => _busy = true);
    try {
      // 先清掉旧图标，抓不到就不会一直显示上一次的
      _site.iconPath = null;
      final String? path = await widget.state.icons.fetch(_site);
      if (!mounted) return;
      setState(() {
        _site.iconPath = path;
        _busy = false;
      });
      widget.state.siteEdited();
      if (path == null) _snack('没抓到图标，可能站点没提供 favicon');
    } finally {
      if (mounted && _busy) setState(() => _busy = false);
    }
  }

  Future<void> _clearPassword() async {
    await widget.state.setBasicPassword(_site.id, null);
    if (!mounted) return;
    setState(() => _hasStoredPassword = false);
    _snack('密码已清除');
  }

  Future<void> _save() async {
    final String? url = normalizeUrl(_url.text);
    if (url == null) {
      _snack('地址不对，检查一下');
      return;
    }
    setState(() => _busy = true);
    try {
      _site.name = _name.text.trim().isEmpty ? guessSiteName(url) : _name.text.trim();
      _site.startUrl = url;
      _site.themeColor = _themeColor;
      final String ua = _ua.text.trim();
      _site.userAgent = ua.isEmpty ? null : ua;
      _site.headers
        ..clear()
        ..addAll(parseHeaderLines(_headers.text));
      _site.hasBasicAuth = _basicAuth;
      final String user = _user.text.trim();
      _site.basicUser = user.isEmpty ? null : user;
      _site.stayInSite = _stayInSite;
      _site.allowSelfSignedCert = _allowSelfSignedCert;

      if (_basicAuth && _password.text.isNotEmpty) {
        await widget.state.setBasicPassword(_site.id, _password.text);
        _hasStoredPassword = true;
      }

      widget.state.siteEdited();
      if (mounted) Navigator.of(context).pop();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete() async {
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('删除站点'),
        content: Text('把「${_site.displayName}」删掉？已经下载到本机的文件不会被删除。'),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    widget.state.removeSite(_site.id);
    await widget.state.setBasicPassword(_site.id, null);
    if (mounted) Navigator.of(context).pop();
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }
}

/// 复制站点地址的小工具（设置页里也用得到）。
Future<void> copyText(BuildContext context, String text) async {
  await Clipboard.setData(ClipboardData(text: text));
  if (!context.mounted) return;
  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已复制')));
}
