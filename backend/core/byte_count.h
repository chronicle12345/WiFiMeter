#pragma once

// 字节计数与十进制字符串之间的转换。
//
// 前后端共享的快照把字节数表示为十进制字符串（见 contracts/README.md），
// 校验规则是 ^(0|[1-9]\d{0,19})$ 且不超过 uint64 上限，因此这里统一按该规则
// 解析与生成，避免各处自行拼接。

#include <cstdint>
#include <string>
#include <string_view>

namespace wifimeter::core
{

using ByteCount = std::uint64_t;

// 生成不带前导零的十进制字符串。
std::string decimalString(ByteCount value);

// 解析十进制字符串；不符合约定（空、前导零、非数字、超出 uint64）时返回 false。
bool parseDecimal(std::string_view text, ByteCount& value);

}  // namespace wifimeter::core
