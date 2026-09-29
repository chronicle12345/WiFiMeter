#pragma once

// 把平台采样得到的累计计数换算成“归属于某个网络的增量”。
//
// 平台层每次给出的是网卡的累计字节数，而用量记录需要的是增量，因此必须保存上一次的
// 基线。真正棘手的是基线何时失效，这里用三条规则处理：
//
//   1. 计数回落：累计值只增不减，变小说明网卡重新加载或驱动重置，这段流量无法估算，
//      因此丢弃并重新建立基线，上报 counterReset。
//   2. 身份变化：同一张网卡换了网络，采样期间的流量无法判断属于哪一个，重新建立基线
//      且不计入，上报 reattributed。
//   3. 网卡从采样中消失：如果本轮报告完整（平台能看清所有网卡），说明它确实不再关联，
//      此时丢弃基线——未关联期间的流量不可归属；如果报告不完整（例如 nmcli 失败），
//      说明情况未知，保留基线，超过 baselineTtl 仍无消息才丢弃，避免把很久之后的差值
//      算到旧网络上。
//
// 首次见到某张网卡只建立基线、不产生增量：进程启动前的流量无从归属。

#include <chrono>
#include <cstddef>
#include <map>
#include <string>
#include <vector>

#include "../platform/network_platform.h"
#include "byte_count.h"
#include "local_time.h"
#include "network_key.h"

namespace wifimeter::core
{

// 一段归属于某个网络的流量。区间由上一次成功采样到 at 之间。
struct UsageDelta
{
    NetworkRef network;
    std::string interfaceId;
    ByteCount rxBytes = 0;
    ByteCount txBytes = 0;
    TimePoint at{};
    std::chrono::seconds span{0};  // 距上次采样的间隔，便于上层判断归属的可信度
};

enum class CounterEventKind
{
    baseline,      // 首次见到该网卡，只记录基线
    counterReset,  // 计数回落，已重新建立基线
    reattributed,  // 身份变化，已重新建立基线
    detached,      // 网卡不再关联或超时未出现，已丢弃基线
};

struct CounterEvent
{
    CounterEventKind kind = CounterEventKind::baseline;
    std::string interfaceId;
    NetworkRef network;            // 变化后的网络；detached 时为空
    std::chrono::seconds span{0};  // 距上次成功采样的间隔；未知为 0
};

struct AccumulateResult
{
    std::vector<UsageDelta> deltas;
    std::vector<CounterEvent> events;
};

class UsageAccumulator
{
public:
    struct Options
    {
        // 报告不完整时基线的保留时长，超过则丢弃。
        std::chrono::seconds baselineTtl{300};
    };

    UsageAccumulator();
    explicit UsageAccumulator(Options options);

    // 处理一次采样。now 必须单调递增；同一网卡出现两次时以最后一行为准。
    AccumulateResult accumulate(const platform::SampleReport& report, TimePoint now);

    std::size_t trackedInterfaces() const
    {
        return baselines_.size();
    }
    void clear()
    {
        baselines_.clear();
    }

private:
    struct Baseline
    {
        NetworkRef network;
        ByteCount rx = 0;
        ByteCount tx = 0;
        TimePoint seenAt{};
    };

    void dropStaleBaselines(TimePoint now, AccumulateResult& result);

    Options options_;
    std::map<std::string, Baseline> baselines_;
};

}  // namespace wifimeter::core
