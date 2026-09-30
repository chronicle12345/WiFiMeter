#pragma once

#include <memory>
#include <string>

#include "../app_traffic.h"

namespace wifimeter::platform::windows
{

class WindowsAppTrafficSource final : public AppTrafficSource
{
public:
    struct Options
    {
        std::string helperPath;
        bool authorize = true;
    };

    explicit WindowsAppTrafficSource(Options options);
    ~WindowsAppTrafficSource() override;
    void start() override;
    void stop() override;
    AppTrafficReport read() override;

private:
    class Session;
    Options options_;
    std::shared_ptr<Session> session_;
};

}  // namespace wifimeter::platform::windows
