import 'package:flutter/material.dart';
import 'package:webshell_core/webshell_core.dart';

import '../state.dart';
import '../theme.dart';
import '../widgets/centered.dart';
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
      // 大标题放在 body 里，AppBar 只留右侧两个动作。
      // 小字标题（17）和大字标题（30）上下堆一起是"没设计过"最典型的痕迹；
      // iOS / Linear / 微信新版的分层都是**只留一个标题层级**，其余交给留白。
      appBar: AppBar(
        toolbarHeight: 48,
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
          const SizedBox(width: 8),
        ],
      ),
      body: Centered(
        child: config.sites.isEmpty
            ? _EmptySites(branding: branding, onAdd: () => _addSite(context))
            : _SiteList(state: state, title: branding.appName),
      ),
      floatingActionButton: branding.allowAddSite && config.sites.isNotEmpty
          ? FloatingActionButton.extended(
              onPressed: () => _addSite(context),
              icon: const Icon(Icons.add_rounded),
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
    // 站点在表单里就已经写进配置了（见 showAddSiteSheet 的说明），这里只负责打开它。
    await Navigator.of(context).push<void>(BrowserPage.route(state, site.id));
  }
}

class _EmptySites extends StatelessWidget {
  const _EmptySites({required this.branding, required this.onAdd});

  final Branding branding;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    final ColorScheme colors = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Container(
              width: 76,
              height: 76,
              decoration: BoxDecoration(
                color: colors.primary.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(24),
                border: Border.all(color: colors.primary.withValues(alpha: 0.12)),
              ),
              child: Icon(
                Icons.language_rounded,
                size: 34,
                color: colors.primary,
              ),
            ),
            const SizedBox(height: 22),
            Text(
              '还没有站点',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 8),
            Text(
              '把任何一个网站的地址加进来，它就会变成这个 App 里的一个独立站点：\n'
              '翻页、登录、上传、下载都照常，下载会直接落到本机目录。',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
            ),
            const SizedBox(height: 28),
            if (presetLoadError != null) ...<Widget>[
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: colors.errorContainer.withValues(alpha: 0.55),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      '预置配置（preset.json）读取失败',
                      style: TextStyle(
                        fontWeight: FontWeight.w700,
                        color: colors.onErrorContainer,
                      ),
                    ),
                    const SizedBox(height: 4),
                    // 可选中：用户能直接把这段贴出来，不用手抄
                    SelectableText(
                      presetLoadError!,
                      style: TextStyle(fontSize: 12, color: colors.onErrorContainer),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),
            ],
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
  const _SiteList({required this.state, required this.title});

  final ShellState state;
  final String title;

  @override
  Widget build(BuildContext context) {
    final List<SiteProfile> sites = state.config.sites;
    final ColorScheme colors = Theme.of(context).colorScheme;
    final TextTheme text = Theme.of(context).textTheme;

    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(20, 2, 20, 110),
      // 0 是大标题头部，最后一条是底部提示，中间才是站点卡片。
      itemCount: sites.length + 2,
      itemBuilder: (BuildContext context, int index) {
        if (index == 0) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(2, 2, 2, 18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: text.headlineMedium,
                ),
                const SizedBox(height: 6),
                Text(
                  '${sites.length} 个站点',
                  style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
                ),
              ],
            ),
          );
        }
        if (index == sites.length + 1) {
          return Padding(
            padding: const EdgeInsets.only(top: 14),
            child: Text(
              '长按站点可以编辑名称、请求头、Basic Auth，或者清掉登录态。',
              textAlign: TextAlign.center,
              style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
          );
        }
        return _SiteCard(state: state, site: sites[index - 1]);
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
    final ColorScheme colors = Theme.of(context).colorScheme;
    final TextTheme text = Theme.of(context).textTheme;

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: colors.surface,
        borderRadius: BorderRadius.circular(AppTheme.radiusCard),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () {
            state.openSite(site);
            Navigator.of(context).push<void>(BrowserPage.route(state, site.id));
          },
          onLongPress: () => _siteMenu(context),
          child: Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(AppTheme.radiusCard),
              border: Border.all(color: AppTheme.hairline(colors)),
            ),
            padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
            child: Row(
              children: <Widget>[
                SiteAvatar(site: site, size: 44),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          Flexible(
                            child: Text(
                              site.displayName,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: text.titleMedium?.copyWith(fontSize: 15),
                            ),
                          ),
                          if (isCurrent) ...<Widget>[
                            const SizedBox(width: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 7,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color: colors.primary.withValues(alpha: 0.10),
                                borderRadius: BorderRadius.circular(999),
                              ),
                              child: Text(
                                '默认',
                                style: TextStyle(
                                  fontSize: 10.5,
                                  fontWeight: FontWeight.w600,
                                  letterSpacing: 0.2,
                                  color: colors.primary,
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 3),
                      Text(
                        displayUrl(site.startUrl),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: text.bodySmall?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 6),
                Icon(
                  Icons.chevron_right_rounded,
                  size: 20,
                  color: colors.outlineVariant,
                ),
              ],
            ),
          ),
        ),
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
///
/// **返回的站点一定已经写进配置**（写盘这一步在表单内部完成，不交给调用方，
/// 免得调用方忘了）。返回 null 表示用户取消。地址已经存在时返回已有的那个站点。
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

  Future<void> _submit() async {
    final String? url = normalizeUrl(_url.text);
    if (url == null) {
      setState(() => _error = '这个地址打不开，检查一下是不是漏了域名或写错了协议');
      return;
    }
    // 同一个地址已经加过了：别再塞一份，直接把已有的那个交回去（调用方会打开它）。
    final SiteProfile? existing = widget.state.config.findByUrl(url);
    if (existing != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('「${existing.displayName}」已经在列表里了，直接打开它')),
      );
      Navigator.of(context).pop(existing);
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
    // 写进配置这一步**必须在这里**做，而不是交给调用方：调用方拿到的站点必须已经是
    // 配置里的一员。否则浏览页按 id 找不到它，只会显示"这个站点已经被删除了"，
    // 首页列表也永远空着 —— 就是"空壳"的表现（这台机器真的漏过一次）。
    await widget.state.addSite(site);
    if (!mounted) return;
    Navigator.of(context).pop(site);
  }

  @override
  Widget build(BuildContext context) {
    final EdgeInsets insets = MediaQuery.of(context).viewInsets;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 8, 20, 20 + insets.bottom),
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
          const SizedBox(height: 20),
          TextField(
            controller: _url,
            autofocus: true,
            keyboardType: TextInputType.url,
            textInputAction: TextInputAction.next,
            decoration: InputDecoration(
              labelText: '站点地址',
              hintText: 'example.com',
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
            ),
            onSubmitted: (_) => _submit(),
          ),
          const SizedBox(height: 24),
          FilledButton(
            onPressed: _submit,
            child: const Text('添加并打开'),
          ),
        ],
      ),
    );
  }
}
