#include "fake_app_traffic.h"

#include <fstream>
#include <iterator>

namespace wifimeter::platform::fake
{

AppTrafficReport FileAppTrafficSource::read()
{
    if (!enabled_)
        return {};
    std::ifstream file(path_, std::ios::binary);
    if (!file)
        return {AppCollectorState::unavailable, {}, "Application traffic fixture cannot be read", {}};
    return parseAppTrafficReport(std::string(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()));
}

}  // namespace wifimeter::platform::fake
