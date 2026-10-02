// Exercise the production query path with deterministic Win32 return codes.
#include "../platform/win32/wlanapi_query.h"
#include <cstddef>
#include <netioapi.h>
#include <iphlpapi.h>
#include "test_support.h"

namespace
{
DWORD queryCode = ERROR_ACCESS_DENIED;
WLAN_INTERFACE_STATE interfaceState = wlan_interface_state_connected;
DWORD WINAPI fakeOpen(DWORD, PVOID, PDWORD version, PHANDLE handle)
{
    *version = 2;
    *handle = reinterpret_cast<HANDLE>(1);
    return ERROR_SUCCESS;
}
DWORD WINAPI fakeClose(HANDLE, PVOID) { return ERROR_SUCCESS; }
DWORD WINAPI fakeEnum(HANDLE, PVOID, PWLAN_INTERFACE_INFO_LIST* output)
{
    // MinGW 的 InterfaceInfo 是柔性数组，sizeof 不包含任何接口记录。
    const auto size = offsetof(WLAN_INTERFACE_INFO_LIST, InterfaceInfo) + sizeof(WLAN_INTERFACE_INFO);
    *output = static_cast<PWLAN_INTERFACE_INFO_LIST>(WlanAllocateMemory(static_cast<DWORD>(size)));
    ZeroMemory(*output, size);
    (*output)->dwNumberOfItems = 1;
    (*output)->InterfaceInfo[0].isState = interfaceState;
    wcscpy_s((*output)->InterfaceInfo[0].strInterfaceDescription, L"Fixture WLAN");
    return ERROR_SUCCESS;
}
DWORD WINAPI fakeQuery(HANDLE, const GUID*, WLAN_INTF_OPCODE, PVOID, PDWORD size, PVOID* data, PWLAN_OPCODE_VALUE_TYPE)
{
    *size = 0;
    *data = nullptr;
    return queryCode;
}
}

// Compile the actual implementation against fake WLAN calls, keeping its parsing,
// error handling and memory cleanup intact. Other platform calls remain read-only.
#define WlanOpenHandle fakeOpen
#define WlanCloseHandle fakeClose
#define WlanEnumInterfaces fakeEnum
#define WlanQueryInterface fakeQuery
#include "../platform/win32/wlanapi_query.cpp"
#undef WlanOpenHandle
#undef WlanCloseHandle
#undef WlanEnumInterfaces
#undef WlanQueryInterface

int main()
{
    namespace win = wifimeter::platform::windows;
    namespace platform = wifimeter::platform;
    for (const DWORD code : {DWORD(ERROR_ACCESS_DENIED), DWORD(ERROR_INVALID_HANDLE), DWORD(ERROR_SUCCESS)})
    {
        queryCode = code;
        interfaceState = wlan_interface_state_connected;
        win::Win32System system;
        const auto result = system.wlanStatuses();
        WIFIMETER_CHECK(result.ok());
        WIFIMETER_CHECK_EQ(result.value->size(), std::size_t{1});
        const auto& status = result.value->at(0);
        WIFIMETER_CHECK(status.connected);
        WIFIMETER_CHECK(!status.ssid.has_value());
        WIFIMETER_CHECK(!win::identityOf(status).associated());
        bool found = false;
        for (const auto& failure : result.failures)
        {
            if (failure.detail.find("WlanQueryInterface") == std::string::npos) continue;
            found = true;
            const DWORD expected = code == ERROR_SUCCESS ? ERROR_INVALID_DATA : code;
            WIFIMETER_CHECK(failure.detail.find(std::to_string(expected)) != std::string::npos);
            if (code == ERROR_ACCESS_DENIED)
            {
                WIFIMETER_CHECK(failure.kind == platform::FailureKind::commandFailed);
                WIFIMETER_CHECK(failure.detail.find("location") != std::string::npos);
                WIFIMETER_CHECK(failure.detail.find("WLAN") != std::string::npos);
            }
        }
        WIFIMETER_CHECK(found);
    }
    interfaceState = wlan_interface_state_disconnected;
    queryCode = ERROR_INVALID_STATE;
    win::Win32System system;
    const auto disconnected = system.wlanStatuses();
    WIFIMETER_CHECK(!disconnected.value->at(0).connected);
    for (const auto& failure : disconnected.failures)
        WIFIMETER_CHECK(failure.detail.find("WlanQueryInterface") == std::string::npos);
    queryCode = ERROR_ACCESS_DENIED;
    const auto denied = system.wlanStatuses();
    bool reported = false;
    for (const auto& failure : denied.failures)
        if (failure.detail.find("WlanQueryInterface") != std::string::npos) reported = true;
    WIFIMETER_CHECK(reported);
    return WIFIMETER_REPORT();
}
