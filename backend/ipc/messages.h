#pragma once

// 与 Electron 之间的消息封装。
//
// 传输是一行一个 JSON 对象的文本协议（JSON Lines）：Electron 写标准输入发请求，
// 后端写标准输出回响应与事件，标准错误留给日志。选它的理由是可直接用命令行调试，
// 不需要套接字、端口或额外的依赖。
//
// 请求：{"id":1,"method":"snapshot","params":{...}}
// 响应：{"id":1,"ok":true,"result":{...}} 或 {"id":1,"ok":false,"error":{"code":"...","message":"..."}}
// 事件：{"event":"live","live":{...}}（没有 id，后端主动推送）

#include <optional>
#include <string>
#include <string_view>

#include "../support/json.h"

namespace wifimeter::ipc
{

// 协议版本。请求里带的版本与后端不一致时会被拒绝，避免新旧不兼容时静默错位。
inline constexpr int kProtocolVersion = 1;

// 方法名集中在这里，避免两端各写一遍字符串。
namespace method
{
inline constexpr const char* kHello = "hello";
inline constexpr const char* kSnapshot = "snapshot";
inline constexpr const char* kUpdateSettings = "updateSettings";
inline constexpr const char* kUpdateNetwork = "updateNetwork";
inline constexpr const char* kClearUsage = "clearUsage";
inline constexpr const char* kSetPaused = "setPaused";
inline constexpr const char* kSetAppCollection = "setAppCollection";
inline constexpr const char* kCollectNow = "collectNow";
inline constexpr const char* kExportUsage = "exportUsage";
inline constexpr const char* kBackup = "backup";
inline constexpr const char* kRestore = "restore";
inline constexpr const char* kDisconnect = "disconnect";
inline constexpr const char* kPruneUsage = "pruneUsage";
inline constexpr const char* kShutdown = "shutdown";
}  // namespace method

namespace event
{
inline constexpr const char* kLive = "live";
inline constexpr const char* kUsage = "usage";
inline constexpr const char* kAppUsage = "appUsage";
inline constexpr const char* kAlert = "alert";
}  // namespace event

// 错误码。界面按码决定提示文案，message 只用于日志排查。
namespace errorCode
{
inline constexpr const char* kBadRequest = "badRequest";
inline constexpr const char* kUnknownMethod = "unknownMethod";
inline constexpr const char* kVersionMismatch = "versionMismatch";
inline constexpr const char* kNotFound = "notFound";
inline constexpr const char* kInvalidParams = "invalidParams";
inline constexpr const char* kStorageFailure = "storageFailure";
inline constexpr const char* kPlatformFailure = "platformFailure";
inline constexpr const char* kUnavailable = "unavailable";
}  // namespace errorCode

struct Request
{
    bool hasId = false;
    long long id = 0;
    std::string method;
    support::JsonValue params;  // 缺省为空对象
    int protocol = kProtocolVersion;
};

struct Error
{
    std::string code;
    std::string message;
};

// 解析一行请求；失败时返回空值并给出错误码与说明。
std::optional<Request> parseRequest(std::string_view line, Error& error);

// 构造响应与事件（返回紧凑的单行文本，不含换行）。
std::string encodeResult(const Request& request, const support::JsonValue& result);
// 错误码与说明直接传字符串视图，不让 Error 聚合体参与返回值传递：
// 实测在 Windows 的 Release 构建下，把 Response 里的 Error 复制出来会得到空串，
// 结果错误码与说明都变成 ""（同一份代码在 Linux 与 Debug 构建下正常）。
// 逐个传参既避开了那条路径，也让调用点一眼看出发出去的是什么。
std::string encodeError(const Request& request, std::string_view code, std::string_view message);
std::string encodeEvent(std::string_view name, const support::JsonValue& payload);

}  // namespace wifimeter::ipc
