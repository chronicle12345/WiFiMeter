// Windows 路径处理测试。
//
// 这段逻辑在真机上出过一次会导致应用完全不可用的问题：逐段创建目录时把盘符 "C:"
// 也当成目录去 CreateDirectory。正常情况下它返回 ERROR_ALREADY_EXISTS 被忽略，
// 但当进程的当前目录不可用时（Electron 拉起子进程时常见）会返回 ERROR_ACCESS_DENIED，
// 于是打包后的应用后端启动即失败，界面永远停在“采集器未就绪”。
//
// 因此这里把“要创建哪些目录前缀”单独测清楚，不依赖任何系统调用。

#include "../platform/windows/path_support.h"

#include <string>
#include <vector>

#include "test_support.h"

using namespace wifimeter::platform::windows;

namespace
{

std::string joined(const std::vector<std::string>& values)
{
    std::string out;
    for (const std::string& value : values)
    {
        if (!out.empty())
            out += "|";
        out += value;
    }
    return out;
}

void skipsDriveLetter()
{
    // 真机形态：绝不能把 "C:" 当成要创建的目录。
    const std::vector<std::string> prefixes = directoryPrefixesToCreate("C:\\Users\\dev\\AppData\\Roaming\\WiFiMeter Demo\\wifimeter.db");
    WIFIMETER_CHECK_EQ(joined(prefixes), std::string("C:\\Users|C:\\Users\\dev|C:\\Users\\dev\\AppData|C:\\Users\\dev\\AppData\\Roaming|C:\\Users\\dev\\AppData\\Roaming\\WiFiMeter Demo"));
    for (const std::string& prefix : prefixes)
        WIFIMETER_CHECK(prefix.size() > 2 && prefix[1] == ':');
}

void skipsDriveRoot()
{
    // 父目录就是盘符本身：没有目录要创建。把 "C:" 交给 CreateDirectory 在进程当前
    // 目录不可用时会返回 ERROR_ACCESS_DENIED，真机上正是这样让后端启动即失败。
    WIFIMETER_CHECK(directoryPrefixesToCreate("C:\\b.db").empty());
    WIFIMETER_CHECK(directoryPrefixesToCreate("C:").empty());
}

void handlesForwardSlashes()
{
    const std::vector<std::string> prefixes = directoryPrefixesToCreate("C:/data/wifimeter/meter.db");
    WIFIMETER_CHECK_EQ(joined(prefixes), std::string("C:/data|C:/data/wifimeter"));
}

void handlesBareFileName()
{
    // 只有文件名：没有父目录要创建。
    WIFIMETER_CHECK(directoryPrefixesToCreate("meter.db").empty());
    WIFIMETER_CHECK_EQ(parentDirectoryOf("meter.db"), std::string(""));
}

void handlesSingleSegment()
{
    WIFIMETER_CHECK_EQ(joined(directoryPrefixesToCreate("C:\\WiFiMeter\\meter.db")), std::string("C:\\WiFiMeter"));
}

void skipsUncSharePrefix()
{
    // UNC 的 \\server\share 同样不是要新建的目录。
    const std::vector<std::string> prefixes = directoryPrefixesToCreate("\\\\server\\share\\dir\\meter.db");
    WIFIMETER_CHECK_EQ(joined(prefixes), std::string("\\\\server\\share\\dir"));
}

void takesParentDirectory()
{
    WIFIMETER_CHECK_EQ(parentDirectoryOf("C:\\Users\\a\\b.db"), std::string("C:\\Users\\a"));
    WIFIMETER_CHECK_EQ(parentDirectoryOf("C:\\b.db"), std::string("C:"));
    WIFIMETER_CHECK_EQ(parentDirectoryOf("/tmp/x/y.db"), std::string("/tmp/x"));
}

}  // namespace

int main()
{
    skipsDriveLetter();
    skipsDriveRoot();
    handlesForwardSlashes();
    handlesBareFileName();
    handlesSingleSegment();
    skipsUncSharePrefix();
    takesParentDirectory();
    return WIFIMETER_REPORT();
}
