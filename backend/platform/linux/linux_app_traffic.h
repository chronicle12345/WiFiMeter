#pragma once

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>

#include "../app_traffic.h"

namespace wifimeter::platform::linux
{

class LinuxAppTrafficSource final : public AppTrafficSource
{
public:
    struct Options
    {
        std::string helperPath;
        bool authorize = true;
    };
    explicit LinuxAppTrafficSource(Options options);
    ~LinuxAppTrafficSource() override;
    void start() override;
    void stop() override;
    AppTrafficReport read() override;

private:
    void run();
    void publish(AppTrafficReport report);
    Options options_;
    std::atomic<bool> stopped_{true};
    std::mutex mutex_;
    std::condition_variable changed_;
    std::thread worker_;
    AppTrafficReport report_;
    std::uint64_t revision_ = 0;
    bool requested_ = false;
};

}  // namespace wifimeter::platform::linux
