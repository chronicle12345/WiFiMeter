#include <filesystem>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

#include "../platform/linux/app_process_identity.h"
#include "../platform/linux/linux_app_traffic.h"
#include "test_support.h"

namespace platform = wifimeter::platform;
namespace linux = platform::linux;

void verifiesProcessIdentity()
{
    const std::string prefix = "42 (a name with ) brackets) S";
    std::string stat = prefix;
    for (int field = 4; field < 22; ++field)
        stat += " 0";
    stat += " 12345";
    WIFIMETER_CHECK_EQ(linux::processStartedTicks(stat).value_or(0), std::uint64_t{12345});
    WIFIMETER_CHECK(!linux::processStartedTicks("invalid"));
    const auto pid = static_cast<std::uint32_t>(::getpid());
    std::ifstream own("/proc/self/stat");
    const auto ticks = linux::processStartedTicks(std::string(std::istreambuf_iterator<char>(own), std::istreambuf_iterator<char>()));
    WIFIMETER_CHECK(ticks.has_value());
    if (!ticks)
        return;
    struct stat executable{};
    WIFIMETER_CHECK(::stat("/proc/self/exe", &executable) == 0);
    const auto started = *ticks * (1000000000ULL / static_cast<std::uint64_t>(::sysconf(_SC_CLK_TCK)));
    const auto device = (static_cast<std::uint32_t>(major(executable.st_dev)) << 20) | static_cast<std::uint32_t>(minor(executable.st_dev));
    const auto identity = linux::appProcessIdentity(pid, started, executable.st_ino, device);
    WIFIMETER_CHECK(identity.active);
    WIFIMETER_CHECK(!identity.path.empty());
    WIFIMETER_CHECK(!linux::appProcessIdentity(pid, started + 1000000000, executable.st_ino, device).active);
    WIFIMETER_CHECK(!linux::appProcessIdentity(pid, started, executable.st_ino + 1, device).active);
}

void supervisesTheHelper()
{
    wifimeter::test::TempDirectory directory("app-helper");
    const auto path = directory.file("helper with spaces");
    platform::AppTrafficReport report{platform::AppCollectorState::running, "one", {},
        {{"wlan0", "browser", "浏览器", "42:100", 42, 123, 45}}};
    const auto json = platform::serializeAppTrafficReport(report);
    wifimeter::test::writeFile(path,
        "#!/bin/sh\nprintf '%s\\n' '" + json + "'\nwhile IFS= read -r command; do\n"
        "[ \"$command\" = read ] || exit 0\nprintf '%s\\n' '" + json + "'\ndone\n");
    std::filesystem::permissions(path, std::filesystem::perms::owner_exec, std::filesystem::perm_options::add);
    linux::LinuxAppTrafficSource source({path, false});
    WIFIMETER_CHECK(source.read().state == platform::AppCollectorState::disabled);
    source.start();
    report = source.read();
    WIFIMETER_CHECK(report.state == platform::AppCollectorState::running);
    WIFIMETER_CHECK_EQ(report.samples.size(), std::size_t{1});
    if (!report.samples.empty())
        WIFIMETER_CHECK_EQ(report.samples[0].rxBytes, std::uint64_t{123});
    source.stop();
    WIFIMETER_CHECK(source.read().state == platform::AppCollectorState::disabled);
    wifimeter::test::writeFile(path, "#!/bin/sh\nprintf '%s\\n' '{\"state\":\"permission\",\"detail\":\"Access denied\"}'\nexit 1\n");
    source.start();
    WIFIMETER_CHECK(source.read().state == platform::AppCollectorState::permission);
    source.stop();
    wifimeter::test::writeFile(path, "#!/bin/sh\nprintf '%s\\n' 'invalid JSON'\nexit 1\n");
    source.start();
    WIFIMETER_CHECK(source.read().state == platform::AppCollectorState::unavailable);
    source.stop();
    linux::LinuxAppTrafficSource missing({directory.file("missing"), false});
    missing.start();
    WIFIMETER_CHECK(missing.read().state == platform::AppCollectorState::unavailable);
#if defined(WIFIMETER_APP_CAPTURE_EXECUTABLE)
    if (::geteuid() != 0)
    {
        linux::LinuxAppTrafficSource native({WIFIMETER_APP_CAPTURE_EXECUTABLE, false});
        native.start();
        WIFIMETER_CHECK(native.read().state == platform::AppCollectorState::permission);
    }
#endif
}

int main()
{
    verifiesProcessIdentity();
    supervisesTheHelper();
    return WIFIMETER_REPORT();
}
