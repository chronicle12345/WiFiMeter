#include "path_support.h"

#include <cstddef>

#if defined(_WIN32)
#include <windows.h>
#endif

#include "text_convert.h"

namespace wifimeter::platform::windows
{
namespace
{

bool isSeparator(char value)
{
    return value == '\\' || value == '/';
}

// 该前缀是不是“根本身”（盘符 "C:" 或 UNC 的 \\server\share）：这些不是要新建的目录。
bool isBareRoot(std::string_view prefix)
{
    if (prefix.size() == 2 && prefix[1] == ':' && ((prefix[0] >= 'A' && prefix[0] <= 'Z') || (prefix[0] >= 'a' && prefix[0] <= 'z')))
        return true;
    // UNC：\server\share
    if (prefix.size() >= 2 && isSeparator(prefix[0]) && isSeparator(prefix[1]))
    {
        int separators = 0;
        for (char value : prefix)
        {
            if (isSeparator(value))
                ++separators;
        }
        return separators <= 3 && prefix.back() != '\\';
    }
    return false;
}

}  // namespace

std::string parentDirectoryOf(std::string_view path)
{
    const std::size_t separator = path.find_last_of("\\/");
    if (separator == std::string_view::npos)
        return {};
    return std::string(path.substr(0, separator));
}

std::vector<std::string> directoryPrefixesToCreate(std::string_view path)
{
    // 只做字符串处理，不用 std::filesystem：这段逻辑在 Linux 上也要编译并测试，
    // 而 Linux 的 path 把反斜杠当普通字符，解析不出 Windows 的目录层级。
    //
    // 分两层：
    //   1) 找出“根”的长度——盘符（C:）与 UNC 的 \\server\share 都不是要新建的目录；
    //   2) 只对根之后的每一段生成前缀。
    // 第 1 步错了会在真机上造成很难查的问题：把 "C:" 交给 CreateDirectory，
    // 当进程当前目录不可用时返回 ERROR_ACCESS_DENIED，"已存在"被误判成失败，
    // 后端直接退出，界面永远停在“采集器未就绪”。
    std::string directory(parentDirectoryOf(path));
    if (directory.empty())
        return {};

    std::size_t begin = 0;
    if (directory.size() >= 3 && directory[1] == ':' && isSeparator(directory[2]))
        begin = 3;  // 盘符后的第一个分隔符
    else if (directory.size() >= 2 && isSeparator(directory[0]) && isSeparator(directory[1]))
    {
        // UNC：跳过 \\server\share
        std::size_t index = 2;
        for (int segment = 0; segment < 2 && index < directory.size(); ++segment)
        {
            while (index < directory.size() && !isSeparator(directory[index]))
                ++index;
            while (index < directory.size() && isSeparator(directory[index]))
                ++index;
        }
        begin = index;
    }

    // 形如 "C:" 或 "C:\" 的根：没有目录要创建（"C:\b.db" 的父目录就是盘符本身）。
    const bool bareRoot = directory.size() == 2 && directory[1] == ':' && (directory[0] >= 'A' && directory[0] <= 'Z');
    if (bareRoot)
        return {};

    std::vector<std::string> prefixes;
    const auto add = [&prefixes](std::string candidate) {
        if (!candidate.empty() && !isBareRoot(candidate))
            prefixes.push_back(std::move(candidate));
    };
    for (std::size_t index = begin; index < directory.size(); ++index)
    {
        if (!isSeparator(directory[index]))
            continue;
        add(directory.substr(0, index));
    }
    if (begin < directory.size())
        add(directory);
    return prefixes;
}

bool ensureParentDirectory(const std::string& path)
{
#if defined(_WIN32)
    for (const std::string& prefix : directoryPrefixesToCreate(path))
    {
        const std::wstring wide = toUtf16(prefix);
        if (wide.empty())
            return false;
        if (!::CreateDirectoryW(wide.c_str(), nullptr))
        {
            const DWORD error = ::GetLastError();
            // 已存在不算失败；其余（权限、路径非法、当前目录不可用）都算失败。
            if (error != ERROR_ALREADY_EXISTS)
                return false;
        }
    }
    return true;
#else
    // 非 Windows 上没有可创建的目录语义，这里只保留按前缀切分的能力供测试使用。
    (void)path;
    return true;
#endif
}

}  // namespace wifimeter::platform::windows
