#include "test_support.h"
#if defined(_WIN32)
#include "../ipc/server_windows.h"
#else
#include "../ipc/server.h"
#include <fcntl.h>
#include <unistd.h>
#endif
#include <cstring>

using namespace wifimeter;
class SamplingPlatform : public platform::NetworkPlatform {
public:
    int samples = 0;
    platform::LinkReport wirelessLinks() override { return {}; }
    platform::SampleReport sampleWifi() override { ++samples; return {}; }
    platform::DisconnectReport disconnectIfAssociated(const std::string&, const std::string&) override { return {}; }
};
void inputDoesNotStarveSampling(bool paused) {
    storage::Status status;
    auto store = storage::Store::open(":memory:", status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store) return;
    SamplingPlatform platform;
    ipc::BackendService service({*store, platform}, paused);
    ipc::StdioServer::Options options;
    const char* request = "{\"id\":1,\"protocol\":1,\"method\":\"hello\",\"params\":{}}\r\n";
#if defined(_WIN32)
    HANDLE writer = INVALID_HANDLE_VALUE;
    const bool opened = CreatePipe(&options.input, &writer, nullptr, 0) != FALSE;
    WIFIMETER_CHECK(opened);
    if (!opened) return;
    DWORD written = 0;
    WIFIMETER_CHECK(WriteFile(writer, request, static_cast<DWORD>(std::strlen(request)), &written, nullptr));
    CloseHandle(writer);
    options.output = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
#else
    int pipes[2]{-1, -1};
    const int opened = pipe(pipes);
    WIFIMETER_CHECK(opened == 0);
    if (opened != 0) return;
    options.inputFd = pipes[0];
    WIFIMETER_CHECK(write(pipes[1], request, std::strlen(request)) == static_cast<ssize_t>(std::strlen(request)));
    close(pipes[1]);
    options.outputFd = open("/dev/null", O_WRONLY);
#endif
    ipc::StdioServer server(service, options);
    WIFIMETER_CHECK_EQ(server.run(std::chrono::system_clock::now() - std::chrono::seconds(5)), 0);
    WIFIMETER_CHECK(paused ? platform.samples == 0 : platform.samples > 0);
#if defined(_WIN32)
    CloseHandle(options.input); CloseHandle(options.output);
#else
    close(options.inputFd); close(options.outputFd);
#endif
}
int main() {
    inputDoesNotStarveSampling(false);
    inputDoesNotStarveSampling(true);
    return WIFIMETER_REPORT();
}
