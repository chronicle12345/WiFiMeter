#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <optional>
#include <string>
#include <tuple>

#include "app_traffic.h"

namespace wifimeter::platform
{

struct AppCaptureIdentity
{
    std::uint32_t processId = 0;
    std::uint64_t startedAt = 0;
    std::uint64_t exitedAt = 0;
    std::string appId;
    std::string name;

    std::string instanceId() const;
};

// Final per-process counters remain available until their exact values are saved.
// Late bytes use a separate cumulative stream shared by application and interface.
class AppCaptureCache
{
public:
    explicit AppCaptureCache(std::size_t maximumSamples = 65536, std::size_t maximumIdentities = 4096);
    void reset(std::string generation);
    bool add(const std::string& interfaceId, const AppCaptureIdentity& identity, std::uint64_t rx, std::uint64_t tx);
    bool addUnknown(const std::string& interfaceId, std::uint64_t rx, std::uint64_t tx);
    void exited(std::uint32_t processId, std::uint64_t startedAt, std::uint64_t exitedAt);
    std::optional<AppCaptureIdentity> identityFor(std::uint32_t processId, std::uint64_t timestamp) const;
    AppTrafficReport snapshot() const;
    void acknowledge(const AppTrafficReport& saved);
    std::size_t pendingCount() const { return pending_.size(); }
    std::size_t mergedCount() const { return merged_.size(); }
    std::size_t identityCount() const { return identities_.size(); }

private:
    // Group interface rows by instance so a batch of exits is not a full scan per process.
    using Key = std::tuple<std::string, std::string, std::string>;
    struct Entry
    {
        AppTrafficSample sample;
        AppCaptureIdentity identity;
        mutable std::uint64_t publishedRx = 0;
        mutable std::uint64_t publishedTx = 0;
    };
    bool addMerged(const std::string& interfaceId, const std::string& appId, const std::string& name,
        std::uint64_t rx, std::uint64_t tx);
    void remember(const AppCaptureIdentity& identity);
    std::string generation_;
    std::size_t maximumSamples_;
    std::size_t maximumIdentities_;
    std::uint64_t serial_ = 0;
    std::map<Key, Entry> pending_;
    std::map<std::pair<std::string, std::string>, AppTrafficSample> merged_;
    std::map<std::string, AppCaptureIdentity> identities_;
    std::map<std::uint32_t, std::map<std::uint64_t, AppCaptureIdentity>> identityIndex_;
    std::map<std::string, std::size_t> identityReferences_;
    std::deque<std::string> identityOrder_;
};

}  // namespace wifimeter::platform
