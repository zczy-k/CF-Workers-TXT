/// 统一的接口异常。
///
/// 之所以把 `needPw / noPwSet / pwFor` 提到一级字段：服务端在"受保护文件夹"
/// 相关操作上会回 `403 + needPw`，前端要据此弹密码框 —— 如果只留一句 error 文案，
/// 调用方就得去字符串里 `contains('密码')`，那是脆的。
library;

class ApiException implements Exception {
  final String message;
  final int status;

  /// 服务端要求验证管理员密码（删除受保护内容 / 移入移出保护区 / 取消保护）
  final bool needPw;

  /// 服务端根本没设 PASSWORD —— 再弹密码框也没用，UI 应该直接报错而不是反复重试
  final bool noPwSet;

  /// 'in' = 要移进保护区；'out' = 要从保护区移出。用于给出不同的提示文案。
  final String? pwFor;

  /// 服务端给的 Retry-After（秒），429 时有值
  final int? retryAfter;

  const ApiException(
    this.message, {
    this.status = 0,
    this.needPw = false,
    this.noPwSet = false,
    this.pwFor,
    this.retryAfter,
  });

  bool get isAuth => status == 401;

  bool get isRateLimited => status == 429;

  /// 网络层失败（连不上、超时、DNS）
  bool get isNetwork => status == 0;

  @override
  String toString() => 'ApiException($status): $message';
}
