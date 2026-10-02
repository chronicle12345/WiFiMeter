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

pub fn snap(bounds: Rect, area: Rect, enabled: bool, scale: f64) -> (Rect, Option<Edge>) {
    let mut next = bounds;
    next.width = bounds.width.min(area.width);
    next.height = bounds.height.min(area.height);
    next.x = bounds.x.clamp(area.x, area.x + area.width - next.width);
    next.y = bounds.y.clamp(area.y, area.y + area.height - next.height);
    let mut nearest = None;
    let mut distance = pixels(20, scale) + 1;
    if enabled {
        for (edge, value) in [
            (Edge::Left, (bounds.x - area.x).abs()),
            (
                Edge::Right,
                (bounds.x + bounds.width - area.x - area.width).abs(),
            ),
            (Edge::Top, (bounds.y - area.y).abs()),
            (
                Edge::Bottom,
                (bounds.y + bounds.height - area.y - area.height).abs(),
            ),
        ] {
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

pub fn collapsed(bounds: Rect, edge: Option<Edge>, scale: f64) -> Rect {
    let mut next = bounds;
    let strip = pixels(6, scale);
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
    let margin = pixels(12, scale);
    point.0 >= (bounds.x - margin) as f64
        && point.0 <= (bounds.x + bounds.width + margin) as f64
        && point.1 >= (bounds.y - margin) as f64
        && point.1 <= (bounds.y + bounds.height + margin) as f64
}

pub struct Layout {
    pub expanded: Rect,
    pub edge: Option<Edge>,
    pub collapsed: bool,
    last_activity: u64,
}

impl Layout {
    pub fn new(bounds: Rect) -> Self {
        Self {
            expanded: bounds,
            edge: None,
            collapsed: false,
            last_activity: 0,
        }
    }
    pub fn bounds(&self, scale: f64) -> Rect {
        if self.collapsed {
            collapsed(self.expanded, self.edge, scale)
        } else {
            self.expanded
        }
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
        self.collapsed = false;
        self.last_activity = now;
    }
    pub fn hover(&mut self, point: (f64, f64), enabled: bool, moving: bool, scale: f64, now: u64) {
        if !enabled {
            self.collapsed = false;
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
        if near(point, self.bounds(scale), scale) {
            self.last_activity = now;
            self.collapsed = false;
        } else if now.saturating_sub(self.last_activity) >= 1200 {
            self.collapsed = true;
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
