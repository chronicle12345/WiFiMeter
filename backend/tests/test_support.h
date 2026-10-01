#pragma once

// 极简测试支撑。仓库当前没有 gtest/catch2 等可用依赖，构建又必须离线可复现，
// 因此只提供断言与统计所需的最小宏。
//
// Windows 上同样要能编译并运行这些用例：进程号用 <process.h> 的 _getpid，
// UTC 日历用 _mkgmtime，时区固定改用 _putenv_s。

#if defined(_WIN32)
#include <process.h>
#else
#include <unistd.h>
#endif

#include <chrono>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <system_error>

namespace wifimeter::test
{

inline int checks = 0;
inline int failures = 0;

inline int processId()
{
#if defined(_WIN32)
    return ::_getpid();
#else
    return ::getpid();
#endif
}

template <typename T>
std::string describe(const T& value)
{
    std::ostringstream stream;
    stream << value;
    return stream.str();
}

// 宽字符串无法直接进 ostream：按 UTF-8 打印，失败时才能看清是哪个网卡名或 SSID。
std::string describe(const std::u16string& value);

inline std::string describe(char16_t value)
{
    return describe(std::u16string(1, value));
}

inline void fail(const char* file, int line, const std::string& detail)
{
    ++failures;
    std::fprintf(stderr, "失败 %s:%d %s\n", file, line, detail.c_str());
}

// 断言失败时把宽字符串按 UTF-8 打印出来：网卡名与 SSID 常常含中文，
// 打印成码元数字会看不出问题。非法代理项写成 \uXXXX，保留原始信息。
inline std::string encodeUtf8(std::u16string_view text)
{
    std::string out;
    for (std::size_t index = 0; index < text.size(); ++index)
    {
        char32_t codePoint = text[index];
        if (codePoint >= 0xD800 && codePoint <= 0xDBFF && index + 1 < text.size() && text[index + 1] >= 0xDC00 && text[index + 1] <= 0xDFFF)
        {
            codePoint = 0x10000 + ((codePoint - 0xD800) << 10) + (text[index + 1] - 0xDC00);
            ++index;
        }
        else if (codePoint >= 0xD800 && codePoint <= 0xDFFF)
        {
            char escape[16] = {};
            std::snprintf(escape, sizeof(escape), "\\u%04X", static_cast<unsigned>(codePoint));
            out += escape;
            continue;
        }

        if (codePoint <= 0x7F)
            out.push_back(static_cast<char>(codePoint));
        else if (codePoint <= 0x7FF)
        {
            out.push_back(static_cast<char>(0xC0 | (codePoint >> 6)));
            out.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
        }
        else if (codePoint <= 0xFFFF)
        {
            out.push_back(static_cast<char>(0xE0 | (codePoint >> 12)));
            out.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
        }
        else
        {
            out.push_back(static_cast<char>(0xF0 | (codePoint >> 18)));
            out.push_back(static_cast<char>(0x80 | ((codePoint >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
        }
    }
    return out;
}

inline std::string describe(const std::u16string& value)
{
    return encodeUtf8(value);
}

// 测试用的临时目录，析构时清理；每个实例带进程号与序号，避免并行用例互相干扰。
class TempDirectory
{
public:
    explicit TempDirectory(const std::string& tag)
    {
        static int counter = 0;
        path_ = std::filesystem::temp_directory_path() / ("wifimeter-test-" + tag + "-" + std::to_string(processId()) + "-" + std::to_string(++counter));
        std::error_code error;
        std::filesystem::remove_all(path_, error);
        std::filesystem::create_directories(path_, error);
    }
    ~TempDirectory()
    {
        std::error_code error;
        std::filesystem::remove_all(path_, error);
    }
    TempDirectory(const TempDirectory&) = delete;
    TempDirectory& operator=(const TempDirectory&) = delete;

    const std::filesystem::path& path() const
    {
        return path_;
    }
    std::string file(const std::string& name) const
    {
        return (path_ / name).string();
    }

private:
    std::filesystem::path path_;
};

inline void writeFile(const std::string& path, const std::string& content, bool executable = false)
{
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    stream << content;
    stream.close();
    if (!executable)
        return;
    std::error_code error;
    std::filesystem::permissions(path, std::filesystem::perms::owner_all | std::filesystem::perms::group_read | std::filesystem::perms::group_exec | std::filesystem::perms::others_read | std::filesystem::perms::others_exec, std::filesystem::perm_options::replace, error);
}

inline std::string readFile(const std::string& path)
{
    std::ifstream stream(path, std::ios::binary);
    std::ostringstream buffer;
    buffer << stream.rdbuf();
    return buffer.str();
}

// 用 UTC 日历构造时间点。GCC 11 的 libstdc++ 没有 C++20 的日期类型，因此用 timegm；
// MSVC 与 MinGW 的对应函数是 _mkgmtime。
inline std::chrono::system_clock::time_point utcTime(int year, int month, int day, int hour = 0, int minute = 0, int second = 0)
{
    std::tm time{};
    time.tm_year = year - 1900;
    time.tm_mon = month - 1;
    time.tm_mday = day;
    time.tm_hour = hour;
    time.tm_min = minute;
    time.tm_sec = second;
#if defined(_WIN32)
    return std::chrono::system_clock::from_time_t(::_mkgmtime(&time));
#else
    return std::chrono::system_clock::from_time_t(timegm(&time));
#endif
}

// 固定时区，让本地日期断言与运行机器的设置无关。
//
// Windows 的 CRT 只认 POSIX 形式的 TZ（如 "UTC"、"GMT-8"），不认 IANA 名称（"Asia/Shanghai"）：
// 认不出的名字会被当成 UTC 加一个夏令时规则（实测会偏一小时），因此这里把 IANA 名称换掉。
// 用例只用无夏令时的时区，固定偏移与真实规则一致。
inline void useTimeZone(const char* name)
{
#if defined(_WIN32)
    const std::string requested(name);
    std::string zone = "UTC";
    if (requested != "UTC")
    {
        // 已知用例期望的偏移；其他名称退回运行机器的时区（偏差一小时也要如实反映）。
        int hours = 0;
        if (requested == "Asia/Shanghai")
        {
            hours = 8;
        }
        else
        {
            long offsetSeconds = 0;
            ::_get_timezone(&offsetSeconds);
            hours = static_cast<int>(-offsetSeconds / 3600);
        }
        if (hours != 0)
            zone = std::string("GMT") + (hours > 0 ? "-" : "+") + std::to_string(hours < 0 ? -hours : hours);
    }
    ::_putenv_s("TZ", zone.c_str());
    ::_tzset();
#else
    ::setenv("TZ", name, 1);
    ::tzset();
#endif
}

}  // namespace wifimeter::test

#define WIFIMETER_CHECK(expression)                                                \
    do                                                                             \
    {                                                                              \
        ++wifimeter::test::checks;                                                 \
        if (!(expression))                                                         \
            wifimeter::test::fail(__FILE__, __LINE__, "断言不成立：" #expression); \
    } while (false)

#define WIFIMETER_CHECK_EQ(actual, expected)                                                                                                                                          \
    do                                                                                                                                                                                \
    {                                                                                                                                                                                 \
        ++wifimeter::test::checks;                                                                                                                                                    \
        const auto& actualValue = (actual);                                                                                                                                           \
        const auto& expectedValue = (expected);                                                                                                                                       \
        if (!(actualValue == expectedValue))                                                                                                                                          \
        {                                                                                                                                                                             \
            wifimeter::test::fail(__FILE__, __LINE__, std::string(#actual " 期望 ") + wifimeter::test::describe(expectedValue) + "，实际 " + wifimeter::test::describe(actualValue)); \
        }                                                                                                                                                                             \
    } while (false)

#define WIFIMETER_REPORT() (std::printf("%s：%d 项检查，%d 项失败\n", __FILE__, wifimeter::test::checks, wifimeter::test::failures), wifimeter::test::failures == 0 ? 0 : 1)
