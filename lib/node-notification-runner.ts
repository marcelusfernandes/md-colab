import { drainNotifications } from './notification-outbox.ts';

function intervalMilliseconds(value: string | undefined) {
  if (!value || !/^[1-9]\d*$/.test(value)) return 30_000;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 100 ? parsed : 30_000;
}

export function startNodeNotificationRunner(values: Cloudflare.Env) {
  let active: Promise<void> | null = null;
  const tick = () => {
    if (active) return active;
    active = drainNotifications(values)
      .then((result) => {
        if (result.examined > 0)
          console.info('notification_drain', JSON.stringify(result));
      })
      .catch(() => {
        console.error('notification_drain_failure');
      })
      .finally(() => {
        active = null;
      });
    return active;
  };

  const timer = setInterval(
    () => void tick(),
    intervalMilliseconds(values.NOTIFICATION_DRAIN_INTERVAL_MS),
  );
  timer.unref();
  void tick();
  return { timer, tick };
}
