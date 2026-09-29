#pragma once

// 标准输入输出上的事件循环（Windows 实现）。
//
// 与 POSIX 版语义相同：一行一个 JSON 请求，逐行回响应，采样按设置的间隔在同一循环里
// 定时触发，因此整个后端是单线程的。
//
// 差别只在等待方式：Windows 的管道句柄用 WaitForSingleObject 等待可读，超时值取
// “下一次采样还有多久”与最大等待时间中的较小者；没有 poll 可用。

#include <chrono>
#include <string>

#include <windows.h>

#include "../core/local_time.h"
#include "service.h"

namespace wifimeter::ipc
{

class StdioServer
{
public:
    struct Options
    {
        HANDLE input = INVALID_HANDLE_VALUE;    // 缺省用标准输入
        HANDLE output = INVALID_HANDLE_VALUE;   // 缺省用标准输出
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
