#pragma once

#include <utility>

#include "app_traffic.h"

namespace wifimeter::platform::fake
{

// 只有显式传入文件路径时才读取夹具；正式启动不会自动启用。
class FileAppTrafficSource final : public AppTrafficSource
{
public:
    explicit FileAppTrafficSource(std::string path) : path_(std::move(path)) {}
    void start() override { enabled_ = true; }
    void stop() override { enabled_ = false; }
    AppTrafficReport read() override;

private:
    std::string path_;
    bool enabled_ = false;
};

}  // namespace wifimeter::platform::fake
