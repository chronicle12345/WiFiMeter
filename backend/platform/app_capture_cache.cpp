#include "app_capture_cache.h"

#include <limits>
#include <utility>

namespace wifimeter::platform
{
std::string AppCaptureIdentity::instanceId() const
{
    return std::to_string(processId) + ":" + std::to_string(startedAt);
}

AppCaptureCache::AppCaptureCache(std::size_t maximumSamples, std::size_t maximumIdentities)
    : maximumSamples_(maximumSamples), maximumIdentities_(maximumIdentities) {}

void AppCaptureCache::reset(std::string generation)
{
    generation_ = std::move(generation);
    serial_ = 0;
    pending_.clear(); merged_.clear(); identities_.clear(); identityOrder_.clear();
    identityIndex_.clear(); identityReferences_.clear();
}

bool AppCaptureCache::add(const std::string& interfaceId, const AppCaptureIdentity& identity, std::uint64_t rx, std::uint64_t tx)
{
    const auto instance = identity.instanceId();
    const Key key{instance, interfaceId, identity.appId};
    auto found = pending_.find(key);
    if (found == pending_.end() && identity.exitedAt && (identities_.count(instance) ||
        merged_.count({interfaceId,identity.appId})))
        return addMerged(interfaceId, identity.appId, identity.name, rx, tx);
    if (found == pending_.end())
    {
        if (pending_.size() + merged_.size() >= maximumSamples_) return false;
        AppTrafficSample sample{interfaceId, identity.appId, identity.name, instance, identity.processId,
            0, 0, !identity.exitedAt};
        sample.source = "WindowsEtw";
        found = pending_.emplace(key, Entry{std::move(sample), identity}).first;
        identityIndex_[identity.processId][identity.startedAt] = identity;
        ++identityReferences_[instance];
    }
    auto& sample = found->second.sample;
    if (sample.rxBytes > (std::numeric_limits<std::uint64_t>::max)() - rx ||
        sample.txBytes > (std::numeric_limits<std::uint64_t>::max)() - tx) return false;
    sample.rxBytes += rx; sample.txBytes += tx;
    return true;
}

bool AppCaptureCache::addUnknown(const std::string& interfaceId, std::uint64_t rx, std::uint64_t tx)
{
    return addMerged(interfaceId, "unknown", "未识别应用", rx, tx);
}

void AppCaptureCache::exited(std::uint32_t processId, std::uint64_t startedAt, std::uint64_t exitedAt)
{
    const auto indexed = identityIndex_.find(processId);
    if (indexed != identityIndex_.end())
    {
        const auto process = indexed->second.find(startedAt);
        if (process != indexed->second.end()) process->second.exitedAt = exitedAt;
    }
    const auto instance = std::to_string(processId) + ":" + std::to_string(startedAt);
    for (auto row = pending_.lower_bound({instance,{},{}}); row != pending_.end() && std::get<0>(row->first) == instance; ++row)
    {
        row->second.identity.exitedAt = exitedAt;
        row->second.sample.active = false;
    }
}

std::optional<AppCaptureIdentity> AppCaptureCache::identityFor(std::uint32_t processId, std::uint64_t timestamp) const
{
    const auto pid = identityIndex_.find(processId);
    if (pid == identityIndex_.end()) return std::nullopt;
    auto process = pid->second.upper_bound(timestamp);
    if (process == pid->second.begin()) return std::nullopt;
    const auto& identity = (--process)->second;
    if (identity.startedAt && (!identity.exitedAt || timestamp <= identity.exitedAt)) return identity;
    return std::nullopt;
}

AppTrafficReport AppCaptureCache::snapshot() const
{
    AppTrafficReport report{AppCollectorState::running, generation_, {}, {}};
    report.retirementSupported = true;
    report.samples.reserve(pending_.size()+merged_.size());
    for (const auto& [key, entry] : pending_)
    {
        (void)key;
        auto sample = entry.sample;
        entry.publishedRx = sample.rxBytes;
        entry.publishedTx = sample.txBytes;
        if (!sample.active) sample.processId = 0;
        report.samples.push_back(std::move(sample));
    }
    for (const auto& [key, sample] : merged_) { (void)key; report.samples.push_back(sample); }
    return report;
}

void AppCaptureCache::acknowledge(const AppTrafficReport& saved)
{
    if (!saved.retirementSupported || saved.generation != generation_) return;
    for (const auto& sample : saved.samples)
    {
        if (sample.active || sample.source != "WindowsEtw" || sample.instanceId.rfind("retired:",0) == 0) continue;
        const auto found = pending_.find({sample.instanceId,sample.interfaceId,sample.appId});
        if (found == pending_.end() || found->second.sample.active || !found->second.identity.exitedAt ||
            sample.rxBytes > found->second.sample.rxBytes || sample.txBytes > found->second.sample.txBytes ||
            sample.rxBytes < found->second.publishedRx || sample.txBytes < found->second.publishedTx) continue;
        const auto entry = found->second;
        // Bytes arriving after the saved snapshot must survive the instance removal.
        const auto lateRx = entry.sample.rxBytes-sample.rxBytes;
        const auto lateTx = entry.sample.txBytes-sample.txBytes;
        pending_.erase(found);
        if (!addMerged(sample.interfaceId,sample.appId,sample.name,lateRx,lateTx))
        {
            pending_.emplace(Key{sample.instanceId,sample.interfaceId,sample.appId},entry);
            continue;
        }
        auto reference = identityReferences_.find(entry.identity.instanceId());
        if (reference != identityReferences_.end() && --reference->second == 0) identityReferences_.erase(reference);
        remember(entry.identity);
    }
}

bool AppCaptureCache::addMerged(const std::string& interfaceId, const std::string& appId, const std::string& name,
    std::uint64_t rx, std::uint64_t tx)
{
    const auto key = std::make_pair(interfaceId, appId);
    auto found = merged_.find(key);
    if (found == merged_.end())
    {
        if (pending_.size() + merged_.size() >= maximumSamples_) return false;
        AppTrafficSample sample{interfaceId, appId, name, "retired:" + std::to_string(++serial_), 0, 0, 0, false};
        sample.source = "WindowsEtw";
        found = merged_.emplace(key, std::move(sample)).first;
    }
    if (found->second.rxBytes > (std::numeric_limits<std::uint64_t>::max)() - rx ||
        found->second.txBytes > (std::numeric_limits<std::uint64_t>::max)() - tx) return false;
    found->second.rxBytes += rx; found->second.txBytes += tx;
    return true;
}

void AppCaptureCache::remember(const AppCaptureIdentity& identity)
{
    const auto instance = identity.instanceId();
    if (maximumIdentities_ && identities_.emplace(instance,identity).second) identityOrder_.push_back(instance);
    if (!maximumIdentities_ && !identityReferences_.count(instance))
    {
        auto pid = identityIndex_.find(identity.processId);
        if (pid != identityIndex_.end())
        {
            pid->second.erase(identity.startedAt);
            if (pid->second.empty()) identityIndex_.erase(pid);
        }
    }
    while (identities_.size() > maximumIdentities_)
    {
        const auto oldest = identities_.find(identityOrder_.front());
        if (oldest != identities_.end() && !identityReferences_.count(oldest->first))
        {
            auto pid = identityIndex_.find(oldest->second.processId);
            if (pid != identityIndex_.end())
            {
                pid->second.erase(oldest->second.startedAt);
                if (pid->second.empty()) identityIndex_.erase(pid);
            }
        }
        identities_.erase(identityOrder_.front());
        identityOrder_.pop_front();
    }
}
}  // namespace wifimeter::platform
