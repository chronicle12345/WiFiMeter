use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

// 逻辑像素：贴边判定距离、收起后的边条厚度、悬停余量，以及按键状态卡住后的自愈时间。
pub const SNAP: i32 = 20;
pub const STRIP: i32 = 6;
pub const NEAR: i32 = 12;
pub const DRAG_HOLD: u64 = 1500;
/// 闲置多久后收起，单位毫秒。
pub const IDLE: u64 = 1200;
/// 收起/展开动效时长，与 renderer/mini/style.css 的 --mini-collapse 保持一致。
pub const COLLAPSE: u64 = 160;
/// 动效期间的采样间隔：约十帧走完一次收起或展开。
pub const COLLAPSE_STEP: u64 = COLLAPSE / 10;
/// 动效结束后仍把尺寸差异算作自己的动作，单位毫秒：窗口落位会晚一两帧。
pub const SETTLE: u64 = 240;

pub fn pixels(logical: i32, scale: f64) -> i32 {
    (logical as f64 * scale).round() as i32
}

pub fn size(shape: &str, scale: f64) -> (i32, i32) {
    let (width, height) = match shape {
        "square" => (152, 152),
        "circle" => (168, 168),
        _ => (224, 92),
    };
    (pixels(width, scale), pixels(height, scale))
}

/// 把窗口夹进工作区，并判断它贴在哪条边上。
///
/// 贴边距离按夹取后的位置计算：抓住窗口中部拖到屏幕边缘时，窗口会有一大截越过工作区，
/// 夹取后它其实已经贴在工作区边上，这时必须算作贴边，否则窗口看着贴了边却既不吸附也不隐藏。
pub fn snap(bounds: Rect, area: Rect, enabled: bool, scale: f64) -> (Rect, Option<Edge>) {
    let mut next = bounds;
    next.width = bounds.width.min(area.width);
    next.height = bounds.height.min(area.height);
    next.x = bounds.x.clamp(area.x, area.x + area.width - next.width);
    next.y = bounds.y.clamp(area.y, area.y + area.height - next.height);
    let mut nearest = None;
    let mut distance = pixels(SNAP, scale) + 1;
    if enabled {
        for (edge, value) in [
            (Edge::Left, next.x - area.x),
            (Edge::Right, next.x + next.width - area.x - area.width),
            (Edge::Top, next.y - area.y),
            (Edge::Bottom, next.y + next.height - area.y - area.height),
        ] {
            let value = value.abs();
            if value < distance {
                distance = value;
                nearest = Some(edge);
            }
        }
    }
    match nearest {
        Some(Edge::Left) => next.x = area.x,
        Some(Edge::Right) => next.x = area.x + area.width - next.width,
        Some(Edge::Top) => next.y = area.y,
        Some(Edge::Bottom) => next.y = area.y + area.height - next.height,
        None => (),
    }
    (next, nearest)
}

/// 一次窗口采样的结果，用来判断小窗此刻该不该重新定位。
pub struct Sample {
    /// 这次采样读到的窗口位置。
    pub observed: Rect,
    /// 布局认为窗口现在应该在的位置。
    pub expected: Rect,
    /// 上一次采样读到的窗口位置，用来判断窗口是否还在移动。
    pub previous: Option<Rect>,
    /// 上一次已经处理过的落点，避免同一个落点反复重排。
    pub placed: Option<Rect>,
    /// 首次定位，或形状、显示器、吸附开关发生变化。
    pub reflow: bool,
    /// 布局当前处于收起状态：收起后窗口没有拖动区，位置差异按目标帧纠正即可。
    pub collapsed: bool,
    /// 收起或展开动效进行中：窗口是我们自己在动，不算用户拖动。
    pub animating: bool,
    /// 动效刚结束的宽限期：这段时间的尺寸差异同样算我们自己的。
    pub settling: bool,
    /// 指针左键是否按下（平台读不到时为 false）。
    pub pressed: bool,
    /// 当前时间与最近一次位置变化的时间，单位毫秒。
    pub now: u64,
    pub last_move: u64,
}

impl Sample {
    /// 窗口位置仍在变化，说明拖动或系统还在移动它。
    pub fn moving(&self) -> bool {
        self.previous != Some(self.observed)
    }
    /// 用户正在拖动小窗：窗口不在布局位置上，且位置仍在变化或左键还按着。
    ///
    /// 平台读不到按键状态时只看位置变化；按键状态卡住超过 [`DRAG_HOLD`] 也按拖动结束处理，
    /// 这样读不到或读错按键状态都不会让小窗永远不再吸附。收起/展开动效期间窗口由我们移动，
    /// 不能当成拖动，否则宿主会停止按帧落位。
    pub fn dragging(&self) -> bool {
        !self.animating
            && self.observed != self.expected
            && (self.moving()
                || (self.pressed && self.now.saturating_sub(self.last_move) < DRAG_HOLD))
    }
}

/// 是否要按观察到的位置重新吸附。
///
/// 拖动过程中不动窗口，交给系统移动；拖动停下后按落点重新吸附一次；同一个落点只处理一次，
/// 这样即使系统拒绝把窗口放到目标位置（位置始终和布局对不上），也不会反复刷新闲置计时
/// 而导致小窗永远不隐藏。形状、显示器、吸附开关变化总能立即重排；收起状态、动效进行中
/// 和动效刚落位时不按落点重排：前两者窗口没有拖动区或由我们自己在动，后者只是尺寸还没到位，
/// 否则中间尺寸会被当成用户放下的位置写进布局。
pub fn reseat(sample: &Sample) -> bool {
    if sample.dragging() {
        return false;
    }
    if sample.reflow {
        return true;
    }
    if sample.animating || sample.collapsed || sample.settling {
        return false;
    }
    sample.observed != sample.expected && sample.placed != Some(sample.observed)
}

pub fn collapsed(bounds: Rect, edge: Option<Edge>, scale: f64) -> Rect {
    let mut next = bounds;
    let strip = pixels(STRIP, scale);
    match edge {
        Some(Edge::Left | Edge::Right) => {
            next.width = strip.min(bounds.width);
            if edge == Some(Edge::Right) {
                next.x += bounds.width - next.width;
            }
        }
        Some(Edge::Top | Edge::Bottom) => {
            next.height = strip.min(bounds.height);
            if edge == Some(Edge::Bottom) {
                next.y += bounds.height - next.height;
            }
        }
        None => (),
    }
    next
}

pub fn near(point: (f64, f64), bounds: Rect, scale: f64) -> bool {
    let margin = pixels(NEAR, scale);
    point.0 >= (bounds.x - margin) as f64
        && point.0 <= (bounds.x + bounds.width + margin) as f64
        && point.1 >= (bounds.y - margin) as f64
        && point.1 <= (bounds.y + bounds.height + margin) as f64
}

/// 收起或展开的补间：从动效开始时的可见位置走到当前的目标位置。
#[derive(Clone, Copy)]
struct Tween {
    from: Rect,
    start: u64,
}

impl Tween {
    fn progress(&self, now: u64) -> f64 {
        (now.saturating_sub(self.start) as f64 / COLLAPSE as f64).min(1.0)
    }
    fn running(&self, now: u64) -> bool {
        now < self.start + COLLAPSE
    }
    fn settling(&self, now: u64) -> bool {
        now < self.start + COLLAPSE + SETTLE
    }
}

/// 二次 ease-out，和页面过渡的 ease-out 手感一致。
fn ease(progress: f64) -> f64 {
    1.0 - (1.0 - progress) * (1.0 - progress)
}

fn between(from: Rect, to: Rect, progress: f64) -> Rect {
    let mix =
        |start: i32, end: i32| (start as f64 + (end - start) as f64 * progress).round() as i32;
    let mut next = Rect {
        x: mix(from.x, to.x),
        y: mix(from.y, to.y),
        width: mix(from.width, to.width),
        height: mix(from.height, to.height),
    };
    // 逐字段取整会让贴合工作区的那一侧抖动一像素，这里按不动的边缘反推坐标。
    if from.x + from.width == to.x + to.width {
        next.x = to.x + to.width - next.width;
    }
    if from.y + from.height == to.y + to.height {
        next.y = to.y + to.height - next.height;
    }
    next
}

pub struct Layout {
    pub expanded: Rect,
    pub edge: Option<Edge>,
    pub collapsed: bool,
    last_activity: u64,
    tween: Option<Tween>,
}

impl Layout {
    pub fn new(bounds: Rect) -> Self {
        Self {
            expanded: bounds,
            edge: None,
            collapsed: false,
            last_activity: 0,
            tween: None,
        }
    }
    /// 布局最终要落在的位置：收起时是贴边条，否则是展开位置。
    pub fn bounds(&self, scale: f64) -> Rect {
        if self.collapsed {
            collapsed(self.expanded, self.edge, scale)
        } else {
            self.expanded
        }
    }
    /// 这一帧窗口应该落到的位置：动效进行中按进度插值，结束后就是目标位置。
    pub fn frame(&self, scale: f64, now: u64) -> Rect {
        let target = self.bounds(scale);
        match self.tween {
            Some(tween) if tween.running(now) => {
                between(tween.from, target, ease(tween.progress(now)))
            }
            _ => target,
        }
    }
    /// 收起或展开动效是否还在进行：宿主据此提高采样频率。
    pub fn animating(&self, now: u64) -> bool {
        self.tween.is_some_and(|tween| tween.running(now))
    }
    /// 动效是否刚开始或刚结束：这段时间的尺寸差异都算我们自己的动作。
    pub fn settling(&self, now: u64) -> bool {
        self.tween.is_some_and(|tween| tween.settling(now))
    }
    /// 切换收起/展开并启动动效；状态没变时不动，避免重复触发。
    ///
    /// 起点取当前可见的一帧，所以动效中途反向（收起到一半指针回来）会从原处继续，不会跳变。
    fn fold(&mut self, folded: bool, scale: f64, now: u64) {
        if self.collapsed == folded {
            return;
        }
        let from = self.frame(scale, now);
        self.collapsed = folded;
        self.tween = Some(Tween { from, start: now });
    }
    pub fn place(
        &mut self,
        bounds: Rect,
        area: Rect,
        dimensions: (i32, i32),
        resize: bool,
        enabled: bool,
        scale: f64,
        now: u64,
    ) {
        let mut desired = bounds;
        if resize {
            desired.width = dimensions.0;
            desired.height = dimensions.1;
            if self.edge == Some(Edge::Right) {
                desired.x = area.x + area.width - desired.width;
            }
            if self.edge == Some(Edge::Bottom) {
                desired.y = area.y + area.height - desired.height;
            }
        }
        (self.expanded, self.edge) = snap(desired, area, enabled, scale);
        self.fold(false, scale, now);
        self.last_activity = now;
    }
    pub fn hover(&mut self, point: (f64, f64), enabled: bool, moving: bool, scale: f64, now: u64) {
        if !enabled {
            self.fold(false, scale, now);
            self.last_activity = now;
            return;
        }
        if moving {
            self.last_activity = now;
            return;
        }
        if self.edge.is_none() {
            return;
        }
        // 用当前可见的一帧判断悬停：收起途中指针回到面板上也能立刻取消。
        if near(point, self.frame(scale, now), scale) {
            self.last_activity = now;
            self.fold(false, scale, now);
        } else if now.saturating_sub(self.last_activity) >= IDLE {
            self.fold(true, scale, now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect(x: i32, y: i32, width: i32, height: i32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }
    #[test]
    fn negative_monitor_edges_keep_strips_inside_the_same_work_area() {
        let area = rect(-1920, -100, 1920, 1040);
        for (bounds, edge, strip) in [
            (
                rect(-1911, 100, 224, 92),
                Edge::Left,
                rect(-1920, 100, 6, 92),
            ),
            (rect(-229, 100, 224, 92), Edge::Right, rect(-6, 100, 6, 92)),
            (
                rect(-900, -94, 224, 92),
                Edge::Top,
                rect(-900, -100, 224, 6),
            ),
            (
                rect(-900, 840, 224, 92),
                Edge::Bottom,
                rect(-900, 934, 224, 6),
            ),
        ] {
            let (bounds, actual) = snap(bounds, area, true, 1.0);
            assert_eq!(actual, Some(edge));
            assert_eq!(collapsed(bounds, actual, 1.0), strip);
            assert!(near((strip.x as f64, strip.y as f64), strip, 1.0));
            assert!(!near(((strip.x - 13) as f64, strip.y as f64), strip, 1.0));
        }
    }
    #[test]
    fn scaling_preserves_logical_size_threshold_and_strip() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let (w, h) = size("bar", scale);
            let area = rect(0, 0, 3840, 2160);
            let (bounds, edge) = snap(rect(pixels(20, scale), 500, w, h), area, true, scale);
            assert_eq!(edge, Some(Edge::Left));
            assert_eq!(collapsed(bounds, edge, scale).width, pixels(6, scale));
            assert_eq!(
                snap(rect(pixels(20, scale) + 1, 500, w, h), area, true, scale).1,
                None
            );
            assert_eq!(
                size("circle", scale),
                (pixels(168, scale), pixels(168, scale))
            );
        }
    }
    #[test]
    fn clamp_small_disconnected_monitor_and_stable_corner_priority() {
        assert_eq!(
            snap(rect(500, 800, 224, 92), rect(-300, 20, 180, 80), false, 1.0),
            (rect(-300, 20, 180, 80), None)
        );
        assert_eq!(
            snap(rect(10, 10, 224, 92), rect(0, 0, 1920, 1080), true, 1.0).1,
            Some(Edge::Left)
        );
    }
    #[test]
    fn dragging_a_window_to_an_edge_snaps_even_when_it_overshoots() {
        // 用户抓住小窗中部拖到屏幕边缘时，窗口总有一大截越过工作区；夹取后它已经贴在边上，
        // 这时必须算作贴边，否则窗口看着贴了边却既不吸附也不隐藏。
        let area = rect(0, 0, 1920, 1080);
        let (width, height) = size("bar", 1.0);
        for (dropped, edge, expected) in [
            (
                rect(-width / 2, 400, width, height),
                Edge::Left,
                rect(0, 400, width, height),
            ),
            (
                rect(area.x + area.width - width / 2, 400, width, height),
                Edge::Right,
                rect(area.x + area.width - width, 400, width, height),
            ),
            (
                rect(700, -height / 2, width, height),
                Edge::Top,
                rect(700, 0, width, height),
            ),
            (
                rect(700, area.y + area.height - height / 2, width, height),
                Edge::Bottom,
                rect(700, area.y + area.height - height, width, height),
            ),
        ] {
            let (bounds, actual) = snap(dropped, area, true, 1.0);
            assert_eq!(actual, Some(edge));
            assert_eq!(bounds, expected);
            assert_eq!(
                collapsed(bounds, actual, 1.0),
                collapsed(expected, Some(edge), 1.0)
            );
        }
        // 落在工作区内部、离边缘超过判定距离时不吸附；刚好进入判定距离时吸附。
        assert_eq!(snap(rect(400, 400, width, height), area, true, 1.0).1, None);
        assert_eq!(
            snap(
                rect(area.width - width - 1, 400, width, height),
                area,
                true,
                1.0
            )
            .1,
            Some(Edge::Right)
        );
    }
    #[test]
    fn an_overshot_drop_stays_snapped_and_hides_after_idle() {
        let area = rect(0, 0, 1920, 1080);
        let (width, height) = size("bar", 1.0);
        let mut layout = Layout::new(rect(848, 454, width, height));
        layout.place(
            rect(848, 454, width, height),
            area,
            size("bar", 1.0),
            false,
            true,
            1.0,
            0,
        );
        assert_eq!(layout.edge, None);
        // 抓住中部拖到右边缘，窗口越过工作区右边缘半个宽度。
        layout.place(
            rect(area.x + area.width - width / 2, 500, width, height),
            area,
            size("bar", 1.0),
            false,
            true,
            1.0,
            100,
        );
        assert_eq!(layout.edge, Some(Edge::Right));
        assert_eq!(
            layout.expanded.x + layout.expanded.width,
            area.x + area.width
        );
        // 指针移开后闲置收起成边条。
        layout.hover((20.0, 20.0), true, false, 1.0, 1400);
        assert!(layout.collapsed);
        assert_eq!(
            layout.bounds(1.0),
            rect(area.x + area.width - 6, 500, 6, height)
        );
    }
    fn sample(observed: Rect, expected: Rect) -> Sample {
        Sample {
            observed,
            expected,
            previous: Some(observed),
            placed: None,
            reflow: false,
            collapsed: false,
            animating: false,
            settling: false,
            pressed: false,
            now: 2000,
            last_move: 1900,
        }
    }
    #[test]
    fn a_dropped_window_is_reseated_once_and_a_moving_one_is_left_alone() {
        let area = rect(0, 0, 1920, 1080);
        let (width, height) = size("bar", 1.0);
        let expected = rect(area.x + area.width - width, 988, width, height);
        let dropped = rect(8, 400, width, height);
        let mut observed = sample(dropped, expected);
        // 位置仍在变化：拖动还没结束，交给系统。
        observed.previous = Some(rect(300, 400, width, height));
        assert!(observed.moving());
        assert!(observed.dragging());
        assert!(!reseat(&observed));
        // 停下后按落点重新吸附一次。
        observed.previous = Some(dropped);
        assert!(!observed.dragging());
        assert!(reseat(&observed));
        observed.placed = Some(dropped);
        assert!(!reseat(&observed));
    }
    #[test]
    fn a_pressed_pointer_holds_the_drag_until_it_is_released() {
        let area = rect(0, 0, 1920, 1080);
        let (width, height) = size("bar", 1.0);
        let expected = rect(area.x + area.width - width, 988, width, height);
        let dropped = rect(8, 400, width, height);
        // 按住左键停在原地：仍算拖动，不抢窗口。
        let mut observed = sample(dropped, expected);
        observed.pressed = true;
        observed.last_move = observed.now;
        assert!(observed.dragging());
        assert!(!reseat(&observed));
        // 松开后立即重排。
        observed.pressed = false;
        assert!(reseat(&observed));
        // 按键状态卡住时超过 DRAG_HOLD 也自愈，不会再让小窗永远不吸附。
        let mut stuck = sample(dropped, expected);
        stuck.pressed = true;
        stuck.last_move = stuck.now - DRAG_HOLD;
        assert!(!stuck.dragging());
        assert!(reseat(&stuck));
    }
    #[test]
    fn a_window_on_its_layout_position_or_a_handled_drop_is_left_alone() {
        let area = rect(0, 0, 1920, 1080);
        let (width, height) = size("bar", 1.0);
        let expected = rect(area.x + area.width - width, 988, width, height);
        assert!(!reseat(&sample(expected, expected)));
        let mut handled = sample(rect(8, 400, width, height), expected);
        handled.placed = Some(handled.observed);
        assert!(!reseat(&handled));
        // 形状、显示器或吸附开关变化时即使位置没变也要重排。
        let mut reflow = sample(expected, expected);
        reflow.reflow = true;
        assert!(reseat(&reflow));
    }
    #[test]
    fn a_window_the_system_refuses_to_move_is_only_placed_once() {
        let area = rect(0, 0, 1920, 1080);
        let (width, height) = size("bar", 1.0);
        let expected = rect(area.x + area.width - width, 988, width, height);
        // 系统拒绝移动窗口：位置始终和布局对不上，也只处理一次，闲置计时不被反复刷新。
        let refused = rect(848, 454, width, height);
        let mut observed = sample(refused, expected);
        assert!(reseat(&observed));
        observed.placed = Some(refused);
        for now in [2100, 2200, 2300] {
            observed.now = now;
            assert!(!reseat(&observed));
        }
    }
    #[test]
    fn collapse_frames_move_continuously_to_the_strip() {
        let area = rect(0, 0, 1920, 1080);
        let (width, height) = size("bar", 1.0);
        let expanded = rect(area.x + area.width - width, 500, width, height);
        let strip = rect(area.x + area.width - 6, 500, 6, height);
        let mut layout = Layout::new(expanded);
        layout.place(expanded, area, size("bar", 1.0), false, true, 1.0, 0);
        layout.hover((20.0, 20.0), true, false, 1.0, 2000);
        assert!(layout.collapsed);
        assert_eq!(layout.frame(1.0, 2000), expanded, "第一帧还在原处");
        assert!(layout.animating(2000));
        assert!(layout.settling(2000));
        let middle = layout.frame(1.0, 2000 + COLLAPSE / 2);
        assert!(
            middle.width < width && middle.width > 6,
            "收起必须经过中间尺寸：{middle:?}"
        );
        assert_eq!(
            middle.x + middle.width,
            area.x + area.width,
            "贴边一侧始终贴合"
        );
        assert_eq!(layout.frame(1.0, 2000 + COLLAPSE), strip);
        assert!(!layout.animating(2000 + COLLAPSE));
        assert!(layout.settling(2000 + COLLAPSE), "刚落位仍在宽限期");
        assert!(!layout.settling(2000 + COLLAPSE + SETTLE));
        assert_eq!(layout.frame(1.0, 2000 + COLLAPSE + SETTLE), strip);
    }
    #[test]
    fn reversing_mid_flight_continues_from_the_visible_frame() {
        let area = rect(0, 0, 1920, 1080);
        let (width, height) = size("bar", 1.0);
        let expanded = rect(area.x + area.width - width, 500, width, height);
        let mut layout = Layout::new(expanded);
        layout.place(expanded, area, size("bar", 1.0), false, true, 1.0, 0);
        layout.hover((20.0, 20.0), true, false, 1.0, 2000);
        let middle = layout.frame(1.0, 2080);
        assert!(layout.collapsed && middle.width < width);
        // 指针落在仍在显示的面板上：从当前这一帧反向展开，不跳变。
        layout.hover(
            (middle.x as f64 + 4.0, middle.y as f64 + 4.0),
            true,
            false,
            1.0,
            2080,
        );
        assert!(!layout.collapsed);
        assert_eq!(layout.frame(1.0, 2080), middle);
        assert_eq!(layout.frame(1.0, 2080 + COLLAPSE), expanded);
        assert!(!layout.animating(2080 + COLLAPSE));
    }
    #[test]
    fn reseat_ignores_differences_while_collapsed_or_settling() {
        let expected = rect(1696, 500, 224, 92);
        let observed = rect(1800, 500, 120, 92);
        // 收起状态：窗口没有拖动区，位置差异按目标帧纠正，不按落点重排。
        let mut collapsed = sample(observed, expected);
        collapsed.collapsed = true;
        assert!(!reseat(&collapsed));
        // 动效刚落位：尺寸还没到位，同样不能当成落点。
        let mut settling = sample(observed, expected);
        settling.settling = true;
        assert!(!reseat(&settling));
        // 动效期间窗口由我们移动，不算拖动。
        let mut animating = sample(observed, expected);
        animating.animating = true;
        animating.previous = Some(rect(1700, 500, 200, 92));
        assert!(!animating.dragging());
        assert!(!reseat(&animating));
        // 形状、显示器或吸附开关变化仍要立即重排。
        let mut reflow = sample(observed, expected);
        reflow.collapsed = true;
        reflow.settling = true;
        reflow.reflow = true;
        assert!(reseat(&reflow));
    }
    /// 按宿主的采样节奏模拟小窗：拖动期间窗口跟着指针走，停稳后落到布局位置。
    struct Host {
        layout: Layout,
        area: Rect,
        observed: Rect,
        previous: Option<Rect>,
        placed: Option<Rect>,
        point: (f64, f64),
        last_move: u64,
        pressed: bool,
        first: bool,
        was_animating: bool,
        now: u64,
    }
    impl Host {
        fn new(bounds: Rect, area: Rect) -> Self {
            Self {
                layout: Layout::new(bounds),
                area,
                observed: bounds,
                previous: None,
                placed: None,
                point: (4.0, 4.0),
                last_move: 0,
                pressed: false,
                first: true,
                was_animating: false,
                now: 0,
            }
        }
        fn tick(&mut self) {
            self.now += if self.layout.animating(self.now) {
                COLLAPSE_STEP
            } else {
                100
            };
            if self.previous != Some(self.observed) {
                self.last_move = self.now;
            }
            let animating = self.layout.animating(self.now);
            let settling = self.layout.settling(self.now);
            let sample = Sample {
                observed: self.observed,
                expected: self.layout.bounds(1.0),
                previous: self.previous,
                placed: self.placed,
                reflow: self.first,
                collapsed: self.layout.collapsed,
                animating,
                settling,
                pressed: self.pressed,
                now: self.now,
                last_move: self.last_move,
            };
            self.first = false;
            let dragging = sample.dragging();
            if reseat(&sample) {
                let settled = if self.layout.collapsed {
                    self.layout.expanded
                } else {
                    self.observed
                };
                let dimensions = size("bar", 1.0);
                self.layout
                    .place(settled, self.area, dimensions, false, true, 1.0, self.now);
                self.placed = Some(self.observed);
            }
            self.layout.hover(self.point, true, dragging, 1.0, self.now);
            // 宿主把窗口放到这一帧。用户按住鼠标时窗口由系统移动；动效刚结束的下一帧仍要补齐
            // 最后一帧，之后再遇到窗口不在目标位置上，更可能是用户刚把它放下，都不要抢。
            let foreign = settling
                && !animating
                && !self.was_animating
                && self.observed != self.layout.bounds(1.0);
            if !dragging && !self.pressed && !foreign {
                self.observed = self.layout.frame(1.0, self.now);
            }
            // 记录"窗口这时应该在哪"：我们自己让它去的位置，或拖动时读到的位置。
            // 用它判断位置变化，自己挪窗口就不会被当成用户拖动。
            self.previous = Some(self.observed);
            self.was_animating = animating;
        }
        fn idle(&mut self, milliseconds: u64) {
            let until = self.now + milliseconds;
            while self.now < until {
                self.tick();
            }
        }
        // 按住左键沿路径拖动窗口，松开后继续采样到落点被处理。
        fn drag(&mut self, path: &[(i32, i32)]) {
            self.pressed = true;
            for (x, y) in path {
                self.observed = rect(*x, *y, self.observed.width, self.observed.height);
                self.tick();
            }
            self.pressed = false;
            self.tick();
            let until = self.now + COLLAPSE + SETTLE + 100;
            while self.now < until {
                self.tick();
            }
        }
    }
    #[test]
    fn moving_the_window_and_dropping_it_at_an_edge_still_snaps_and_hides() {
        let area = rect(0, 0, 1920, 1080);
        let (width, height) = size("bar", 1.0);
        let mut host = Host::new(
            rect(area.x + area.width - width - 12, 900, width, height),
            area,
        );
        host.tick();
        assert_eq!(host.layout.edge, Some(Edge::Right));
        // 闲置后收起；指针移到边条上展开，用户从这里开始拖动。
        host.idle(2000);
        assert!(host.layout.collapsed);
        host.point = (1917.0, 940.0);
        host.tick();
        assert!(!host.layout.collapsed);
        // 展开动效走完，用户这时才抓住面板。
        host.idle(COLLAPSE);
        // 拖到屏幕中间：拖动期间不抢窗口，松开后停在落点，不再吸附。
        host.drag(&[(1400, 700), (1000, 600), (848, 500)]);
        assert_eq!(host.layout.edge, None);
        assert_eq!(host.layout.expanded, rect(848, 500, width, height));
        // 再拖到右边缘：抓住窗口中部会越过工作区，落点仍应吸附并在闲置后隐藏。
        host.drag(&[(1500, 500), (1808, 500)]);
        assert_eq!(host.layout.edge, Some(Edge::Right));
        assert_eq!(
            host.layout.expanded.x + host.layout.expanded.width,
            area.x + area.width
        );
        host.point = (400.0, 400.0);
        host.idle(2000);
        assert!(host.layout.collapsed);
        assert_eq!(
            host.layout.bounds(1.0),
            rect(area.x + area.width - 6, 500, 6, height)
        );
    }
    #[test]
    fn idle_hover_drag_and_disabling_auto_hide_preserve_expanded_bounds() {
        let mut layout = Layout::new(rect(8, 100, 224, 92));
        layout.place(
            layout.expanded,
            rect(0, 0, 1920, 1080),
            size("bar", 1.0),
            false,
            true,
            1.0,
            0,
        );
        layout.hover((900.0, 500.0), true, false, 1.0, 1199);
        assert!(!layout.collapsed);
        layout.hover((900.0, 500.0), true, true, 1.0, 2000);
        assert!(!layout.collapsed);
        layout.hover((900.0, 500.0), true, false, 1.0, 3200);
        assert!(layout.collapsed);
        layout.hover((10.0, 130.0), true, false, 1.0, 3300);
        assert!(!layout.collapsed);
        assert_eq!(layout.bounds(1.0), rect(0, 100, 224, 92));
        layout.hover((900.0, 500.0), true, false, 1.0, 4500);
        assert!(layout.collapsed);
        layout.hover((900.0, 500.0), false, false, 1.0, 4600);
        assert!(!layout.collapsed);
    }
    #[test]
    fn shape_and_monitor_changes_keep_right_edge_and_restart_idle_timer() {
        let mut layout = Layout::new(rect(-226, 100, 224, 92));
        layout.place(
            layout.expanded,
            rect(-1600, 0, 1600, 900),
            size("bar", 1.0),
            false,
            true,
            1.0,
            0,
        );
        layout.place(
            layout.expanded,
            rect(-1600, 0, 1600, 900),
            size("circle", 1.0),
            true,
            true,
            1.0,
            100,
        );
        assert_eq!(layout.expanded.x + layout.expanded.width, 0);
        layout.hover((900.0, 500.0), true, false, 1.0, 2000);
        assert!(layout.collapsed);
        layout.place(
            layout.expanded,
            rect(0, 30, 1280, 690),
            size("circle", 1.5),
            true,
            true,
            1.5,
            2000,
        );
        assert!(!layout.collapsed);
        assert_eq!(layout.expanded.x + layout.expanded.width, 1280);
        assert_eq!(layout.expanded.width, 252);
        layout.hover((900.0, 500.0), true, false, 1.5, 2100);
        assert!(!layout.collapsed);
    }
}
