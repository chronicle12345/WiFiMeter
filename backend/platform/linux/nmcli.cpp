#include "nmcli.h"

#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstdlib>
#include <cstring>

// posix_spawnp 需要显式传入环境变量。
extern char** environ;

namespace wifimeter::platform::linux
{
namespace
{

bool isTerseSeparator(char value)
{
    return value == ':';
}

// 取非负整数，例如信号强度与频率；解析失败或为负返回空值。
std::optional<int> parseOptionalInt(std::string_view value)
{
    const int parsed = parseLeadingInt(value);
    if (parsed < 0)
        return std::nullopt;
    return parsed;
}

}  // namespace

std::string unescapeTerse(std::string_view value)
{
    std::string result;
    result.reserve(value.size());
    for (std::size_t index = 0; index < value.size(); ++index)
    {
        if (value[index] == '\\' && index + 1 < value.size())
        {
            const char next = value[index + 1];
            if (next == ':' || next == '\\')
            {
                result.push_back(next);
                ++index;
                continue;
            }
        }
        result.push_back(value[index]);
    }
    return result;
}

std::vector<std::string> splitTerseFields(std::string_view line)
{
    std::vector<std::string> fields;
    std::string current;
    for (std::size_t index = 0; index < line.size(); ++index)
    {
        const char value = line[index];
        if (value == '\\' && index + 1 < line.size() && (line[index + 1] == ':' || line[index + 1] == '\\'))
        {
            current.push_back(line[index + 1]);
            ++index;
            continue;
        }
        if (isTerseSeparator(value))
        {
            fields.push_back(std::move(current));
            current.clear();
            continue;
        }
        current.push_back(value);
    }
    fields.push_back(std::move(current));
    return fields;
}

std::pair<std::string, std::string> splitTersePair(std::string_view line)
{
    const std::vector<std::string> fields = splitTerseFields(line);
    if (fields.empty())
        return {};
    if (fields.size() == 1)
        return {fields.front(), std::string()};
    std::string value = fields[1];
    for (std::size_t index = 2; index < fields.size(); ++index)
    {
        value.push_back(':');
        value.append(fields[index]);
    }
    return {fields.front(), std::move(value)};
}

std::vector<std::map<std::string, std::string>> parseTerseBlocks(std::string_view output)
{
    std::vector<std::map<std::string, std::string>> blocks;
    std::map<std::string, std::string> current;
    std::size_t lineStart = 0;
    while (lineStart <= output.size())
    {
        const std::size_t lineEnd = output.find('\n', lineStart);
        std::string_view line = output.substr(lineStart, lineEnd == std::string_view::npos ? std::string_view::npos : lineEnd - lineStart);
        lineStart = lineEnd == std::string_view::npos ? output.size() + 1 : lineEnd + 1;
        if (!line.empty() && line.back() == '\r')
            line.remove_suffix(1);

        if (line.empty())
        {
            if (!current.empty())
            {
                blocks.push_back(std::move(current));
                current.clear();
            }
            continue;
        }
        auto [key, value] = splitTersePair(line);
        if (key.empty())
            continue;
        current.insert_or_assign(std::move(key), std::move(value));
    }
    if (!current.empty())
        blocks.push_back(std::move(current));
    return blocks;
}

int parseLeadingInt(std::string_view value)
{
    std::size_t index = 0;
    while (index < value.size() && (value[index] == ' ' || value[index] == '\t'))
        ++index;
    const std::size_t begin = index;
    if (index < value.size() && (value[index] == '-' || value[index] == '+'))
        ++index;
    const std::size_t digitsBegin = index;
    while (index < value.size() && value[index] >= '0' && value[index] <= '9')
        ++index;
    if (index == digitsBegin)
        return -1;  // 只有符号或没有数字都不算有效取值
    const std::string digits(value.substr(begin, index - begin));
    return static_cast<int>(std::strtol(digits.c_str(), nullptr, 10));
}

std::optional<Failure> commandFailure(const CommandResult& result, std::string interfaceId)
{
    if (!result.started)
        return Failure{FailureKind::unavailable, interfaceId, result.error};
    if (result.timedOut)
        return Failure{FailureKind::timeout, interfaceId, {}};
    if (result.exitCode != 0)
    {
        const std::string& detail = result.error.empty() ? result.output : result.error;
        return Failure{FailureKind::commandFailed, interfaceId, detail};
    }
    return std::nullopt;
}

std::vector<DeviceStatus> parseDeviceStatus(std::string_view output)
{
    std::vector<DeviceStatus> devices;
    for (const auto& block : parseTerseBlocks(output))
    {
        const auto field = [&block](const std::string& key) -> std::string {
            const auto found = block.find(key);
            return found == block.end() ? std::string() : found->second;
        };
        DeviceStatus status;
        status.device = field("GENERAL.DEVICE");
        if (status.device.empty())
            continue;
        status.type = field("GENERAL.TYPE");
        status.stateCode = parseLeadingInt(field("GENERAL.STATE"));
        status.connection = field("GENERAL.CONNECTION");
        status.connectionUuid = field("GENERAL.CON-UUID");
        status.vendor = field("GENERAL.VENDOR");
        status.product = field("GENERAL.PRODUCT");
        devices.push_back(std::move(status));
    }
    return devices;
}

std::string adapterAliasFrom(const std::string& vendor, const std::string& product)
{
    if (vendor.empty())
        return product;
    if (product.empty())
        return vendor;
    if (product.find(vendor) != std::string::npos)
        return product;
    return vendor + " " + product;
}

std::vector<WifiBss> parseWifiList(std::string_view output)
{
    std::vector<WifiBss> list;
    std::size_t lineStart = 0;
    while (lineStart <= output.size())
    {
        const std::size_t lineEnd = output.find('\n', lineStart);
        std::string_view line = output.substr(lineStart, lineEnd == std::string_view::npos ? std::string_view::npos : lineEnd - lineStart);
        lineStart = lineEnd == std::string_view::npos ? output.size() + 1 : lineEnd + 1;
        if (line.empty())
            continue;

        // 列：IN-USE、SSID、SIGNAL、FREQ。SSID 可能为空（隐藏网络）或含转义冒号。
        const std::vector<std::string> fields = splitTerseFields(line);
        if (fields.size() < 4)
            continue;

        WifiBss bss;
        bss.ssid = fields[1];
        bss.signalPercent = parseOptionalInt(fields[2]);
        bss.frequencyMhz = parseOptionalInt(fields[3]);
        list.push_back(std::move(bss));
    }
    return list;
}

std::optional<WifiBss> findBssBySsid(const std::vector<WifiBss>& list, std::string_view ssid)
{
    if (ssid.empty())
        return std::nullopt;
    const WifiBss* best = nullptr;
    for (const WifiBss& candidate : list)
    {
        if (candidate.ssid != ssid)
            continue;
        const int strength = candidate.signalPercent.value_or(-1);
        if (best == nullptr || strength > best->signalPercent.value_or(-1))
            best = &candidate;
    }
    if (best == nullptr)
        return std::nullopt;
    return *best;
}

CommandResult runCommand(const std::vector<std::string>& argv, std::chrono::milliseconds timeout)
{
    CommandResult result;
    if (argv.empty())
        return result;

    int outputPipe[2] = {-1, -1};
    int errorPipe[2] = {-1, -1};
    if (pipe(outputPipe) != 0)
        return result;
    if (pipe(errorPipe) != 0)
    {
        close(outputPipe[0]);
        close(outputPipe[1]);
        return result;
    }

    std::vector<char*> arguments;
    arguments.reserve(argv.size() + 1);
    for (const std::string& item : argv)
        arguments.push_back(const_cast<char*>(item.c_str()));
    arguments.push_back(nullptr);

    // 使用 posix_spawnp 而不是 fork：后端将来会有多个线程，fork 后只允许调用异步信号安全的函数。
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_adddup2(&actions, outputPipe[1], STDOUT_FILENO);
    posix_spawn_file_actions_adddup2(&actions, errorPipe[1], STDERR_FILENO);
    for (const int descriptor : {outputPipe[0], outputPipe[1], errorPipe[0], errorPipe[1]})
        posix_spawn_file_actions_addclose(&actions, descriptor);

    posix_spawnattr_t attributes;
    posix_spawnattr_init(&attributes);
#ifdef POSIX_SPAWN_CLOEXEC_DEFAULT
    // glibc 扩展：未显式重定向的描述符不继承，避免常驻进程把无关句柄泄漏给子进程。
    posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT);
#endif

    pid_t child = -1;
    const int spawnError = posix_spawnp(&child, arguments[0], &actions, &attributes, arguments.data(), environ);
    posix_spawnattr_destroy(&attributes);
    posix_spawn_file_actions_destroy(&actions);

    close(outputPipe[1]);
    close(errorPipe[1]);
    if (spawnError != 0)
    {
        close(outputPipe[0]);
        close(errorPipe[0]);
        result.started = false;
        result.error = std::strerror(spawnError);
        return result;
    }
    result.started = true;

    const auto deadline = std::chrono::steady_clock::now() + timeout;
    int openDescriptors = 2;
    while (openDescriptors > 0)
    {
        const auto now = std::chrono::steady_clock::now();
        if (now >= deadline)
        {
            result.timedOut = true;
            break;
        }
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
        pollfd descriptors[2] = {{outputPipe[0], POLLIN, 0}, {errorPipe[0], POLLIN, 0}};
        const int ready = poll(descriptors, 2, static_cast<int>(std::min<long long>(remaining, 1000)));
        if (ready < 0)
        {
            if (errno == EINTR)
                continue;
            break;
        }
        if (ready == 0)
            continue;

        for (int index = 0; index < 2; ++index)
        {
            if (descriptors[index].fd < 0)
                continue;
            if ((descriptors[index].revents & (POLLIN | POLLHUP | POLLERR)) == 0)
                continue;
            char buffer[4096];
            const ssize_t count = read(descriptors[index].fd, buffer, sizeof(buffer));
            if (count > 0)
            {
                (index == 0 ? result.output : result.error).append(buffer, static_cast<std::size_t>(count));
                continue;
            }
            if (count == 0)
            {
                close(descriptors[index].fd);
                descriptors[index].fd = -1;
                --openDescriptors;
                continue;
            }
            if (errno != EINTR && errno != EAGAIN)
            {
                close(descriptors[index].fd);
                descriptors[index].fd = -1;
                --openDescriptors;
            }
        }
    }

    if (result.timedOut)
        ::kill(child, SIGKILL);
    close(outputPipe[0]);
    close(errorPipe[0]);

    int status = 0;
    while (waitpid(child, &status, 0) < 0 && errno == EINTR)
    {
    }
    if (WIFEXITED(status))
    {
        result.exitCode = WEXITSTATUS(status);
    }
    else if (WIFSIGNALED(status))
    {
        result.exitCode = -1;
    }
    return result;
}

Nmcli::Nmcli(std::string executable, std::chrono::milliseconds timeout)
    : executable_(std::move(executable)),
      timeout_(timeout)
{}

Nmcli::DevicesResult Nmcli::devices() const
{
    DevicesResult result;
    const CommandResult command = runCommand({executable_, "-t", "-f", "GENERAL.DEVICE,GENERAL.TYPE,GENERAL.STATE,GENERAL.CONNECTION,GENERAL.CON-UUID,GENERAL.VENDOR,GENERAL.PRODUCT", "dev", "show"}, timeout_);
    if (const auto failure = commandFailure(command))
    {
        result.failure = failure;
        return result;
    }

    result.devices = parseDeviceStatus(command.output);
    for (DeviceStatus& device : result.devices)
    {
        // 只有已激活的无线网卡才有网络身份；SSID 以连接配置为准，取不到就留空。
        if (device.type != "wifi" || device.stateCode != 100 || device.connectionUuid.empty())
            continue;
        device.ssid = ssidForUuid(device.connectionUuid);
    }
    return result;
}

std::optional<std::string> Nmcli::ssidForUuid(const std::string& uuid) const
{
    const auto readField = [](const std::string& text) -> std::optional<std::string> {
        std::size_t lineStart = 0;
        while (lineStart <= text.size())
        {
            const std::size_t lineEnd = text.find('\n', lineStart);
            const std::string_view line = std::string_view(text).substr(lineStart, lineEnd == std::string::npos ? std::string::npos : lineEnd - lineStart);
            lineStart = lineEnd == std::string::npos ? text.size() + 1 : lineEnd + 1;
            auto [key, value] = splitTersePair(line);
            if (key == "802-11-wireless.ssid")
                return value;
        }
        return std::nullopt;
    };

    const CommandResult targeted = runCommand({executable_, "-t", "-f", "802-11-wireless.ssid", "connection", "show", uuid}, timeout_);
    if (targeted.started && !targeted.timedOut && targeted.exitCode == 0)
    {
        if (const auto value = readField(targeted.output))
            return value;
    }

    // 部分 nmcli 版本不接受该字段名，退回读取连接的完整配置。
    const CommandResult detailed = runCommand({executable_, "-t", "connection", "show", uuid}, timeout_);
    if (detailed.started && !detailed.timedOut && detailed.exitCode == 0)
    {
        if (const auto value = readField(detailed.output))
            return value;
    }
    return std::nullopt;
}

Nmcli::WifiListResult Nmcli::wifiList(const std::string& interfaceId) const
{
    WifiListResult result;
    const CommandResult command = runCommand({executable_, "-t", "-f", "IN-USE,SSID,SIGNAL,FREQ", "dev", "wifi", "list", "ifname", interfaceId}, timeout_);
    if (const auto failure = commandFailure(command, interfaceId))
    {
        result.failure = failure;
        return result;
    }
    result.list = parseWifiList(command.output);
    return result;
}

CommandResult Nmcli::disconnect(const std::string& interfaceId) const
{
    return runCommand({executable_, "dev", "disconnect", interfaceId}, timeout_);
}

}  // namespace wifimeter::platform::linux
