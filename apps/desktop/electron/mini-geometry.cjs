'use strict';

const SIZES = { bar: { width: 224, height: 92 }, square: { width: 152, height: 152 }, circle: { width: 168, height: 168 } };
const SNAP_DISTANCE = 20;
const STRIP_SIZE = 6;

function miniSize(shape) { return { ...(SIZES[shape] || SIZES.bar) }; }

function clampBounds(bounds, area) {
    const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
    return { x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
        y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))), width, height };
}

function snapBounds(bounds, area, enabled = true) {
    const next = clampBounds(bounds, area);
    if (!enabled) return { bounds: next, edge: null };
    const distances = [
        ['left', Math.abs(bounds.x - area.x)], ['right', Math.abs(bounds.x + bounds.width - area.x - area.width)],
        ['top', Math.abs(bounds.y - area.y)], ['bottom', Math.abs(bounds.y + bounds.height - area.y - area.height)]
    ].sort((a, b) => a[1] - b[1]);
    const edge = distances[0][1] <= SNAP_DISTANCE ? distances[0][0] : null;
    if (edge === 'left') next.x = area.x;
    if (edge === 'right') next.x = area.x + area.width - next.width;
    if (edge === 'top') next.y = area.y;
    if (edge === 'bottom') next.y = area.y + area.height - next.height;
    return { bounds: next, edge };
}

// 收起后的窗口完全位于当前工作区内，相邻屏幕上不会露出窗口主体。
function collapsedBounds(bounds, edge) {
    const next = { ...bounds };
    if (edge === 'left' || edge === 'right') {
        if (edge === 'right') next.x += next.width - STRIP_SIZE;
        next.width = STRIP_SIZE;
    } else if (edge === 'top' || edge === 'bottom') {
        if (edge === 'bottom') next.y += next.height - STRIP_SIZE;
        next.height = STRIP_SIZE;
    }
    return next;
}

function isNear(point, bounds, margin = 12) {
    return point.x >= bounds.x - margin && point.x <= bounds.x + bounds.width + margin
        && point.y >= bounds.y - margin && point.y <= bounds.y + bounds.height + margin;
}

module.exports = { miniSize, clampBounds, snapBounds, collapsedBounds, isNear };
