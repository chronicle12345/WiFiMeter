#pragma once

#include <memory>

#include "../app_traffic.h"

namespace wifimeter::platform::windows
{

// 仅由获授权的辅助进程使用。每个实例拥有独立 ETW 会话，不控制系统 Kernel Logger。
class EtwAppCapture
{
public:
    EtwAppCapture();
    ~EtwAppCapture();
    EtwAppCapture(const EtwAppCapture&) = delete;
    EtwAppCapture& operator=(const EtwAppCapture&) = delete;

    AppTrafficReport start();
    AppTrafficReport read();
    void stop();

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace wifimeter::platform::windows
