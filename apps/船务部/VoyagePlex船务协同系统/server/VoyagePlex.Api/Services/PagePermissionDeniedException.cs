namespace VoyagePlex.Api.Services;

public sealed class PagePermissionDeniedException() : Exception("账号权限已更改，请刷新后重试");
