#pragma once

// UTF-16（Windows 的宽字符）与 UTF-8（协议与存储使用）之间的转换。
//
// Windows 的 API 用宽字符报告网卡名称、配置名与 SSID，这些都是用户数据，可能是中文
// 或 emoji，不能按当前代码页降级为本地字符集。这里按 UTF-16 码元处理，遇到落单的
// 代理项或非法序列写 U+FFFD，而不是丢弃整串或截断。
//
// 解码也在这里实现，而不是直接调用 MultiByteToWideChar：那样单元测试只能在 Windows
// 上跑，而解析配置名与 SSID 的用例必须在开发机上就能验证。

#include <cstdint>
#include <string>
#include <string_view>

namespace wifimeter::platform::windows
{

std::string toUtf8(std::u16string_view text);

// 原始字节串 → 合法 UTF-8：非法序列按“最长非法子串”替换成 U+FFFD。
// 用于 SSID 这类系统直接给出的字节串（DOT11_SSID.ucSSID）：合法的 UTF-8 原样保留，
// 坏字节被替换而不是丢掉整条记录。
std::string toUtf8Bytes(std::string_view bytes);

std::u16string fromUtf8(std::string_view text);

// 供测试与逐步解析使用：把一个 UTF-8 码点写入输出，返回消耗的字节数；
// 非法序列写入 U+FFFD 并返回 1。
std::size_t appendUtf8(std::string& out, std::string_view text);

}  // namespace wifimeter::platform::windows
