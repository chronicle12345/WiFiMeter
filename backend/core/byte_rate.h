#pragma once

#include <chrono>
#include <limits>

#include "byte_count.h"

namespace wifimeter::core
{

// 按毫秒区间换算字节/秒，保留整数精度；超过 uint64 范围时返回最大值。
inline ByteCount byteRate(ByteCount bytes, std::chrono::milliseconds span)
{
    const auto milliseconds = static_cast<ByteCount>(span.count() > 0 ? span.count() : 1000);
    const auto whole = bytes / milliseconds;
    const auto fraction = bytes % milliseconds * 1000 / milliseconds;
    constexpr auto maximum = std::numeric_limits<ByteCount>::max();
    return whole > (maximum - fraction) / 1000 ? maximum : whole * 1000 + fraction;
}

}  // namespace wifimeter::core
