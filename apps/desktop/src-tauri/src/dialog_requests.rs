use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Mutex,
};

pub type Answer = Option<(usize, bool)>;

#[derive(Default)]
pub struct DialogRequests {
    sequence: AtomicU64,
    pending: Mutex<HashMap<u64, (usize, mpsc::Sender<Answer>)>>,
}

impl DialogRequests {
    pub fn begin(&self, buttons: usize) -> (u64, mpsc::Receiver<Answer>) {
        let id = self.sequence.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, (buttons, sender));
        (id, receiver)
    }

    pub fn reply(&self, id: u64, button: Option<usize>, remember: bool) {
        if let Some((count, sender)) = self.pending.lock().unwrap().remove(&id) {
            let answer = button
                .filter(|button| *button < count)
                .map(|button| (button, remember));
            let _ = sender.send(answer);
        }
    }

    pub fn cancel_all(&self) {
        self.pending.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replies_are_correlated_and_invalid_choices_cancel() {
        let requests = DialogRequests::default();
        let (a, first) = requests.begin(3);
        let (b, second) = requests.begin(2);
        requests.reply(b, Some(8), true);
        assert_eq!(second.recv().unwrap(), None);
        assert!(first.try_recv().is_err());
        requests.reply(a, Some(1), true);
        assert_eq!(first.recv().unwrap(), Some((1, true)));
    }
    #[test]
    fn reload_cancels_waiters_and_stale_replies() {
        let requests = DialogRequests::default();
        let (old, first) = requests.begin(2);
        requests.cancel_all();
        assert!(first.recv().is_err());
        let (new, second) = requests.begin(2);
        requests.reply(old, Some(0), false);
        assert!(second.try_recv().is_err());
        requests.reply(new, None, false);
        assert_eq!(second.recv().unwrap(), None);
    }
}
