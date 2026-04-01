export interface AvailabilityWindow {
	start: string;
	end: string;
	status: "free" | "busy";
}

export interface CalendarEvent {
	title: string;
	start: string;
	end: string;
	location?: string;
	description?: string;
	timezone?: string;
}

export interface ICalendarProvider {
	getAvailability(
		timeRange: { start: string; end: string },
		options?: { timezone?: string },
	): Promise<AvailabilityWindow[]>;

	createEvent(event: CalendarEvent): Promise<{ eventId: string }>;

	cancelEvent(eventId: string): Promise<void>;
}
