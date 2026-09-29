// wifimeter-backend：本机采集与存储进程（Windows）。
//
// 与 Linux 版共用同一份业务逻辑、协议与存储层，这里只处理两处系统差异：
//
//   * 数据库默认位置：Electron 的 userData 目录在 Windows 上是
//     %LOCALAPPDATA%\WiFiMeter Demo，后端默认与之相邻，便于界面与后端都找得到；
//   * 标准输出的编码与换行：Node 按 UTF-8 解码子进程输出，而 Windows 控制台的
//     默认代码页与文本模式会把换行改写成 CRLF、把非 ASCII 字符降级成本地代码页。
//     因此启动时把标准句柄切到二进制模式，并请求 UTF-8 代码页。
//
// 命令行参数与 Linux 版一致（--db / --paused / --version），另外保留
// --profile-name 之类的排查开关没有意义：Windows 的身份来自 WLAN API，不需要外部命令路径。

#include <windows.h>

#include <fcntl.h>
#include <io.h>
#include <shlobj.h>

#include <cstdio>
#include <cstdlib>
#include <string>

#include "../core/local_time.h"
#include "../ipc/server_windows.h"
#include "../ipc/service.h"
#include "../platform/win32/wlanapi_query.h"
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

// 逐级创建父目录；已存在不算失败。
bool ensureParentDirectory(const std::string& path)
{
    const std::size_t separator = path.find_last_of("\\/");
    if (separator == std::string::npos || separator == 0)
        return true;

    const std::string directory = path.substr(0, separator);
    // CreateDirectoryA 不创建中间层，因此从盘符之后逐段创建。
    for (std::size_t index = 1; index <= directory.size(); ++index)
    {
        if (index != directory.size() && directory[index] != '\\' && directory[index] != '/')
            continue;
        const std::string partial = directory.substr(0, index);
        if (!CreateDirectoryA(partial.c_str(), nullptr))
        {
            const DWORD error = GetLastError();
            if (error != ERROR_ALREADY_EXISTS)
                return false;
        }
    }
    return true;
}

}  // namespace

int main(int argc, char** argv)
{
    configureStdio();

    std::string databasePath;
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

    wifimeter::platform::windows::Win32System system;
    wifimeter::platform::windows::WindowsNetworkPlatform network(wifimeter::platform::windows::WindowsNetworkPlatform::Options{&system});
    ipc::BackendService service(ipc::BackendService::Deps{*store, network}, paused);
    ipc::StdioServer server(service);

    std::fprintf(stderr, "wifimeter-backend 已启动：%s\n", databasePath.c_str());
    return server.run(std::chrono::system_clock::now());
}
