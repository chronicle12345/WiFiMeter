// wifimeter-backend：本机采集与存储进程。
//
// Electron 主进程负责拉起它，通过标准输入输出按行交换 JSON；
// 也可以单独运行用于排查：把请求写进标准输入即可。

#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "../core/local_time.h"
#include "../ipc/server.h"
#include "../ipc/service.h"
#include "../platform/linux/linux_network_platform.h"
#include "../storage/store.h"

namespace
{

namespace ipc = wifimeter::ipc;

void printUsage()
{
    std::printf(
        "用法：wifimeter-backend [--db 路径] [--paused] [--version]\n"
        "\n"
        "  --db 路径     数据库文件位置；缺省为 $WIFIMETER_DB 或 $XDG_DATA_HOME/wifimeter/wifimeter.db\n"
        "  --nmcli 路径  NetworkManager 命令位置，缺省用 PATH 中的 nmcli（便于测试与排查）\n"
        "  --proc-net-dev 路径  计数文件位置，缺省 /proc/net/dev（便于测试与排查）\n"
        "  --paused      启动后不自动采集，等待 setPaused 恢复\n"
        "  --version     输出版本信息\n");
}

// 数据库默认放在用户数据目录，符合 XDG 约定。
std::string defaultDatabasePath()
{
    if (const char* explicitPath = std::getenv("WIFIMETER_DB"); explicitPath != nullptr && *explicitPath != '\0')
        return explicitPath;

    std::string base;
    if (const char* xdg = std::getenv("XDG_DATA_HOME"); xdg != nullptr && *xdg != '\0')
    {
        base = xdg;
    }
    else if (const char* home = std::getenv("HOME"); home != nullptr && *home != '\0')
    {
        base = std::string(home) + "/.local/share";
    }
    else
    {
        base = "/tmp";
    }
    return base + "/wifimeter/wifimeter.db";
}

bool ensureParentDirectory(const std::string& path)
{
    const std::size_t separator = path.find_last_of('/');
    if (separator == std::string::npos || separator == 0)
        return true;
    const std::string directory = path.substr(0, separator);
    // 逐级创建，忽略“已存在”。
    for (std::size_t index = 1; index <= directory.size(); ++index)
    {
        if (index != directory.size() && directory[index] != '/')
            continue;
        const std::string partial = directory.substr(0, index);
        if (::mkdir(partial.c_str(), 0700) != 0 && errno != EEXIST)
            return false;
    }
    return true;
}

}  // namespace

int main(int argc, char** argv)
{
    std::string databasePath;
    std::string nmcliPath;
    std::string procNetDevPath;
    bool paused = false;

    for (int index = 1; index < argc; ++index)
    {
        const std::string argument = argv[index];
        if (argument == "--help" || argument == "-h")
        {
            printUsage();
            return 0;
        }
        if (argument == "--version")
        {
            std::printf("wifimeter-backend 0.1.0（协议版本 %d）\n", ipc::kProtocolVersion);
            return 0;
        }
        if (argument == "--paused")
        {
            paused = true;
            continue;
        }
        if (argument == "--db" && index + 1 < argc)
        {
            databasePath = argv[++index];
            continue;
        }
        if (argument == "--nmcli" && index + 1 < argc)
        {
            nmcliPath = argv[++index];
            continue;
        }
        if (argument == "--proc-net-dev" && index + 1 < argc)
        {
            procNetDevPath = argv[++index];
            continue;
        }
        std::fprintf(stderr, "未知参数：%s\n", argument.c_str());
        printUsage();
        return 2;
    }

    if (databasePath.empty())
        databasePath = defaultDatabasePath();
    if (!ensureParentDirectory(databasePath))
    {
        std::fprintf(stderr, "无法创建数据目录：%s\n", databasePath.c_str());
        return 1;
    }

    wifimeter::storage::Status status;
    auto store = wifimeter::storage::Store::open(databasePath, status);
    if (!store)
    {
        std::fprintf(stderr, "打开数据库失败：%s\n", status.message.c_str());
        return 1;
    }

    wifimeter::platform::linux::LinuxNetworkPlatform::Options networkOptions;
    if (!nmcliPath.empty())
        networkOptions.nmcliExecutable = nmcliPath;
    if (!procNetDevPath.empty())
        networkOptions.procNetDevPath = procNetDevPath;
    wifimeter::platform::linux::LinuxNetworkPlatform network(networkOptions);
    ipc::BackendService service(ipc::BackendService::Deps{*store, network}, paused);
    ipc::StdioServer server(service);

    std::fprintf(stderr, "wifimeter-backend 已启动：%s\n", databasePath.c_str());
    return server.run(std::chrono::system_clock::now());
}
