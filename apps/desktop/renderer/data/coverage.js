// 仅合并已结束且首尾相接的同语义区间；不跨空档、不补零、不丢弃历史。
export function appendCoverageGaps(gaps, incoming) {
    for (const gap of incoming) {
        const start = Date.parse(gap.startedAt), end = Date.parse(gap.endedAt);
        const previous = gaps.findLast(candidate =>
            candidate.networkId === gap.networkId && candidate.reason === gap.reason &&
            candidate.scope === gap.scope && candidate.detail === gap.detail);
        const previousStart = previous ? Date.parse(previous.startedAt) : NaN;
        const previousEnd = previous ? Date.parse(previous.endedAt) : NaN;
        if (Number.isFinite(start) && Number.isFinite(end) && end > start &&
            Number.isFinite(previousStart) && previousEnd > previousStart && previousEnd === start) {
            previous.endedAt = gap.endedAt;
            previous.spanSeconds = (end - previousStart) / 1000;
        } else {
            // 后续合并只修改快照中的副本，事件负载仍可交给其他订阅者使用。
            gaps.push({ ...gap });
        }
    }
}
