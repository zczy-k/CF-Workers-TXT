import 'package:flutter/material.dart';
import 'package:webshell_core/webshell_core.dart';

import '../state.dart';
import '../widgets/site_avatar.dart';
import 'browser_page.dart';
import 'downloads_page.dart';
import 'settings_page.dart';
import 'site_edit_page.dart';

/// 首页：站点列表。
class HomePage extends StatelessWidget {
  const HomePage({super.key, required this.state});

  final ShellState state;

  @override
  Widget build(BuildContext context) {
    final ShellConfig config = state.config;
    final Branding branding = state.branding;

    return Scaffold(
      appBar: AppBar(
        title: Text(branding.appName),
        actions: <Widget>[
          IconButton(
            tooltip: '下载',
            onPressed: () => _push(context, DownloadsPage(state: state)),
            icon: Badge(
              isLabelVisible: state.activeDownloadCount > 0,
              label: Text('${state.activeDownloadCount}'),
              child: const Icon(Icons.download_outlined),
            ),
          ),
          IconButton(
            tooltip: '设置',
            onPressed: () => _push(context, SettingsPage(state: state)),
            icon: const Icon(Icons.settings_outlined),
          ),
        ],
      ),
      body: config.sites.isEmpty
          ? _EmptySites(branding: branding, onAdd: () => _addSite(context))
          : _SiteList(state: state, onAdd: () => _addSite(context)),
      floatingActionButton: branding.allowAddSite && config.sites.isNotEmpty
          ? FloatingActionButton.extended(
              onPressed: () => _addSite(context),
              icon: const Icon(Icons.add),
              label: const Text('添加站点'),
            )
          : null,
    );
  }

  void _push(BuildContext context, Widget page) {
    Navigator.of(context).push<void>(
      MaterialPageRoute<void>(builder: (BuildContext _) => page),
    );
  }

  Future<void> _addSite(BuildContext context) async {
    if (!state.branding.allowAddSite) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('这个版本只允许使用预置站点')),
      );
      return;
    }
    final SiteProfile? site = await showAddSiteSheet(context, state);
    if (site == null || !context.mounted) return;
    await Navigator.of(context).push<void>(BrowserPage.route(state, site.id));
  }
}

class _EmptySites extends StatelessWidget {
  const _EmptySites({required this.branding, required this.onAdd});

  final Branding branding;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(
              Icons.language_outlined,
              size: 64,
              color: Theme.of(context).colorScheme.primary,
            ),
            const SizedBox(height: 16),
            Text(
              '还没有站点',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 8),
            Text(
              '把任何一个网站的地址加进来，它就会变成这个 App 里的一个独立站点：\n'
              '翻页、登录、上传、下载都照常，下载会直接落到本机目录。',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            const SizedBox(height: 24),
            if (branding.allowAddSite)
              FilledButton.icon(
                onPressed: onAdd,
                icon: const Icon(Icons.add),
                label: const Text('添加站点'),
              ),
          ],
        ),
      ),
    );
  }
}

class _SiteList extends StatelessWidget {
  const _SiteList({required this.state, required this.onAdd});

  final ShellState state;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    final List<SiteProfile> sites = state.config.sites;
    return ListView.builder(
      padding: const EdgeInsets.only(bottom: 96),
      itemCount: sites.length + 1,
      itemBuilder: (BuildContext context, int index) {
        if (index == sites.length) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: Text(
              '长按站点可以编辑名称、请求头、Basic Auth，或者清掉登录态。',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          );
        }
        final SiteProfile site = sites[index];
        return _SiteCard(state: state, site: site);
      },
    );
  }
}

class _SiteCard extends StatelessWidget {
  const _SiteCard({required this.state, required this.site});

  final ShellState state;
  final SiteProfile site;

  @override
  Widget build(BuildContext context) {
    final bool isCurrent = state.config.activeSiteId == site.id;
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 6, 12, 6),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        leading: SiteAvatar(site: site, size: 44),
        title: Row(
          children: <Widget>[
            Flexible(
              child: Text(
                site.displayName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
            if (isCurrent) ...<Widget>[
              const SizedBox(width: 6),
              const Icon(Icons.star, size: 14),
            ],
          ],
        ),
        subtitle: Text(
          displayUrl(site.startUrl),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        trailing: const Icon(Icons.chevron_right),
        onTap: () {
          state.openSite(site);
          Navigator.of(context).push<void>(BrowserPage.route(state, site.id));
        },
        onLongPress: () => _siteMenu(context),
      ),
    );
  }

  Future<void> _siteMenu(BuildContext context) async {
    await showModalBottomSheet<void>(
      context: context,
      builder: (BuildContext sheetContext) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              ListTile(
                leading: SiteAvatar(site: site, size: 32),
                title: Text(site.displayName),
                subtitle: Text(displayUrl(site.startUrl)),
              ),
              const Divider(height: 1),
              ListTile(
                leading: const Icon(Icons.open_in_new),
                title: const Text('打开'),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  state.openSite(site);
                  Navigator.of(context).push<void>(BrowserPage.route(state, site.id));
                },
              ),
              ListTile(
                leading: const Icon(Icons.edit_outlined),
                title: const Text('编辑站点'),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  Navigator.of(context).push<void>(
                    MaterialPageRoute<void>(
                      builder: (BuildContext _) => SiteEditPage(state: state, siteId: site.id),
                    ),
                  );
                },
              ),
              if (state.config.activeSiteId != site.id)
                ListTile(
                  leading: const Icon(Icons.star_outline),
                  title: const Text('设为默认'),
                  onTap: () {
                    state.openSite(site);
                    Navigator.of(sheetContext).pop();
                  },
                ),
              ListTile(
                leading: const Icon(Icons.image_outlined),
                title: const Text('重新抓取图标'),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  state.refreshIcon(site);
                },
              ),
              ListTile(
                leading: const Icon(Icons.logout),
                title: const Text('清除该站点登录态'),
                subtitle: const Text('只清这个站点的 Cookie，别的站点不受影响'),
                onTap: () async {
                  Navigator.of(sheetContext).pop();
                  await state.clearSiteData(site);
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text('已清除 ${site.displayName} 的登录态')),
                    );
                  }
                },
              ),
              ListTile(
                leading: Icon(Icons.delete_outline, color: Theme.of(context).colorScheme.error),
                title: Text('删除站点', style: TextStyle(color: Theme.of(context).colorScheme.error)),
                onTap: () async {
                  Navigator.of(sheetContext).pop();
                  final bool? ok = await showDialog<bool>(
                    context: context,
                    builder: (BuildContext dialogContext) => AlertDialog(
                      title: const Text('删除站点'),
                      content: Text('把「${site.displayName}」从这个 App 里删掉？\n已经下载到本机的文件不会被删除。'),
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
                  if (ok == true) state.removeSite(site.id);
                },
              ),
            ],
          ),
        );
      },
    );
  }
}

/// 「添加站点」表单：只要一个地址，其余都能以后再改。
Future<SiteProfile?> showAddSiteSheet(BuildContext context, ShellState state) {
  return showModalBottomSheet<SiteProfile>(
    context: context,
    isScrollControlled: true,
    builder: (BuildContext sheetContext) => _AddSiteSheet(state: state),
  );
}

class _AddSiteSheet extends StatefulWidget {
  const _AddSiteSheet({required this.state});

  final ShellState state;

  @override
  State<_AddSiteSheet> createState() => _AddSiteSheetState();
}

class _AddSiteSheetState extends State<_AddSiteSheet> {
  final TextEditingController _url = TextEditingController();
  final TextEditingController _name = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    _name.dispose();
    super.dispose();
  }

  void _submit() {
    final String? url = normalizeUrl(_url.text);
    if (url == null) {
      setState(() => _error = '这个地址打不开，检查一下是不是漏了域名或写错了协议');
      return;
    }
    final String typedName = _name.text.trim();
    final SiteProfile site = SiteProfile(
      id: newId(),
      name: typedName.isEmpty ? guessSiteName(url) : typedName,
      startUrl: url,
      themeColor: widget.state.branding.themeColor,
      createdAtMs: nowMs(),
    );
    Navigator.of(context).pop(site);
  }

  @override
  Widget build(BuildContext context) {
    final EdgeInsets insets = MediaQuery.of(context).viewInsets;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + insets.bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text('添加站点', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 4),
          Text(
            '填网站地址就行，比如 portal.example.com 或 http://192.168.1.10:8080',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _url,
            autofocus: true,
            keyboardType: TextInputType.url,
            textInputAction: TextInputAction.next,
            decoration: InputDecoration(
              labelText: '站点地址',
              hintText: 'example.com',
              border: const OutlineInputBorder(),
              errorText: _error,
            ),
            onChanged: (_) {
              if (_error != null) setState(() => _error = null);
            },
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _name,
            textInputAction: TextInputAction.done,
            decoration: const InputDecoration(
              labelText: '名称（可留空）',
              hintText: '不填就用网站域名',
              border: OutlineInputBorder(),
            ),
            onSubmitted: (_) => _submit(),
          ),
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _submit,
            child: const Text('添加并打开'),
          ),
        ],
      ),
    );
  }
}
