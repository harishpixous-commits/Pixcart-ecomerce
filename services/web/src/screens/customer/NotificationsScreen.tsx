/**
 * SCR-021 — Notification inbox (FR-CUS-022).
 *
 * Lists the account's notifications with their read state, marks one read, or
 * the whole inbox read. Read state is the server's (`readAt`), never a local
 * guess, so reopening the page reflects what actually happened.
 *
 * Unread rows are distinguished by a left border and an explicit "Unread"
 * label, not by colour alone (§8.4). Linking notifications that carry a
 * `linkUrl` goes through the router to in-app routes and opens external ones
 * in a new tab with `rel="noreferrer"`.
 */
import { Link } from 'react-router-dom';
import type { NotificationItem } from '@contracts/dto';
import { Badge, Button, useToast } from '../../design';
import { ApiProblem, api } from '../../lib/api';
import { dateTime, relativeTime } from '../../lib/format';
import { useAsync } from '../lib/useAsync';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { RequireCustomer } from './RequireCustomer';
import './customer.css';

interface NotificationsPayload {
  items: NotificationItem[];
}

function severityTone(s: NotificationItem['severity']): 'info' | 'success' | 'warning' | 'danger' {
  switch (s) {
    case 'SUCCESS':
      return 'success';
    case 'WARNING':
      return 'warning';
    case 'ERROR':
      return 'danger';
    default:
      return 'info';
  }
}

function NotificationsInner() {
  const toast = useToast();
  const notifications = useAsync<NotificationsPayload>(
    async (signal) => (await api.notifications(false, signal)) as NotificationsPayload,
    [],
  );

  const items = notifications.data?.items ?? [];
  const unread = items.filter((i) => !i.readAt).length;

  async function markOne(n: NotificationItem): Promise<void> {
    try {
      await api.readNotification(n.id);
      notifications.setData((cur) =>
        cur
          ? { items: cur.items.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) }
          : cur,
      );
    } catch (err) {
      toast.error(
        err instanceof ApiProblem
          ? err.problem.detail || err.problem.title
          : 'Could not reach the server. Check your connection and try again.',
      );
    }
  }

  async function markAll(): Promise<void> {
    try {
      await api.readAllNotifications();
      notifications.reload();
      toast.success('All notifications marked as read');
    } catch (err) {
      toast.error(
        err instanceof ApiProblem
          ? err.problem.detail || err.problem.title
          : 'Could not reach the server. Check your connection and try again.',
      );
    }
  }

  if (notifications.status === 'loading') {
    return <ScreenLoading label="Loading your notifications" />;
  }
  if (notifications.status === 'error') {
    return <ScreenError error={notifications.error} onRetry={notifications.reload} />;
  }

  return (
    <div>
      <PageHeader
        title="Notifications"
        description={
          unread > 0
            ? `${unread} unread of ${items.length}`
            : items.length > 0
              ? `${items.length} total · you're all caught up`
              : 'Order, payment and account updates land here.'
        }
        actions={
          unread > 0 ? (
            <Button variant="secondary" onClick={markAll}>
              Mark all as read
            </Button>
          ) : undefined
        }
      />

      {items.length === 0 ? (
        <ScreenEmpty
          title="No notifications"
          description="Updates about your orders, returns, payments and account appear here."
        />
      ) : (
        <ul className="pxcu-notifs">
          {items.map((n) => (
            <li key={n.id} className={`pxcu-notif ${n.readAt ? '' : 'pxcu-notif--unread'}`}>
              <div className="pxcu-notif__head">
                <Badge tone={severityTone(n.severity)} size="sm">
                  {n.category}
                </Badge>
                <span className="pxcu-notif__title">{n.title}</span>
                {!n.readAt && (
                  <Badge tone="info" size="sm">
                    Unread
                  </Badge>
                )}
                <span className="pxcu-muted" title={dateTime(n.createdAt)}>
                  {relativeTime(n.createdAt)}
                </span>
              </div>
              <p className="pxcu-notif__body">{n.body}</p>
              <div className="pxcu-line__actions">
                {n.linkUrl &&
                  (n.linkUrl.startsWith('/') ? (
                    <Link to={n.linkUrl} onClick={() => !n.readAt && markOne(n)}>
                      Open
                    </Link>
                  ) : (
                    <a href={n.linkUrl} target="_blank" rel="noreferrer noopener">
                      Open details
                    </a>
                  ))}
                {!n.readAt && (
                  <Button size="sm" variant="ghost" onClick={() => markOne(n)}>
                    Mark as read
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function NotificationsScreen() {
  return (
    <RequireCustomer>
      <NotificationsInner />
    </RequireCustomer>
  );
}
