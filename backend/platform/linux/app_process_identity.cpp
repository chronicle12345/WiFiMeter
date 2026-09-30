#include "app_process_identity.h"

#include <charconv>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <sstream>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

namespace wifimeter::platform::linux
{

std::optional<std::uint64_t> processStartedTicks(std::string_view text)
{
    const auto closing = text.rfind(')');
    if (closing == std::string_view::npos)
        return std::nullopt;
    std::istringstream fields(std::string(text.substr(closing + 1)));
    std::string value;
    for (int field = 3; field <= 22; ++field)
        if (!(fields >> value))
            return std::nullopt;
    std::uint64_t ticks = 0;
    const auto parsed = std::from_chars(value.data(), value.data() + value.size(), ticks);
    if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size())
        return std::nullopt;
    return ticks;
}

AppProcessIdentity appProcessIdentity(std::uint32_t pid, std::uint64_t startedNs, std::uint64_t executableInode, std::uint32_t executableDevice)
{
    AppProcessIdentity result;
    const auto directory = std::filesystem::path("/proc") / std::to_string(pid);
    std::ifstream statFile(directory / "stat");
    const auto started = processStartedTicks(std::string(std::istreambuf_iterator<char>(statFile), std::istreambuf_iterator<char>()));
    const auto hz = ::sysconf(_SC_CLK_TCK);
    if (!started || hz <= 0 || hz > 1000000000 || !startedNs || startedNs / (1000000000ULL / static_cast<std::uint64_t>(hz)) != *started)
        return result;
    const auto executable = directory / "exe";
    struct stat identity{};
    if (::stat(executable.c_str(), &identity) != 0 || static_cast<std::uint64_t>(identity.st_ino) != executableInode ||
        ((static_cast<std::uint32_t>(major(identity.st_dev)) << 20) | static_cast<std::uint32_t>(minor(identity.st_dev))) != executableDevice)
        return result;
    std::error_code error;
    const auto path = std::filesystem::read_symlink(executable, error);
    if (error)
        return result;
    // 读取路径之后再确认身份，覆盖两次读取之间发生的退出、PID 重用或 exec。
    std::ifstream again(directory / "stat");
    const auto checked = processStartedTicks(std::string(std::istreambuf_iterator<char>(again), std::istreambuf_iterator<char>()));
    struct stat current{};
    if (checked != started || ::stat(executable.c_str(), &current) != 0 || current.st_dev != identity.st_dev || current.st_ino != identity.st_ino)
        return result;
    result.path = path.string();
    result.active = true;
    return result;
}

}  // namespace wifimeter::platform::linux
