// wifimeter-backend：本机采集与存储进程（Windows）。
//
// 与 Linux 版共用同一份业务逻辑、协议与存储层，这里只处理三处系统差异：
//
//   * 数据库默认位置：%LOCALAPPDATA%\WiFiMeter\wifimeter.db（主进程始终显式传入
//     --db，因此实际位置以主进程为准，这里是直接运行后端排查时的缺省值）；
//   * 标准输出的编码与换行：Node 按 UTF-8 解码子进程输出，而 Windows 控制台的
//     默认代码页与文本模式会把换行改写成 CRLF、把非 ASCII 字符降级成本地代码页。
//     因此启动时把标准句柄切到二进制模式，并请求 UTF-8 代码页；
//   * 路径与输入输出都走宽字符或二进制 API：用户名含中文时目录仍能创建。
//
// 命令行参数与 Linux 版一致（--db / --paused / --version）。不需要 --nmcli 之类的开关：
// Windows 的身份与计数都来自系统 API，没有外部命令路径可配。

// winsock2.h 必须在 windows.h 之前：platform/win32 的头文件需要它的地址族类型。
#include <winsock2.h>
#include <ws2ipdef.h>
#include <windows.h>

#include <fcntl.h>
#include <io.h>
#include <shlobj.h>

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <string>

#include "../core/local_time.h"
#include "../ipc/server_windows.h"
#include "../ipc/service.h"
#include "../platform/counter_source.h"
#include "../platform/fake_app_traffic.h"
#include "../platform/windows/path_support.h"
#include "../platform/win32/wlanapi_query.h"
#include "../platform/win32/windows_app_traffic.h"
#include "../platform/windows/windows_network_platform.h"
#include "../storage/store.h"

namespace
{

namespace ipc = wifimeter::ipc;

void printUsage()
{
    std::printf(
        "用法：wifimeter-backend.exe [--db 路径] [--paused] [--version]\n"
        "\n"
        "  --db 路径     数据库文件位置；缺省为 %%WIFIMETER_DB%% 或\n"
        "                %%LOCALAPPDATA%%\\WiFiMeter\\wifimeter.db\n"
        "  --paused      启动后不自动采集，等待 setPaused 恢复\n"
        "  --fake-adapter 路径  改用 JSON 文件里的网卡数据，不查询系统（自动测试用）\n"
        "  --fake-counters 路径 改用 JSON 文件里的累计计数，不读系统计数（自动测试用）\n"
        "  --fake-apps 路径     改用 JSON 文件里的进程累计计数（自动测试用）\n"
        "  --version     输出版本信息\n");
}

// 让标准输入输出按 UTF-8 与 "\n" 工作：Node 侧按 UTF-8 解码并按行切分，
// 若沿用控制台代码页或文本模式，中文网卡名与 SSID 会变成乱码。
void configureStdio()
{
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    // 控制台代码页只影响在终端里手工查看；重定向到管道时不起作用，两者都要设置。
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCP(CP_UTF8);
}

std::string utf8FromWide(const wchar_t* text)
{
    if (text == nullptr || *text == L'\0')
        return {};
    const int size = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    if (size <= 1)
        return {};
    std::string result(static_cast<std::size_t>(size - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, -1, result.data(), size, nullptr, nullptr);
    return result;
}

// 数据库默认放在本机用户数据目录（不放漫游目录：用量记录是这台机器的数据）。
std::string defaultDatabasePath()
{
    if (const char* explicitPath = std::getenv("WIFIMETER_DB"); explicitPath != nullptr && *explicitPath != '\0')
        return explicitPath;

    PWSTR localAppData = nullptr;
    std::string base;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &localAppData)) && localAppData != nullptr)
        base = utf8FromWide(localAppData);
    if (localAppData != nullptr)
        CoTaskMemFree(localAppData);
    if (base.empty())
        base = ".";
    return base + "\\WiFiMeter\\wifimeter.db";
}

}  // namespace

// 参数取自 GetCommandLineW 而不是 main 的 argv：Windows 的 argv 按当前代码页
// （简体中文是 GBK）解释命令行，而调用方写出的路径是 UTF-8，非 ASCII 的用户名
// 会出现乱码并导致目录创建失败。这里先拿到 UTF-16 再转成 UTF-8，与协议一致。
int main()
{
    configureStdio();
    // 测试用数据源：默认从环境变量读，也可以用参数覆盖（见下面的 --fake-*）。
    wifimeter::platform::fake::configureFromEnvironment();

    int argumentCount = 0;
    LPWSTR* argumentList = ::CommandLineToArgvW(::GetCommandLineW(), &argumentCount);
    if (argumentList == nullptr)
    {
        std::fprintf(stderr, "无法读取命令行。\n");
        return 1;
    }

    std::string databasePath;
    bool paused = false;
    std::string fakeAppsPath;
    if (const char* path = std::getenv("WIFIMETER_FAKE_APPS"))
        fakeAppsPath = path;
    bool done = false;  // --help / --version：打印后正常退出
    int exitCode = 0;

    for (int index = 1; index < argumentCount && !done && exitCode == 0; ++index)
    {
        const std::string argument = utf8FromWide(argumentList[index]);
        if (argument == "--help" || argument == "-h")
        {
            printUsage();
            done = true;
            continue;
        }
        if (argument == "--version")
        {
            std::printf("wifimeter-backend 1.2.3（协议版本 %d）\n", ipc::kProtocolVersion);
            done = true;
            continue;
        }
        if (argument == "--paused")
        {
            paused = true;
            continue;
        }
        if (argument == "--db" && index + 1 < argumentCount)
        {
            databasePath = utf8FromWide(argumentList[++index]);
            continue;
        }
        // 测试数据源：与 WIFIMETER_FAKE_* 环境变量等价。命令行形式更可靠——
        // 实测把自定义环境块交给 CreateProcess 时子进程读不到这些变量。
        if (argument == "--fake-adapter" && index + 1 < argumentCount)
        {
            wifimeter::platform::fake::setAdapterPath(utf8FromWide(argumentList[++index]));
            continue;
        }
        if (argument == "--fake-counters" && index + 1 < argumentCount)
        {
            wifimeter::platform::fake::setCountersPath(utf8FromWide(argumentList[++index]));
            continue;
        }
        if (argument == "--fake-apps" && index + 1 < argumentCount)
        {
            fakeAppsPath = utf8FromWide(argumentList[++index]);
            continue;
        }
        std::fprintf(stderr, "未知参数：%s\n", argument.c_str());
        printUsage();
        exitCode = 2;
    }
    ::LocalFree(argumentList);
    if (exitCode != 0)
        return exitCode;
    if (done)
        return 0;

    if (databasePath.empty())
        databasePath = defaultDatabasePath();
    if (!wifimeter::platform::windows::ensureParentDirectory(databasePath))
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

    wifimeter::platform::windows::Win32System system;
    wifimeter::platform::windows::WindowsNetworkPlatform network(wifimeter::platform::windows::WindowsNetworkPlatform::Options{&system});
    std::unique_ptr<wifimeter::platform::AppTrafficSource> applications;
    if (!fakeAppsPath.empty())
        applications = std::make_unique<wifimeter::platform::fake::FileAppTrafficSource>(fakeAppsPath);
    else
    {
        wchar_t executable[32768]{};
        const auto length = ::GetModuleFileNameW(nullptr, executable, 32768);
        if (length && length < 32768)
        {
            const auto helper = std::filesystem::path(executable).parent_path() / L"wifimeter-app-capture.exe";
            applications = std::make_unique<wifimeter::platform::windows::WindowsAppTrafficSource>(
                wifimeter::platform::windows::WindowsAppTrafficSource::Options{utf8FromWide(helper.c_str())});
        }
    }
    ipc::BackendService service(ipc::BackendService::Deps{*store, network, applications.get()}, paused);
    ipc::StdioServer server(service);

    std::fprintf(stderr, "wifimeter-backend 已启动：%s\n", databasePath.c_str());
    return server.run(std::chrono::system_clock::now());
}
