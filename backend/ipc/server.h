#pragma once

// 标准输入输出上的事件循环。
//
// 一行一个 JSON 请求，逐行回响应；采样按设置的间隔在同一循环里定时触发，
// 因此整个后端是单线程的——没有锁，也没有两个线程抢数据库连接的问题。

#include <chrono>
#include <string>

#include "../core/local_time.h"
#include "service.h"

namespace wifimeter::ipc
{

class StdioServer
{
public:
    struct Options
    {
        int inputFd = 0;
        int outputFd = 1;
        // 单次等待输入的最长时间；采样间隔更短时会用采样间隔。
        std::chrono::milliseconds maxWait{1000};
    };

    // 嵌套类型的默认成员初始化器不能用在类内的默认实参里，因此拆成两个构造函数。
    explicit StdioServer(BackendService& service);
    StdioServer(BackendService& service, Options options);

    // 运行到收到 shutdown、输入结束或写入失败为止，返回进程退出码。
    int run(core::TimePoint startAt);

    // 便于测试：处理一行输入并写出响应，不进入循环。
    bool handleLine(const std::string& line, core::TimePoint now);

private:
    void emitEvent(const std::string& name, const support::JsonValue& payload);
    bool writeLine(const std::string& text);

    BackendService& service_;
    Options options_;
};

}  // namespace wifimeter::ipc
