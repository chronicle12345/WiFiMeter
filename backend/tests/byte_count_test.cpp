// 字节计数与十进制字符串的转换测试：快照格式为 ^(0|[1-9]\d{0,19})$。

#include "../core/byte_count.h"

#include <string>

#include "test_support.h"

using namespace wifimeter::core;

namespace
{

void writesDecimalStrings()
{
    WIFIMETER_CHECK_EQ(decimalString(0), std::string("0"));
    WIFIMETER_CHECK_EQ(decimalString(7), std::string("7"));
    WIFIMETER_CHECK_EQ(decimalString(1000000000), std::string("1000000000"));
    WIFIMETER_CHECK_EQ(decimalString(18446744073709551615ULL), std::string("18446744073709551615"));
}

void parsesValidDecimals()
{
    ByteCount value = 123;
    WIFIMETER_CHECK(parseDecimal("0", value));
    WIFIMETER_CHECK_EQ(value, ByteCount{0});
    WIFIMETER_CHECK(parseDecimal("1000000000", value));
    WIFIMETER_CHECK_EQ(value, ByteCount{1000000000});
    WIFIMETER_CHECK(parseDecimal("18446744073709551615", value));
    WIFIMETER_CHECK_EQ(value, ByteCount{18446744073709551615ULL});
}

void rejectsMalformedDecimals()
{
    ByteCount value = 0;
    WIFIMETER_CHECK(!parseDecimal("", value));
    WIFIMETER_CHECK(!parseDecimal("007", value));  // 前导零不符合快照格式
    WIFIMETER_CHECK(!parseDecimal("00", value));
    WIFIMETER_CHECK(!parseDecimal("-1", value));
    WIFIMETER_CHECK(!parseDecimal("+1", value));
    WIFIMETER_CHECK(!parseDecimal("1a", value));
    WIFIMETER_CHECK(!parseDecimal(" 1", value));
    WIFIMETER_CHECK(!parseDecimal("1 ", value));
    WIFIMETER_CHECK(!parseDecimal("1.5", value));
    WIFIMETER_CHECK(!parseDecimal("18446744073709551616", value));  // 超出 uint64
    WIFIMETER_CHECK(!parseDecimal("99999999999999999999999", value));
}

void roundTripsEveryMagnitude()
{
    for (const ByteCount value : {ByteCount{0}, ByteCount{1}, ByteCount{999}, ByteCount{1000000000}, ByteCount{18446744073709551615ULL}})
    {
        ByteCount parsed = 0;
        WIFIMETER_CHECK(parseDecimal(decimalString(value), parsed));
        WIFIMETER_CHECK_EQ(parsed, value);
    }
}

}  // namespace

int main()
{
    writesDecimalStrings();
    parsesValidDecimals();
    rejectsMalformedDecimals();
    roundTripsEveryMagnitude();
    return WIFIMETER_REPORT();
}
