#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace wifimeter::platform::linux
{

std::optional<std::uint64_t> processStartedTicks(std::string_view stat);

// 使用进程开始时间和可执行文件 inode 一并验证，避免 PID 重用或 exec 后读错身份。
struct AppProcessIdentity
{
    std::string path;
    bool active = false;
};

AppProcessIdentity appProcessIdentity(std::uint32_t pid, std::uint64_t startedNs, std::uint64_t executableInode, std::uint32_t executableDevice);

}  // namespace wifimeter::platform::linux
