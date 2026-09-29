#pragma once

// 极简测试支撑。仓库当前没有 gtest/catch2 等可用依赖，构建又必须离线可复现，
// 因此只提供断言与统计所需的最小宏。

#include <unistd.h>

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

template <typename T>
std::string describe(const T& value)
{
    std::ostringstream stream;
    stream << value;
    return stream.str();
}

inline void fail(const char* file, int line, const std::string& detail)
{
    ++failures;
    std::fprintf(stderr, "失败 %s:%d %s\n", file, line, detail.c_str());
}

// 测试用的临时目录，析构时清理；每个实例带进程号与序号，避免并行用例互相干扰。
class TempDirectory
{
public:
    explicit TempDirectory(const std::string& tag)
    {
        static int counter = 0;
        path_ = std::filesystem::temp_directory_path() / ("wifimeter-test-" + tag + "-" + std::to_string(::getpid()) + "-" + std::to_string(++counter));
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

// 用 UTC 日历构造时间点。GCC 11 的 libstdc++ 没有 C++20 的日期类型，因此用 timegm。
inline std::chrono::system_clock::time_point utcTime(int year, int month, int day, int hour = 0, int minute = 0, int second = 0)
{
    std::tm time{};
    time.tm_year = year - 1900;
    time.tm_mon = month - 1;
    time.tm_mday = day;
    time.tm_hour = hour;
    time.tm_min = minute;
    time.tm_sec = second;
    return std::chrono::system_clock::from_time_t(timegm(&time));
}

// 固定时区，让本地日期断言与运行机器的设置无关。
inline void useTimeZone(const char* name)
{
    ::setenv("TZ", name, 1);
    ::tzset();
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
