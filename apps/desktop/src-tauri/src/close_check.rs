use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Mutex,
};

#[derive(Default)]
pub struct CloseCheck {
    sequence: AtomicU64,
    pending: Mutex<Option<(u64, mpsc::Sender<bool>)>>,
}

impl CloseCheck {
    pub fn begin(&self) -> (u64, mpsc::Receiver<bool>) {
        let id = self.sequence.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        *self.pending.lock().unwrap() = Some((id, sender));
        (id, receiver)
    }

    pub fn reply(&self, id: u64, dirty: bool) {
        let mut pending = self.pending.lock().unwrap();
        if pending
            .as_ref()
            .is_some_and(|(expected, _)| *expected == id)
        {
            if let Some((_, sender)) = pending.take() {
                let _ = sender.send(dirty);
            }
        }
    }

    pub fn cancel(&self, id: u64) {
        let mut pending = self.pending.lock().unwrap();
        if pending
            .as_ref()
            .is_some_and(|(expected, _)| *expected == id)
        {
            *pending = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_replies_cannot_approve_a_new_close_request() {
        let check = CloseCheck::default();
        let (first, old) = check.begin();
        check.cancel(first);
        assert!(old.recv().is_err());
        let (second, current) = check.begin();
        check.reply(first, false);
        assert!(current.try_recv().is_err());
        check.reply(second, true);
        assert!(current.recv().unwrap());
    }
}
