import 'package:flutter/material.dart';

import '../util.dart';
import 'icons.dart';

/// 列表里的一行。文件名**直接点就打开**（与网页端一致），其余操作收进 ⋯ 菜单 ——
/// 手机上每行塞 6 个按钮是灾难。
class EntryTile extends StatelessWidget {
  final String name;
  final bool isDir;
  final int size;
  final DateTime? mtime;
  final bool selected;
  final bool shared;
  final bool isProtected;
  final bool selectionMode;

  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final VoidCallback? onToggle;
  final List<PopupMenuEntry<String>> menuItems;
  final void Function(String value) onMenuSelected;

  const EntryTile({
    super.key,
    required this.name,
    this.isDir = false,
    this.size = 0,
    this.mtime,
    this.selected = false,
    this.shared = false,
    this.isProtected = false,
    this.selectionMode = false,
    this.onTap,
    this.onLongPress,
    this.onToggle,
    this.menuItems = const [],
    required this.onMenuSelected,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final ext = extOf(name);

    return ListTile(
      dense: false,
      selected: selected,
      selectedTileColor: theme.colorScheme.primary.withAlpha(26),
      leading: selectionMode
          ? Checkbox(value: selected, onChanged: (_) => onToggle?.call())
          : Icon(
              iconOf(iconFor(name, isDir: isDir)),
              color: isDir
                  ? (isProtected ? const Color(0xFFB8891F) : theme.colorScheme.primary)
                  : theme.colorScheme.outline,
            ),
      title: Row(
        children: [
          Flexible(
            child: Text(
              name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontWeight: FontWeight.w500),
            ),
          ),
          if (ext.isNotEmpty && !isDir) ...[
            const SizedBox(width: 6),
            _Badge(text: ext.toUpperCase()),
          ],
          if (shared) ...[
            const SizedBox(width: 6),
            Icon(Icons.link_rounded, size: 14, color: theme.colorScheme.primary),
          ],
          if (isProtected) ...[
            const SizedBox(width: 4),
            const Icon(Icons.lock_rounded, size: 14, color: Color(0xFFB8891F)),
          ],
        ],
      ),
      subtitle: Text(
        isDir
            ? '文件夹'
            : '${fmtSize(size)}${mtime != null ? ' · ${fmtTime(mtime)}' : ''}',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.bodySmall,
      ),
      trailing: menuItems.isEmpty
          ? null
          : PopupMenuButton<String>(
              tooltip: '更多',
              onSelected: onMenuSelected,
              itemBuilder: (context) => menuItems,
            ),
      onTap: onTap,
      onLongPress: onLongPress,
    );
  }
}

class _Badge extends StatelessWidget {
  final String text;

  const _Badge({required this.text});

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
      decoration: BoxDecoration(
        color: c.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        text,
        style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: c.onSurfaceVariant),
      ),
    );
  }
}
