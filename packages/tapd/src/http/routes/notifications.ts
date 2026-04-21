import type { NotificationQueue, TapNotification } from "../../notification-queue.js";
import type { RouteHandler } from "../router.js";

export function createNotificationsRoute(
	queue: NotificationQueue,
): RouteHandler<unknown, { notifications: TapNotification[] }> {
	return async () => ({ notifications: queue.drain() });
}
