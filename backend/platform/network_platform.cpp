#include "network_platform.h"

namespace wifimeter::platform
{

Band classifyBand(int frequencyMhz)
{
    // 边界按 IEEE 802.11 的频段划分：5 GHz 与 6 GHz 之间留出的间隔不予归类。
    if (frequencyMhz >= 2400 && frequencyMhz <= 2500)
        return Band::ghz2_4;
    if (frequencyMhz >= 4900 && frequencyMhz <= 5895)
        return Band::ghz5;
    if (frequencyMhz >= 5925 && frequencyMhz <= 7125)
        return Band::ghz6;
    if (frequencyMhz >= 57000 && frequencyMhz <= 71000)
        return Band::ghz60;
    return Band::unknown;
}

std::string_view bandLabel(Band band)
{
    switch (band)
    {
        case Band::ghz2_4:
            return "2.4 GHz";
        case Band::ghz5:
            return "5 GHz";
        case Band::ghz6:
            return "6 GHz";
        case Band::ghz60:
            return "60 GHz";
        case Band::unknown:
            break;
    }
    return {};
}

}  // namespace wifimeter::platform
