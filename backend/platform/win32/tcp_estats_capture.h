#pragma once
#include <memory>
#include "../app_traffic.h"
namespace wifimeter::platform::windows
{
// TCP 回环数据源。仅在已启动的 helper 内调用；不发起提权、不写数据库。
class TcpEStatsCapture
{
public:
    TcpEStatsCapture();
    ~TcpEStatsCapture();
    AppTrafficReport read();
    void clear();
private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
}
